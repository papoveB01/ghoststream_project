// Zoho CRM connector (OAuth, BYO API client). Same BYO pattern as Salesforce:
// each TENANT registers their own client in the Zoho API Console (Server-based
// Application), pastes its Client ID + Secret into DealScope and picks the data
// center their Zoho account lives in. We run the redirect handshake (crm/
// index.js) and store { access_token, refresh_token, api_domain, region }
// alongside the client creds in crm_connections.credentials (encrypted).
//
//   authorizeUrl({clientId,redirectUri,state,region})  → string
//   exchangeCode({clientId,clientSecret,code,redirectUri,region}) → token set
//   credsFromToken(tok, prev)  → merged credential object to persist
//   verify(creds)              → throws on a dead session, else true
//   pullProspects(creds, opts) → { companies:[{name,domain}], contacts:[...] }
//
// Zoho access tokens live ~1h; the refresh token is permanent. Every API call
// refreshes-on-401 and persists the fresh token via opts.saveCredentials.

const API_VERSION = 'v8';

// Zoho is multi-DC: the OAuth host and the API host depend on where the
// tenant's Zoho account is hosted. The token response also returns the
// account's `api_domain`, which we prefer once known.
const DATA_CENTERS = {
  us: { accounts: 'https://accounts.zoho.com',    api: 'https://www.zohoapis.com',    label: 'United States (zoho.com)' },
  eu: { accounts: 'https://accounts.zoho.eu',     api: 'https://www.zohoapis.eu',     label: 'Europe (zoho.eu)' },
  in: { accounts: 'https://accounts.zoho.in',     api: 'https://www.zohoapis.in',     label: 'India (zoho.in)' },
  au: { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au', label: 'Australia (zoho.com.au)' },
  jp: { accounts: 'https://accounts.zoho.jp',     api: 'https://www.zohoapis.jp',     label: 'Japan (zoho.jp)' },
  ca: { accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca',    label: 'Canada (zohocloud.ca)' },
  sa: { accounts: 'https://accounts.zoho.sa',     api: 'https://www.zohoapis.sa',     label: 'Saudi Arabia (zoho.sa)' },
  cn: { accounts: 'https://accounts.zoho.com.cn', api: 'https://www.zohoapis.com.cn', label: 'China (zoho.com.cn)' },
};
function dc(region) { return DATA_CENTERS[region] || DATA_CENTERS.us; }

// Read-only access to CRM record modules (Accounts/Contacts/Leads).
const SCOPES = 'ZohoCRM.modules.READ';

function authorizeUrl({ clientId, redirectUri, state, region }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent',      // re-consent always returns one
    state,
  });
  return `${dc(region).accounts}/oauth/v2/auth?${params.toString()}`;
}

