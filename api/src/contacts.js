// Prospect contacts — the real humans on the buyer side. One row per
// (tenant, person), linked to a `companies` row. Migration 0015 stood up
// the schema; this module is the CRUD service + HTTP router.
//
// Role is required free text per the product requirement. We also keep an
// optional FK to the `personas` tagging dimension so a "CFO" contact can
// silently widen KB retrieval to CFO-scoped chunks at brief time. The
// persona_id is auto-inferred from role text on write (case-insensitive
// match against personas.name); the rep can override explicitly via the
// API by passing persona_id directly on create/update.
//
// All queries are tenant-scoped (the "Data Firewall") — a contact id from
// another tenant is invisible (returns 404). Same shape as companies.js.

const express = require('express');
const db = require('./db');
const gating = require('./gating');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Outreach email categories. Each shapes the AI's goal/tone; `engagement: true`
// pulls the prospect's most recent completed engagement into the context.
const EMAIL_CATEGORIES = {
  cold: {
    label: 'Cold outreach',
    goal: 'A first-touch cold email — no prior relationship. Open with a specific, relevant reason for reaching out (a buying signal / why-now, or a sharp insight about their business), state the value we offer in one line, and close with a low-friction ask (a brief reply or a short call). Short, human, curiosity-driven.',
    engagement: false,
  },
  followup: {
    label: 'Follow-up',
    goal: 'A follow-up after a previous email or touchpoint that got no reply. Briefly reference the prior outreach, add one new piece of value or a fresh angle, and make a soft, easy CTA. Polite and concise — never guilt-trip.',
    engagement: false,
  },
  postcall: {
    label: 'Post-call / engagement',
    goal: 'A follow-up after a recent call or meeting. Reference what was discussed, reinforce the value or next step that emerged, and propose a clear next action. Warm and specific to the conversation.',
    engagement: true,
  },
  reengage: {
    label: 'Re-engagement',
    goal: 'Re-engage a prospect who has gone quiet. Use a recent development or signal about their business as a natural reason to reconnect, remind them of the value, and keep the CTA low-pressure.',
    engagement: false,
  },
  meeting: {
    label: 'Meeting request',
    goal: 'Request a specific meeting or demo: one clear value reason to meet plus a single concrete CTA to book time. Brief and direct.',
    engagement: false,
  },
  proposal: {
    label: 'Proposal / next-steps',
    goal: 'Summarize a recommendation / proposed next steps, tying our products to the needs evidenced in the prospect intel. Confident and value-led with a clear next step.',
    engagement: true,
  },
  other: {
    label: 'Other',
    goal: 'Write the email to accomplish what the sender describes in their instruction. Use a professional, warm B2B sales tone.',
    engagement: false,
  },
};

// Best-effort: find a personas row whose name matches the given role text
// (case-insensitive). Returns the persona_id or null.
async function inferPersonaIdForRole(tenantId, role) {
  const r = String(role || '').trim();
  if (!r) return null;
  const res = await db.query(
    `SELECT id FROM personas WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [tenantId, r]
  );
  return res.rows[0] ? res.rows[0].id : null;
}

// ── Selects ──────────────────────────────────────────────────────────────

const SELECT_COLUMNS = `
  pc.id, pc.company_id, pc.name, pc.email, pc.role, pc.persona_id, pc.likely_product_id, pc.location,
  pc.title, pc.notes, pc.created_by, pc.created_at, pc.updated_at,
  c.name AS company_name,
  c.domain AS company_domain,
  p.name AS persona_name,
  pr.name AS likely_product_name
`;
const FROM_JOIN = `
  FROM prospect_contacts pc
  LEFT JOIN companies c ON c.id = pc.company_id
  LEFT JOIN personas  p ON p.id = pc.persona_id AND p.tenant_id = pc.tenant_id
  LEFT JOIN products  pr ON pr.id = pc.likely_product_id AND pr.tenant_id = pc.tenant_id
`;

async function list(tenantId, { companyId, q } = {}) {
  const where = ['pc.tenant_id = $1'];
  const params = [tenantId];
  if (companyId) {
    params.push(companyId);
    where.push(`pc.company_id = $${params.length}`);
  }
  if (q && q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`);
    where.push(`(lower(pc.name) LIKE $${params.length} OR lower(pc.email) LIKE $${params.length} OR lower(pc.role) LIKE $${params.length})`);
  }
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN}
      WHERE ${where.join(' AND ')}
      ORDER BY pc.updated_at DESC, pc.name ASC
      LIMIT 500`,
    params
  );
  return r.rows;
}

async function get(tenantId, id) {
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN}
      WHERE pc.tenant_id = $1 AND pc.id = $2`,
    [tenantId, id]
  );
  return r.rows[0] || null;
}

