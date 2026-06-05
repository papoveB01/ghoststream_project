// Direct Google integration. One OAuth 2.0 "Web application" client, registered
// in OUR Google Cloud project; every customer's user authenticates against it.
// This is the Google counterpart to api/src/microsoft.js — same shape, same
// Redis grant model, same provider-agnostic event/suggestion normalization — so
// the schedule-form picker and the "Generate meeting" modal treat Google and
// Microsoft identically. It REPLACES the old Nylas-mediated Google calendar
// connection (see docs/adr/0002-microsoft-graph-direct.md, Option D).
//
// Scope of this module:
//
//   **Per-user delegated OAuth** (`/google/connect` → `/google/callback`) with
//   scopes openid/email/profile + calendar.events (read + create/patch/delete,
//   including Google Meet conferenceData) + contacts.readonly /
//   contacts.other.readonly (the attendees autocomplete). The refresh token is
//   keyed `(tenantId, userId)` in Redis under `google_grant:` with a 180-day
//   rolling TTL, mirroring the Microsoft grant in microsoft.js.
//
// GOOGLE_CLIENT_SECRET never leaves the server. redactForLog (bottom) is used
// at every error log site to keep tokens + the secret out of stdout.

const crypto = require('crypto');
const redis = require('./redis');
const secretbox = require('./secretbox');

const APP_BASE_URL =
  process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net';

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = (process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token').replace(/\/+$/, '');
const GOOGLE_USERINFO  = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_BASE    = (process.env.GOOGLE_CALENDAR_BASE || 'https://www.googleapis.com/calendar/v3').replace(/\/+$/, '');
const PEOPLE_BASE      = (process.env.GOOGLE_PEOPLE_BASE   || 'https://people.googleapis.com/v1').replace(/\/+$/, '');

const CALLBACK_PATH = '/api/integrations/google/callback';

// Delegated scopes:
//   openid / email / profile — auth plumbing + the connected email for display.
//   calendar.events — list the rep's events AND create/patch/delete events
//     (incl. the Google Meet conferenceData create-request).
//   contacts.readonly + contacts.other.readonly — the attendees autocomplete on
//     the create-meeting form (saved contacts + "other" auto-collected people).
//
// All scopes are user-consent (no admin/Workspace approval needed). Changing
// this list is a breaking change for already-connected reps — their refresh
// tokens were issued against the previous scope set; they must disconnect +
// reconnect. The needsReconsent signal (below) detects the gap for the UI.
const DELEGATED_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
];

function clientId()     { return process.env.GOOGLE_CLIENT_ID     || null; }
function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || null; }
function redirectUri()  {
  return (process.env.GOOGLE_REDIRECT_URI && process.env.GOOGLE_REDIRECT_URI.trim())
    || `${APP_BASE_URL}${CALLBACK_PATH}`;
}

function isConfigured() {
  return !!(clientId() && clientSecret());
}

// ── Redis: CSRF state + per-user grant (mirrors microsoft.js shape) ───────

const STATE_TTL_SEC = 600;                      // 10 min OAuth round-trip
const GRANT_TTL_SEC = 60 * 60 * 24 * 180;       // 180 days rolling

