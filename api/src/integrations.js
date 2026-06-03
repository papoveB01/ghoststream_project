// Calendar integrations — "stop the double-entry". Two shapes:
//
//   1. READ an existing calendar via **Nylas** (one connect flow covers
//      Google, Microsoft 365 / Outlook, iCloud, IMAP). The rep clicks
//      "Connect calendar" → Nylas hosted auth → we store a per-(tenant,user)
//      `grant_id`. The schedule form can then list upcoming events and prefill
//      Company / When / Meeting URL / attendees. Needs NYLAS_API_KEY +
//      NYLAS_CLIENT_ID (a Nylas application + a registered callback URI).
//
//   2. RECEIVE from Calendly (internal-use booking links). When a prospect
//      books a slot, Calendly fires an `invitee.created` webhook; we verify
//      the HMAC signature and auto-create a mission from it — zero manual
//      entry. Needs only CALENDLY_WEBHOOK_SIGNING_KEY (no OAuth dance).
//
// Same env-gated pattern as the Omni-Sync providers (Firecrawl / Phyllo) and
// SendGrid: every endpoint reports a clear 503 until its env vars are set.

const crypto = require('crypto');
const express = require('express');
const redis = require('./redis');
const secretbox = require('./secretbox');
const microsoft = require('./microsoft');
const email     = require('./email');
const ics       = require('./ics');
const db        = require('./db');
const gating    = require('./gating');

const APP_BASE_URL =
  process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net';

// Nylas region base — set NYLAS_API_URI to https://api.eu.nylas.com for the
// EU data region. The callback URI must be registered in the Nylas app.
const NYLAS_API_URI = (process.env.NYLAS_API_URI || 'https://api.us.nylas.com').replace(/\/+$/, '');
const NYLAS_CALLBACK_PATH = '/api/integrations/calendar/callback';

function nylasApiKey()  { return process.env.NYLAS_API_KEY  || null; }
function nylasClientId() { return process.env.NYLAS_CLIENT_ID || null; }
function nylasCallbackUri() { return `${APP_BASE_URL}${NYLAS_CALLBACK_PATH}`; }

// Calendly OAuth app + webhook config.
const CALENDLY_API_BASE  = (process.env.CALENDLY_API_BASE  || 'https://api.calendly.com').replace(/\/+$/, '');
const CALENDLY_AUTH_BASE = (process.env.CALENDLY_AUTH_BASE || 'https://auth.calendly.com').replace(/\/+$/, '');
const CALENDLY_CALLBACK_PATH = '/api/integrations/calendly/callback';
const CALENDLY_WEBHOOK_PATH  = '/webhooks/calendly';
function calendlyClientId()     { return process.env.CALENDLY_CLIENT_ID     || null; }
function calendlyClientSecret() { return process.env.CALENDLY_CLIENT_SECRET || null; }
function calendlySigningKey()   { return process.env.CALENDLY_WEBHOOK_SIGNING_KEY || null; }
// Calendly does an exact-match on the redirect URI; override with
// CALENDLY_REDIRECT_URI if what you registered in the app differs from the
// APP_BASE_URL-derived default (e.g. local testing).
function calendlyCallbackUri()  { return (process.env.CALENDLY_REDIRECT_URI && process.env.CALENDLY_REDIRECT_URI.trim()) || `${APP_BASE_URL}${CALENDLY_CALLBACK_PATH}`; }
function calendlyWebhookUri(routeToken) { return `${APP_BASE_URL}${CALENDLY_WEBHOOK_PATH}${routeToken ? '/' + routeToken : ''}`; }

// ── Provider registry (for the admin Integrations page) ───────────────────

const PROVIDERS = [
  {
    key: 'nylas',
    name: 'Calendar',
    icon: '📆',
    mode: 'read', // we read the rep's calendar
    blurb: 'Connect a Google or iCloud calendar (via Nylas). The schedule form then pulls an upcoming event — date, link and attendees fill in automatically.',
    requires: ['NYLAS_API_KEY', 'NYLAS_CLIENT_ID'],
    setup: 'Create a Nylas v3 application, add the callback URI below to its allowed callback URIs, then set NYLAS_API_KEY + NYLAS_CLIENT_ID (and NYLAS_API_URI if your data region is EU) and restart.',
    callbackPath: NYLAS_CALLBACK_PATH,
  },
  {
    key: 'microsoft',
    name: 'Microsoft 365 (direct)',
    icon: '🪟',
    mode: 'read', // per-user delegated calendar reads (Piece A in ADR-0002)
    blurb: 'Connect a Microsoft 365 / Outlook calendar directly via Microsoft Graph. Outlook events + Teams join links prefill the schedule form, and you can generate Teams meetings from it.',
    requires: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET'],
    setup: 'Register a multi-tenant Azure AD application (see .env.example for the exact registration steps), add the redirect URI below to the app, set MS_CLIENT_ID + MS_CLIENT_SECRET and restart. Authenticated Teams meeting joining is a separate one-time operator action on the Recall.ai dashboard — see ADR-0002 §8.',
    callbackPath: microsoft.CALLBACK_PATH,
  },
  {
    key: 'calendly',
    name: 'Calendly',
    icon: '🗓️',
    mode: 'webhook', // Calendly pushes bookings to us
    blurb: 'For internal booking links: when someone books a slot, Calendly notifies us and a mission is created automatically — no form at all.',
    requires: ['CALENDLY_CLIENT_ID', 'CALENDLY_CLIENT_SECRET', 'CALENDLY_WEBHOOK_SIGNING_KEY'],
    setup: 'Create a Calendly OAuth app with scopes webhooks:write + webhooks:read + organizations:read + users:read + scheduled_events:read (the last one is required to subscribe to invitee.created), set its redirect URI to the one below, then set CALENDLY_CLIENT_ID + CALENDLY_CLIENT_SECRET + CALENDLY_WEBHOOK_SIGNING_KEY and restart. "Connect Calendly" then registers the invitee.created webhook for you. (Webhook subscriptions need a Calendly Standard plan or higher.)',
    callbackPath: CALENDLY_CALLBACK_PATH,
    webhookPath: CALENDLY_WEBHOOK_PATH,
  },
];

function envSet(name) {
  return !!(process.env[name] && String(process.env[name]).trim());
}

function isConfigured(key) {
  const p = PROVIDERS.find((x) => x.key === key);
  if (!p) return false;
  return p.requires.every(envSet);
}

// ── Redis: OAuth state (CSRF) + per-user calendar grant ───────────────────

const STATE_TTL_SEC = 600;                       // 10 min — the OAuth round-trip
const GRANT_TTL_SEC = 60 * 60 * 24 * 180;        // 180 days — rolling

function stateKey(s)               { return `cal_state:${s}`; }
function grantKey(tenantId, userId){ return `cal_grant:${tenantId}:${userId}`; }