async function create(tenantId, userId, { companyId, name, email, role, personaId, title, notes, likelyProductId, location }) {
  if (!companyId) { const e = new Error('companyId required'); e.status = 400; throw e; }
  if (!email || !EMAIL_RE.test(String(email))) { const e = new Error('valid email required'); e.status = 400; throw e; }

  // Apollo autofill — when the rep only has the email (name = email or just
  // missing), try to enrich it to a real Name/Role/Title before persisting.
  // Best-effort: a failure (no plan, out of credits, unknown person) silently
  // falls back to the values the rep typed.
  let finalName = name && String(name).trim();
  let finalTitle = title || null;
  const looksStubName = !finalName || finalName === email.split('@')[0] || finalName.toLowerCase() === String(email).toLowerCase();
  if (looksStubName) {
    try {
      const apollo = require('./knowledge/apollo');
      const p = await apollo.enrichPerson(tenantId, email);
      if (p && p.name) finalName = p.name;
      if (p && !finalTitle && p.title) finalTitle = p.title;
      if (p && (!role || role === 'Unknown') && p.title) role = p.title;
    } catch (e) { /* non-fatal */ }
  }
  if (!finalName) { const e = new Error('name required'); e.status = 400; throw e; }

  const finalRole = (role && String(role).trim()) || 'Unknown';
  const finalPersonaId = personaId !== undefined ? (personaId || null) : await inferPersonaIdForRole(tenantId, finalRole);
  try {
    const r = await db.query(
      `INSERT INTO prospect_contacts
         (tenant_id, company_id, name, email, role, persona_id, title, notes, created_by, likely_product_id, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [tenantId, companyId, finalName, String(email).trim(), finalRole, finalPersonaId, finalTitle, notes || null, userId || null, likelyProductId || null, location || null]
    );
    return get(tenantId, r.rows[0].id);
  } catch (err) {
    if (err.code === '23505') {
      const e = new Error('a contact with this email already exists in your workspace');
      e.status = 409; e.code = 'EMAIL_TAKEN'; throw e;
    }
    if (err.code === '23503') {
      const e = new Error('company not found in your workspace');
      e.status = 404; e.code = 'COMPANY_NOT_FOUND'; throw e;
    }
    throw err;
  }
}

// Idempotent stub — used by the mission scheduler to create a placeholder
// contact for any prospect_email that doesn't yet have one. Won't overwrite
// existing contacts (the rep may have already given them a real name + role).
async function findOrCreateStub(tenantId, companyId, email) {
  if (!email || !EMAIL_RE.test(email)) return null;
  // Check by case-insensitive email first; if it exists, just link it.
  const existing = await db.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN}
      WHERE pc.tenant_id = $1 AND lower(pc.email) = lower($2) LIMIT 1`,
    [tenantId, email]
  );
  if (existing.rows[0]) return existing.rows[0];
  // Create. name defaults to the local part; role 'Unknown' until edited.
  const localPart = email.split('@')[0];
  const r = await db.query(
    `INSERT INTO prospect_contacts
       (tenant_id, company_id, name, email, role)
     VALUES ($1, $2, $3, $4, 'Unknown')
     ON CONFLICT (tenant_id, lower(email)) DO NOTHING
     RETURNING id`,
    [tenantId, companyId, localPart, email.trim()]
  );
  if (r.rows[0]) return get(tenantId, r.rows[0].id);
  // ON CONFLICT raced — re-fetch.
  return (await db.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN}
      WHERE pc.tenant_id = $1 AND lower(pc.email) = lower($2) LIMIT 1`,
    [tenantId, email]
  )).rows[0] || null;
}

async function update(tenantId, id, { name, email, role, personaId, title, notes, likelyProductId, location }) {
  const existing = await get(tenantId, id);
  if (!existing) return null;
  const next = {
    name:  name  != null ? String(name).trim()  : existing.name,
    email: email != null ? String(email).trim() : existing.email,
    role:  role  != null ? (String(role).trim() || 'Unknown') : existing.role,
    title: title != null ? title : existing.title,
    notes: notes != null ? notes : existing.notes,
  };
  if (next.email && !EMAIL_RE.test(next.email)) {
    const e = new Error('valid email required'); e.status = 400; throw e;
  }
  // Persona: an explicit null clears it; an explicit string sets it; an
  // undefined re-infers if role changed and persona was previously inferred.
  let nextPersonaId = existing.persona_id;
  if (personaId !== undefined) {
    nextPersonaId = personaId || null;
  } else if (role !== undefined && role !== existing.role) {
    nextPersonaId = await inferPersonaIdForRole(tenantId, next.role);
  }
  try {
    await db.query(
      `UPDATE prospect_contacts
          SET name=$3, email=$4, role=$5, persona_id=$6, title=$7, notes=$8,
              likely_product_id=$9, location=$10, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, next.name, next.email, next.role, nextPersonaId, next.title, next.notes,
       likelyProductId !== undefined ? (likelyProductId || null) : existing.likely_product_id,
       location !== undefined ? (location || null) : existing.location]
    );
    return get(tenantId, id);
  } catch (err) {
    if (err.code === '23505') {
      const e = new Error('another contact with this email already exists in your workspace');
      e.status = 409; e.code = 'EMAIL_TAKEN'; throw e;
    }
    throw err;
  }
}