function stateKey(s)               { return `google_state:${s}`; }
function grantKey(tenantId, userId){ return `google_grant:${tenantId}:${userId}`; }

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
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: DELEGATED_SCOPES.join(' '),
    // offline + consent → Google returns a refresh_token. Without prompt=consent
    // Google omits the refresh_token on every connect after the first, which
    // would leave a reconnecting rep with an access token that can't refresh.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(form) {
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Google token request failed (${r.status}): ${j.error_description || j.error || JSON.stringify(redactForLog(j)).slice(0, 200)}`);
  }
  return j; // { access_token, expires_in, refresh_token, scope, token_type, id_token }
}

function exchangeCode(code) {
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    redirect_uri: redirectUri(),
  });
}

// Google does NOT return a new refresh_token on refresh — the caller keeps the
// existing one.
function refreshToken(rt) {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: rt,
  });
}

// Compare a grant's actual scope string (whatever Google returned at token
// time) to the set we currently require. True when any required scope is
// missing — the signal to prompt the rep to reconnect. The auth-plumbing
// scopes (openid/email/profile) aren't always echoed back, so we only assert
// the API scopes.
function grantHasAllRequiredScopes(grantScope) {
  if (!grantScope || typeof grantScope !== 'string') return false;
  const have = new Set(grantScope.split(/\s+/).filter(Boolean));
  const required = DELEGATED_SCOPES.filter((s) => /^https:\/\//.test(s));
  return required.every((s) => have.has(s));
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
    // Google omits refresh_token on refresh — keep the one we have.
    refreshToken: fresh.refresh_token || g.refreshToken,
    expiresAt: fresh.expires_in ? Date.now() + fresh.expires_in * 1000 : null,
    scope: fresh.scope || g.scope,
  };
  await saveGrant(tenantId, userId, updated);
  return updated.accessToken;
}

// ── REST helpers ──────────────────────────────────────────────────────────

async function apiGet(accessToken, url, { extraHeaders } = {}) {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(extraHeaders || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Google GET ${shortPath(url)} → ${r.status}: ${(j.error && (j.error.message || j.error.status)) || 'error'}`);
    e.status = r.status;
    e.code = (j.error && (j.error.status || j.error.code)) || null;
    throw e;
  }
  return j;
}