async function makeOAuthState(tenantId, userId) {
  const s = crypto.randomBytes(24).toString('base64url');
  await redis.set(stateKey(s), JSON.stringify({ tenantId, userId }), 'EX', STATE_TTL_SEC);
  return s;
}
async function consumeOAuthState(s) {
  if (!s) return null;
  const raw = await redis.get(stateKey(s));
  if (raw) await redis.del(stateKey(s));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function saveGrant(tenantId, userId, grant) {
  // Encrypted at rest — holds the calendar OAuth access/refresh tokens.
  await redis.set(grantKey(tenantId, userId), secretbox.sealJson(grant), 'EX', GRANT_TTL_SEC);
}
async function loadGrant(tenantId, userId) {
  const raw = await redis.get(grantKey(tenantId, userId));
  try { return raw ? secretbox.openJson(raw) : null; } catch { return null; }
}
async function deleteGrant(tenantId, userId) {
  await redis.del(grantKey(tenantId, userId));
}

// ── Nylas API helpers ────────────────────────────────────────

// Providers we let a rep connect (must have a matching connector in the Nylas
// app). `outlook` is an alias for `microsoft`; `icloud` for `imap`.
const CALENDAR_PROVIDERS = ['google', 'microsoft', 'imap'];
function normalizeProvider(p) {
  const v = String(p || '').trim().toLowerCase();
  if (v === 'outlook') return 'microsoft';
  if (v === 'icloud')  return 'imap';
  return CALENDAR_PROVIDERS.includes(v) ? v : 'google'; // default: Google
}

// Build the Nylas v3 hosted-auth URL. `provider` is REQUIRED in v3 — without
// it Nylas redirects to a sandbox-warning page that has no working picker and
// dead-ends on nylas.com. We always pass one (defaulting to Google).
function nylasAuthUrl(state, provider) {
  const params = new URLSearchParams({
    client_id: nylasClientId(),
    redirect_uri: nylasCallbackUri(),
    response_type: 'code',
    provider: normalizeProvider(provider),
    access_type: 'offline',
    state,
  });
  return `${NYLAS_API_URI}/v3/connect/auth?${params.toString()}`;
}

// Exchange the hosted-auth `code` for a grant. v3 `POST /v3/connect/token`
// authenticates with the application API key (Bearer) + `client_id` in the
// body — there's no separate client_secret in v3. Returns { grantId, email,
// provider }; falls back to a `GET /v3/grants/{id}` for email/provider if the
// token response didn't carry them.
async function nylasExchangeCode(code) {
  const r = await fetch(`${NYLAS_API_URI}/v3/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${nylasApiKey()}`,
    },
    body: JSON.stringify({
      client_id: nylasClientId(),
      redirect_uri: nylasCallbackUri(),
      code,
      grant_type: 'authorization_code',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Nylas token exchange failed (${r.status}): ${j.error_description || j.error || JSON.stringify(j).slice(0, 200)}`);
  }
  const d = j.data || j;
  const grantId = d.grant_id || null;
  if (!grantId) throw new Error('Nylas token exchange returned no grant_id');
  let email = d.email || null;
  let provider = d.provider || null;
  if (!email || !provider) {
    try {
      const g = await nylasGet(`/v3/grants/${encodeURIComponent(grantId)}`);
      const gd = g.data || g;
      email = email || gd.email || null;
      provider = provider || gd.provider || null;
    } catch { /* non-fatal — we still have the grant id */ }
  }
  return { grantId, email, provider };
}

// Authenticated call against a grant. NYLAS_API_KEY is the application bearer.
async function nylasGet(path) {
  const r = await fetch(`${NYLAS_API_URI}${path}`, {
    headers: { Authorization: `Bearer ${nylasApiKey()}`, Accept: 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Nylas GET ${path} → ${r.status}: ${(j.error && (j.error.message || j.error.type)) || j.message || 'error'}`);
    e.status = r.status;
    throw e;
  }
  return j;
}
async function nylasDelete(path) {
  const r = await fetch(`${NYLAS_API_URI}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${nylasApiKey()}`, Accept: 'application/json' },
  });
  // 200 or 404 (already gone) are both "fine" for our purposes.
  if (!r.ok && r.status !== 404) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`Nylas DELETE ${path} → ${r.status}: ${(j.error && j.error.message) || 'error'}`);
  }
}

// ── Connection status (is this user's calendar connected? as whom?) ───────

async function calendarConnection(tenantId, userId) {
  const g = await loadGrant(tenantId, userId);
  if (!g) return { connected: false };
  return {
    connected: true,
    email: g.email || null,
    provider: g.provider || null,
    connectedAt: g.connectedAt || null,
  };
}

// ── Event listing + normalization ─────────────────────────────────

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

// "acme-corp.com" → "Acme Corp" (best-effort; the rep edits before saving).
function companyNameFromDomain(domain) {
  if (!domain) return null;
  const base = domain.replace(/\.[a-z.]+$/i, '');
  return base.split(/[-_.]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || null;
}

// Nylas v3 `when` object → ISO string for the start. Variants:
//   { object:'timespan', start_time, end_time }   unix seconds
//   { object:'date', date }                        "YYYY-MM-DD"
//   { object:'datespan', start_date, end_date }
function whenToIso(when, which /* 'start'|'end' */) {
  if (!when) return null;
  if (when.object === 'timespan') {
    const sec = which === 'end' ? when.end_time : when.start_time;
    return sec ? new Date(sec * 1000).toISOString() : null;
  }
  if (when.object === 'date')     return when.date ? `${when.date}T00:00:00.000Z` : null;
  if (when.object === 'datespan') return (which === 'end' ? when.end_date : when.start_date) || null;
  // Fallbacks for older shapes
  if (when.start_time) return new Date((which === 'end' ? when.end_time : when.start_time) * 1000).toISOString();
  return null;
}

function conferencingUrl(ev) {
  const c = ev.conferencing || {};
  if (c.details && c.details.url) return c.details.url;
  if (c.url) return c.url;
  if (typeof ev.location === 'string' && /^https?:\/\//.test(ev.location)) return ev.location.trim();
  return null;
}

// Hostnames Recall.ai's bot dispatcher recognises directly. If a meeting URL
// already resolves to one of these, no need to follow redirects.
const RECALL_NATIVE_HOSTS = /(meet\.google\.com|zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|gotomeet(ing)?\.com|whereby\.com|chime\.aws)$/i;

// Calendly serves conferencing links as `/events/{uuid}/{platform}` redirect
// pages — a clean 302 to the real meet.google.com / zoom.us URL. Recall.ai
// can't dispatch a bot against the calendly.com hostname, so resolve once at
// fetch / dispatch time. Also handles short-link wrappers in general (one-hop
// only — we don't chase arbitrary redirect chains).
async function resolveMeetingUrl(url, { timeoutMs = 4000 } = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url;
  let host;
  try { host = new URL(url).hostname; } catch { return url; }
  if (RECALL_NATIVE_HOSTS.test(host)) return url;             // already resolved
  if (!/(^|\.)calendly\.com$/i.test(host)) return url;        // only Calendly for now
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'GhostStream/1.0 (calendar-resolver)' },
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (loc && /^https?:\/\//i.test(loc)) {
        try {
          const lh = new URL(loc).hostname;
          if (RECALL_NATIVE_HOSTS.test(lh)) return loc;
        } catch { /* fall through to original */ }
      }
    }
  } catch (err) {
    // Network/timeout/abort — fall back to the original URL so the picker
    // still shows something. Recall dispatch will then fail loudly with a
    // clear "unsupported URL" message rather than silently swallowing.
    console.warn('[resolveMeetingUrl] failed for', url, '—', err.message);
  } finally {
    clearTimeout(timer);
  }
  return url;
}

