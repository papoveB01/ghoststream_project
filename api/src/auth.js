// Auth — multi-tenant. JWT in an HttpOnly cookie. Identity is a row in the
// `users` table; the token bakes in the tenant_id so every downstream query
// can scope to it (the "Data Firewall"). bcrypt verifies the password.
//
// Migration note: pre-multitenancy tokens carried `{ sub: email, role: 'admin' }`.
// Those are no longer accepted — the verify path requires a `tid` claim, so
// stale `gs_admin` cookies will 401 and the user re-logs in once.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const users = require('./users');
const apiTokens = require('./auth-tokens');
const sessions = require('./sessions');

const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_ALG = 'HS256';
const COOKIE_NAME = 'gs_admin';
const JWT_TTL_SEC = 60 * 60 * 8; // 8 hours

function isConfigured() {
  return Boolean(JWT_SECRET);
}

// Surface weak/missing signing secrets at boot rather than failing silently.
if (!JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set — authentication is disabled (logins will 500).');
} else if (JWT_SECRET.length < 32) {
  console.warn(`[auth] JWT_SECRET is weak (${JWT_SECRET.length} chars) — use >= 32 bytes of entropy.`);
}

// Token claims:
//   sub   — user id (uuid)
//   tid   — tenant id (uuid)  ← the firewall key
//   email — user email (denormalized for display / engagement key)
//   name  — display name "First Last" (denormalized for the UI; may be null)
//   role  — in-tenant role (owner / manager / rep)
//   adm   — platform superadmin flag (Founders tenant only)
function signToken(user) {
  return jwt.sign(
    // jti gives each session a unique id so logout can revoke exactly it; iat
    // (added automatically) lets a per-user cutoff invalidate older sessions.
    { sub: user.id, tid: user.tenantId, email: user.email, name: user.name || null, role: user.role, adm: !!user.isAdmin, jti: crypto.randomBytes(16).toString('hex') },
    JWT_SECRET,
    { expiresIn: JWT_TTL_SEC, algorithm: JWT_ALG }
  );
}

function verifyToken(token) {
  if (!token) return null;
  try {
    // Pin the algorithm — never accept `alg:none` or a caller-chosen algorithm.
    const claims = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALG] });
    // Reject legacy tokens that predate multitenancy — they lack `tid`.
    if (!claims || !claims.tid || !claims.sub) return null;
    return claims;
  } catch { return null; }
}

// Email + password → the public user projection (no passwordHash) on success,
// null on bad credentials. Does NOT issue a token or touch last_login — callers
// decide that (the login route may interpose device-OTP first; see devices.js).
// Throws (500) only if the JWT secret is missing — a config error.
async function verifyCredentials(email, password) {
  if (!isConfigured()) {
    const err = new Error('auth not configured (set JWT_SECRET)');
    err.status = 500; throw err;
  }
  const found = await users.findByEmail(email);
  // Always run a bcrypt compare — even on a missing user — to keep response
  // time roughly constant and not leak which emails exist. The dummy hash is a
  // valid bcrypt string that no password produces.
  const hash = (found && found.passwordHash) ||
    '$2a$12$C6UzMDM.H6dfI/f/IKxGhuRSx2pZ8M3i0wF1m6vR3uYh7s.0Q1aZK';
  const ok = await users.verifyPassword(password || '', hash);
  if (!found || !ok) return null;
  return {
    id: found.id, tenantId: found.tenantId, email: found.email,
    name: found.name, role: found.role, isAdmin: found.isAdmin,
    emailVerified: found.emailVerified,
  };
}

// Email + password → { token, user } on success, null on bad credentials.
// Convenience wrapper that verifies, marks the login, and mints a token in one
// step (the direct-issue path, used where device-OTP doesn't apply).
async function attemptLogin(email, password) {
  const publicUser = await verifyCredentials(email, password);
  if (!publicUser) return null;
  await users.touchLogin(publicUser.id);
  return { token: signToken(publicUser), user: publicUser };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    try { out[k] = decodeURIComponent(rest.join('=')); } catch { out[k] = rest.join('='); }
  }
  return out;
}

function tokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const ah = req.headers.authorization;
  if (ah) {
    const m = ah.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  return null;
}

// Require a valid session. Attaches:
//   req.user     — the token claims ({ sub, tid, email, role, adm } [+ token_id
//                  when authenticated via a bearer PAT])
//   req.tenantId — shorthand for req.user.tid; the value every data query
//                  must scope by.
//
// Two auth paths, tried in order:
//   1. JWT  — cookie or `Authorization: Bearer <jwt>` (the web app + legacy)
//   2. PAT  — `Authorization: Bearer gs_pat_v1_...` (Lili MCP / scripts;
//             see auth-tokens.js and docs/rfcs/0001-lili-integration.md)
async function authMiddleware(req, res, next) {
  try {
    const token = tokenFromRequest(req);

    const claims = verifyToken(token);
    if (claims) {
      // Server-side revocation: reject logged-out / globally-invalidated sessions.
      if (await sessions.isRevoked(claims)) return res.status(401).json({ error: 'session expired' });
      req.user = claims;
      req.tenantId = claims.tid;
      return next();
    }

    // Bearer-PAT path — only attempted when the token *looks* like a PAT,
    // to avoid an extra DB lookup on every unauthenticated request.
    if (token && token.startsWith('gs_pat_')) {
      const ctx = await apiTokens.verifyApiToken(token);
      if (ctx) {
        req.user = ctx.user;
        req.tenantId = ctx.tenantId;
        return next();
      }
    }

    return res.status(401).json({ error: 'unauthorized' });
  } catch (err) { return next(err); }
}

// Optional auth — populates req.user/req.tenantId when a valid token is
// present, otherwise leaves them undefined and continues. Used by the portal
// endpoint, which serves a stripped payload to anonymous viewers. Same two
// auth paths as authMiddleware.
async function optionalAuth(req, _res, next) {
  try {
    const token = tokenFromRequest(req);
    const claims = verifyToken(token);
    if (claims && !(await sessions.isRevoked(claims))) {
      req.user = claims;
      req.tenantId = claims.tid;
    } else if (token && token.startsWith('gs_pat_')) {
      const ctx = await apiTokens.verifyApiToken(token);
      if (ctx) { req.user = ctx.user; req.tenantId = ctx.tenantId; }
    }
    next();
  } catch (err) { next(err); }
}

// Require platform superadmin (Founders tenant owner). Layer on top of
// authMiddleware for routes that manage the platform itself.
function requireSuperadmin(req, res, next) {
  if (!req.user || !req.user.adm) return res.status(403).json({ error: 'forbidden' });
  next();
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: JWT_TTL_SEC * 1000,
  };
}

module.exports = {
  attemptLogin,
  verifyCredentials,
  signToken,
  verifyToken,
  authMiddleware,
  optionalAuth,
  requireSuperadmin,
  tokenFromRequest,
  cookieOptions,
  COOKIE_NAME,
  JWT_TTL_SEC,
  isConfigured,
};
