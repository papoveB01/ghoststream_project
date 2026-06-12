// CRM integrations — connect an external CRM (token auth) and PULL prospects into
// companies + prospect_contacts. The connector dispatch + import pipeline + the
// Express router live here; per-provider API logic lives in sibling files
// (hubspot.js is the live reference connector). Mounted at /crm in index.js.

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const redis = require('../redis');
const secretbox = require('../secretbox');
const companies = require('../companies');
const contacts = require('../contacts');
const registry = require('./registry');
const hubspot = require('./hubspot');
const salesforce = require('./salesforce');
const zoho = require('./zoho');

// provider id → connector module (verify + pullProspects; OAuth ones also expose
// authorizeUrl/exchangeCode/credsFromToken). Missing = not live yet.
const CONNECTORS = { hubspot, salesforce, zoho };
function getConnector(provider) { return CONNECTORS[provider] || null; }
function isOauthProvider(prov) { return !!(prov && prov.authType === 'oauth' && prov.live && CONNECTORS[prov.id]); }

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://dealscope.io';

// OAuth callback URI per provider. The proxy strips the /api prefix, so the
// route is mounted at /crm/:provider/callback (index.js) while the URL tenants
// register in their CRM app — and the redirect_uri we send the provider — is
// the /api-prefixed external one. Override per provider with
// SALESFORCE_REDIRECT_URI / ZOHO_REDIRECT_URI / <PROVIDER>_REDIRECT_URI.
function oauthCallbackUri(provider) {
  const env = process.env[`${provider.toUpperCase()}_REDIRECT_URI`];
  return (env && env.trim()) || `${APP_BASE_URL}/api/crm/${provider}/callback`;
}