// Normalize one Nylas event → a stable shape the frontend understands, plus a
// `suggestion` object pre-derived for the schedule form.
function normalizeEvent(ev, providerHint) {
  const start = whenToIso(ev.when, 'start');
  const end   = whenToIso(ev.when, 'end');
  const url   = conferencingUrl(ev);
  const participants = Array.isArray(ev.participants) ? ev.participants : [];
  const organizerEmail = (ev.organizer && ev.organizer.email) || null;
  // Anyone on the invite who isn't us / a resource room.
  const attendeeEmails = participants
    .map((p) => (p && p.email ? String(p.email).toLowerCase() : null))
    .filter(Boolean);
  // "External" = not from a public-mail provider. First external attendee/
  // organizer domain drives the company guess.
  const externalDomains = [...new Set(
    [...attendeeEmails, organizerEmail].filter(Boolean)
      .map(domainOf).filter((d) => d && !PUBLIC_EMAIL_DOMAINS.has(d))
  )];
  const guessDomain = externalDomains[0] || null;
  // A name for the primary contact: first participant whose email matches the
  // guessed domain (or just the first non-empty participant name).
  let primaryContact = null;
  for (const p of participants) {
    if (!p || !p.email) continue;
    if (guessDomain && domainOf(p.email) === guessDomain && (p.name || '').trim()) { primaryContact = p.name.trim(); break; }
  }
  if (!primaryContact) {
    const named = participants.find((p) => p && (p.name || '').trim());
    if (named) primaryContact = named.name.trim();
  }
  const externalEmails = attendeeEmails.filter((e) => {
    const d = domainOf(e);
    return d && !PUBLIC_EMAIL_DOMAINS.has(d);
  });

  return {
    provider: providerHint || ev.provider || 'calendar',
    id: ev.id || null,
    title: ev.title || ev.subject || '(no title)',
    start, end,
    url,
    location: typeof ev.location === 'string' ? ev.location : null,
    attendees: attendeeEmails,
    organizerEmail,
    // Pre-baked prefill for the schedule form. The rep reviews before saving.
    suggestion: {
      companyName: companyNameFromDomain(guessDomain) || (externalEmails[0] || ''),
      companyDomain: guessDomain || null,
      primaryContact,
      scheduledAt: start,
      meetingUrl: url,
      prospectEmails: externalEmails,
      notes: `Imported from calendar — "${ev.title || ev.subject || 'meeting'}".`,
    },
  };
}

// Upcoming events from the user's connected calendar (next `days` days).
async function fetchUpcomingEvents(tenantId, userId, { days = 14, limit = 30 } = {}) {
  const g = await loadGrant(tenantId, userId);
  if (!g || !g.grantId) { const e = new Error('no calendar connected'); e.status = 409; e.code = 'NOT_CONNECTED'; throw e; }
  const now = Math.floor(Date.now() / 1000);
  const until = now + days * 86400;
  const params = new URLSearchParams({
    calendar_id: 'primary',
    start: String(now),
    end: String(until),
    limit: String(Math.max(1, Math.min(limit, 50))),
    order_by: 'start',
  });
  const j = await nylasGet(`/v3/grants/${encodeURIComponent(g.grantId)}/events?${params.toString()}`);
  const items = Array.isArray(j.data) ? j.data : [];
  return items
    .filter((ev) => (ev.status || '').toLowerCase() !== 'cancelled')
    .map((ev) => normalizeEvent(ev, g.provider))
    .filter((ev) => ev.start) // need a start time to be useful
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

// ── Calendly webhook (unchanged) ──────────────────────────────────

function verifyCalendlyWebhook(rawBody, signatureHeader) {
  const key = process.env.CALENDLY_WEBHOOK_SIGNING_KEY || null;
  if (!key) return false;
  if (!rawBody || !signatureHeader) return false;
  try {
    const parts = Object.fromEntries(
      String(signatureHeader).split(',').map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      })
    );
    const t = parts.t, v1 = parts.v1;
    if (!t || !v1) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const expected = crypto.createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function missionFromCalendlyEvent(payload) {
  const p = payload || {};
  const ev = p.scheduled_event || {};
  const startTime = ev.start_time || null;
  if (!startTime) return null;
  const inviteeEmail = (p.email || '').trim() || null;
  const dom = domainOf(inviteeEmail);
  const externalDomain = dom && !PUBLIC_EMAIL_DOMAINS.has(dom) ? dom : null;
  let companyName = null;
  for (const qa of (p.questions_and_answers || [])) {
    if (/\bcompany|organi[sz]ation\b/i.test(qa.question || '') && (qa.answer || '').trim()) { companyName = qa.answer.trim(); break; }
  }
  if (!companyName) companyName = companyNameFromDomain(externalDomain) || (inviteeEmail || 'Unknown company');
  const loc = ev.location || {};
  const meetingUrl = loc.join_url || (typeof loc.location === 'string' && /^https?:\/\//.test(loc.location) ? loc.location : null) || null;
  const qaNotes = (p.questions_and_answers || []).filter((qa) => (qa.answer || '').trim()).map((qa) => `${qa.question}: ${qa.answer}`).join('\n');
  const notes = [`Booked via Calendly${ev.name ? ` — "${ev.name}"` : ''}.`, qaNotes].filter(Boolean).join('\n');
  return {
    companyName, companyDomain: externalDomain,
    primaryContact: (p.name || '').trim() || null,
    scheduledAt: startTime, meetingUrl,
    prospectEmails: inviteeEmail ? [inviteeEmail] : [],
    productIds: [], personaIds: [], competitorIds: [],
    notes,
  };
}

// ── Calendly OAuth + webhook subscription ───────────────────────────
// Connecting Calendly: OAuth code flow → access token (the token response also
// carries `owner` (user URI) and `organization` (org URI)) → register an
// `invitee.created` webhook subscription on /webhooks/calendly, signed with
// CALENDLY_WEBHOOK_SIGNING_KEY. The token is stored so we can refresh it /
// delete the subscription later; the webhook *receiver* itself needs only the
// signing key.

function calendlyTokenKey(tenantId, userId) { return `caly_token:${tenantId}:${userId}`; }
async function saveCalendlyToken(tenantId, userId, t) {
  // Encrypted at rest — holds the Calendly OAuth access/refresh tokens.
  await redis.set(calendlyTokenKey(tenantId, userId), secretbox.sealJson(t), 'EX', GRANT_TTL_SEC);
}
async function loadCalendlyToken(tenantId, userId) {
  const raw = await redis.get(calendlyTokenKey(tenantId, userId));
  try { return raw ? secretbox.openJson(raw) : null; } catch { return null; }
}
async function deleteCalendlyToken(tenantId, userId) {
  await redis.del(calendlyTokenKey(tenantId, userId));
}

// ── Inbound routing: per-tenant webhook callback URL ──────────────────────
// All Calendly orgs would otherwise POST to the same /webhooks/calendly and we
// could not tell which tenant a booking belongs to (the invitee.created payload
// carries the host user URI but not the organization, and resolving the org
// needs that org's own token — chicken-and-egg). So each tenant's subscription
// is registered at /webhooks/calendly/<routeToken>, and this opaque token maps
// back to the tenant. The shared signing key still gates every delivery, so the
// token need not be secret. The reverse index is persistent and idempotent.
function calendlyRouteKey(routeToken) { return `caly_route:${routeToken}`; }

async function ensureCalendlyRouteToken(tenantId, userId, existing) {
  const routeToken = existing || ('cr_' + crypto.randomBytes(16).toString('hex'));
  await redis.set(calendlyRouteKey(routeToken), JSON.stringify({ tenantId, userId }));
  return routeToken;
}

// Resolve a routeToken from an inbound webhook URL → { tenantId, userId } | null.
async function resolveCalendlyRoute(routeToken) {
  if (!routeToken) return null;
  const raw = await redis.get(calendlyRouteKey(routeToken));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function calendlyAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: calendlyClientId(),
    response_type: 'code',
    redirect_uri: calendlyCallbackUri(),
    state,
  });
  return `${CALENDLY_AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

async function calendlyTokenRequest(form) {
  const r = await fetch(`${CALENDLY_AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly token request failed (${r.status}): ${j.error_description || j.error || JSON.stringify(j).slice(0, 200)}`);
  return j; // { access_token, refresh_token, token_type, expires_in, scope, created_at, owner, organization }
}
function calendlyExchangeCode(code) {
  return calendlyTokenRequest({
    grant_type: 'authorization_code',
    client_id: calendlyClientId(),
    client_secret: calendlyClientSecret(),
    redirect_uri: calendlyCallbackUri(),
    code,
  });
}
function calendlyRefresh(refreshToken) {
  return calendlyTokenRequest({
    grant_type: 'refresh_token',
    client_id: calendlyClientId(),
    client_secret: calendlyClientSecret(),
    refresh_token: refreshToken,
  });
}

async function calendlyApi(accessToken, method, pathOrUrl, body) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${CALENDLY_API_BASE}${pathOrUrl}`;
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && (j.message || j.title)) || `HTTP ${r.status}`;
    const detail = Array.isArray(j && j.details) && j.details.length
      ? ` (${j.details.map((d) => (d && d.message) || JSON.stringify(d)).join('; ')})`
      : '';
    const e = new Error(`Calendly ${method} ${pathOrUrl} → ${msg}${detail}`);
    e.status = r.status; e.details = j;
    throw e;
  }
  return j;
}

