// Proposal Engine Phase 2 — inbound email ingestion (SendGrid Inbound Parse).
//
// A rep BCCs/forwards a prospect's emails to <token>@<INBOUND_PARSE_DOMAIN>.
// SendGrid Inbound Parse POSTs the parsed message (multipart/form-data) to
// POST /webhooks/inbound-email/<INBOUND_PARSE_SECRET>. We map the token back to
// the prospect and file the email as a PROSPECT-scope KB doc (so it flows into
// research re-analysis AND the proposal synthesis) plus an engagement-input log
// row. Intelligence + suggestion only — no CRM/threading.
//
// Activation is ops-side (env + DNS MX + SendGrid + nginx) — see
// docs/design/proposal-engine.md. Until INBOUND_PARSE_DOMAIN/SECRET are set the
// address endpoint reports "not configured" and the webhook 503s.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./db');
const service = require('./knowledge/service');

const INBOUND_DOMAIN = (process.env.INBOUND_PARSE_DOMAIN || '').trim().toLowerCase();
const INBOUND_SECRET = (process.env.INBOUND_PARSE_SECRET || '').trim();
const MAX_BODY_CHARS = parseInt(process.env.INBOUND_MAX_BODY_CHARS || '20000', 10);

function isConfigured() { return Boolean(INBOUND_DOMAIN && INBOUND_SECRET); }
function newToken() { return crypto.randomBytes(8).toString('hex'); }
function addressFor(token) { return (INBOUND_DOMAIN && token) ? `${token}@${INBOUND_DOMAIN}` : null; }

// One stable token per company. Authed path → RLS-scoped + explicit tenant_id.
async function getOrCreateToken(tenantId, companyId) {
  const c = await db.query(`SELECT id FROM companies WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
  if (!c.rows[0]) { const e = new Error('prospect not found'); e.status = 404; throw e; }
  const existing = await db.query(`SELECT token FROM prospect_inbound_tokens WHERE company_id = $1 AND tenant_id = $2`, [companyId, tenantId]);
  if (existing.rows[0]) return existing.rows[0].token;
  // Retry once on the (astronomically unlikely) token collision.
  for (let i = 0; i < 2; i++) {
    try {
      const r = await db.query(
        `INSERT INTO prospect_inbound_tokens (token, tenant_id, company_id) VALUES ($1, $2, $3) RETURNING token`,
        [newToken(), tenantId, companyId]
      );
      return r.rows[0].token;
    } catch (err) {
      if (i === 1 || !/duplicate key/i.test(String(err.message))) throw err;
    }
  }
}

async function inboxInfo(tenantId, companyId) {
  if (!isConfigured()) return { configured: false, address: null };
  const token = await getOrCreateToken(tenantId, companyId);
  return { configured: true, address: addressFor(token) };
}

// ── Parsing helpers ─────────────────────────────────────────────────────────
// SendGrid posts `envelope` (JSON: {to:[...],from}) plus a friendly `to` header.
// The token is the entire local-part of whichever recipient is @our domain.
function tokenFromRecipients(fields) {
  const candidates = [];
  try { const env = JSON.parse(fields.envelope || '{}'); (env.to || []).forEach((a) => candidates.push(a)); } catch { /* ignore */ }
  if (fields.to) candidates.push(...String(fields.to).split(','));
  for (const raw of candidates) {
    const m = String(raw).match(/([^<@\s,;]+)@([^>\s,;]+)/);
    if (!m) continue;
    const local = m[1].toLowerCase();
    const domain = m[2].toLowerCase();
    if (domain !== INBOUND_DOMAIN) continue;
    // Support both "<token>@" and "anything+<token>@".
    return local.includes('+') ? local.split('+').pop() : local;
  }
  return null;
}

// Best-effort: drop quoted replies / forwarded chains / common signatures so the
// filed intel is the new content, not the whole history.
function cleanBody(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  const cutters = [
    /\n[>\s]*On .+ wrote:.*$/s,
    /\n-{2,}\s*Original Message\s*-{2,}.*$/is,
    /\n_{5,}.*$/s,
    /\nFrom:.*\nSent:.*$/is,
    /\n--\s*\n.*$/s, // signature delimiter
  ];
  for (const re of cutters) { const m = t.match(re); if (m && m.index > 40) t = t.slice(0, m.index); }
  return t.trim().slice(0, MAX_BODY_CHARS);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Ingest one parsed inbound email ─────────────────────────────────────────
// Unauthenticated context (SendGrid): resolves token via sysPool, then files.
async function handleInbound(fields) {
  const token = tokenFromRecipients(fields);
  if (!token) return { ok: false, reason: 'no recipient token' };
  const row = (await db.query(
    `SELECT tenant_id, company_id FROM prospect_inbound_tokens WHERE token = $1`, [token]
  )).rows[0];
  if (!row) return { ok: false, reason: 'unknown token' };

  const { tenant_id: tenantId, company_id: companyId } = row;
  const from = String(fields.from || '').slice(0, 300);
  const subject = String(fields.subject || '').slice(0, 300) || '(no subject)';
  const body = cleanBody(fields.text || htmlToText(fields.html));
  if (!body) return { ok: false, reason: 'empty body' };

  const receivedAt = new Date().toISOString();
  const md = `# Email: ${subject}\n\n**From:** ${from}\n**Received:** ${receivedAt}\n\n${body}`;

  // File as PROSPECT intel — auto-feeds research re-analysis + proposal synthesis.
  await service.ingest({
    tenantId,
    file: { buffer: Buffer.from(md, 'utf8'), mimetype: 'text/markdown', originalname: `email-${Date.now()}.md` },
    category: 'ORG_INTELLIGENCE',
    title: `Email: ${subject}`,
    metadata: { source: 'inbound-email', from, subject, receivedAt },
    streamType: 'FILE',
    scope: 'PROSPECT',
    companyId,
  });

  // Append to the engagement-input log (provenance / timeline).
  await db.query(
    `INSERT INTO prospect_engagement_inputs (tenant_id, company_id, type, ref, extraction_json)
     VALUES ($1, $2, 'EMAIL', $3, $4)`,
    [tenantId, companyId, subject, JSON.stringify({ from, subject, receivedAt, chars: body.length })]
  ).catch((e) => console.warn('[inbound] engagement log failed:', e.message));

  console.log(`[inbound] filed email for company ${companyId} (${subject})`);
  return { ok: true, companyId };
}

// ── Webhook router (mounted UNAUTHENTICATED at /webhooks/inbound-email) ──────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26214400 } });
const webhookRouter = express.Router();

webhookRouter.post('/:secret', upload.any(), async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'inbound email not configured' });
  if (req.params.secret !== INBOUND_SECRET) return res.status(403).json({ error: 'forbidden' });
  try {
    const result = await handleInbound(req.body || {});
    // Always 200 so SendGrid doesn't retry storms; report the outcome in body.
    res.status(200).json(result);
  } catch (err) {
    console.error('[inbound] handler error:', err && err.message);
    res.status(200).json({ ok: false, reason: 'error' });
  }
});

module.exports = { webhookRouter, inboxInfo, getOrCreateToken, isConfigured, handleInbound, addressFor };