async function apiWrite(method, accessToken, url, body) {
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Google ${method} ${shortPath(url)} → ${r.status}: ${(j.error && (j.error.message || j.error.status)) || 'error'}`);
    e.status = r.status;
    e.code = (j.error && (j.error.status || j.error.code)) || null;
    throw e;
  }
  return j;
}
const apiPost   = (t, url, body) => apiWrite('POST',   t, url, body);
const apiPatch  = (t, url, body) => apiWrite('PATCH',  t, url, body);
const apiDelete = (t, url)       => apiWrite('DELETE', t, url, null);

function shortPath(url) { try { return new URL(url).pathname; } catch { return url; } }
const cal = (path) => `${CALENDAR_BASE}${path}`;

// ── Connection status (status payload + admin-page card) ──────────────────

async function connection(tenantId, userId) {
  const g = await loadGrant(tenantId, userId);
  if (!g) return { connected: false };
  return {
    connected: true,
    email: g.email || null,
    name:  g.name  || null,
    connectedAt: g.connectedAt || null,
    // True when the stored grant is missing one or more scopes we now require —
    // typically a rep who connected before a scope expansion. UI prompts a
    // reconnect.
    needsReconsent: !grantHasAllRequiredScopes(g.scope),
  };
}

// ── Event normalization (Google shape → integrations.js shape) ────────────
// Same public-email set / companyNameFromDomain heuristic / `suggestion`
// shape as microsoft.js so the schedule-form picker is provider-agnostic.

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

// Google's start/end is { dateTime, timeZone } (timed) or { date } (all-day).
function gDateTime(d) {
  if (!d) return null;
  if (d.dateTime) return new Date(d.dateTime).toISOString();        // RFC3339 w/ offset
  if (d.date)     return new Date(`${d.date}T00:00:00.000Z`).toISOString();
  return null;
}

// Google Meet join URL: hangoutLink is the canonical one; conferenceData's
// 'video' entry point is the fallback for events created via createRequest
// before hangoutLink was backfilled.
function joinUrlFromEvent(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;
  const eps = (ev.conferenceData && Array.isArray(ev.conferenceData.entryPoints)) ? ev.conferenceData.entryPoints : [];
  const video = eps.find((e) => e && e.entryPointType === 'video' && e.uri);
  if (video) return video.uri;
  if (ev.location && typeof ev.location === 'string' && /^https?:\/\//.test(ev.location)) return ev.location.trim();
  return null;
}

function normalizeEvent(ev) {
  const start = gDateTime(ev.start);
  const end   = gDateTime(ev.end);
  const url   = joinUrlFromEvent(ev);
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  // Drop resource rooms — they're not people.
  const people = attendees.filter((a) => a && a.email && !a.resource);
  const attendeeEmails = people.map((a) => String(a.email).toLowerCase());
  const organizerEmail = (ev.organizer && ev.organizer.email) ? String(ev.organizer.email).toLowerCase() : null;
  const externalDomains = [...new Set(
    [...attendeeEmails, organizerEmail].filter(Boolean)
      .map(domainOf).filter((d) => d && !PUBLIC_EMAIL_DOMAINS.has(d))
  )];
  const guessDomain = externalDomains[0] || null;
  let primaryContact = null;
  for (const a of people) {
    if (guessDomain && domainOf(a.email) === guessDomain && (a.displayName || '').trim()) {
      primaryContact = a.displayName.trim(); break;
    }
  }
  if (!primaryContact) {
    const named = people.find((a) => (a.displayName || '').trim());
    if (named) primaryContact = named.displayName.trim();
  }
  const externalEmails = attendeeEmails.filter((e) => {
    const d = domainOf(e);
    return d && !PUBLIC_EMAIL_DOMAINS.has(d);
  });

  return {
    provider: 'google',
    id: ev.id || null,
    title: ev.summary || '(no title)',
    start, end,
    url,
    location: typeof ev.location === 'string' ? ev.location : null,
    attendees: attendeeEmails,
    organizerEmail,
    suggestion: {
      companyName: companyNameFromDomain(guessDomain) || (externalEmails[0] || ''),
      companyDomain: guessDomain || null,
      primaryContact,
      scheduledAt: start,
      meetingUrl: url,
      prospectEmails: externalEmails,
      notes: `Imported from Google Calendar — "${ev.summary || 'meeting'}".`,
    },
  };
}

async function fetchUpcomingEvents(tenantId, userId, { days = 14, limit = 30 } = {}) {
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) { const e = new Error('Google not connected'); e.status = 409; e.code = 'NOT_CONNECTED'; throw e; }
  const now   = new Date();
  const until = new Date(now.getTime() + days * 86400000);
  // singleEvents=true expands recurring series into individual occurrences,
  // which is what the picker wants. orderBy=startTime requires singleEvents.
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.max(1, Math.min(limit, 50))),
    fields: 'items(id,summary,start,end,organizer,attendees,hangoutLink,conferenceData,location,status,iCalUID)',
  });
  const j = await apiGet(token, cal(`/calendars/primary/events?${params.toString()}`));
  const items = Array.isArray(j.items) ? j.items : [];
  return items
    .filter((ev) => (ev.status || '').toLowerCase() !== 'cancelled')
    .map(normalizeEvent)
    .filter((ev) => ev.start)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

// ── Create the Google Meet meeting + the rep's Google Calendar event ──────
// POST /calendars/primary/events?conferenceDataVersion=1 with a Meet
// createRequest builds BOTH the calendar event AND the backing Meet space in
// one call. CRUCIAL detail (same as microsoft.js): we send `attendees: []`
// and `sendUpdates=none` so Google does NOT email an invite from the rep's
// Gmail — the invite goes out separately via SendGrid from our branded sender
// with the .ics attachment. The rep still sees the meeting on their own
// calendar; that's intended (reps want their day's schedule in Google).
async function createMeeting(tenantId, userId, { subject, startISO, endISO, attendees = [], body = '' } = {}) {
  if (!subject || !startISO || !endISO) {
    throw Object.assign(new Error('subject, startISO and endISO are required'), { status: 400 });
  }
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) {
    throw Object.assign(new Error('Google not connected'), { status: 409, code: 'NOT_CONNECTED' });
  }
  const normalizedAttendees = normalizeAttendees(attendees);
  const event = {
    summary: String(subject).slice(0, 250),
    description: String(body || '').slice(0, 20_000),
    start: { dateTime: startISO, timeZone: 'UTC' },
    end:   { dateTime: endISO,   timeZone: 'UTC' },
    // Empty on purpose — Google only emails invites when attendees are set
    // (and sendUpdates != none). We deliver via SendGrid instead.
    attendees: [],
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };
  let created = await apiPost(token, cal('/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none'), event);
  let joinUrl = joinUrlFromEvent(created);
  // The Meet space is created asynchronously; if the create response came back
  // before it was provisioned, re-GET the event once to pick up hangoutLink.
  if (!joinUrl && created.id) {
    try {
      const refetched = await apiGet(token, cal(`/calendars/primary/events/${encodeURIComponent(created.id)}?conferenceDataVersion=1`));
      created = refetched;
      joinUrl = joinUrlFromEvent(created);
    } catch { /* fall through to the no-joinUrl error below */ }
  }
  if (!joinUrl) {
    throw Object.assign(new Error('Google created the event but returned no Meet link'), { status: 502 });
  }
  const organizerEmail = (created.organizer && created.organizer.email) || null;
  const organizerName  = (created.organizer && created.organizer.displayName) || null;
  return {
    eventId: created.id || null,
    iCalUId: created.iCalUID || null,  // stable across calendars; good ICS UID base
    joinUrl,
    subject: created.summary || subject,
    startISO: gDateTime(created.start) || startISO,
    endISO:   gDateTime(created.end)   || endISO,
    webLink:  created.htmlLink || null,
    organizerEmail,
    organizerName,
    attendees: normalizedAttendees,
    platformLabel: 'Google Meet',
  };
}

// ── Edit a previously-created Google Meet meeting ─────────────────────────
// PATCH /calendars/primary/events/{eventId}. We never touch the attendees
// array (same reason as create) and pass sendUpdates=none; the recipient-side
// update lands via SendGrid + an .ics with the SEQUENCE bumped.
async function updateMeeting(tenantId, userId, eventId, { subject, startISO, endISO, body } = {}) {
  if (!eventId) throw Object.assign(new Error('eventId is required'), { status: 400 });
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) throw Object.assign(new Error('Google not connected'), { status: 409, code: 'NOT_CONNECTED' });
  const patch = {};
  if (typeof subject === 'string') patch.summary = subject.slice(0, 250);
  if (typeof body === 'string')    patch.description = body.slice(0, 20_000);
  if (startISO) patch.start = { dateTime: startISO, timeZone: 'UTC' };
  if (endISO)   patch.end   = { dateTime: endISO,   timeZone: 'UTC' };
  const updated = await apiPatch(token, cal(`/calendars/primary/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`), patch);
  return {
    eventId: updated.id || eventId,
    iCalUId: updated.iCalUID || null,
    joinUrl: joinUrlFromEvent(updated),
    subject:  updated.summary || subject || null,
    startISO: gDateTime(updated.start) || startISO || null,
    endISO:   gDateTime(updated.end)   || endISO   || null,
    webLink:  updated.htmlLink || null,
    organizerEmail: (updated.organizer && updated.organizer.email) || null,
    platformLabel: 'Google Meet',
  };
}

// DELETE /calendars/primary/events/{eventId}?sendUpdates=none. Tolerant of
// 404/410 (already deleted). Cancellation invites are sent separately by the
// integrations route via SendGrid (METHOD:CANCEL .ics).
async function cancelMeeting(tenantId, userId, eventId) {
  if (!eventId) throw Object.assign(new Error('eventId is required'), { status: 400 });
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) throw Object.assign(new Error('Google not connected'), { status: 409, code: 'NOT_CONNECTED' });
  try {
    await apiDelete(token, cal(`/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`));
    return { eventId, deleted: true };
  } catch (err) {
    if (err.status === 404 || err.status === 410) return { eventId, deleted: false, alreadyGone: true };
    throw err;
  }
}

function normalizeAttendees(attendees) {
  return (Array.isArray(attendees) ? attendees : [])
    .map((a) => (typeof a === 'string' ? { email: a } : a))
    .filter((a) => a && typeof a.email === 'string' && /@/.test(a.email))
    .map((a) => ({ email: a.email.trim(), name: (a.name || '').trim() || null }));
}

// ── Contacts: People API for the attendees autocomplete ───────────────────
// With a query: people:searchContacts (saved contacts) + otherContacts:search
// (auto-collected "other" contacts). Without one: people/me/connections, most-
// recently-modified first. Results are merged + de-duped by email, capped at 10.
async function searchPeople(tenantId, userId, query) {
  const token = await getValidAccessToken(tenantId, userId);
  if (!token) {
    throw Object.assign(new Error('Google not connected'), { status: 409, code: 'NOT_CONNECTED' });
  }
  const q = String(query || '').trim();
  const out = [];
  const seen = new Set();
  const push = (person) => {
    if (!person) return;
    const emails = Array.isArray(person.emailAddresses) ? person.emailAddresses : [];
    const email = emails[0] && emails[0].value ? String(emails[0].value).trim().toLowerCase() : null;
    if (!email || seen.has(email)) return;
    seen.add(email);
    const name = (Array.isArray(person.names) && person.names[0] && person.names[0].displayName) || email;
    const org  = (Array.isArray(person.organizations) && person.organizations[0]) || {};
    out.push({
      displayName: name,
      email,
      jobTitle: org.title || null,
      company: org.name || null,
      relevanceScore: null,
    });
  };

  try {
    if (q) {
      const mask = 'names,emailAddresses,organizations';
      const [a, b] = await Promise.all([
        apiGet(token, `${PEOPLE_BASE}/people:searchContacts?query=${encodeURIComponent(q)}&readMask=${encodeURIComponent(mask)}&pageSize=10`).catch(() => ({})),
        apiGet(token, `${PEOPLE_BASE}/otherContacts:search?query=${encodeURIComponent(q)}&readMask=${encodeURIComponent('names,emailAddresses')}&pageSize=10`).catch(() => ({})),
      ]);
      for (const r of (a.results || [])) push(r.person);
      for (const r of (b.results || [])) push(r.person);
    } else {
      const conn = await apiGet(token, `${PEOPLE_BASE}/people/me/connections?personFields=names,emailAddresses,organizations&pageSize=10&sortOrder=LAST_MODIFIED_DESCENDING`).catch(() => ({}));
      for (const p of (conn.connections || [])) push(p);
    }
  } catch (err) {
    // Contacts are a convenience — never let a People API hiccup 500 the
    // autocomplete. Return whatever we gathered (possibly empty).
    console.warn('[google.searchPeople]', redactForLog({ message: err.message, status: err.status }));
  }
  return out.slice(0, 10);
}

// ── Callback handler (mounted UN-authed in index.js) ──────────────────────
// The browser arrives here with the consent code; the session cookie is NOT
// carried (cookies don't ride through Google's consent screen), so this route
// can't use authMiddleware. CSRF state binds the (tenantId, userId).
async function handleCalendarCallback(req, res) {
  const finish = (k, v) => res.redirect(`/admin/?${k}=${encodeURIComponent(v)}#integrations`);
  try {
    if (!isConfigured()) return finish('google_error', 'Google not configured');
    const { code, state, error } = req.query || {};
    if (error) return finish('google_error', error);
    if (!code || !state) return finish('google_error', 'missing code/state');
    const st = await consumeOAuthState(state);
    if (!st) return finish('google_error', 'state expired — please try connecting again');
    const tok = await exchangeCode(code);
    // Identify the connected account for display. userinfo is the simplest
    // path (works for any Google account); failure is non-fatal.
    let email = null, name = null;
    try {
      const me = await apiGet(tok.access_token, GOOGLE_USERINFO);
      email = me.email || null;
      name  = me.name  || null;
    } catch { /* keep null */ }
    await saveGrant(st.tenantId, st.userId, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
      scope: tok.scope || null,
      email,
      name,
      connectedAt: new Date().toISOString(),
    });
    return finish('google', 'connected');
  } catch (err) {
    console.error('[google-callback]', err.stack || err.message);
    return finish('google_error', err.message || 'connect failed');
  }
}

// ── Log redaction (mirrors microsoft.js) ──────────────────────────────────
const SECRET_KEYS = new Set([
  'access_token', 'refresh_token', 'id_token',
  'client_secret', 'authorization', 'cookie',
  'GOOGLE_CLIENT_SECRET',
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
  // Calendar reads
  fetchUpcomingEvents,
  connection,
  // Calendar writes / people search
  createMeeting,
  updateMeeting,
  cancelMeeting,
  searchPeople,
  // Callback handler
  handleCalendarCallback,
  // Helpers exposed for safe logging / tests
  redactForLog,
  // Constants the integrations module consumes
  DELEGATED_SCOPES,
  CALLBACK_PATH,
};