async function remove(tenantId, id) {
  const r = await db.query(
    `DELETE FROM prospect_contacts WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id]
  );
  return r.rowCount > 0;
}

// ── Mission ↔ contacts bridge (mission_contacts) ────────────────────────

async function linkContactsToMission(tenantId, missionId, contactIds) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) return;
  const unique = [...new Set(contactIds.filter(Boolean))];
  for (const cid of unique) {
    await db.query(
      `INSERT INTO mission_contacts (meeting_id, contact_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [missionId, cid]
    );
  }
}

async function listForMission(tenantId, missionId) {
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOIN}
       JOIN mission_contacts mc ON mc.contact_id = pc.id
      WHERE pc.tenant_id = $1 AND mc.meeting_id = $2
      ORDER BY pc.name ASC`,
    [tenantId, missionId]
  );
  return r.rows;
}

// ── HTTP router ─────────────────────────────────────────────────────────

// Build the "past engagement" context block for follow-up / post-call drafts.
// A touchpoint id is `call:<scheduled_meeting_id>` or `email:<kb_document_id>`
// (a bare id is treated as a call, for back-compat). Selecting one grounds the
// draft on exactly that touchpoint; auto-mode (no id) pulls the latest call AND
// the latest captured email thread so the AI sees the recent history either way.
async function gatherEngagementContext(tenantId, companyId, engagementId) {
  const eid = String(engagementId || '').trim();
  const blocks = [];

  async function callBlock(m) {
    if (!m) return null;
    const bits = [`Date: ${new Date(m.scheduled_at).toISOString().slice(0, 10)}`];
    if (m.portal_id) {
      try {
        const p = await require('./store').getPortal(m.portal_id);
        if (p) {
          if (p.title) bits.push(`Call: ${p.title}`);
          const names = (Array.isArray(p.participants) ? p.participants : []).map((x) => (x && (x.name || x.displayName)) || (typeof x === 'string' ? x : '')).filter(Boolean);
          if (names.length) bits.push(`Participants: ${names.join(', ')}`);
          if (p.sowSummary) bits.push(`What was discussed: ${String(p.sowSummary).slice(0, 1100)}`);
          const obj = p.moments && p.moments.objection;
          const objText = obj && (obj.quote || obj.summary || obj.context);
          if (objText) bits.push(`Key moment / objection raised: ${String(objText).slice(0, 300)}`);
        }
      } catch { /* portal gone — date + notes still useful */ }
    }
    if (m.notes) bits.push(`Notes: ${String(m.notes).slice(0, 500)}`);
    return `PAST CALL (ground concretely in THIS conversation):\n${bits.join('\n')}`;
  }
  async function emailBlock(docId) {
    try {
      const d = await require('./knowledge/service').getDocumentText(tenantId, docId);
      if (!d || !d.text) return null;
      return `CAPTURED EMAIL THREAD (ground concretely in THIS exchange — continue it naturally):\n${String(d.text).slice(0, 1500)}`;
    } catch { return null; }
  }
  const latestCall = () => db.query(
    `SELECT id, scheduled_at, notes, portal_id FROM scheduled_meetings WHERE tenant_id = $1 AND company_id = $2 AND status = 'COMPLETED' ORDER BY scheduled_at DESC LIMIT 1`,
    [tenantId, companyId]
  ).then((r) => r.rows[0]);
  if (eid.startsWith('email:')) {
    const b = await emailBlock(eid.slice(6)); if (b) blocks.push(b);
  } else if (eid) {
    const callId = eid.startsWith('call:') ? eid.slice(5) : eid;
    const m = (await db.query(`SELECT id, scheduled_at, notes, portal_id FROM scheduled_meetings WHERE id = $1 AND tenant_id = $2 AND company_id = $3`, [callId, tenantId, companyId])).rows[0];
    const b = await callBlock(m); if (b) blocks.push(b);
  } else {
    // Auto: latest completed call. Email history is supplied separately by
    // gatherEmailTrail() so every draft sees the full trail, not just one email.
    const m = await latestCall();
    const cb = await callBlock(m); if (cb) blocks.push(cb);
  }
  return blocks.join('\n\n');
}

// The recent captured email trail with a prospect — the ingested outbound/inbound
// emails (source='inbound-email'), oldest→newest, so a new draft can continue the
// conversation instead of starting cold. Included in EVERY draft regardless of
// category (that's the whole point: brief on the prior trail and carry context).
// `excludeDocId` skips an email already shown as the explicit engagement
// touchpoint, so it isn't printed twice.
//
// When `contactEmail` is given we thread by that specific person: keep only the
// emails whose stored From/To/CC mention their address. If none match — older
// rows filed before recipients were captured, or a different correspondent — we
// fall back to the whole prospect-company trail so the draft still gets context.
async function gatherEmailTrail(tenantId, companyId, { contactEmail = null, limit = 5, excludeDocId = null } = {}) {
  if (!companyId) return '';
  // Over-fetch so contact-filtering below can still yield up to `limit` emails.
  const rows = (await db.query(
    `SELECT id, title, metadata, created_at
       FROM kb_documents
      WHERE tenant_id = $1 AND company_id = $2 AND scope = 'PROSPECT'
        AND metadata->>'source' = 'inbound-email' AND status = 'READY'
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, companyId, Math.max(limit * 3, limit)]
  )).rows.filter((r) => r.id !== excludeDocId);
  if (!rows.length) return '';

  // Prefer the thread with this specific contact; fall back to company-wide.
  let chosen = rows;
  const needle = String(contactEmail || '').trim().toLowerCase();
  if (needle) {
    const hay = (r) => `${(r.metadata && r.metadata.from) || ''} ${(r.metadata && r.metadata.to) || ''} ${(r.metadata && r.metadata.cc) || ''}`.toLowerCase();
    const matches = rows.filter((r) => hay(r).includes(needle));
    if (matches.length) chosen = matches;
  }
  chosen = chosen.slice(0, limit).reverse(); // newest `limit`, then oldest → newest

  const svc = require('./knowledge/service');
  const parts = [];
  for (const r of chosen) {
    let text = '';
    try { const d = await svc.getDocumentText(tenantId, r.id); text = (d && d.text) || ''; } catch { /* skip unreadable */ }
    if (!text) continue;
    const when = (r.metadata && r.metadata.receivedAt) || (r.created_at && new Date(r.created_at).toISOString());
    const subj = (r.metadata && r.metadata.subject) || r.title || '(no subject)';
    parts.push(`--- ${when ? String(when).slice(0, 10) : ''} · ${subj} ---\n${String(text).slice(0, 1200)}`);
  }
  if (!parts.length) return '';
  return 'PRIOR EMAIL TRAIL with this contact (oldest first, most recent last). '
    + 'CONTINUE this conversation naturally — reference what was already said and '
    + 'move it forward; do NOT repeat points already made or reintroduce yourself '
    + `if the thread is already underway:\n${parts.join('\n\n')}`;
}

