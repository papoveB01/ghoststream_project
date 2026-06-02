// CRM integrations — connect an external CRM (token auth) and PULL prospects into
// companies + prospect_contacts. The connector dispatch + import pipeline + the
// Express router live here; per-provider API logic lives in sibling files
// (hubspot.js is the live reference connector). Mounted at /crm in index.js.

const express = require('express');
const db = require('../db');
const companies = require('../companies');
const contacts = require('../contacts');
const registry = require('./registry');
const hubspot = require('./hubspot');

// provider id → connector module (verify + pullProspects). Missing = not live yet.
const CONNECTORS = { hubspot };
function getConnector(provider) { return CONNECTORS[provider] || null; }

// ──────────────────────────────────────────────────────────── store helpers
async function getConnection(tenantId, provider) {
  const r = await db.query(`SELECT * FROM crm_connections WHERE tenant_id = $1 AND provider = $2`, [tenantId, provider]);
  return r.rows[0] || null;
}

function maskToken(t) {
  const s = String(t || '');
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// The client-safe view of a connection — NEVER includes the raw token.
function publicConnection(row) {
  if (!row) return null;
  return {
    provider: row.provider,
    status: row.status,
    connected: true,
    lastSyncAt: row.last_sync_at,
    lastSyncSummary: row.last_sync_summary,
    tokenHint: row.credentials && row.credentials.token ? maskToken(row.credentials.token) : null,
  };
}

// ──────────────────────────────────────────────────── email/domain helpers
function domainOf(email) {
  const m = String(email || '').toLowerCase().match(/@([^@\s]+)$/);
  return m ? m[1] : null;
}
function companyNameFromDomain(domain) {
  if (!domain) return null;
  const base = String(domain).replace(/^www\./, '').split('.')[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
}

// ─────────────────────────────────────────────────────────── import pipeline
// Resolve (or create) a company by name; first-write-wins on domain. Cached per
// import so repeated company refs don't re-hit the DB.
async function resolveCompany(tenantId, name, domain, cache) {
  const key = `${String(name || '').toLowerCase()}|${domain || ''}`;
  if (cache.has(key)) return cache.get(key);
  let created = false;
  const existing = await db.query(
    `SELECT id FROM companies WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [tenantId, name]
  );
  let id;
  if (existing.rows[0]) {
    id = existing.rows[0].id;
  } else {
    const row = await companies.findOrCreate(tenantId, { name, domain });
    id = row.id; created = true;
  }
  const res = { id, created };
  cache.set(key, res);
  return res;
}

// Pull prospects from the connected CRM and upsert into companies + contacts.
async function importProspects(tenantId, userId, provider, { limit = 200 } = {}) {
  const connector = getConnector(provider);
  if (!connector) { const e = new Error(`the ${provider} connector is coming soon`); e.status = 501; throw e; }
  const conn = await getConnection(tenantId, provider);
  if (!conn) { const e = new Error('this CRM is not connected'); e.status = 400; throw e; }

  const payload = await connector.pullProspects(conn.credentials, { limit });
  const summary = { companiesCreated: 0, companiesExisting: 0, contactsCreated: 0, contactsExisting: 0, skipped: 0 };
  const cache = new Map();

  // Companies first so contact→company association maps cleanly.
  for (const c of (payload.companies || [])) {
    if (!c.name) { summary.skipped++; continue; }
    try {
      const r = await resolveCompany(tenantId, c.name, c.domain, cache);
      if (r.created) summary.companiesCreated++; else summary.companiesExisting++;
    } catch { summary.skipped++; }
  }

  for (const ct of (payload.contacts || [])) {
    if (!ct.email) { summary.skipped++; continue; }
    // Resolve company: explicit association, else derive from the email domain.
    let companyName = ct.companyName, companyDomain = ct.companyDomain;
    if (!companyName) { const d = domainOf(ct.email); companyName = companyNameFromDomain(d); companyDomain = d; }
    if (!companyName) { summary.skipped++; continue; }
    let companyId;
    try { companyId = (await resolveCompany(tenantId, companyName, companyDomain, cache)).id; }
    catch { summary.skipped++; continue; }
    try {
      await contacts.create(tenantId, userId, {
        companyId, name: ct.name || ct.email, email: ct.email,
        role: ct.role || null, title: ct.title || null,
      });
      summary.contactsCreated++;
    } catch (err) {
      if (err && (err.code === 'EMAIL_TAKEN' || err.status === 409)) summary.contactsExisting++;
      else summary.skipped++;
    }
  }

  await db.query(
    `UPDATE crm_connections SET last_sync_at = now(), last_sync_summary = $3, status = 'connected', updated_at = now()
      WHERE tenant_id = $1 AND provider = $2`,
    [tenantId, provider, summary]
  );
  return summary;
}

// ───────────────────────────────────────────────────────────────── router
const router = express.Router();
router.use(express.json());

// GET /crm/providers → the registry + this tenant's connection status per provider.
router.get('/providers', async (req, res, next) => {
  try {
    const conns = await db.query(`SELECT * FROM crm_connections WHERE tenant_id = $1`, [req.tenantId]);
    const byProvider = new Map(conns.rows.map((r) => [r.provider, r]));
    const providers = registry.list().map((p) => ({
      id: p.id, label: p.label, authType: p.authType, tokenLabel: p.tokenLabel,
      tokenHelp: p.tokenHelp, docsUrl: p.docsUrl, live: p.live,
      connection: publicConnection(byProvider.get(p.id) || null),
    }));
    res.json({ providers });
  } catch (err) { next(err); }
});

// POST /crm/connections { provider, token } → verify creds, then upsert.
router.post('/connections', async (req, res, next) => {
  try {
    const provider = String((req.body && req.body.provider) || '').trim();
    const token = String((req.body && req.body.token) || '').trim();
    const prov = registry.get(provider);
    if (!prov) return res.status(400).json({ error: 'unknown CRM provider' });
    if (!token) return res.status(400).json({ error: `${prov.tokenLabel} required` });
    const connector = getConnector(provider);
    if (!connector) {
      return res.status(501).json({ error: `the ${prov.label} connector is coming soon — only HubSpot is live today.` });
    }
    try {
      await connector.verify({ token });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'could not authenticate with the CRM' });
    }
    await db.query(
      `INSERT INTO crm_connections (tenant_id, provider, status, credentials)
            VALUES ($1, $2, 'connected', $3)
       ON CONFLICT (tenant_id, provider)
       DO UPDATE SET credentials = EXCLUDED.credentials, status = 'connected', updated_at = now()`,
      [req.tenantId, provider, { token }]
    );
    res.status(201).json({ connection: publicConnection(await getConnection(req.tenantId, provider)) });
  } catch (err) { next(err); }
});

// DELETE /crm/connections/:provider
router.delete('/connections/:provider', async (req, res, next) => {
  try {
    await db.query(`DELETE FROM crm_connections WHERE tenant_id = $1 AND provider = $2`, [req.tenantId, req.params.provider]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /crm/connections/:provider/import { limit? } → pull prospects.
router.post('/connections/:provider/import', async (req, res, next) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt((req.body && req.body.limit) || '200', 10) || 200));
    const summary = await importProspects(req.tenantId, req.user.sub, req.params.provider, { limit });
    res.json({ ok: true, summary });
  } catch (err) {
    if (err.status === 501) return res.status(501).json({ error: err.message });
    if (err.status === 400 || err.status === 401) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = { router, importProspects, getConnector, getConnection, registry };