// Find an existing invitee.created subscription pointing at our URL, or create
// one. Returns the subscription URI.
async function ensureWebhookSubscription(accessToken, orgUri, routeToken) {
  const want = calendlyWebhookUri(routeToken);
  // List org-scoped subs (best-effort; if listing fails we just try to create).
  try {
    const list = await calendlyApi(accessToken, 'GET',
      `/webhook_subscriptions?organization=${encodeURIComponent(orgUri)}&scope=organization&count=100`);
    const hit = (list.collection || []).find((s) =>
      s.callback_url === want && (s.state ? s.state === 'active' : true) &&
      Array.isArray(s.events) && s.events.includes('invitee.created'));
    if (hit && hit.uri) return hit.uri;
  } catch { /* fall through to create */ }
  const created = await calendlyApi(accessToken, 'POST', '/webhook_subscriptions', {
    url: want,
    events: ['invitee.created'],
    organization: orgUri,
    scope: 'organization',
    signing_key: calendlySigningKey(),
  });
  return (created.resource && created.resource.uri) || null;
}

async function getValidCalendlyToken(tenantId, userId) {
  const t = await loadCalendlyToken(tenantId, userId);
  if (!t) return null;
  if (t.expiresAt && Date.now() < t.expiresAt - 60000) return t.accessToken;
  if (!t.refreshToken) return t.accessToken; // best-effort
  const fresh = await calendlyRefresh(t.refreshToken);
  const updated = {
    ...t,
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token || t.refreshToken,
    expiresAt: fresh.expires_in ? Date.now() + fresh.expires_in * 1000 : null,
  };
  await saveCalendlyToken(tenantId, userId, updated);
  return updated.accessToken;
}

async function calendlyConnection(tenantId, userId) {
  const t = await loadCalendlyToken(tenantId, userId);
  if (!t) return { connected: false };
  return {
    connected: true,
    orgUri: t.orgUri || null,
    webhookActive: !!t.subscriptionUri,
    connectedAt: t.connectedAt || null,
  };
}

// (Re)register the invitee.created webhook for an already-connected account and
// persist the result. webhookActive is derived from the stored subscriptionUri,
// which is captured once at connect time — so if registration failed back then
// (e.g. the webhooks:write scope was added to the OAuth app afterwards) the
// status stays frozen "inactive" with no way to recover short of disconnecting.
// This lets the user retry registration in place. Throws Calendly's own error
// (scope/plan/etc) so the UI can show the real reason.
// NB: named registerCalendlyWebhook, NOT verifyCalendlyWebhook — the latter is
// the HMAC signature verifier (above), exported and used by the receiver.
async function registerCalendlyWebhook(tenantId, userId) {
  const t = await loadCalendlyToken(tenantId, userId);
  if (!t) { const e = new Error('Calendly not connected'); e.code = 'NOT_CONNECTED'; e.status = 409; throw e; }
  if (!t.orgUri) {
    const e = new Error('Stored Calendly token has no organization URI — disconnect and reconnect.');
    e.status = 409; throw e;
  }
  const routeToken = await ensureCalendlyRouteToken(tenantId, userId, t.routeToken);
  // Persist the routeToken up front so a retry after a failed registration
  // (e.g. Calendly plan-tier rejection) reuses it instead of orphaning a new
  // route-index entry on every attempt.
  if (routeToken !== t.routeToken) await saveCalendlyToken(tenantId, userId, { ...t, routeToken });
  const accessToken = await getValidCalendlyToken(tenantId, userId);
  const subscriptionUri = await ensureWebhookSubscription(accessToken, t.orgUri, routeToken);
  await saveCalendlyToken(tenantId, userId, { ...t, routeToken, subscriptionUri });
  return subscriptionUri;
}

// ── Microsoft 365 (direct Graph) ──────────────────────────────────────────
// Per-user delegated OAuth + calendar reads. Module-level Microsoft API
// logic lives in api/src/microsoft.js; this file owns only the route surface.
//
// Authenticated Teams meeting joining (for meetings that disable
// anonymous-join) is a SEPARATE concern, handled by configuring a Microsoft
// user account in the Recall.ai dashboard — one-time operator action, not an
// in-app flow. See ADR-0002 §8 for why that ended up dashboard-only.

// microsoft.connection already returns { connected, email, name, msTenantId, connectedAt }.
// We re-export through this name for symmetry with calendarConnection /
// calendlyConnection, in case future shape additions need to wrap it.
const microsoftConnection = (tenantId, userId) => microsoft.connection(tenantId, userId);

// Public callback (mounted UN-authed in index.js) — MS's cookieless redirect
// can't carry the session cookie, so the state token in Redis is the only
// thing binding the response to (tenantId, userId).
async function handleMicrosoftCallback(req, res) {
  return microsoft.handleCalendarCallback(req, res);
}