// Zoho's token endpoint can answer HTTP 200 with {"error":"invalid_code"} —
// treat a body-level error exactly like a failed status.
async function tokenRequest(region, form) {
  const r = await fetch(`${dc(region).accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = new Error(`Zoho token request failed${r.ok ? '' : ` (${r.status})`}: ${j.error_description || j.error || JSON.stringify(j).slice(0, 200)}`);
    e.status = 401;
    throw e;
  }
  return j; // { access_token, refresh_token?, api_domain, token_type, expires_in }
}

function exchangeCode({ clientId, clientSecret, code, redirectUri, region }) {
  return tokenRequest(region, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
}

// Merge a fresh token set into the stored credentials. Zoho only issues the
// refresh_token on the consent exchange, so keep the existing one on re-auth.
function credsFromToken(tok, prev = {}) {
  return {
    ...prev,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || prev.refresh_token || null,
    api_domain: tok.api_domain || prev.api_domain || null,
  };
}

async function refresh(creds) {
  if (!creds.refresh_token) {
    const e = new Error('Zoho session expired and no refresh token is stored — reconnect Zoho CRM.');
    e.status = 401; throw e;
  }
  const j = await tokenRequest(creds.region, {
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  });
  return { ...creds, access_token: j.access_token, api_domain: j.api_domain || creds.api_domain || null };
}

function apiBase(creds) { return creds.api_domain || dc(creds.region).api; }

// ─────────────────────────────────────────────────── record fetch runner
// GETs a module's records (`fields` is mandatory from API v3 on), following
// page pagination, transparently refreshing the access token once on a 401.
// `state` is a mutable holder so a refresh mid-pagination (and the persisted
// creds) propagate to later pages. Zoho answers 204 when a page is empty.
async function zFetch(state, module, fields, { limit = 200, saveCredentials } = {}) {
  const records = [];
  const perPage = Math.min(200, Math.max(1, limit));
  let page = 1;
  let refreshed = false;

  while (records.length < limit) {
    const url = `${apiBase(state.creds)}/crm/${API_VERSION}/${module}?fields=${encodeURIComponent(fields.join(','))}&per_page=${perPage}&page=${page}`;
    let res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${state.creds.access_token}`, Accept: 'application/json' } });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      state.creds = await refresh(state.creds);
      if (saveCredentials) { try { await saveCredentials(state.creds); } catch { /* best-effort persist */ } }
      res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${state.creds.access_token}`, Accept: 'application/json' } });
    }
    if (res.status === 204) break; // no (more) records
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`Zoho API error ${res.status} on ${module}: ${body.slice(0, 200)}`);
      e.status = res.status === 401 ? 401 : 502; throw e;
    }
    const data = await res.json();
    for (const rec of (data.data || [])) records.push(rec);
    if (!data.info || !data.info.more_records) break;
    page += 1;
  }
  return records.slice(0, limit);
}

async function verify(creds) {
  if (!creds || !creds.access_token) {
    const e = new Error('Zoho CRM is not authorized yet.'); e.status = 400; throw e;
  }
  await zFetch({ creds }, 'Accounts', ['Account_Name'], { limit: 1 });
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
  const opts = { limit: cap, saveCredentials };

  // 1. Accounts → companies.
  const companies = [];
  const accounts = await zFetch(state, 'Accounts', ['Account_Name', 'Website'], opts);
  for (const a of accounts) {
    const name = String(a.Account_Name || '').trim();
    if (!name) continue;
    companies.push({ name, domain: domainOf(a.Website) });
  }

  const contacts = [];

  // 2. Contacts → contacts (Account_Name is a lookup: { name, id }).
  const contactRows = await zFetch(state, 'Contacts', ['First_Name', 'Last_Name', 'Email', 'Title', 'Account_Name'], opts);
  for (const c of contactRows) {
    const email = String(c.Email || '').trim();
    if (!email) continue;
    const title = String(c.Title || '').trim() || null;
    const acct = c.Account_Name && typeof c.Account_Name === 'object' ? c.Account_Name : null;
    contacts.push({
      name: fullName(c.First_Name, c.Last_Name) || email,
      email, role: title, title,
      companyName: acct && acct.name ? String(acct.name).trim() : null,
      companyDomain: null, // the lookup doesn't carry the account's website
    });
  }

  // 3. Leads → contacts (Zoho's job-title field on Leads is `Designation`;
  // converted leads are excluded from plain GETs by default).
  const leadRows = await zFetch(state, 'Leads', ['First_Name', 'Last_Name', 'Email', 'Designation', 'Company', 'Website'], opts);
  for (const l of leadRows) {
    const email = String(l.Email || '').trim();
    if (!email) continue;
    const title = String(l.Designation || '').trim() || null;
    contacts.push({
      name: fullName(l.First_Name, l.Last_Name) || email,
      email, role: title, title,
      companyName: String(l.Company || '').trim() || null,
      companyDomain: domainOf(l.Website),
    });
  }

  return { companies, contacts };
}

module.exports = { authorizeUrl, exchangeCode, credsFromToken, refresh, verify, pullProspects, DATA_CENTERS, API_VERSION };
