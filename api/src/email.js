// SendGrid transactional email — connection layer only.
//
// Flows (pre-call brief, post-call follow-up, portal link, brief-failure alert)
// will be wired into mission/portal pipelines in a follow-up sprint. This
// module owns the SDK init, env validation, a key-verification probe, and a
// generic send() helper. Nothing here fires automatically.
//
// Sender authentication: domain `eel-global.com` is authenticated in SendGrid
// (DKIM/SPF/Return-Path CNAMEs). All From: addresses MUST use that domain or
// SendGrid will reject the message with 403/550.

const sg = require('@sendgrid/mail');

const API_BASE = 'https://api.sendgrid.com/v3';
const PROBE_TIMEOUT_MS = parseInt(process.env.SENDGRID_PROBE_TIMEOUT_MS || '8000', 10);

// One-time client init guarded by isConfigured() — getClient() pattern so a
// missing key only blows up the first time mail is actually sent, not at
// module load. Matches the lazy-getClient style used in gemini.js / web.js.
let _initialized = false;
function init() {
  if (_initialized) return;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SENDGRID_API_KEY not set');
  sg.setApiKey(key);
  _initialized = true;
}

function isConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);
}

function fromAddress() {
  return {
    email: process.env.SENDGRID_FROM_EMAIL || 'no-reply@eel-global.com',
    name:  process.env.SENDGRID_FROM_NAME  || 'GhostStream',
  };
}

function replyTo() {
  const addr = process.env.SENDGRID_REPLY_TO;
  return addr ? { email: addr } : null;
}

// Hit SendGrid's /v3/user/profile to validate the API key without sending a
// message. Returns { ok, status, scopes? } — never throws on auth failure,
// returns { ok: false, reason } so the caller can render the diagnostic.
async function verifyKey() {
  if (!process.env.SENDGRID_API_KEY) {
    return { ok: false, reason: 'SENDGRID_API_KEY not set' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/scopes`, {
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body.errors && body.errors[0] && body.errors[0].message) ||
                  body.error || `HTTP ${res.status}`;
      return { ok: false, status: res.status, reason: msg };
    }
    return { ok: true, status: res.status, scopes: body.scopes || [] };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, reason: `verifyKey timed out after ${PROBE_TIMEOUT_MS}ms` };
    }
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Generic send. Either `html` or `text` (or both) required. `to` may be a
// single address string or an array. `replyTo` falls back to env. Templates
// are NOT used yet — that's a Phase 2 concern once we have a brief-email and
// a follow-up-email shape stable enough to lock as a SendGrid Dynamic Template.
async function send({ to, subject, html, text, replyTo: replyToOverride, from: fromOverride, categories, customArgs, attachments } = {}) {
  if (!isConfigured()) {
    const err = new Error('SendGrid not configured — set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL');
    err.status = 503;
    throw err;
  }
  if (!to)      { const e = new Error('to required');      e.status = 400; throw e; }
  if (!subject) { const e = new Error('subject required'); e.status = 400; throw e; }
  if (!html && !text) {
    const e = new Error('html or text body required'); e.status = 400; throw e;
  }

  init();

  const msg = {
    to: Array.isArray(to) ? to : [to],
    // Per-call From override (eg. branded meeting-invite sender — see
    // ics.js / ADR-0002 §10). Must remain on an authenticated sender domain
    // or SendGrid will reject; we leave validation of that to SendGrid.
    from: fromOverride && fromOverride.email
      ? { email: fromOverride.email, name: fromOverride.name || fromAddress().name }
      : fromAddress(),
    subject,
  };
  if (html) msg.html = html;
  if (text) msg.text = text;
  const rt = replyToOverride ? { email: replyToOverride } : replyTo();
  if (rt) msg.replyTo = rt;
  if (Array.isArray(categories) && categories.length) msg.categories = categories;
  if (customArgs && typeof customArgs === 'object') msg.customArgs = customArgs;
  // Attachments: pass through unchanged. SendGrid SDK expects
  // [{ filename, content (base64), type, disposition, contentId }].
  if (Array.isArray(attachments) && attachments.length) msg.attachments = attachments;

  try {
    const [response] = await sg.send(msg);
    return {
      ok: true,
      statusCode: response.statusCode,
      messageId: response.headers && response.headers['x-message-id'] || null,
    };
  } catch (err) {
    // SendGrid SDK errors include a response body with the per-field reason.
    const detail = err.response && err.response.body && err.response.body.errors;
    const reason = Array.isArray(detail) ? detail.map((d) => d.message).join('; ') : err.message;
    const e = new Error(`SendGrid send failed: ${reason}`);
    e.status = (err.response && err.response.statusCode) || err.code || 502;
    throw e;
  }
}

// Status payload for the admin "Connections" panel. Never includes the key
// itself — only whether it's present + the result of a live verify probe.
async function getStatus({ probe = false } = {}) {
  const base = {
    configured: isConfigured(),
    fromEmail: fromAddress().email,
    fromName: fromAddress().name,
    replyTo: process.env.SENDGRID_REPLY_TO || null,
    senderDomain: 'eel-global.com',
  };
  if (!probe) return base;
  const verify = await verifyKey();
  return { ...base, verify };
}

module.exports = {
  isConfigured,
  fromAddress,
  verifyKey,
  send,
  getStatus,
};
