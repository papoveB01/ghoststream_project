// Password-reset tokens + email.
//
// Mirrors the device-OTP pattern (devices.js): a high-entropy secret is mailed
// to the user, and only its SHA-256 is stored in Redis with a short TTL — so a
// Redis read never exposes a usable token. Tokens are single-use (deleted on
// consume) and the whole flow is enumeration-safe at the route layer (the
// request endpoint always returns 200 regardless of whether the email exists).

const crypto = require('crypto');
const redis = require('./redis');
const email = require('./email');

const TOKEN_TTL_SEC = parseInt(process.env.PWRESET_TTL_SEC || String(30 * 60), 10); // 30 min
const KEY_PREFIX = 'pwreset:';

// Spam / abuse caps for the "send me a link" endpoint.
const RL_WINDOW_SEC  = parseInt(process.env.PWRESET_RL_WINDOW_SEC || String(60 * 60), 10); // 1 h
const RL_EMAIL_CAP   = parseInt(process.env.PWRESET_RL_EMAIL_CAP || '5', 10);
const RL_IP_CAP      = parseInt(process.env.PWRESET_RL_IP_CAP || '25', 10);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function keyFor(token) {
  return KEY_PREFIX + sha256(token);
}

// Create a single-use reset token for a user. Returns the RAW token (goes in
// the email link); only its hash is persisted.
async function createToken({ userId, email: addr }) {
  const token = crypto.randomBytes(32).toString('hex');
  await redis.set(
    keyFor(token),
    JSON.stringify({ userId, email: addr }),
    'EX', TOKEN_TTL_SEC
  );
  return token;
}

// Validate + atomically consume a token. Returns { userId, email } or null.
async function consumeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const key = keyFor(token);
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key); // single use
  try { return JSON.parse(raw); }
  catch { return null; }
}

// Rate-limit a request by both the target email and the caller IP. Returns
// { ok } or { ok:false, retryAfter }. Best-effort: a Redis hiccup fails open
// so a transient cache outage never blocks a legitimate reset.
async function checkRateLimit(req, addr) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown')
    .toString().split(',')[0].trim();
  try {
    const checks = [
      { key: `${KEY_PREFIX}rl:email:${sha256(String(addr).toLowerCase())}`, cap: RL_EMAIL_CAP },
      { key: `${KEY_PREFIX}rl:ip:${ip}`, cap: RL_IP_CAP },
    ];
    for (const { key, cap } of checks) {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, RL_WINDOW_SEC);
      if (n > cap) {
        const ttl = await redis.ttl(key);
        return { ok: false, retryAfter: ttl > 0 ? ttl : RL_WINDOW_SEC };
      }
    }
  } catch {
    return { ok: true };
  }
  return { ok: true };
}

async function sendResetEmail(to, link) {
  const mins = Math.round(TOKEN_TTL_SEC / 60);
  await email.send({
    to,
    subject: 'Reset your DealScope password',
    categories: ['password-reset'],
    html:
      `<p>We received a request to reset the password for your DealScope account.</p>` +
      `<p style="margin:20px 0">` +
        `<a href="${link}" style="display:inline-block;background:#1e7d45;color:#fff;` +
        `text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Reset password</a>` +
      `</p>` +
      `<p style="color:#6b7280;font-size:13px">This link expires in ${mins} minutes and can be used once. ` +
      `If you didn't request a reset, you can safely ignore this email — your password won't change.</p>` +
      `<p style="color:#9ca3af;font-size:12px;word-break:break-all">If the button doesn't work, paste this URL into your browser:<br>${link}</p>`,
    text:
      `Reset your DealScope password\n\n` +
      `Open this link to choose a new password (expires in ${mins} minutes, single use):\n${link}\n\n` +
      `If you didn't request a reset, ignore this email — your password won't change.`,
  });
}

module.exports = { createToken, consumeToken, checkRateLimit, sendResetEmail, TOKEN_TTL_SEC };
