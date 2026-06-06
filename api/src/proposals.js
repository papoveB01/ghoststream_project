// Proposal Engine (Phase 1) — intelligence-driven proposal RECOMMENDATIONS.
//
// Per-prospect synthesis: consolidates OUR profile (strengths/positioning),
// the PROSPECT's intel (research opportunities + filed intel), COMPETITOR intel,
// and ENGAGEMENT touchpoints (completed calls), then has Gemini formulate an
// outcome-based recommendation — what to propose, how to position, what to
// preempt — grounded in numbered evidence [n] with per-section confidence.
//
// This is market-intelligence + SUGGESTION, NOT a CRM: no pricing, no deal
// stages, no win/loss. Output is a versioned recommendation the rep decides on.
// See docs/design/proposal-engine.md.

const express = require('express');
const db = require('./db');
const gemini = require('./gemini');
const store = require('./store');
const keypoints = require('./knowledge/keypoints');
const service = require('./knowledge/service');
const exportDocx = require('./exportDocx');

const MODEL = require('./models').modelFor('proposal');
const EVIDENCE_TEXT_CAP = parseInt(process.env.PROPOSAL_EVIDENCE_TEXT_CAP || '1800', 10);
const MAX_CALLS         = parseInt(process.env.PROPOSAL_MAX_CALLS || '8', 10);
const MAX_PROSPECT_DOCS = parseInt(process.env.PROPOSAL_MAX_PROSPECT_DOCS || '8', 10);
const MAX_COMPETITOR_DOCS = parseInt(process.env.PROPOSAL_MAX_COMPETITOR_DOCS || '6', 10);

