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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Best-effort: find a personas row whose name matches the given role text
// (case-insensitive). Returns the persona_id or null.
async function inferPersonaIdForRole(role) {
  const r = String(role || '').trim();
  if (!r) return null;
  const res = await db.query(
    `SELECT id FROM personas WHERE lower(name) = lower($1) LIMIT 1`,
    [r]
  );
  return res.rows[0] ? res.rows[0].id : null;
}

// ── Selects ──────────────────────────────────────────────────────────────

const SELECT_COLUMNS = `
  pc.id, pc.company_id, pc.name, pc.email, pc.role, pc.persona_id,
  pc.title, pc.notes, pc.created_by, pc.created_at, pc.updated_at,
  c.name AS company_name,
  c.domain AS company_domain,
  p.name AS persona_name
`;
const FROM_JOIN = `
  FROM prospect_contacts pc
  LEFT JOIN companies c ON c.id = pc.company_id
  LEFT JOIN personas  p ON p.id = pc.persona_id
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

async function create(tenantId, userId, { companyId, name, email, role, personaId, title, notes }) {
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
  const finalPersonaId = personaId !== undefined ? (personaId || null) : await inferPersonaIdForRole(finalRole);
  try {
    const r = await db.query(
      `INSERT INTO prospect_contacts
         (tenant_id, company_id, name, email, role, persona_id, title, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [tenantId, companyId, finalName, String(email).trim(), finalRole, finalPersonaId, finalTitle, notes || null, userId || null]
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

async function update(tenantId, id, { name, email, role, personaId, title, notes }) {
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
    nextPersonaId = await inferPersonaIdForRole(next.role);
  }
  try {
    await db.query(
      `UPDATE prospect_contacts
          SET name=$3, email=$4, role=$5, persona_id=$6, title=$7, notes=$8, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, next.name, next.email, next.role, nextPersonaId, next.title, next.notes]
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
