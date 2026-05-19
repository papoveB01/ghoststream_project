// API tokens (PATs) for non-browser clients — see docs/rfcs/0001-lili-integration.md.
//
// Exports:
//   router          — Express router for /auth/tokens (mount with authMiddleware)
//   verifyApiToken  — used by auth.authMiddleware to accept Bearer PATs
//
// Token format:  gs_pat_v1_<8-char-prefix>_<32-char-secret>
//   - prefix:  fast indexed lookup, no full-table bcrypt scan
//   - secret:  bcrypt-hashed in token_hash; compared with constant-time bcrypt.compare
//   - returned in plaintext exactly once, at mint time — never recoverable

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const TOKEN_VERSION = 'v1';
const PREFIX_LEN = 8;
const SECRET_LEN = 32;
const MAX_TOKENS_PER_USER = 10;
const BCRYPT_COST = 12;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function _randomString(len) {
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

// Parse-and-validate the token shape without DB I/O. Returns { prefix } on
// well-formed v1 tokens, null otherwise. Cheap DoS surface — bail before
// touching the DB on garbage input.
function _parsePat(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  // Total length: 'gs_pat_v1_' (10) + 8 (prefix) + '_' (1) + 32 (secret) = 51
  if (plaintext.length !== 51) return null;
  const head = `gs_pat_${TOKEN_VERSION}_`;
  if (!plaintext.startsWith(head)) return null;
  const rest = plaintext.slice(head.length);
  const sep = rest.indexOf('_');
  if (sep !== PREFIX_LEN) return null;
  const prefix = rest.slice(0, PREFIX_LEN);
  const secret = rest.slice(PREFIX_LEN + 1);
  if (!/^[A-Za-z0-9]{8}$/.test(prefix)) return null;
  if (!/^[A-Za-z0-9]{32}$/.test(secret)) return null;
  return { prefix };
}

// Verify a bearer-style API token and return the same shape authMiddleware
// produces for JWT-authenticated requests, so downstream routes don't need to
// know which auth path was taken.
//
// Returns { user, tenantId } on success, null on any failure (malformed,
// unknown prefix, hash mismatch, revoked, expired).
async function verifyApiToken(plaintext) {
  const parsed = _parsePat(plaintext);
  if (!parsed) return null;

  const r = await db.query(
    `SELECT t.id, t.tenant_id, t.user_id, t.token_hash,
            u.email, u.role, u.is_admin
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.prefix = $1
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [parsed.prefix]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];

  const ok = await bcrypt.compare(plaintext, row.token_hash);
  if (!ok) return null;

  // Fire-and-forget last_used_at bump — never block the request on it.
  db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id])
    .catch((err) => console.error('[auth-tokens] last_used_at update failed:', err.message));

  return {
    tenantId: row.tenant_id,
    user: {
      sub: row.user_id,
      tid: row.tenant_id,
      email: row.email,
      role: row.role,
      adm: !!row.is_admin,
      token_id: row.id,
    },
  };
}

// ---- HTTP routes ----------------------------------------------------------
// Mounted at /auth/tokens with auth.authMiddleware applied at mount time
// (matches the pattern other routers use). Both cookie-JWT and bearer-PAT
// requests can reach these routes; the per-request `req.user.sub` and
// `req.tenantId` define the scope.

const router = express.Router();

router.post('/', express.json(), async (req, res, next) => {
  try {
    const { label, expires_in_days } = req.body || {};

    if (typeof label !== 'string' || label.trim().length === 0 || label.length > 100) {
      return res.status(400).json({ error: 'label_required', detail: 'label must be a 1-100 char string' });
    }
    if (expires_in_days != null &&
        (!Number.isInteger(expires_in_days) || expires_in_days < 1 || expires_in_days > 3650)) {
      return res.status(400).json({
        error: 'invalid_expiry',
        detail: 'expires_in_days must be an integer 1-3650, or null/omitted for no expiry',
      });
    }

    // Cap: per-user active token count
    const c = await db.query(
      `SELECT COUNT(*)::int AS n FROM api_tokens
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [req.user.sub]
    );
    if (c.rows[0].n >= MAX_TOKENS_PER_USER) {
      return res.status(409).json({
        error: 'token_limit_reached',
        detail: `you already have ${MAX_TOKENS_PER_USER} active tokens; revoke one before creating another`,
      });
    }

    const prefix = _randomString(PREFIX_LEN);
    const secret = _randomString(SECRET_LEN);
    const plaintext = `gs_pat_${TOKEN_VERSION}_${prefix}_${secret}`;
    const tokenHash = await bcrypt.hash(plaintext, BCRYPT_COST);
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86400000)
      : null;

    const r = await db.query(
      `INSERT INTO api_tokens (tenant_id, user_id, label, prefix, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at, expires_at`,
      [req.tenantId, req.user.sub, label.trim(), prefix, tokenHash, expiresAt]
    );
    const row = r.rows[0];

    console.log(JSON.stringify({
      msg: 'api_token.created',
      token_id: row.id,
      tenant_id: req.tenantId,
      user_id: req.user.sub,
      label: label.trim(),
      expires_at: row.expires_at,
      ip: req.ip,
    }));

    return res.status(201).json({
      id: row.id,
      label: label.trim(),
      prefix,
      plaintext_token: plaintext, // ONLY time we return this — never stored, never re-shown
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, label, prefix, created_at, last_used_at, expires_at, revoked_at
         FROM api_tokens
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY created_at DESC`,
      [req.tenantId, req.user.sub]
    );
    return res.json(r.rows);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const r = await db.query(
      `UPDATE api_tokens
          SET revoked_at = now()
        WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL
        RETURNING id`,
      [req.params.id, req.tenantId, req.user.sub]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'token_not_found' });

    console.log(JSON.stringify({
      msg: 'api_token.revoked',
      token_id: req.params.id,
      tenant_id: req.tenantId,
      user_id: req.user.sub,
      ip: req.ip,
    }));
    return res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = { router, verifyApiToken };