const router = express.Router();
router.use(express.json());

router.get('/', async (req, res, next) => {
  try {
    const rows = await list(req.tenantId, {
      companyId: req.query.companyId || null,
      q: req.query.q || null,
    });
    res.json({ contacts: rows });
  } catch (err) { next(err); }
});

// GET /contacts/apollo-search?domain=acme.com&q=jane — augments the Teams
// modal autocomplete with Apollo's people search. Returns [] when Apollo
// isn't configured, is over the daily cap, or has no match — UI just merges
// what it gets back with prospect_contacts + /me/people results.
router.get('/apollo-search', async (req, res, next) => {
  try {
    const apollo = require('./knowledge/apollo');
    if (!apollo.isConfigured()) return res.json({ people: [] });
    const domain = String(req.query.domain || '').trim();
    const q      = String(req.query.q || '').trim();
    if (!domain) return res.json({ people: [] });
    const people = await apollo.searchPeople(req.tenantId, domain, { name: q || undefined, limit: 6 });
    res.json({ people });
  } catch (err) { next(err); }
});

// GET /contacts/email-categories — the category options for the composer UI.
router.get('/email-categories', (req, res) => {
  res.json({ categories: Object.entries(EMAIL_CATEGORIES).map(([key, c]) => ({ key, label: c.label })) });
});

