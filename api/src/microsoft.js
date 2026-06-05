// Direct Microsoft Graph integration. One multi-tenant Azure AD app, registered
// in OUR Azure tenant; every customer's user can authenticate against it.
// See docs/adr/0002-microsoft-graph-direct.md for the design — including the
// §8 correction that removed the admin-consent flow originally drafted here
// (Recall.ai has no programmatic Teams bot credential endpoint; authenticated
// Teams joining is an operator-side Recall dashboard config).
//
// Scope of this module:
//
//   **Per-user delegated OAuth** (`/microsoft/connect` → `/microsoft/callback`)
//   with scopes `Calendars.Read OnlineMeetings.Read User.Read offline_access`.
//   No admin consent needed — these are user-consent scopes. The refresh
//   token is keyed `(tenantId, userId)` in Redis under `ms_grant:` with a
//   180-day rolling TTL, mirroring the Calendly/Google grants in integrations.js.
//
// MS_CLIENT_SECRET never leaves the server. The redactForLog helper at the
// bottom is used at every error log site to keep it (and any access/refresh
// token returned by Microsoft) out of stdout, even when a future debug branch
// passes a token-exchange response straight to console.error.

const crypto = require('crypto');
const redis = require('./redis');
const secretbox = require('./secretbox');

const APP_BASE_URL =
  process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net';