// Send a branded GhostStream meeting invite via SendGrid with the .ics
// attachment. The rep's M365 mailbox is intentionally NOT used for delivery
// (ADR-0002 §10). Reply-To is the rep's email so prospects' "can we push by
// 30?" lands in the rep's inbox, not in our no-reply.
//
// method = 'REQUEST' (create / update) | 'CANCEL' (event was cancelled).
// sequence is the RFC 5545 SEQUENCE number — must monotonically increase
// for the same UID so Outlook & co. treat updates as replacements rather
// than duplicates.
//
// Returns { sent: [{ email, ok, messageId|reason }], totalAttempted, branding }
// so the UI can surface per-attendee success/failure.
async function sendBrandedInvite({ created, body, replyTo, sequence = 0, method = 'REQUEST' }) {
  const attendees = Array.isArray(created.attendees) ? created.attendees : [];
  const branding = {
    fromEmail: process.env.MEETINGS_FROM_EMAIL || 'meetings@eel-global.com',
    fromName:  process.env.MEETINGS_FROM_NAME  || 'GhostStream Meetings',
    replyTo:   process.env.MEETINGS_REPLY_TO || replyTo || null,
  };
  // Refuse to silently swallow the invite step when SendGrid isn't set up;
  // surface a clear partial-success to the UI so the rep knows to resend
  // manually instead of assuming the prospect got the invite.
  if (!email.isConfigured()) {
    return {
      sent: attendees.map((a) => ({ email: a.email, ok: false, reason: 'SendGrid not configured — set SENDGRID_API_KEY' })),
      totalAttempted: attendees.length,
      branding,
    };
  }
  if (attendees.length === 0) {
    return { sent: [], totalAttempted: 0, branding };
  }

  // Build the ICS once — same body for every recipient. UID is per-event
  // (Microsoft's iCalUId is stable and unique).
  const description = body && body.trim()
    ? `${body.trim()}\n\nJoin the Teams meeting: ${created.joinUrl}`
    : `Join the Teams meeting: ${created.joinUrl}`;
  const icsBody = ics.buildInvite({
    uid: created.iCalUId || `${created.eventId}@ghoststream`,
    subject: method === 'CANCEL' ? `Cancelled: ${created.subject}` : created.subject,
    description,
    location: created.joinUrl,
    start: created.startISO,
    end:   created.endISO,
    organizer: { email: branding.fromEmail, name: branding.fromName },
    attendees: attendees.map((a) => ({ email: a.email, name: a.name || null })),
    sequence,
    method,
  });
  const attachment = ics.asAttachment(icsBody, 'invite.ics');

  // HTML body — minimal, scannable. The .ics is what actually creates the
  // calendar entry; this body is the "preview" surface in inbox lists.
  const startLocal = new Date(created.startISO).toUTCString();
  const htmlBody = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">
      <p>You're invited to <strong>${escapeHtmlEntity(created.subject)}</strong></p>
      <p><strong>When:</strong> ${escapeHtmlEntity(startLocal)}</p>
      <p><strong>Where:</strong> <a href="${escapeAttr(created.joinUrl)}">Microsoft Teams meeting</a></p>
      ${body && body.trim() ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0"><div>${nl2br(escapeHtmlEntity(body.trim()))}</div>` : ''}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0">
      <p style="font-size:12px;color:#6b7280">Sent via GhostStream. Reply to this email to reach the meeting organizer.</p>
    </div>
  `;
  const textBody = [
    `You're invited to ${created.subject}`,
    `When: ${startLocal}`,
    `Join the Teams meeting: ${created.joinUrl}`,
    body && body.trim() ? `\n${body.trim()}` : '',
  ].filter(Boolean).join('\n');

  const sent = [];
  // Send one message per attendee so SendGrid records per-recipient status
  // and so each recipient sees themselves as the sole `to:` (cleaner inbox UX
  // than a To: list of every prospect on every other call we run).
  for (const a of attendees) {
    try {
      const r = await email.send({
        to: a.email,
        from: { email: branding.fromEmail, name: branding.fromName },
        subject: method === 'CANCEL' ? `Cancelled: ${created.subject}` : created.subject,
        html: htmlBody,
        text: textBody,
        replyTo: branding.replyTo || undefined,
        categories: [method === 'CANCEL' ? 'meeting-cancel' : 'meeting-invite'],
        customArgs: { eventId: created.eventId || '' },
        attachments: [attachment],
      });
      sent.push({ email: a.email, ok: true, messageId: r.messageId || null });
    } catch (err) {
      sent.push({ email: a.email, ok: false, reason: err.message });
    }
  }
  return { sent, totalAttempted: attendees.length, branding };
}

// Local HTML escapers — kept separate from web/ helpers since this is server
// side only and we don't pull a templating dep just for two functions.
function escapeHtmlEntity(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtmlEntity(s); }
function nl2br(s) { return String(s || '').replace(/\r?\n/g, '<br>'); }

// Normalize one Calendly scheduled event (+ its first invitee) → the same
// shape `/calendar/events` returns, so the schedule-form picker handles both.
// Reuses `missionFromCalendlyEvent` for the `suggestion` by synthesizing a
// webhook-payload-shaped object from the event + invitee.
async function normalizeCalendlyScheduledEvent(ev, invitee) {
  const synth = {
    email: (invitee && invitee.email) || null,
    name:  (invitee && invitee.name)  || null,
    scheduled_event: ev,
    questions_and_answers: (invitee && invitee.questions_and_answers) || [],
  };
  const s = missionFromCalendlyEvent(synth) || {};
  const loc = ev.location || {};
  const rawUrl = loc.join_url || (typeof loc.location === 'string' && /^https?:\/\//.test(loc.location) ? loc.location : null) || null;
  // Calendly's join_url for google_conference / zoom etc. is a calendly.com
  // redirect page — resolve once so the form (and Recall.ai dispatch) gets
  // the canonical meet.google.com / zoom.us URL.
  const url = rawUrl ? await resolveMeetingUrl(rawUrl) : null;
  const hostEmail = ((ev.event_memberships || [])[0] || {}).user_email || null;
  return {
    provider: 'calendly',
    id: String(ev.uri || '').split('/').pop() || null,
    title: ev.name || '(no title)',
    start: ev.start_time || null,
    end: ev.end_time || null,
    url,
    location: typeof loc.location === 'string' ? loc.location : (loc.type || null),
    attendees: invitee && invitee.email ? [invitee.email] : [],
    organizerEmail: hostEmail,
    suggestion: {
      companyName:    s.companyName || (invitee && invitee.email) || '',
      companyDomain:  s.companyDomain || null,
      primaryContact: s.primaryContact || (invitee && invitee.name) || null,
      scheduledAt:    s.scheduledAt || ev.start_time || null,
      // Prefer the resolved url (`url`) over s.meetingUrl since the synth
      // path doesn't run the resolver.
      meetingUrl:     url || s.meetingUrl || rawUrl,
      prospectEmails: (s.prospectEmails && s.prospectEmails.length) ? s.prospectEmails : (invitee && invitee.email ? [invitee.email] : []),
      notes:          s.notes || `Imported from Calendly — "${ev.name || 'meeting'}".`,
    },
  };
}

// Upcoming Calendly-booked events for the schedule-form picker. Needs the
// `scheduled_events:read` scope on the Calendly app.
async function fetchUpcomingCalendlyEvents(tenantId, userId, { days = 30, limit = 20 } = {}) {
  const t = await loadCalendlyToken(tenantId, userId);
  if (!t || !t.ownerUri) { const e = new Error('Calendly not connected'); e.status = 409; e.code = 'NOT_CONNECTED'; throw e; }
  const token = await getValidCalendlyToken(tenantId, userId);
  if (!token) { const e = new Error('Calendly token unavailable'); e.status = 409; e.code = 'NOT_CONNECTED'; throw e; }
  const now = new Date();
  const max = new Date(now.getTime() + days * 86400000);
  const params = new URLSearchParams({
    user: t.ownerUri,
    min_start_time: now.toISOString(),
    max_start_time: max.toISOString(),
    status: 'active',
    sort: 'start_time:asc',
    count: String(Math.max(1, Math.min(limit, 100))),
  });
  const list = await calendlyApi(token, 'GET', `/scheduled_events?${params.toString()}`);
  const events = (Array.isArray(list.collection) ? list.collection : []).slice(0, limit);
  const out = await Promise.all(events.map(async (ev) => {
    const uuid = String(ev.uri || '').split('/').pop();
    let invitee = null;
    if (uuid) {
      try {
        const inv = await calendlyApi(token, 'GET', `/scheduled_events/${encodeURIComponent(uuid)}/invitees?count=5&status=active`);
        invitee = (Array.isArray(inv.collection) ? inv.collection : [])[0] || null;
      } catch { /* invitee may be unreadable — proceed with event-only data */ }
    }
    return normalizeCalendlyScheduledEvent(ev, invitee);
  }));
  return out.filter((e) => e.start);
}

// Public callback (mounted UN-authed in index.js): Calendly redirects the
// browser here after consent: ?code=...&state=...
async function handleCalendlyCallback(req, res) {
  const finish = (k, v) => res.redirect(`/admin/?${k}=${encodeURIComponent(v)}#integrations`);
  try {
    if (!isConfigured('calendly')) return finish('cal_error', 'Calendly not configured');
    const { code, state, error, error_description } = req.query || {};
    if (error) return finish('cal_error', error_description || error);
    if (!code || !state) return finish('cal_error', 'missing code/state');
    const st = await consumeOAuthState(state);
    if (!st) return finish('cal_error', 'state expired — please try connecting again');
    const tok = await calendlyExchangeCode(code);
    const orgUri = tok.organization || null;
    // Per-tenant callback token so inbound bookings route back to THIS tenant
    // (see ensureCalendlyRouteToken). Reuse the existing one if reconnecting.
    const prior = await loadCalendlyToken(st.tenantId, st.userId);
    const routeToken = await ensureCalendlyRouteToken(st.tenantId, st.userId, prior && prior.routeToken);
    let subscriptionUri = null;
    let subErr = null;
    if (orgUri) {
      try { subscriptionUri = await ensureWebhookSubscription(tok.access_token, orgUri, routeToken); }
      catch (e) { subErr = e; console.warn('[calendly] webhook subscription failed:', e.message); }
    } else {
      subErr = new Error('token response had no organization URI');
    }
    await saveCalendlyToken(st.tenantId, st.userId, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
      ownerUri: tok.owner || null,
      orgUri,
      routeToken,
      subscriptionUri,
      connectedAt: new Date().toISOString(),
    });
    if (!subscriptionUri) {
      // Distinguish the well-known Calendry-plan-tier limitation from real
      // failures so we point the user at the right next step. On Free tier
      // the picker on the schedule form is the supported workflow.
      const msg = subErr ? String(subErr.message || subErr) : 'unknown';
      const isPlanTier = /upgrade.*standard|standard\s+plan|standard\s+account|paid\s+plan/i.test(msg);
      const friendly = isPlanTier
        ? `connected — but Calendly auto-create requires a Standard plan, so we couldn't register the invitee.created webhook. Use "🗓️ From Calendly" on the schedule form to import bookings into missions on demand.`
        : `connected, but the invitee.created webhook couldn't be registered (${msg}) — bookings won't auto-create missions yet`;
      // Plan-tier limitation isn't an error per se — flag it as a notice so
      // the admin page renders it in the green "connected" lane.
      return finish(isPlanTier ? 'cal_notice' : 'cal_error', friendly);
    }
    return finish('cal', 'connected');
  } catch (err) {
    console.error('[calendly-callback]', err.stack || err.message);
    return finish('cal_error', err.message || 'connect failed');
  }
}

