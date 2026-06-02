// Server-side session revocation (SOC 2 CC6.7). JWTs are otherwise valid for
// their full 8h TTL with no way to kill them. Two Redis-backed mechanisms:
//
//   1. Per-token denylist — `jti_deny:<jti>` (TTL = the token's remaining life).
//      Used by logout to kill exactly the current session.
//   2. Per-user "valid-after" cutoff — `sess_valid_after:<userId>` = epoch secs.
//      Any token whose `iat` predates the cutoff is rejected. Used by password
//      change and "sign out everywhere" to invalidate all existing sessions.
//
// isRevoked() is called on the authenticated hot path. It FAILS OPEN on a Redis
// error — an outage must not lock every user out (availability > the marginal
// security of revocation during an outage).

const redis = require('./redis');

const jtiKey = (jti) => `jti_deny:${jti}`;
const validAfterKey = (userId) => `sess_valid_after:${userId}`;

// Keep a user's valid-after marker alive a bit longer than the max token life so
// no still-valid token can outlast it. (Mirrors auth.JWT_TTL_SEC = 8h.)
const VALID_AFTER_TTL_SEC = 60 * 60 * 8 + 60;

// Deny a single token until it would have expired anyway.
async function denyToken(claims) {
  if (!claims || !claims.jti) return;
  const ttl = claims.exp ? Math.max(1, claims.exp - Math.floor(Date.now() / 1000)) : 3600;
  try { await redis.set(jtiKey(claims.jti), '1', 'EX', ttl); } catch { /* best-effort */ }
}

// Invalidate every existing session for a user (sets the cutoff to "now").
async function revokeAllForUser(userId) {
  if (!userId) return;
  const now = Math.floor(Date.now() / 1000);
  try { await redis.set(validAfterKey(userId), String(now), 'EX', VALID_AFTER_TTL_SEC); } catch { /* best-effort */ }
}

// True if this token has been revoked (denylisted jti, or issued before the
// user's valid-after cutoff). Fails open on Redis trouble.
async function isRevoked(claims) {
  if (!claims) return false;
  try {
    if (claims.jti && (await redis.exists(jtiKey(claims.jti)))) return true;
    const cutoff = await redis.get(validAfterKey(claims.sub));
    if (cutoff && claims.iat && claims.iat < Number(cutoff)) return true;
    return false;
  } catch {
    return false; // fail open — don't lock everyone out on a Redis hiccup
  }
}

module.exports = { denyToken, revokeAllForUser, isRevoked };