// Authority host — global Azure AD by default. Sovereign clouds (Azure
// Government, China 21Vianet) use a different host; override per ADR-0002 §6
// when a sovereign-cloud customer signs.
const MS_AUTHORITY_HOST = (process.env.MS_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const MS_GRAPH_BASE     = (process.env.MS_GRAPH_BASE     || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
const MS_TENANT         = (process.env.MS_TENANT_ID || 'common').trim() || 'common';

const CALLBACK_PATH = '/api/integrations/microsoft/callback';

// Delegated scopes:
//   openid / profile / offline_access / User.Read — auth plumbing.
//   Calendars.ReadWrite + OnlineMeetings.ReadWrite — create the Teams meeting
//     + the Outlook calendar event that wraps it (so attendees get an invite).
//   Contacts.Read + People.Read — the attendees autocomplete on the create-
//     meeting form. People.Read is the higher-signal one (most-contacted with
//     relevance scoring); Contacts.Read is the rep's saved address book.
//
// All scopes are user-consent (no admin consent needed). Changing this list
// is a breaking change for already-connected reps — their refresh tokens
// were issued against the previous scope set. They have to disconnect +
// reconnect to get a token with the new scopes. See ADR-0002 §9.
const DELEGATED_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Calendars.ReadWrite',
  'OnlineMeetings.ReadWrite',
  'Contacts.Read',
  'People.Read',
];

function clientId()     { return process.env.MS_CLIENT_ID     || null; }
function clientSecret() { return process.env.MS_CLIENT_SECRET || null; }
function redirectUri()  {
  return (process.env.MS_REDIRECT_URI && process.env.MS_REDIRECT_URI.trim())
    || `${APP_BASE_URL}${CALLBACK_PATH}`;
}

function isConfigured() {
  return !!(clientId() && clientSecret());
}

// ── Redis: CSRF state + per-user grant (mirrors integrations.js shape) ────

const STATE_TTL_SEC = 600;                      // 10 min OAuth round-trip
const GRANT_TTL_SEC = 60 * 60 * 24 * 180;       // 180 days rolling

function stateKey(s)               { return `ms_state:${s}`; }
function grantKey(tenantId, userId){ return `ms_grant:${tenantId}:${userId}`; }

async function makeOAuthState(tenantId, userId) {
  const s = crypto.randomBytes(24).toString('base64url');
  await redis.set(stateKey(s), JSON.stringify({ tenantId, userId }), 'EX', STATE_TTL_SEC);
  return s;
}

// State is single-use: GET then DEL. State binds the (tenantId, userId) we
// issued the URL for; a stolen state still lands the grant on the same user.
async function consumeOAuthState(s) {
  if (!s) return null;
  const raw = await redis.get(stateKey(s));
  if (raw) await redis.del(stateKey(s));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

async function saveGrant(tenantId, userId, grant) {
  // Encrypted at rest — holds access/refresh tokens (see secretbox.js).
  await redis.set(grantKey(tenantId, userId), secretbox.sealJson(grant), 'EX', GRANT_TTL_SEC);
}
async function loadGrant(tenantId, userId) {
  const raw = await redis.get(grantKey(tenantId, userId));
  try { return raw ? secretbox.openJson(raw) : null; } catch { return null; }
}
async function deleteGrant(tenantId, userId) {
  await redis.del(grantKey(tenantId, userId));
}

// ── OAuth: auth URL + token exchange + refresh ────────────────────────────

function authUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: DELEGATED_SCOPES.join(' '),
    state,
    // Forces the account picker — important when a rep has multiple MS
    // accounts signed into the browser; without it, MS silently re-uses the
    // most recent one and the rep can't connect their work account.
    prompt: 'select_account',
  });
  return `${MS_AUTHORITY_HOST}/${MS_TENANT}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function tokenRequest(form) {
  const url = `${MS_AUTHORITY_HOST}/${MS_TENANT}/oauth2/v2.0/token`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // redactForLog so any access/refresh token in the response body is masked.
    throw new Error(`Microsoft token request failed (${r.status}): ${j.error_description || j.error || JSON.stringify(redactForLog(j)).slice(0, 200)}`);
  }
  return j; // { access_token, refresh_token, expires_in, scope, id_token, token_type }
}

function exchangeCode(code) {
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    redirect_uri: redirectUri(),
    scope: DELEGATED_SCOPES.join(' '),
  });
}

// Note: do NOT pass scope on refresh. Microsoft returns whatever scopes the
// user originally consented to; passing a *wider* scope set here is what
// triggers AADSTS65001 for users whose grant was issued before a scope
// expansion. The new-scope path is to detect the gap via needsReconsent
// (below) and prompt the rep to disconnect + reconnect from the UI.
function refreshToken(rt) {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: rt,
  });
}

// Compare a grant's actual scope string (whatever Microsoft returned at
// token-exchange time) to the set we currently require. Returns true when
// any required scope is missing — that's the signal to prompt the rep to
// reconnect. Case-insensitive (MS sometimes lower-cases scope names in the
// response).
function grantHasAllRequiredScopes(grantScope) {
  if (!grantScope || typeof grantScope !== 'string') return false;
  const have = new Set(grantScope.toLowerCase().split(/\s+/).filter(Boolean));
  // The auth-plumbing scopes (openid/profile/offline_access) are sometimes
  // not echoed back in the response's `scope` field; only check the ones
  // that matter for Graph calls.
  const required = DELEGATED_SCOPES
    .filter((s) => !/^(openid|profile|offline_access)$/i.test(s))
    .map((s) => s.toLowerCase());
  return required.every((s) => have.has(s));
}

// Pull the MS-side tenant + user id out of the id_token (no signature
// verification — we don't trust the *contents*, we just want the OID/TID for
// display & for the consent lookup. The token came from a direct HTTPS request
// to MS minutes ago, not from a third party).
function decodeIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return {};
  const parts = idToken.split('.');
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      msUserId:   payload.oid || payload.sub || null,
      msTenantId: payload.tid || null,
      email:      payload.preferred_username || payload.upn || payload.email || null,
      name:       payload.name || null,
    };
  } catch { return {}; }
}

async function getValidAccessToken(tenantId, userId) {
  const g = await loadGrant(tenantId, userId);
  if (!g) return null;
  // 60s safety margin so we don't hand out a token that expires mid-request.
  if (g.expiresAt && Date.now() < g.expiresAt - 60_000) return g.accessToken;
  if (!g.refreshToken) return g.accessToken;
  const fresh = await refreshToken(g.refreshToken);
  const updated = {
    ...g,
    accessToken: fresh.access_token,
    // Microsoft *may* rotate the refresh token; fall back to the existing one
    // if they didn't.
    refreshToken: fresh.refresh_token || g.refreshToken,
    expiresAt: fresh.expires_in ? Date.now() + fresh.expires_in * 1000 : null,
    scope: fresh.scope || g.scope,
  };
  await saveGrant(tenantId, userId, updated);
  return updated.accessToken;
}

// ── Graph API helper ─────────────────────────────────────────────────────

async function graphGet(accessToken, path, { extraHeaders } = {}) {
  const url = path.startsWith('http') ? path : `${MS_GRAPH_BASE}${path}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(extraHeaders || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Microsoft Graph GET ${path} → ${r.status}: ${(j.error && (j.error.message || j.error.code)) || 'error'}`);
    e.status = r.status;
    e.code = (j.error && j.error.code) || null;
    throw e;
  }
  return j;
}

async function graphPost(accessToken, path, body) {
  return graphWrite('POST', accessToken, path, body);
}
async function graphPatch(accessToken, path, body) {
  return graphWrite('PATCH', accessToken, path, body);
}
async function graphDelete(accessToken, path) {
  return graphWrite('DELETE', accessToken, path, null);
}

async function graphWrite(method, accessToken, path, body) {
  const url = path.startsWith('http') ? path : `${MS_GRAPH_BASE}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Ask Graph to interpret + return start/end timestamps in UTC. Keeps
      // round-tripping through ISO simple — we never have to guess timezones.
      Prefer: 'outlook.timezone="UTC"',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // DELETE returns 204 with no body; gracefully short-circuit.
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Microsoft Graph ${method} ${path} → ${r.status}: ${(j.error && (j.error.message || j.error.code)) || 'error'}`);
    e.status = r.status;
    e.code = (j.error && j.error.code) || null;
    throw e;
  }
  return j;
}

// ── Connection status (status payload + admin-page card) ──────────────────

async function connection(tenantId, userId) {
  const g = await loadGrant(tenantId, userId);
  if (!g) return { connected: false };
  return {
    connected: true,
    email: g.email || null,
    name:  g.name  || null,
    msTenantId: g.msTenantId || null,
    connectedAt: g.connectedAt || null,
    // True when the stored grant's scope set is missing one or more of the
    // scopes we currently require — typically because the rep connected
    // before a scope expansion. The UI uses this to prompt a reconnect.
    needsReconsent: !grantHasAllRequiredScopes(g.scope),
  };
}

// ── Event normalization (Graph shape → integrations.js shape) ────────────
//
// Reproduces the small surface we need from integrations.js — kept inline so
// the two providers don't have a load-bearing coupling. Same set of public
// email domains, same companyNameFromDomain heuristic, same `suggestion`
// shape, so the schedule-form picker is provider-agnostic.

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.de',
  'zoho.com', 'fastmail.com', 'tutanota.com', 'mail.com', 'yandex.com',
  'qq.com', '163.com', '126.com', 'sina.com',
]);

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return null;
  const d = String(email).slice(at + 1).toLowerCase().trim();
  return d || null;
}

function companyNameFromDomain(domain) {
  if (!domain) return null;
  const base = domain.replace(/\.[a-z.]+$/i, '');
  return base.split(/[-_.]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || null;
}

// Graph returns `start: { dateTime, timeZone }`. dateTime is ISO without the Z,
// and Graph uses the timeZone we ask for (we ask for UTC via the Prefer header
// at fetch time below).
function graphDateTime(d) {
  if (!d || !d.dateTime) return null;
  const s = String(d.dateTime);
  if (/Z$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).toISOString();
  // No tz suffix — we asked for UTC, append Z.
  return new Date(`${s}Z`).toISOString();
}

function joinUrlFromEvent(ev) {
  if (ev.onlineMeeting && ev.onlineMeeting.joinUrl) return ev.onlineMeeting.joinUrl;
  if (ev.onlineMeetingUrl) return ev.onlineMeetingUrl;
  if (ev.location && typeof ev.location.displayName === 'string' && /^https?:\/\//.test(ev.location.displayName)) {
    return ev.location.displayName.trim();
  }
  return null;
}

function normalizeEvent(ev) {
  const start = graphDateTime(ev.start);
  const end   = graphDateTime(ev.end);
  const url   = joinUrlFromEvent(ev);
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const attendeeEmails = attendees
    .map((a) => (a && a.emailAddress && a.emailAddress.address ? String(a.emailAddress.address).toLowerCase() : null))
    .filter(Boolean);
  const organizerEmail = (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.address) || null;
  const externalDomains = [...new Set(
    [...attendeeEmails, organizerEmail].filter(Boolean)
      .map(domainOf).filter((d) => d && !PUBLIC_EMAIL_DOMAINS.has(d))
  )];
  const guessDomain = externalDomains[0] || null;
  let primaryContact = null;
  for (const a of attendees) {
    const addr = a && a.emailAddress;
    const name = addr && addr.name;
    if (!addr || !addr.address || !name) continue;
    if (guessDomain && domainOf(addr.address) === guessDomain) { primaryContact = String(name).trim(); break; }
  }
  if (!primaryContact) {
    const named = attendees.find((a) => a && a.emailAddress && (a.emailAddress.name || '').trim());
    if (named) primaryContact = String(named.emailAddress.name).trim();
  }
  const externalEmails = attendeeEmails.filter((e) => {
    const d = domainOf(e);
    return d && !PUBLIC_EMAIL_DOMAINS.has(d);
  });

  return {
    provider: 'microsoft',
    id: ev.id || null,
    title: ev.subject || '(no title)',
    start, end,
    url,
    location: (ev.location && typeof ev.location.displayName === 'string') ? ev.location.displayName : null,
    attendees: attendeeEmails,
    organizerEmail,
    suggestion: {
      companyName: companyNameFromDomain(guessDomain) || (externalEmails[0] || ''),
      companyDomain: guessDomain || null,
      primaryContact,
      scheduledAt: start,
      meetingUrl: url,
      prospectEmails: externalEmails,
      notes: `Imported from Microsoft 365 calendar — "${ev.subject || 'meeting'}".`,
    },
  };
}

async function fetchUpcomingEvents(tenantId, userId, { days = 14, limit = 30 } = {}) {
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) { const e = new Error('Microsoft not connected'); e.status = 409; e.code = 'NOT_CONNECTED'; throw e; }
  const now   = new Date();
  const until = new Date(now.getTime() + days * 86400000);
  // /me/calendarView expands recurring series into individual occurrences,
  // which is what the picker wants. $select keeps the payload small; $top is
  // bounded so a calendar with thousands of events doesn't OOM us.
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime:   until.toISOString(),
    $orderby: 'start/dateTime',
    $top:     String(Math.max(1, Math.min(limit, 50))),
    $select:  'id,subject,start,end,organizer,attendees,onlineMeeting,onlineMeetingUrl,onlineMeetingProvider,isOnlineMeeting,location,isCancelled,showAs,bodyPreview',
  });
  // Ask Graph to return start/end in UTC so graphDateTime can append Z safely.
  const url = `${MS_GRAPH_BASE}/me/calendarView?${params.toString()}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Microsoft Graph calendarView → ${r.status}: ${(j.error && (j.error.message || j.error.code)) || 'error'}`);
    e.status = r.status;
    throw e;
  }
  const items = Array.isArray(j.value) ? j.value : [];
  return items
    .filter((ev) => !ev.isCancelled)
    .map(normalizeEvent)
    .filter((ev) => ev.start)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

// ── Create the Teams meeting + the rep's private Outlook event ───────────
// We POST /me/events with isOnlineMeeting=true so Graph creates BOTH the
// calendar event AND the backing Teams onlineMeeting in one call. CRUCIAL
// detail: we send `attendees: []` so Microsoft does NOT try to mail an
// invite from the rep's mailbox — the moment the rep's tenant lands on
// Microsoft's outbound spam list (5.7.708, ADR-0002 §10) every invite
// silently bounces. The invite is sent separately via SendGrid from our
// branded sender, with the .ics attachment doing the calendar lift on the
// recipient side.
//
// The rep still sees the meeting on their own Outlook calendar because the
// event lives on /me/events with isOnlineMeeting=true; this is a feature,
// not a side-effect — reps want their day's schedule in Outlook.
//
// `attendeesForLog` is preserved on the returned record so the caller can
// hand the list to the SendGrid step + record who was invited on the mission.
async function createTeamsMeeting(tenantId, userId, { subject, startISO, endISO, attendees = [], body = '' } = {}) {
  if (!subject || !startISO || !endISO) {
    throw Object.assign(new Error('subject, startISO and endISO are required'), { status: 400 });
  }
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) {
    throw Object.assign(new Error('Microsoft not connected'), { status: 409, code: 'NOT_CONNECTED' });
  }
  const normalizedAttendees = (Array.isArray(attendees) ? attendees : [])
    .map((a) => (typeof a === 'string' ? { email: a } : a))
    .filter((a) => a && typeof a.email === 'string' && /@/.test(a.email))
    .map((a) => ({ email: a.email.trim(), name: (a.name || '').trim() || null }));
  const event = {
    subject: String(subject).slice(0, 250),
    body: { contentType: 'HTML', content: String(body || '').slice(0, 20_000) },
    start: { dateTime: startISO, timeZone: 'UTC' },
    end:   { dateTime: endISO,   timeZone: 'UTC' },
    // Empty on purpose — see header comment. Graph won't send invites if the
    // attendees array is empty.
    attendees: [],
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
  };
  const created = await graphPost(token, '/me/events', event);
  const joinUrl = (created.onlineMeeting && created.onlineMeeting.joinUrl) || created.onlineMeetingUrl || null;
  if (!joinUrl) {
    throw Object.assign(new Error('Graph created the event but returned no joinUrl'), { status: 502 });
  }
  // organizerEmail is what we use as Reply-To on the SendGrid invite so
  // prospects reply back to the rep, not into our no-reply.
  const organizerEmail = (created.organizer && created.organizer.emailAddress && created.organizer.emailAddress.address) || null;
  const organizerName  = (created.organizer && created.organizer.emailAddress && created.organizer.emailAddress.name)  || null;
  return {
    eventId: created.id || null,
    iCalUId: created.iCalUId || null, // stable across calendars; good ICS UID base
    joinUrl,
    subject: created.subject || subject,
    startISO: (created.start && created.start.dateTime) ? `${created.start.dateTime}Z`.replace(/Z+$/, 'Z') : startISO,
    endISO:   (created.end   && created.end.dateTime)   ? `${created.end.dateTime}Z`.replace(/Z+$/,   'Z') : endISO,
    webLink:  created.webLink || null,
    organizerEmail,
    organizerName,
    attendees: normalizedAttendees,
    platformLabel: 'Microsoft Teams',
  };
}

// ── Edit a previously-created Teams meeting ───────────────────────────────
// PATCH /me/events/{eventId}. We never touch the Graph attendees array
// (same reason as create — Microsoft would try to mail an update from the
// rep's mailbox, hitting 5.7.708 etc.); the recipient-side update lands via
// SendGrid + an .ics with SEQUENCE bumped. See ADR-0002 §10/§11.
async function updateTeamsMeeting(tenantId, userId, eventId, { subject, startISO, endISO, body } = {}) {
  if (!eventId) throw Object.assign(new Error('eventId is required'), { status: 400 });
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) throw Object.assign(new Error('Microsoft not connected'), { status: 409, code: 'NOT_CONNECTED' });
  const patch = {};
  if (typeof subject === 'string') patch.subject = subject.slice(0, 250);
  if (typeof body === 'string')    patch.body = { contentType: 'HTML', content: body.slice(0, 20_000) };
  if (startISO) patch.start = { dateTime: startISO, timeZone: 'UTC' };
  if (endISO)   patch.end   = { dateTime: endISO,   timeZone: 'UTC' };
  const updated = await graphPatch(token, `/me/events/${encodeURIComponent(eventId)}`, patch);
  const joinUrl = (updated.onlineMeeting && updated.onlineMeeting.joinUrl) || updated.onlineMeetingUrl || null;
  return {
    eventId: updated.id || eventId,
    iCalUId: updated.iCalUId || null,
    joinUrl,
    subject:  updated.subject || subject || null,
    startISO: (updated.start && updated.start.dateTime) ? `${updated.start.dateTime}Z`.replace(/Z+$/, 'Z') : (startISO || null),
    endISO:   (updated.end   && updated.end.dateTime)   ? `${updated.end.dateTime}Z`.replace(/Z+$/,   'Z') : (endISO   || null),
    webLink:  updated.webLink || null,
    organizerEmail: (updated.organizer && updated.organizer.emailAddress && updated.organizer.emailAddress.address) || null,
    platformLabel: 'Microsoft Teams',
  };
}

// DELETE /me/events/{eventId}. Tolerant of 404 (already deleted) so the
// caller can safely retry. Cancellation invites are sent separately by the
// integrations route via SendGrid (METHOD:CANCEL .ics).
async function cancelTeamsMeeting(tenantId, userId, eventId) {
  if (!eventId) throw Object.assign(new Error('eventId is required'), { status: 400 });
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) throw Object.assign(new Error('Microsoft not connected'), { status: 409, code: 'NOT_CONNECTED' });
  try {
    await graphDelete(token, `/me/events/${encodeURIComponent(eventId)}`);
    return { eventId, deleted: true };
  } catch (err) {
    if (err.status === 404) return { eventId, deleted: false, alreadyGone: true };
    throw err;
  }
}

// ── Contacts: search /me/people for autocomplete in the meeting form ─────
// /me/people is relevance-ranked (most-contacted at top), and unlike
// /me/contacts it doesn't require the rep to have explicitly saved someone
// to their address book. Falls back to /me/contacts only if /me/people
// returns nothing AND a search term is set — the latter respects the
// Contacts.Read scope as a secondary signal.
async function searchPeople(tenantId, userId, query) {
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) {
    throw Object.assign(new Error('Microsoft not connected'), { status: 409, code: 'NOT_CONNECTED' });
  }
  const q = String(query || '').trim();
  const params = new URLSearchParams({
    $top: '10',
    $select: 'displayName,scoredEmailAddresses,jobTitle,companyName',
  });
  if (q) params.set('$search', `"${q}"`);
  // /me/people requires the ConsistencyLevel: eventual header when $search is
  // used. Safe to send it regardless.
  const j = await graphGet(token, `/me/people?${params.toString()}`, {
    extraHeaders: { ConsistencyLevel: 'eventual' },
  });
  const items = Array.isArray(j.value) ? j.value : [];
  return items
    .map((p) => {
      const emails = Array.isArray(p.scoredEmailAddresses) ? p.scoredEmailAddresses : [];
      const top = emails[0] || null;
      const email = top && top.address ? String(top.address).trim() : null;
      if (!email) return null;
      return {
        displayName: p.displayName || email,
        email,
        jobTitle: p.jobTitle || null,
        company: p.companyName || null,
        relevanceScore: top && typeof top.relevanceScore === 'number' ? top.relevanceScore : null,
      };
    })
    .filter(Boolean);
}

// ── Callback handlers (mounted UN-authed in index.js) ─────────────────────

// Per-user delegated callback. The browser arrives here with the consent code;
// the session cookie is NOT carried (cookies don't ride through MS's consent
// screen), so this route can't use authMiddleware. CSRF state binds the
// (tenantId, userId) we issued the URL for.
async function handleCalendarCallback(req, res) {
  const finish = (k, v) => res.redirect(`/admin/?${k}=${encodeURIComponent(v)}#integrations`);
  try {
    if (!isConfigured()) return finish('ms_error', 'Microsoft not configured');
    const { code, state, error, error_description } = req.query || {};
    if (error) return finish('ms_error', error_description || error);
    if (!code || !state) return finish('ms_error', 'missing code/state');
    const st = await consumeOAuthState(state);
    if (!st) return finish('ms_error', 'state expired — please try connecting again');
    const tok = await exchangeCode(code);
    const id  = decodeIdToken(tok.id_token);
    // Best-effort /me lookup if the id_token didn't include an email (some MSA
    // accounts strip preferred_username); failure here is non-fatal.
    let email = id.email, name = id.name;
    if (!email) {
      try {
        const me = await graphGet(tok.access_token, '/me');
        email = me.mail || me.userPrincipalName || null;
        name  = name || me.displayName || null;
      } catch { /* keep null */ }
    }
    await saveGrant(st.tenantId, st.userId, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
      scope: tok.scope || null,
      msUserId: id.msUserId || null,
      msTenantId: id.msTenantId || null,
      email,
      name,
      connectedAt: new Date().toISOString(),
    });
    return finish('ms', 'connected');
  } catch (err) {
    console.error('[microsoft-callback]', err.stack || err.message);
    return finish('ms_error', err.message || 'connect failed');
  }
}