// ── Status payload for the admin page ────────────────────────────────

async function statusPayload(tenantId, userId) {
  const [calConn, calyConn, msConn] = await Promise.all([
    calendarConnection(tenantId, userId),
    calendlyConnection(tenantId, userId),
    microsoftConnection(tenantId, userId),
  ]);
  return {
    providers: PROVIDERS.map((p) => ({
      key: p.key, name: p.name, icon: p.icon, mode: p.mode, blurb: p.blurb, setup: p.setup,
      configured: p.requires.every(envSet),
      requires: p.requires.map((name) => ({ name, set: envSet(name) })),
      // The effective redirect/callback URI to register in the provider's
      // console (Calendly honours CALENDLY_REDIRECT_URI; Nylas uses APP_BASE_URL;
      // Microsoft honours MS_REDIRECT_URI via microsoft.redirectUri()).
      callbackUri: p.key === 'calendly'  ? calendlyCallbackUri()
                 : p.key === 'microsoft' ? microsoft.redirectUri()
                 : p.callbackPath ? `${APP_BASE_URL}${p.callbackPath}` : null,
      webhookUrl:  p.webhookPath  ? `${APP_BASE_URL}${p.webhookPath}`  : null,
      // Per-user connection state (Nylas grant / Calendly OAuth token /
      // Microsoft delegated grant).
      connection: p.key === 'nylas'     ? calConn
                : p.key === 'calendly'  ? calyConn
                : p.key === 'microsoft' ? msConn
                : null,
    })),
  };
}

// ── Public callback handler (mounted UN-authed in index.js) ───────────────
// Nylas redirects the browser here after hosted auth: ?code=...&state=...

async function handleCalendarCallback(req, res) {
  const finish = (queryKey, val) => res.redirect(`/admin/?${queryKey}=${encodeURIComponent(val)}#integrations`);
  try {
    if (!isConfigured('nylas')) return finish('cal_error', 'Nylas not configured');
    const { code, state, error, error_description } = req.query || {};
    if (error) return finish('cal_error', error_description || error);
    if (!code || !state) return finish('cal_error', 'missing code/state');
    const st = await consumeOAuthState(state);
    if (!st) return finish('cal_error', 'state expired — please try connecting again');
    const grant = await nylasExchangeCode(code);
    await saveGrant(st.tenantId, st.userId, {
      grantId: grant.grantId,
      email: grant.email,
      provider: grant.provider,
      connectedAt: new Date().toISOString(),
    });
    return finish('cal', 'connected');
  } catch (err) {
    console.error('[nylas-callback]', err.stack || err.message);
    return finish('cal_error', err.message || 'connect failed');
  }
}

// ── Router (mounted at /api/integrations behind authMiddleware) ────────────

const router = express.Router();
router.use(express.json());

// GET /api/integrations/calendar — provider statuses + this user's connection.
router.get('/calendar', async (req, res, next) => {
  try { res.json(await statusPayload(req.tenantId, req.user.sub)); }
  catch (err) { next(err); }
});

// GET /api/integrations/calendar/connect — start the Nylas hosted-auth flow.
// 302-redirects the browser to Nylas; the browser carries the session cookie
// on this top-level navigation, so authMiddleware has already run.
router.get('/calendar/connect', async (req, res, next) => {
  try {
    if (!isConfigured('nylas')) {
      return res.status(503).json({ error: 'Calendar (Nylas) not configured — set NYLAS_API_KEY + NYLAS_CLIENT_ID.', code: 'NOT_CONFIGURED' });
    }
    const state = await makeOAuthState(req.tenantId, req.user.sub);
    res.redirect(nylasAuthUrl(state, req.query.provider));
  } catch (err) { next(err); }
});

// DELETE /api/integrations/calendar/connection — revoke + forget the grant.
router.delete('/calendar/connection', async (req, res, next) => {
  try {
    const g = await loadGrant(req.tenantId, req.user.sub);
    if (g && g.grantId && isConfigured('nylas')) {
      try { await nylasDelete(`/v3/grants/${encodeURIComponent(g.grantId)}`); } catch (e) { /* best-effort */ }
    }
    await deleteGrant(req.tenantId, req.user.sub);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/integrations/calendar/events?days=14 — upcoming events for the
// schedule-form picker. 409 (with code) when no calendar is connected so the
// UI can prompt the rep to connect one.
router.get('/calendar/events', async (req, res, next) => {
  try {
    if (!isConfigured('nylas')) {
      return res.status(503).json({ error: 'Calendar (Nylas) not configured.', code: 'NOT_CONFIGURED' });
    }
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 14, 60));
    const events = await fetchUpcomingEvents(req.tenantId, req.user.sub, { days });
    res.json({ events });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.status === 409) {
      return res.status(409).json({ error: 'No calendar connected — connect one on the Integrations page.', code: 'NOT_CONNECTED' });
    }
    next(err);
  }
});