// ── Retry on transient Gemini errors (same policy as knowledge/research.js) ──
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      const is429 = /\b429\b|RESOURCE_EXHAUSTED/i.test(msg);
      const isDailyQuota = /per[_\s-]?day|PerDay|free_tier_requests/i.test(msg);
      const transient = /\b(503|UNAVAILABLE|overloaded)\b|high demand|deadline[ _]?exceeded/i.test(msg) || (is429 && !isDailyQuota);
      if (!transient || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ── Evidence gathering — the 4 intelligence layers, as a numbered list ──────
// Returns { profileText, evidence: [{n,type,label,text}], byLayer }.
// Everything is best-effort: a failing layer is skipped, never fatal.
async function gatherEvidence(tenantId, companyId) {
  const evidence = [];
  const byLayer = { PROSPECT_RESEARCH: 0, PROSPECT_INTEL: 0, COMPETITOR: 0, ENGAGEMENT: 0 };
  let n = 0;
  const add = (type, label, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    evidence.push({ n: ++n, type, label, text: t.slice(0, EVIDENCE_TEXT_CAP) });
    if (byLayer[type] != null) byLayer[type]++;
  };

  // OUR profile (strengths / positioning / portfolio) — not numbered; it's "us".
  let profileText = '';
  try { profileText = (await keypoints.tenantContextText(tenantId)) || ''; } catch { /* none on file */ }

  // THEM — latest research synthesis (summary + opportunities).
  try {
    const r = await db.query(
      `SELECT summary, opportunities FROM prospect_research
        WHERE tenant_id = $1 AND company_id = $2 AND status = 'DONE'
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, companyId]
    );
    const row = r.rows[0];
    if (row) {
      if (row.summary) add('PROSPECT_RESEARCH', 'Research summary', row.summary);
      for (const o of (Array.isArray(row.opportunities) ? row.opportunities : []).slice(0, 8)) {
        const txt = [o.title, o.analysis, (o.products && o.products.length) ? `Fit: ${o.products.join(', ')}` : null,
                     o.strength ? `Strength: ${o.strength}` : null].filter(Boolean).join('\n');
        add('PROSPECT_RESEARCH', `Opportunity — ${o.title || 'untitled'}`, txt);
      }
    }
  } catch (e) { console.warn('[proposals] research evidence failed:', e.message); }

  // THEM — filed prospect intel (KB docs, excluding research-synthesis docs).
  try {
    const docs = await service.listDocuments({ tenantId, scope: 'PROSPECT', companyId, status: 'READY', limit: MAX_PROSPECT_DOCS });
    for (const d of (docs || []).filter((x) => !((x.metadata || {}).isResearchSynthesis))) {
      try {
        const t = await service.getDocumentText(tenantId, d.id);
        const text = t && (typeof t === 'string' ? t : t.text);
        add('PROSPECT_INTEL', `Filed intel — ${d.title}`, text);
      } catch { /* skip a bad doc */ }
    }
  } catch (e) { console.warn('[proposals] prospect intel failed:', e.message); }

  // THE FIELD — competitor intel / battlecards (tenant-level).
  try {
    const docs = await service.listDocuments({ tenantId, scope: 'COMPETITOR', status: 'READY', limit: MAX_COMPETITOR_DOCS });
    for (const d of (docs || [])) {
      try {
        const t = await service.getDocumentText(tenantId, d.id);
        const text = t && (typeof t === 'string' ? t : t.text);
        add('COMPETITOR', `Competitor intel — ${d.title}`, text);
      } catch { /* skip */ }
    }
  } catch (e) { console.warn('[proposals] competitor intel failed:', e.message); }

  // THE ENGAGEMENT — completed calls (moments live on the Redis portal).
  try {
    const m = await db.query(
      `SELECT portal_id, scheduled_at FROM scheduled_meetings
        WHERE tenant_id = $1 AND company_id = $2 AND portal_id IS NOT NULL
        ORDER BY scheduled_at DESC NULLS LAST LIMIT $3`,
      [tenantId, companyId, MAX_CALLS]
    );
    for (const row of m.rows) {
      const p = await store.getPortal(row.portal_id).catch(() => null);
      const mo = p && p.moments;
      if (!mo) continue;
      const parts = [];
      if (mo.summary) parts.push(`Summary: ${mo.summary}`);
      if (mo.agreement && mo.agreement.quote) parts.push(`They agreed: "${mo.agreement.quote}"${mo.agreement.commitment ? ` (commitment: ${mo.agreement.commitment})` : ''}`);
      if (mo.objection && mo.objection.quote) parts.push(`Objection raised: "${mo.objection.quote}"`);
      if (Array.isArray(mo.nextSteps) && mo.nextSteps.length) parts.push(`Next steps: ${mo.nextSteps.join('; ')}`);
      add('ENGAGEMENT', `Call — ${p.title || row.portal_id}`, parts.join('\n'));
    }
  } catch (e) { console.warn('[proposals] engagement evidence failed:', e.message); }

  return { profileText, evidence, byLayer };
}

// ── Synthesis schema ────────────────────────────────────────────────────────
const section = (desc) => ({
  type: 'object',
  properties: {
    text: { type: 'string', description: desc },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = well grounded in evidence; low = mostly inference.' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Claims made WITHOUT supporting evidence (thin intel). Empty when fully grounded.' },
    citations: { type: 'array', items: { type: 'integer' }, description: 'Evidence numbers [n] this section is grounded in.' },
  },
  required: ['text', 'confidence'],
});

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    headline:     section('The core recommended proposal angle, 1-2 sentences.'),
    situation:    section("The prospect's situation — pain, goals, triggers. Only what the evidence supports."),
    positioning:  section('How to position US given their inclinations and our strengths.'),
    outcomes:     section('The specific outcomes / metrics to emphasize to this prospect.'),
    edge:         section('Our differentiation vs the alternatives, relevant to THIS prospect.'),
    proof:        section('Proof points to cite (case studies, results) — only if evidence exists.'),
    objections: {
      type: 'array',
      description: 'Likely objections and how to preempt each. Empty if none are evidenced.',
      items: {
        type: 'object',
        properties: {
          objection: { type: 'string' },
          response:  { type: 'string' },
          citations: { type: 'array', items: { type: 'integer' } },
        },
        required: ['objection', 'response'],
      },
    },
    nextMove:         section('The recommended next move to advance the engagement.'),
    intelligenceGaps: { type: 'array', items: { type: 'string' }, description: 'What missing intel would most strengthen this recommendation.' },
  },
  required: ['headline', 'situation', 'positioning', 'outcomes', 'edge', 'objections', 'nextMove'],
};

const SYNTHESIS_PROMPT =
  'You are a sales strategist producing an INTERNAL proposal RECOMMENDATION for a rep — not a contract, not a quote. ' +
  'Consolidate OUR company profile, then the numbered EVIDENCE [n] about a PROSPECT (their research-derived opportunities, filed intel, our competitor intel, and what they said on calls), into an outcome-based recommendation: what to propose, how to position us, which outcomes to emphasize, and which objections to preempt. ' +
  'RULES: (1) Ground every claim in the evidence and cite the relevant [n] numbers. (2) Where evidence is thin, still give your best recommendation but list those claims under `assumptions` and set that section\'s `confidence` to "low" — NEVER invent facts, signals, or figures. (3) NO pricing, NO contract terms, NO deal-stage language — this is intelligence + suggestion only. (4) Be concrete and specific to THIS prospect; no generic sales filler. (5) Map positioning to products/strengths that actually appear in OUR profile. ' +
  '(6) COMPLETELY IGNORE website boilerplate in the evidence — cookie/consent banners, "we use cookies", "we value/take your privacy", privacy-policy and terms-of-use text, navigation, footers, copyright lines. None of that is a signal: never cite it, quote it, or build a point on it.';

async function synthesize(companyName, profileText, evidence) {
  const ai = gemini.getClient();
  const evidenceBlock = evidence.length
    ? evidence.map((e) => `[${e.n}] (${e.type}) ${e.label}\n${e.text}`).join('\n\n')
    : '(no prospect/competitor/engagement evidence on file — base the recommendation on our profile and flag the gap)';
  const prompt =
    `${SYNTHESIS_PROMPT}\n\n` +
    (profileText ? `===OUR COMPANY (profile, strengths, positioning, portfolio)===\n${profileText}\n\n`
                 : '===OUR COMPANY===\n(No company profile on file — note this as a gap and keep positioning generic.)\n\n') +
    `===PROSPECT===\n${companyName}\n\n` +
    `===EVIDENCE (numbered; cite by [n])===\n${evidenceBlock}`;
  const resp = await withRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.4, maxOutputTokens: 3000, responseMimeType: 'application/json', responseSchema: PROPOSAL_SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
  }));
  const content = JSON.parse(resp.text);
  return { content, usage: resp.usageMetadata || null };
}

// Coverage/confidence = average of the section confidences (high/med/low →
// 100/60/25), plus a per-layer evidence tally and the model's stated gaps.
function computeCoverage(content, byLayer) {
  const weight = { high: 100, medium: 60, low: 25 };
  const keys = ['headline', 'situation', 'positioning', 'outcomes', 'edge', 'proof', 'nextMove'];
  const scores = keys.map((k) => weight[content[k] && content[k].confidence] ?? 25);
  const score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return { score, byLayer, gaps: Array.isArray(content.intelligenceGaps) ? content.intelligenceGaps : [] };
}

// ── Tenant recommendation mode ──────────────────────────────────────────────
const PROPOSAL_MODES = ['DRAFT_WITH_ASSUMPTIONS', 'BLOCK'];
async function getMode(tenantId) {
  const r = await db.query(`SELECT proposal_mode FROM tenants WHERE id = $1`, [tenantId]);
  const m = r.rows[0] && r.rows[0].proposal_mode;
  return PROPOSAL_MODES.includes(m) ? m : 'DRAFT_WITH_ASSUMPTIONS';
}
async function setMode(tenantId, mode) {
  if (!PROPOSAL_MODES.includes(mode)) { const e = new Error('mode must be DRAFT_WITH_ASSUMPTIONS or BLOCK'); e.status = 400; throw e; }
  await db.query(`UPDATE tenants SET proposal_mode = $2 WHERE id = $1`, [tenantId, mode]);
  return mode;
}

// ── Public ops ──────────────────────────────────────────────────────────────
async function generate(tenantId, companyId, userId) {
  const c = await db.query(`SELECT id, name FROM companies WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
  if (!c.rows[0]) { const e = new Error('prospect not found'); e.status = 404; throw e; }

  const { profileText, evidence, byLayer } = await gatherEvidence(tenantId, companyId);
  if (!evidence.length && !profileText) {
    const e = new Error('no intelligence on file for this prospect yet — run research or log a call first');
    e.status = 422; throw e;
  }

  // BLOCK mode: require prospect-specific intelligence before generating, rather
  // than building a recommendation from our profile + generic intel alone.
  const mode = await getMode(tenantId);
  if (mode === 'BLOCK') {
    const prospectSignal = (byLayer.PROSPECT_RESEARCH || 0) + (byLayer.PROSPECT_INTEL || 0) + (byLayer.ENGAGEMENT || 0);
    if (prospectSignal === 0) {
      const e = new Error('Not enough prospect-specific intelligence yet — run research, file intel, or forward a call/email first. (Your workspace requires this before generating; change it in Settings → Recommendations.)');
      e.status = 422; throw e;
    }
  }

  const { content, usage } = await synthesize(c.rows[0].name, profileText, evidence);
  const coverage = computeCoverage(content, byLayer);

  const ins = await db.query(
    `INSERT INTO proposals (tenant_id, company_id, version, status, content_json, coverage_json, citations_json, models, created_by)
     VALUES ($1, $2, (SELECT COALESCE(MAX(version), 0) + 1 FROM proposals WHERE company_id = $2 AND tenant_id = $1),
             'DRAFT', $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, companyId, JSON.stringify(content), JSON.stringify(coverage), JSON.stringify(evidence),
     JSON.stringify({ model: MODEL, usage }), userId || null]
  );
  return ins.rows[0];
}

async function listForCompany(tenantId, companyId) {
  const r = await db.query(
    `SELECT id, version, status, coverage_json, created_by, created_at, updated_at
       FROM proposals WHERE tenant_id = $1 AND company_id = $2 ORDER BY version DESC`,
    [tenantId, companyId]
  );
  return r.rows;
}

async function getVersion(tenantId, id) {
  const r = await db.query(`SELECT * FROM proposals WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] || null;
}

async function updateVersion(tenantId, id, { status, content }) {
  const sets = [];
  const params = [id, tenantId];
  if (status && ['DRAFT', 'FINAL'].includes(status)) { params.push(status); sets.push(`status = $${params.length}`); }
  if (content && typeof content === 'object') { params.push(JSON.stringify(content)); sets.push(`content_json = $${params.length}`); }
  if (!sets.length) { const e = new Error('nothing to update (status or content required)'); e.status = 400; throw e; }
  sets.push('updated_at = now()');
  const r = await db.query(`UPDATE proposals SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`, params);
  if (!r.rows[0]) { const e = new Error('proposal version not found'); e.status = 404; throw e; }
  return r.rows[0];
}

// ── Export: a tenant-branded Word .docx of the recommendation (Phase 3) ────
function proposalMarkdown(prop) {
  const c = prop.content_json || {};
  const cov = prop.coverage_json || {};
  const ev = Array.isArray(prop.citations_json) ? prop.citations_json : [];
  const L = [];
  const sec = (label, s) => { if (s && s.text) { L.push(`## ${label}`, s.text); if (s.confidence) L.push(`**Confidence:** ${s.confidence}`); L.push(''); } };
  sec('Their situation', c.situation);
  sec('Recommended positioning', c.positioning);
  sec('Outcomes to emphasize', c.outcomes);
  sec('Our edge vs. alternatives', c.edge);
  sec('Proof points', c.proof);
  const objections = Array.isArray(c.objections) ? c.objections : [];
  if (objections.length) {
    L.push('## Objections to preempt');
    objections.forEach((o) => { L.push(`**${o.objection || ''}**`, o.response || '', ''); });
  }
  sec('Recommended next move', c.nextMove);
  const gaps = Array.isArray(cov.gaps) ? cov.gaps : [];
  if (gaps.length) { L.push('## Intelligence gaps'); gaps.forEach((g) => L.push(`- ${g}`)); L.push(''); }
  if (ev.length) { L.push('## Evidence basis'); ev.forEach((e) => L.push(`- [${e.n}] ${e.label} (${e.type})`)); }
  return L.join('\n');
}

// Build the recommendation as a rich, tenant-branded .docx → { buffer, filename }.
async function exportDocxFile(tenantId, id) {
  const r = await db.query(
    `SELECT p.*, c.name AS prospect_name, t.name AS tenant_name
       FROM proposals p
       JOIN companies c ON c.id = p.company_id
       JOIN tenants   t ON t.id = p.tenant_id
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [id, tenantId]
  );
  const row = r.rows[0];
  if (!row) { const e = new Error('proposal version not found'); e.status = 404; throw e; }
  const c = row.content_json || {};
  const cov = row.coverage_json || {};
  const date = new Date(row.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const coverage = cov.score != null ? ` · intelligence coverage ${cov.score}%` : '';
  const buffer = await exportDocx.markdownToDocxBuffer(proposalMarkdown(row), {
    title: (c.headline && c.headline.text) || 'Sales Recommendation',
    subtitle: `Prepared for ${row.prospect_name} · ${date} · v${row.version}${coverage}`,
    brand: row.tenant_name || 'DealScope',
    docType: 'Sales Recommendation · Internal',
    footerNote: 'Generated by DealScope — review before acting.',
  });
  const slug = String(row.prospect_name || 'prospect').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return { buffer, filename: `recommendation-${slug}-v${row.version}.docx` };
}

// ── Router (mounted at /api/proposals behind authMiddleware) ────────────────
const router = express.Router();
router.use(express.json());

// GET /proposals/version/:id/export — tenant-branded Word .docx of the recommendation.
router.get('/version/:id/export', async (req, res, next) => {
  try {
    const { buffer, filename } = await exportDocxFile(req.tenantId, req.params.id);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

// POST /proposals/:companyId/generate — synthesize a new recommendation version.
router.post('/:companyId/generate', async (req, res, next) => {
  try { res.json(await generate(req.tenantId, req.params.companyId, req.user && req.user.sub)); }
  catch (err) { next(err); }
});

// GET /proposals/version/:id — one full version (declared before /:companyId).
router.get('/version/:id', async (req, res, next) => {
  try {
    const row = await getVersion(req.tenantId, req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// PATCH /proposals/version/:id — DRAFT→FINAL and/or rep edits to content.
router.patch('/version/:id', async (req, res, next) => {
  try { res.json(await updateVersion(req.tenantId, req.params.id, { status: req.body.status, content: req.body.content })); }
  catch (err) { next(err); }
});

// GET /proposals/:companyId/inbox — the per-prospect forward address (Phase 2).
router.get('/:companyId/inbox', async (req, res, next) => {
  try { res.json(await require('./inboundEmail').inboxInfo(req.tenantId, req.params.companyId)); }
  catch (err) { next(err); }
});

// GET /proposals/:companyId — version list (latest first) for a prospect.
router.get('/:companyId', async (req, res, next) => {
  try { res.json({ versions: await listForCompany(req.tenantId, req.params.companyId) }); }
  catch (err) { next(err); }
});

module.exports = { router, generate, gatherEvidence, listForCompany, getVersion, updateVersion, exportDocxFile, getMode, setMode, PROPOSAL_MODES };