// ── Log redaction ────────────────────────────────────────────────────────
// Strip access_token / refresh_token / id_token / client_secret from anything
// before it hits console. Called at every error log site in this module; pair
// it with redactForLog at any new log site future-you adds.

const SECRET_KEYS = new Set([
  'access_token', 'refresh_token', 'id_token',
  'client_secret', 'authorization', 'cookie',
  'MS_CLIENT_SECRET',
]);

function redactForLog(v, depth = 0) {
  if (depth > 4) return '[depth]';
  if (v == null) return v;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => redactForLog(x, depth + 1));
  if (typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (SECRET_KEYS.has(k) || SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = typeof val === 'string' ? `[redacted ${val.length}b]` : '[redacted]';
    } else {
      out[k] = redactForLog(val, depth + 1);
    }
  }
  return out;
}

module.exports = {
  isConfigured,
  // OAuth surface
  authUrl,
  makeOAuthState,
  redirectUri,
  // Token / grant management
  exchangeCode,
  refreshToken,
  getValidAccessToken,
  saveGrant,
  loadGrant,
  deleteGrant,
  // Graph reads
  fetchUpcomingEvents,
  connection,
  // Graph writes / people search
  createTeamsMeeting,
  updateTeamsMeeting,
  cancelTeamsMeeting,
  searchPeople,
  // Callback handler
  handleCalendarCallback,
  // Helpers exposed for unit tests / safe logging
  decodeIdToken,
  redactForLog,
  // Constants the integrations module consumes
  DELEGATED_SCOPES,
  CALLBACK_PATH,
};