// GET /api/integrations/calendly/connect — start the Calendly OAuth flow.
// Multi-tenant: each tenant's webhook is registered at a per-tenant callback
// URL (/webhooks/calendly/<routeToken>) so inbound bookings route back to the
// connecting tenant. No Founders-only restriction.
router.get('/calendly/connect', gating.requireFeature('calendly'), async (req, res, next) => {
  try {
    if (!isConfigured('calendly')) {
      return res.status(503).json({ error: 'Calendly not configured — set CALENDLY_CLIENT_ID + CALENDLY_CLIENT_SECRET + CALENDLY_WEBHOOK_SIGNING_KEY.', code: 'NOT_CONFIGURED' });
    }
    const state = await makeOAuthState(req.tenantId, req.user.sub);
    res.redirect(calendlyAuthUrl(state));
  } catch (err) { next(err); }
});

// GET /api/integrations/calendly/events?days=30 — upcoming Calendly-booked
// events for the schedule-form picker. 409 (with code) when Calendly isn't
// connected so the UI can prompt the rep to connect it.
router.get('/calendly/events', async (req, res, next) => {
  try {
    if (!isConfigured('calendly')) {
      return res.status(503).json({ error: 'Calendly not configured.', code: 'NOT_CONFIGURED' });
    }
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 90));
    const events = await fetchUpcomingCalendlyEvents(req.tenantId, req.user.sub, { days });
    res.json({ events });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.status === 409) {
      return res.status(409).json({ error: 'Calendly not connected — connect it on the Integrations page.', code: 'NOT_CONNECTED' });
    }
    next(err);
  }
});

// POST /api/integrations/calendly/verify — (re)register the invitee.created
// webhook for an already-connected account and refresh the stored status.
// Recovers the case where registration failed at connect time (most commonly:
// the webhooks:write scope was granted to the OAuth app after connecting).
router.post('/calendly/verify', gating.requireFeature('calendly'), async (req, res, next) => {
  try {
    if (!isConfigured('calendly')) {
      return res.status(503).json({ error: 'Calendly not configured.', code: 'NOT_CONFIGURED' });
    }
    const uri = await registerCalendlyWebhook(req.tenantId, req.user.sub);
    if (!uri) {
      return res.status(502).json({ error: 'Calendly accepted the request but returned no subscription URI.' });
    }
    res.json({ ok: true, webhookActive: true });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED') {
      return res.status(409).json({ error: err.message, code: 'NOT_CONNECTED' });
    }
    // Surface Calendly's own error text (scope / plan tier / etc) to the UI.
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: err.message || 'webhook registration failed' });
  }
});

// DELETE /api/integrations/calendly/connection — delete the webhook
// subscription (best-effort) and forget the stored token.
router.delete('/calendly/connection', async (req, res, next) => {
  try {
    const t = await loadCalendlyToken(req.tenantId, req.user.sub);
    if (t && t.subscriptionUri) {
      try {
        const tok = await getValidCalendlyToken(req.tenantId, req.user.sub);
        if (tok) await calendlyApi(tok, 'DELETE', t.subscriptionUri);
      } catch (e) { /* best-effort */ }
    }
    if (t && t.routeToken) {
      try { await redis.del(calendlyRouteKey(t.routeToken)); } catch (e) { /* best-effort */ }
    }
    await deleteCalendlyToken(req.tenantId, req.user.sub);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Microsoft 365 (direct) routes ─────────────────────────────────────────

// GET /api/integrations/microsoft/connect — start the per-user delegated
// OAuth flow for the rep's calendar.
router.get('/microsoft/connect', async (req, res, next) => {
  try {
    if (!microsoft.isConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 (direct) not configured — set MS_CLIENT_ID + MS_CLIENT_SECRET.', code: 'NOT_CONFIGURED' });
    }
    const state = await microsoft.makeOAuthState(req.tenantId, req.user.sub, 'calendar');
    res.redirect(microsoft.authUrl(state));
  } catch (err) { next(err); }
});

// GET /api/integrations/microsoft/events?days=14 — upcoming events from the
// rep's Microsoft 365 calendar. Same shape as /calendar/events so the picker
// is provider-agnostic.
router.get('/microsoft/events', async (req, res, next) => {
  try {
    if (!microsoft.isConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 (direct) not configured.', code: 'NOT_CONFIGURED' });
    }
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 14, 60));
    const events = await microsoft.fetchUpcomingEvents(req.tenantId, req.user.sub, { days });
    res.json({ events });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.status === 409) {
      return res.status(409).json({ error: 'Microsoft 365 not connected — connect it on the Integrations page.', code: 'NOT_CONNECTED' });
    }
    next(err);
  }
});