// POST /contacts/:id/draft-email { category, instruction } — AI-draft an outreach
// email TO this contact, grounded in our company + the prospect's intel/signals
// (and last engagement for post-call/proposal). Returns { to, cc, subject, body };
// the UI opens it in the rep's mail client via mailto. The cc is the prospect's
// inbound-parse address so the sent mail + any reply-all are captured as intel.
router.post('/:id/draft-email', gating.requireFeature('engagements'), async (req, res, next) => {
  try {
    const contact = await get(req.tenantId, req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (!contact.email) return res.status(422).json({ error: 'this contact has no email address yet' });
    const cat = EMAIL_CATEGORIES[String((req.body && req.body.category) || 'cold').toLowerCase()] || EMAIL_CATEGORIES.cold;
    const instruction = String((req.body && req.body.instruction) || '').trim().slice(0, 1000);

    // Sender + our-company context.
    const tenant = (await db.query(`SELECT name FROM tenants WHERE id = $1`, [req.tenantId])).rows[0] || {};
    const prof = (await db.query(`SELECT positioning, ideal_customer_profile FROM tenant_profiles WHERE tenant_id = $1`, [req.tenantId])).rows[0] || {};
    const products = (await db.query(`SELECT id, name, description FROM products WHERE tenant_id = $1 ORDER BY lower(name) LIMIT 12`, [req.tenantId])).rows;
    // Optional product focus — the modal's product dropdown. When set, the
    // draft pitches ONLY this product instead of the whole portfolio.
    const focusId = String((req.body && req.body.productId) || '').trim();
    const focusProduct = focusId ? products.find((p) => p.id === focusId) || null : null;
    const u = (await db.query(`SELECT first_name, last_name FROM users WHERE id = $1`, [req.user && req.user.sub])).rows[0] || {};
    const senderName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || tenant.name || 'the team';

    // Prospect intel: latest research synthesis + signals; last engagement when relevant.
    const research = (await db.query(
      `SELECT summary, opportunities FROM prospect_research WHERE tenant_id = $1 AND company_id = $2 AND status = 'DONE' ORDER BY created_at DESC LIMIT 1`,
      [req.tenantId, contact.company_id]
    )).rows[0] || {};
    const signals = Array.isArray(research.opportunities)
      ? research.opportunities.map((o) => `- ${(o && (o.title || o.summary)) || (typeof o === 'string' ? o : '')}`).filter((s) => s.length > 3).slice(0, 6).join('\n')
      : '';
    let engagement = '';
    if (cat.engagement) engagement = await gatherEngagementContext(req.tenantId, contact.company_id, req.body && req.body.engagementId);

    // Always brief the draft on the prior email trail with this prospect so the
    // next email picks up the thread and carries context — regardless of the
    // chosen category. If a specific email was pinned as the engagement
    // touchpoint, exclude it here so it isn't shown twice.
    const eidRaw = String((req.body && req.body.engagementId) || '').trim();
    const pinnedEmailId = eidRaw.startsWith('email:') ? eidRaw.slice(6) : null;
    const emailTrail = await gatherEmailTrail(req.tenantId, contact.company_id, { contactEmail: contact.email, excludeDocId: pinnedEmailId });

    const ctxBlock = [
      `OUR COMPANY: ${tenant.name || ''}`,
      prof.positioning ? `What we do: ${String(prof.positioning).slice(0, 600)}` : '',
      focusProduct
        ? `FOCUS PRODUCT (the ONLY product this email is about): ${focusProduct.name}${focusProduct.description ? ` — ${String(focusProduct.description).slice(0, 300)}` : ''}`
        : (products.length ? `Our products: ${products.map((p) => p.name + (p.description ? ` (${String(p.description).slice(0, 80)})` : '')).join('; ')}` : ''),
      `PROSPECT COMPANY: ${contact.company_name || ''}${contact.company_domain ? ` (${contact.company_domain})` : ''}`,
      `RECIPIENT: ${contact.name}${contact.role && contact.role !== 'Unknown' ? `, ${contact.role}` : ''}`,
      research.summary ? `What we know about them: ${String(research.summary).slice(0, 1200)}` : '',
      signals ? `Recent signals / opportunities:\n${signals}` : '',
      emailTrail,
      engagement,
    ].filter(Boolean).join('\n');

    const prompt =
      `You are an expert B2B sales writer composing a SHORT outreach email that ${senderName} will send to ${contact.name}.\n` +
      `EMAIL TYPE — ${cat.label}: ${cat.goal}\n` +
      (engagement ? 'Ground the email concretely in the PAST ENGAGEMENT shown in the context — reference what was actually discussed (specifics, not generic phrases), and build the next step from there.\n' : '') +
      (emailTrail ? 'A PRIOR EMAIL TRAIL with this prospect is in the context — write this as the NEXT message in that thread: briefly acknowledge where things left off, do NOT reintroduce yourself or repeat points already made, and move the conversation toward the next step.\n' : '') +
      (instruction ? `MUST REFLECT (the sender's explicit instruction — follow it closely): ${instruction}\n` : '') +
      (focusProduct ? `PRODUCT FOCUS — this email pitches ONLY "${focusProduct.name}". Do not mention or allude to our other products; tie the hook, value and call-to-action specifically to it.\n` : '') +
      'Write a compelling subject line and a WELL-STRUCTURED, professional plain-text body. Format the body like a real business email:\n' +
      `- A greeting on its OWN line ("Hi ${(contact.name || '').split(/\\s+/)[0] || 'there'},"), then a blank line.\n` +
      '- 2 to 3 SHORT paragraphs (1-2 sentences each), each separated by a BLANK line. One idea per paragraph: (1) the reason for writing / hook, (2) the value or relevance to them, (3) a single clear call to action.\n' +
      `- A sign-off on its own lines: a closing such as "Best," on one line, then "${senderName}" on the next line.\n` +
      'Separate every paragraph with a real blank line (two newlines). Keep it concise (~110 words total). Be specific and credible using the context below; NEVER invent facts, figures, or events the context does not support. Professional and warm — no clichés, no spammy phrasing, no markdown.\n\n' +
      `===CONTEXT===\n${ctxBlock}`;

    const gemini = require('./gemini');
    const MODEL = require('./models').modelFor('content');
    const SCHEMA = {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'A concise, specific subject line (no "Re:" unless continuing a thread).' },
        body: { type: 'string', description: 'The plain-text email body, formatted as a professional email: a greeting on its own line, a blank line, then 2-3 short paragraphs each separated by a blank line, then a sign-off ("Best,\\n<sender name>"). Use real newline characters between paragraphs — never run sentences together.' },
      },
      required: ['subject', 'body'],
    };
    let draft = {};
    try {
      const ai = gemini.getClient();
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.6, maxOutputTokens: 1200, responseMimeType: 'application/json', responseSchema: SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
      });
      draft = JSON.parse(resp.text);
    } catch (e) {
      console.warn('[draft-email] generation failed:', (e && e.message) || e);
      return res.status(502).json({ error: 'could not draft the email right now — try again' });
    }

    // CC the prospect's inbound-parse address so the outbound email (and any
    // reply-all from the prospect) is ingested as prospect intel + engagement log.
    let cc = null, ccCapture = false;
    try {
      const info = await require('./inboundEmail').inboxInfo(req.tenantId, contact.company_id);
      if (info && info.configured && info.address) { cc = info.address; ccCapture = true; }
    } catch { /* capture is best-effort — draft still returns */ }

    res.json({
      ok: true,
      to: contact.email,
      cc,
      ccCapture,
      subject: String(draft.subject || '').trim(),
      body: String(draft.body || '').trim(),
      category: cat.label,
      contactName: contact.name,
    });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const c = await get(req.tenantId, req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ contact: c });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const c = await create(req.tenantId, req.user.sub, req.body || {});
    res.status(201).json({ contact: c });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code || null });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const c = await update(req.tenantId, req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ contact: c });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code || null });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await remove(req.tenantId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = {
  list, get, create, update, remove,
  findOrCreateStub,
  linkContactsToMission, listForMission,
  router,
};
