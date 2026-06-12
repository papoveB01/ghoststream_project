// Salesforce connector (OAuth, BYO Connected App). Unlike HubSpot's static
// private-app token, Salesforce uses OAuth 2.0 authorization-code: each TENANT
// registers their own Connected App in their org and pastes its Consumer Key +
// Secret into DealScope. We run the redirect handshake (see crm/index.js) and
// store the resulting { access_token, refresh_token, instance_url } alongside
// the app creds in crm_connections.credentials (encrypted).
//
//   authorizeUrl({clientId,redirectUri,state,environment})  → string
//   exchangeCode({clientId,clientSecret,code,redirectUri,environment}) → token set
//   verify(creds)              → throws on a dead session, else true
//   pullProspects(creds, opts) → { companies:[{name,domain}], contacts:[...] }
//
// Access tokens expire in hours, so every API call refreshes-on-401 and persists
// the fresh token via opts.saveCredentials (a callback the router supplies).

const API_VERSION = 'v60.0';

// Production orgs authenticate at login.salesforce.com; sandboxes at
// test.salesforce.com. (Token refresh later uses the org's own instance_url.)
function loginBase(environment) {
  return environment === 'sandbox'
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';
}

// `api` = REST/SOQL access; `refresh_token` (a.k.a. offline_access) = a refresh
// token so the connection survives access-token expiry without re-consenting.
const SCOPES = 'api refresh_token';

function authorizeUrl({ clientId, redirectUri, state, environment }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });
  return `${loginBase(environment)}/services/oauth2/authorize?${params.toString()}`;
}

async function tokenRequest(base, form) {
  const r = await fetch(`${base}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Salesforce token request failed (${r.status}): ${j.error_description || j.error || JSON.stringify(j).slice(0, 200)}`);
    e.status = r.status === 400 || r.status === 401 ? 401 : 502;
    throw e;
  }
  return j; // { access_token, refresh_token, instance_url, id, issued_at, signature, ... }
}

function exchangeCode({ clientId, clientSecret, code, redirectUri, environment }) {
  return tokenRequest(loginBase(environment), {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
}

// Refresh against the org's instance_url (valid for the token endpoint too).
// Salesforce does NOT return a new refresh_token, so we keep the existing one.
async function refresh(creds) {
  if (!creds.refresh_token) {
    const e = new Error('Salesforce session expired and no refresh token is stored — reconnect Salesforce.');
    e.status = 401; throw e;
  }
  const base = creds.instance_url || loginBase();
  const j = await tokenRequest(base, {
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  });
  return {
    ...creds,
    access_token: j.access_token,
    instance_url: j.instance_url || creds.instance_url,
    issued_at: j.issued_at || creds.issued_at || null,
  };
}

// Merge a fresh token set into the stored credentials. Salesforce does not
// re-issue the refresh_token on later handshakes, so keep the existing one.
function credsFromToken(tok, prev = {}) {
  return {
    ...prev,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || prev.refresh_token || null,
    instance_url: tok.instance_url || prev.instance_url || null,
    issued_at: tok.issued_at || null,
  };
}

// ─────────────────────────────────────────────────────── SOQL query runner
// Runs a SOQL query, following nextRecordsUrl pagination, and transparently
// refreshes the access token once on a 401. `state` is a mutable holder so a
// refresh mid-pagination (and the persisted creds) propagate to later pages.
async function sfQuery(state, soql, { saveCredentials } = {}) {
  const records = [];
  let url = `${state.creds.instance_url}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  let refreshed = false;

  while (url) {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${state.creds.access_token}`, Accept: 'application/json' } });
    if ((res.status === 401) && !refreshed) {
      refreshed = true;
      state.creds = await refresh(state.creds);
      if (saveCredentials) { try { await saveCredentials(state.creds); } catch { /* best-effort persist */ } }
      res = await fetch(url, { headers: { Authorization: `Bearer ${state.creds.access_token}`, Accept: 'application/json' } });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`Salesforce API error ${res.status}: ${body.slice(0, 200)}`);
      e.status = res.status === 401 ? 401 : 502; throw e;
    }
    const data = await res.json();
    for (const rec of (data.records || [])) records.push(rec);
    url = data.done ? null : (data.nextRecordsUrl ? `${state.creds.instance_url}${data.nextRecordsUrl}` : null);
  }
  return records;
}

async function verify(creds) {
  if (!creds || !creds.access_token || !creds.instance_url) {
    const e = new Error('Salesforce is not authorized yet.'); e.status = 400; throw e;
  }
  await sfQuery({ creds }, 'SELECT Id FROM Account LIMIT 1');
  return true;
}

// ───────────────────────────────────────────────────────── normalization
function domainOf(website) {
  const s = String(website || '').trim().toLowerCase();
  if (!s) return null;
  const m = s.replace(/^https?:\/\//, '').replace(/^www\./, '').match(/^([^/\s?#]+)/);
  return m ? m[1] : null;
}
function fullName(first, last) {
  return [first, last].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null;
}

async function pullProspects(creds, { limit = 200, saveCredentials } = {}) {
  const state = { creds };
  const cap = Math.max(1, Math.min(2000, limit));
  const opts = { saveCredentials };

  // 1. Accounts → companies (keyed by Id so contacts can associate cleanly).
  const accountById = new Map();
  const companies = [];
  const accounts = await sfQuery(state, `SELECT Id, Name, Website FROM Account WHERE Name != null LIMIT ${cap}`, opts);
  for (const a of accounts) {
    const name = String(a.Name || '').trim();
    if (!name) continue;
    const domain = domainOf(a.Website);
    companies.push({ name, domain });
    accountById.set(a.Id, { name, domain });
  }

  const contacts = [];

  // 2. Contacts → contacts (associated to their Account via parent fields).
  const contactRows = await sfQuery(state,
    `SELECT Id, FirstName, LastName, Email, Title, Account.Name, Account.Website FROM Contact WHERE Email != null LIMIT ${cap}`, opts);
  for (const c of contactRows) {
    const email = String(c.Email || '').trim();
    if (!email) continue;
    const title = String(c.Title || '').trim() || null;
    const acct = c.Account || null;
    contacts.push({
      name: fullName(c.FirstName, c.LastName) || email,
      email, role: title, title,
      companyName: acct && acct.Name ? String(acct.Name).trim() : null,
      companyDomain: acct ? domainOf(acct.Website) : null,
    });
  }

  // 3. Leads → contacts (unconverted prospects; Company/Website are plain text).
  const leadRows = await sfQuery(state,
    `SELECT Id, FirstName, LastName, Email, Title, Company, Website FROM Lead WHERE Email != null AND IsConverted = false LIMIT ${cap}`, opts);
  for (const l of leadRows) {
    const email = String(l.Email || '').trim();
    if (!email) continue;
    const title = String(l.Title || '').trim() || null;
    contacts.push({
      name: fullName(l.FirstName, l.LastName) || email,
      email, role: title, title,
      companyName: String(l.Company || '').trim() || null,
      companyDomain: domainOf(l.Website),
    });
  }

  return { companies, contacts };
}

module.exports = { authorizeUrl, exchangeCode, credsFromToken, refresh, verify, pullProspects, loginBase, API_VERSION };