// DELETE /api/integrations/microsoft/connection — forget the per-user grant.
router.delete('/microsoft/connection', async (req, res, next) => {
  try {
    await microsoft.deleteGrant(req.tenantId, req.user.sub);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/integrations/microsoft/meetings — create a Teams meeting + the
// Outlook event that wraps it. The event's attendees get an invite from
// Microsoft on our behalf. Returns the joinUrl the caller writes into the
// mission's meeting_url.
//
// Body: { subject, startISO, endISO, attendees: [string|{email,name}], body }
router.post('/microsoft/meetings', async (req, res, next) => {
  try {
    if (!microsoft.isConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 (direct) not configured.', code: 'NOT_CONFIGURED' });
    }
    const { subject, startISO, endISO, attendees, body } = req.body || {};
    const created = await microsoft.createTeamsMeeting(req.tenantId, req.user.sub, {
      subject, startISO, endISO, attendees, body,
    });
    // Send the branded invite via SendGrid. Failure here doesn't unmake the
    // meeting — the rep already has it on their calendar with a working
    // joinUrl. We return per-attendee status so the UI can surface partial
    // failures and the rep knows whether to resend manually.
    const invite = await sendBrandedInvite({
      created, body,
      replyTo: created.organizerEmail,
      replyToName: created.organizerName,
    });
    res.json({ ...created, invite });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.status === 409) {
      return res.status(409).json({ error: 'Microsoft 365 not connected — connect it on the Integrations page.', code: 'NOT_CONNECTED' });
    }
    // Consent-required: typically AADSTS65001 / AADSTS50079 from the token
    // endpoint, OR Graph 403 with code Authorization_RequestDenied when the
    // access token doesn't carry the new scopes. Both mean "disconnect +
    // reconnect to grant the new permissions". Distinguishing them is fine
    // for logs but the UI does the same thing in either case.
    const msg = String(err.message || '');
    if (/AADSTS6500\d|AADSTS50079|consent_required|interaction_required/i.test(msg)
        || (err.status === 403 && /Authorization_RequestDenied|access_denied/i.test(msg))) {
      return res.status(401).json({
        error: 'Reconnect Microsoft 365 to grant the new permissions — your existing connection was made before meeting creation was enabled.',
        code: 'CONSENT_REQUIRED',
      });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    // 403 from Graph for any other reason — typically the rep's tenant
    // policy blocks creating external-attendee invites or Teams online
    // meetings. Surface the message so the UI can guide the rep.
    if (err.status === 403) {
      return res.status(403).json({ error: `Microsoft Graph refused: ${err.message}`, code: 'GRAPH_FORBIDDEN' });
    }
    next(err);
  }
});

// PATCH /api/integrations/microsoft/meetings/:eventId — edit a previously
// created Teams meeting. Body shape mirrors POST (subject / startISO /
// endISO / attendees / body). The mission row linked by ms_event_id is
// updated (scheduled_at, meeting_url, prospect_emails, ms_sequence++) and
// a SEQUENCE-bumped update .ics is sent via SendGrid to current attendees.
// Removed attendees get a separate METHOD:CANCEL .ics so their calendar
// drops the event. See ADR-0002 §10/§11.
router.patch('/microsoft/meetings/:eventId', async (req, res, next) => {
  try {
    if (!microsoft.isConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 (direct) not configured.', code: 'NOT_CONFIGURED' });
    }
    const eventId = String(req.params.eventId);
    const { subject, startISO, endISO, attendees, body } = req.body || {};
    const mission = await loadMissionByMsEvent(req.tenantId, eventId);
    if (!mission) return res.status(404).json({ error: 'No mission found for this Graph event id.', code: 'NOT_FOUND' });

    const updated = await microsoft.updateTeamsMeeting(req.tenantId, req.user.sub, eventId, {
      subject, startISO, endISO, body,
    });

    const newAttendees = normalizeAttendees(attendees);
    const newEmails = newAttendees.map((a) => a.email.toLowerCase());
    const prevEmails = (mission.ms_attendee_emails || []).map((e) => String(e).toLowerCase());
    const removed = prevEmails.filter((e) => !newEmails.includes(e));

    const nextSequence = (mission.ms_sequence || 0) + 1;
    await db.query(
      `UPDATE scheduled_meetings
          SET scheduled_at        = COALESCE($2, scheduled_at),
              meeting_url         = COALESCE($3, meeting_url),
              prospect_emails     = $4,
              ms_attendee_emails  = $5,
              ms_sequence         = $6,
              updated_at          = now()
        WHERE id = $1 AND tenant_id = $7`,
      [
        mission.id,
        updated.startISO || null,
        updated.joinUrl  || null,
        newEmails,
        newEmails,
        nextSequence,
        req.tenantId,
      ]
    );

    // Send the update (bumped SEQUENCE) to everyone still on the invite.
    const updateResult = await sendBrandedInvite({
      created: {
        ...updated,
        attendees: newAttendees,
        // Reuse the iCalUId so this is recognised as the same event, just
        // updated. Outlook keys off UID + SEQUENCE to do the replace.
        iCalUId: mission.ms_ical_uid || updated.iCalUId,
      },
      body,
      replyTo: updated.organizerEmail || mission.ms_organizer_email,
      sequence: nextSequence,
      method: 'REQUEST',
    });

    // Send a CANCEL .ics to anyone we just dropped from the attendees list.
    let cancelResult = { sent: [], totalAttempted: 0 };
    if (removed.length > 0) {
      cancelResult = await sendBrandedInvite({
        created: {
          ...updated,
          attendees: removed.map((email) => ({ email, name: null })),
          iCalUId: mission.ms_ical_uid || updated.iCalUId,
        },
        body,
        replyTo: updated.organizerEmail || mission.ms_organizer_email,
        sequence: nextSequence,
        method: 'CANCEL',
      });
    }

    res.json({
      ...updated,
      invite: updateResult,
      cancelledForRemoved: cancelResult,
    });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.status === 409) {
      return res.status(409).json({ error: 'Microsoft 365 not connected.', code: 'NOT_CONNECTED' });
    }
    if (err.status === 404) {
      return res.status(404).json({ error: 'Outlook event no longer exists.', code: 'EVENT_GONE' });
    }
    next(err);
  }
});

// DELETE /api/integrations/microsoft/meetings/:eventId — cancel the Outlook
// event + send a METHOD:CANCEL .ics to the last-known attendee list. The
// linked mission row is updated (ms_event_id cleared, status=CANCELLED) so
// the detail UI stops offering Edit / Cancel.
router.delete('/microsoft/meetings/:eventId', async (req, res, next) => {
  try {
    if (!microsoft.isConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 (direct) not configured.', code: 'NOT_CONFIGURED' });
    }
    const eventId = String(req.params.eventId);
    const mission = await loadMissionByMsEvent(req.tenantId, eventId);
    if (!mission) return res.status(404).json({ error: 'No mission found for this Graph event id.', code: 'NOT_FOUND' });

    let graphResult;
    try {
      graphResult = await microsoft.cancelTeamsMeeting(req.tenantId, req.user.sub, eventId);
    } catch (err) {
      // 404 = already gone; keep going to clean up our side.
      if (err.status === 404) graphResult = { eventId, deleted: false, alreadyGone: true };
      else throw err;
    }

    const nextSequence = (mission.ms_sequence || 0) + 1;
    const lastAttendees = (mission.ms_attendee_emails || []).map((e) => ({ email: String(e), name: null }));

    const cancelResult = await sendBrandedInvite({
      created: {
        eventId,
        iCalUId: mission.ms_ical_uid || `${eventId}@ghoststream`,
        joinUrl: mission.meeting_url || '',
        subject: 'Meeting cancelled',
        startISO: (mission.scheduled_at instanceof Date ? mission.scheduled_at : new Date(mission.scheduled_at)).toISOString(),
        endISO:   new Date(new Date(mission.scheduled_at).getTime() + 30 * 60_000).toISOString(),
        organizerEmail: mission.ms_organizer_email,
        attendees: lastAttendees,
      },
      body: 'This meeting has been cancelled.',
      replyTo: mission.ms_organizer_email,
      sequence: nextSequence,
      method: 'CANCEL',
    });

    await db.query(
      `UPDATE scheduled_meetings
          SET status              = 'CANCELLED',
              ms_event_id         = NULL,
              ms_sequence         = $2,
              updated_at          = now()
        WHERE id = $1 AND tenant_id = $3`,
      [mission.id, nextSequence, req.tenantId]
    );

    res.json({
      ...graphResult,
      invite: cancelResult,
      missionId: mission.id,
    });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.status === 409) {
      return res.status(409).json({ error: 'Microsoft 365 not connected.', code: 'NOT_CONNECTED' });
    }
    next(err);
  }
});

// Lookup helper: the only way the routes above know which mission row to
// update is by the Graph event id. Scoped to the caller's tenant — we never
// reach across tenants.
async function loadMissionByMsEvent(tenantId, eventId) {
  const r = await db.query(
    `SELECT id, tenant_id, scheduled_at, meeting_url, prospect_emails,
            ms_event_id, ms_ical_uid, ms_organizer_email, ms_attendee_emails, ms_sequence
       FROM scheduled_meetings
      WHERE ms_event_id = $1 AND tenant_id = $2
      LIMIT 1`,
    [eventId, tenantId]
  );
  return r.rows[0] || null;
}

function normalizeAttendees(attendees) {
  return (Array.isArray(attendees) ? attendees : [])
    .map((a) => (typeof a === 'string' ? { email: a } : a))
    .filter((a) => a && typeof a.email === 'string' && /@/.test(a.email))
    .map((a) => ({ email: a.email.trim(), name: (a.name || '').trim() || null }));
}

// GET /api/integrations/microsoft/contacts?q=... — relevance-ranked contacts
// from /me/people. Used by the meeting-creation form's attendees autocomplete.
router.get('/microsoft/contacts', async (req, res, next) => {
  try {
    if (!microsoft.isConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 (direct) not configured.', code: 'NOT_CONFIGURED' });
    }
    const q = String(req.query.q || '').trim();
    const contacts = await microsoft.searchPeople(req.tenantId, req.user.sub, q);
    res.json({ contacts });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.status === 409) {
      return res.status(409).json({ error: 'Microsoft 365 not connected.', code: 'NOT_CONNECTED' });
    }
    next(err);
  }
});

module.exports = {
  router,
  handleCalendarCallback,
  handleCalendlyCallback,
  handleMicrosoftCallback,
  isConfigured,
  statusPayload,
  verifyCalendlyWebhook,
  resolveCalendlyRoute,
  missionFromCalendlyEvent,
  resolveMeetingUrl,
};