// OAuth CSRF state (Redis, short-lived) binding the round-trip to (tenant,
// user, provider) — the cookieless callback authenticates via this, not the
// session, and the provider check stops a code minted for one provider being
// replayed against another's callback.
const OAUTH_STATE_TTL_SEC = 600;
function stateKey(s) { return `crm_oauth_state:${s}`; }
async function makeState(tenantId, userId, provider) {
  const s = crypto.randomBytes(24).toString('base64url');
  await redis.set(stateKey(s), JSON.stringify({ tenantId, userId, provider }), 'EX', OAUTH_STATE_TTL_SEC);
  return s;
}
async function consumeState(s) {
  if (!s) return null;
  const raw = await redis.get(stateKey(s));
  if (raw) await redis.del(stateKey(s));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ──────────────────────────────────────────────────────────── store helpers
async function getConnection(tenantId, provider) {
  const r = await db.query(`SELECT * FROM crm_connections WHERE tenant_id = $1 AND provider = $2`, [tenantId, provider]);
  const row = r.rows[0] || null;
  if (row) row.credentials = decodeCredentials(row.credentials);
  return row;
}

// crm_connections.credentials is jsonb. Encrypted form is { enc: <envelope> };
// legacy plaintext { token, ... } passes through unchanged (re-encrypted on the
// next write). See secretbox.js.
function decodeCredentials(creds) {
  if (creds && typeof creds.enc === 'string') {
    try { return secretbox.openJson(creds.enc); } catch { return {}; }
  }
  return creds || {};
}
function encodeCredentials(creds) { return { enc: secretbox.sealJson(creds) }; }

function maskToken(t) {
  const s = String(t || '');
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// The client-safe view of a connection — NEVER includes the raw token/secret.
// Expects row.credentials already decoded (see GET /providers + getConnection).
function publicConnection(row) {
  if (!row) return null;
  const creds = row.credentials || {};
  return {
    provider: row.provider,
    status: row.status,
    connected: row.status === 'connected',
    // OAuth (BYO app): app creds saved but maybe not yet authorized.
    appConfigured: !!creds.client_id,
    environment: (row.config && row.config.environment) || null,
    region: (row.config && row.config.region) || null,
    instanceUrl: creds.instance_url || creds.api_domain || null,
    lastSyncAt: row.last_sync_at,
    lastSyncSummary: row.last_sync_summary,
    tokenHint: creds.token ? maskToken(creds.token) : null,
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

  // saveCredentials lets a connector persist a refreshed OAuth token mid-import
  // (Salesforce); HubSpot ignores it.
  const saveCredentials = async (updated) => {
    await db.query(
      `UPDATE crm_connections SET credentials = $3, updated_at = now() WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider, encodeCredentials(updated)]
    );
  };
  const payload = await connector.pullProspects(conn.credentials, { limit, saveCredentials });
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
    const byProvider = new Map(conns.rows.map((r) => { r.credentials = decodeCredentials(r.credentials); return [r.provider, r]; }));
    const providers = registry.list().map((p) => ({
      id: p.id, label: p.label, authType: p.authType, tokenLabel: p.tokenLabel,
      tokenHelp: p.tokenHelp, docsUrl: p.docsUrl, live: p.live,
      oauth: p.authType === 'oauth',
      fields: p.fields || null,
      environments: !!p.environments,
      callbackUri: p.authType === 'oauth' ? oauthCallbackUri(p.id)
                 : (p.callbackPath ? `${APP_BASE_URL}${p.callbackPath}` : null),
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
    if (prov.authType === 'oauth') {
      return res.status(400).json({ error: `${prov.label} connects via the guided OAuth flow — use its Save & Connect card.` });
    }
    if (!token) return res.status(400).json({ error: `${prov.tokenLabel} required` });
    const connector = getConnector(provider);
    if (!connector) {
      return res.status(501).json({ error: `the ${prov.label} connector is coming soon.` });
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
      [req.tenantId, provider, encodeCredentials({ token })]
    );
    res.status(201).json({ connection: publicConnection(await getConnection(req.tenantId, provider)) });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────── provider OAuth (BYO app)
// One generic surface for every OAuth CRM (Salesforce, Zoho, …): the tenant
// saves THEIR app's credentials, then we run the redirect handshake. Adding a
// provider = a connector module + a registry entry; no new routes.

// The credential-flash redirect target: lands the user back on the
// Integrations page with a per-provider banner.
function flashRedirect(res, provider, ok, message) {
  const k = ok ? 'crm_ok' : 'crm_error';
  return res.redirect(`/admin/?crm=${encodeURIComponent(provider)}&${k}=${encodeURIComponent(message)}#integrations`);
}

// POST /crm/:provider/app { clientId, clientSecret, environment?, region? } —
// save the tenant's app credentials (status → pending). Blank clientId/
// clientSecret on a re-save keeps the stored ones.
router.post('/:provider/app', async (req, res, next) => {
  try {
    const provider = String(req.params.provider || '').trim();
    const prov = registry.get(provider);
    if (!isOauthProvider(prov)) return res.status(400).json({ error: 'unknown OAuth CRM provider' });

    const existing = await getConnection(req.tenantId, provider);
    const prev = (existing && existing.credentials) || {};
    const inId = String((req.body && req.body.clientId) || '').trim();
    const inSecret = String((req.body && req.body.clientSecret) || '').trim();

    const clientId = inId || prev.client_id || null;
    const clientSecret = inSecret || prev.client_secret || null;
    if (!clientId || !clientSecret) {
      const labels = (prov.fields || []).filter((f) => f.type !== 'select').map((f) => f.label).join(' and ') || 'Client ID and Client Secret';
      return res.status(400).json({ error: `${labels} are required` });
    }

    // Provider knobs, validated against the registry: environment (Salesforce
    // Production/Sandbox) and region (Zoho data center).
    const config = {};
    if (prov.environments) {
      config.environment = (req.body && req.body.environment) === 'sandbox' ? 'sandbox' : 'production';
    }
    const regionField = (prov.fields || []).find((f) => f.key === 'region');
    if (regionField) {
      const region = String((req.body && req.body.region) || '').trim();
      const valid = (regionField.options || []).some((o) => o.value === region);
      config.region = valid ? region : ((existing && existing.config && existing.config.region) || regionField.options[0].value);
    }

    // If the app identity changed, drop any tokens minted for the old app.
    const sameApp = prev.client_id === clientId;
    const creds = sameApp
      ? { ...prev, client_id: clientId, client_secret: clientSecret }
      : { client_id: clientId, client_secret: clientSecret };
    // Connectors that are region-bound need it inside creds too (token refresh
    // happens deep in the connector, where only creds travel).
    if (config.region) creds.region = config.region;

    await db.query(
      `INSERT INTO crm_connections (tenant_id, provider, status, credentials, config)
            VALUES ($1, $2, 'pending', $3, $4)
       ON CONFLICT (tenant_id, provider)
       DO UPDATE SET credentials = EXCLUDED.credentials, config = EXCLUDED.config, status = 'pending', updated_at = now()`,
      [req.tenantId, provider, encodeCredentials(creds), config]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// GET /crm/:provider/connect — start the OAuth handshake using the tenant's
// stored app credentials. Redirects the browser to the provider.
router.get('/:provider/connect', async (req, res, next) => {
  try {
    const provider = String(req.params.provider || '').trim();
    const prov = registry.get(provider);
    if (!isOauthProvider(prov)) return res.status(400).json({ error: 'unknown OAuth CRM provider' });

    const conn = await getConnection(req.tenantId, provider);
    if (!conn || !conn.credentials.client_id) {
      return flashRedirect(res, provider, false, 'Save your app credentials first.');
    }
    const state = await makeState(req.tenantId, req.user.sub, provider);
    res.redirect(CONNECTORS[provider].authorizeUrl({
      clientId: conn.credentials.client_id,
      redirectUri: oauthCallbackUri(provider),
      state,
      environment: (conn.config && conn.config.environment) || 'production',
      region: (conn.config && conn.config.region) || (conn.credentials && conn.credentials.region) || null,
    }));
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

// GET /crm/:provider/callback — the CRM redirects the browser here after the
// user authorizes. Cookieless, so it's mounted top-level in index.js BEFORE the
// authMiddleware'd /crm router; identity comes from the Redis `state`. Exchanges
// the code for tokens (instance_url / api_domain captured by the connector's
// credsFromToken), verifies the grant, and marks the connection connected.
async function handleOAuthCallback(req, res) {
  const provider = String((req.params && req.params.provider) || '').trim();
  const fail = (msg) => flashRedirect(res, provider || 'crm', false, msg);
  try {
    const prov = registry.get(provider);
    if (!isOauthProvider(prov)) return fail('unknown OAuth CRM provider');
    const connector = CONNECTORS[provider];

    const { code, state, error, error_description: errDesc } = req.query || {};
    if (error) return fail(errDesc || error);
    if (!code) return fail('no authorization code returned');

    const st = await consumeState(state);
    if (!st) return fail('the connect link expired — try connecting again');
    if (st.provider !== provider) return fail('the connect link does not match this provider — try connecting again');

    const conn = await getConnection(st.tenantId, provider);
    if (!conn || !conn.credentials.client_id) return fail(`${prov.label} app credentials are missing — re-enter them`);

    const tok = await connector.exchangeCode({
      clientId: conn.credentials.client_id,
      clientSecret: conn.credentials.client_secret,
      code,
      redirectUri: oauthCallbackUri(provider),
      environment: (conn.config && conn.config.environment) || 'production',
      region: (conn.config && conn.config.region) || (conn.credentials && conn.credentials.region) || null,
    });

    const creds = connector.credsFromToken(tok, conn.credentials);
    await connector.verify(creds); // sanity-check the grant before storing

    await db.query(
      `UPDATE crm_connections SET credentials = $3, status = 'connected', updated_at = now()
        WHERE tenant_id = $1 AND provider = $2`,
      [st.tenantId, provider, encodeCredentials(creds)]
    );
    return flashRedirect(res, provider, true, 'connected');
  } catch (err) {
    console.error(`[crm-oauth-callback:${provider}]`, err.stack || err.message);
    return fail(err.message || 'connect failed');
  }
}

module.exports = { router, importProspects, getConnector, getConnection, registry, handleOAuthCallback };
