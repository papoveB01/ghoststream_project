// Device trust + email-OTP for new-device verification.
//
// On a password login we fingerprint the device server-side from
// (userId + User-Agent + client IP /24). A non-expired row in `trusted_devices`
// (migration 0025) means the device already passed an OTP → skip the code.
// Otherwise we mint a 6-digit code, stash it in Redis under a random challengeId
// (never the plaintext — only its sha256), and email it. The client posts the
// code back to /auth/verify-device; on success we issue the session cookie and,
// if the user ticked "trust this device", write a trusted_devices row.
//
// Scope: password logins only (see api/src/index.js). Onboarding signup
// auto-login and PAT auth never call into here.

const crypto = require('crypto');
const db = require('./db');
const redis = require('./redis');
const email = require('./email');

const TRUST_DAYS       = parseInt(process.env.DEVICE_TRUST_DAYS || '30', 10);
const OTP_TTL_SEC      = parseInt(process.env.DEVICE_OTP_TTL_SEC || '600', 10); // 10 min
const OTP_MAX_ATTEMPTS = parseInt(process.env.DEVICE_OTP_MAX_ATTEMPTS || '5', 10);
const OTP_SEND_CAP     = parseInt(process.env.DEVICE_OTP_SEND_CAP || '5', 10);  // per window
const OTP_SEND_WINDOW  = parseInt(process.env.DEVICE_OTP_SEND_WINDOW_SEC || '900', 10); // 15 min

const otpKey  = (challengeId) => `device_otp:${challengeId}`;
const sendKey = (userId) => `otp_send:${userId}`;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- fingerprint -----------------------------------------------------------

// Real client IP. Express has no `trust proxy` set, so req.ip is the nginx
// container — read the forwarded headers nginx sets (proxy/nginx.conf).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// Coarsen an IP to a subnet so a normal lease change within the same network
// doesn't read as a new device. IPv4 → /24, IPv6 → /48.
function ipPrefix(ip) {
  if (!ip) return 'unknown';
  let v = ip;
  // IPv4-mapped IPv6 (e.g. ::ffff:203.0.113.5) → treat as IPv4.
  const mapped = v.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];
  if (v.includes('.')) {
    const o = v.split('.');
    if (o.length === 4) return `${o[0]}.${o[1]}.${o[2]}.0/24`;
    return v;
  }
  if (v.includes(':')) {
    const groups = v.split(':').filter((g) => g !== '');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return v;
}

function deviceFingerprint(req, userId) {
  const ua = req.headers['user-agent'] || '';
  const prefix = ipPrefix(clientIp(req));
  // When the browser supplies a client fingerprint (X-Device-FP), key the device
  // on it instead of UA+IP — it's IP-independent (survives network changes) and
  // harder to spoof than UA alone. Falls back to UA+IP/24 for non-browser callers.
  const cfp = req.headers['x-device-fp'];
  const hash = (cfp && /^[a-f0-9]{32,128}$/i.test(cfp))
    ? sha256(`${userId}|cfp|${cfp}`)
    : sha256(`${userId}|${ua}|${prefix}`);
  return { hash, userAgent: String(ua).slice(0, 500), ipPrefix: prefix };
}

// ---- trusted_devices store -------------------------------------------------

async function isTrusted(userId, deviceHash) {
  const r = await db.query(
    `UPDATE trusted_devices SET last_seen_at = now()
       WHERE user_id = $1 AND device_hash = $2 AND expires_at > now()
       RETURNING id`,
    [userId, deviceHash]
  );
  return r.rowCount > 0;
}

async function trustDevice(userId, fp) {
  await db.query(
    `INSERT INTO trusted_devices (user_id, device_hash, user_agent, ip_prefix, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
     ON CONFLICT (user_id, device_hash)
       DO UPDATE SET expires_at  = now() + ($5 || ' days')::interval,
                     last_seen_at = now(),
                     user_agent   = EXCLUDED.user_agent,
                     ip_prefix    = EXCLUDED.ip_prefix`,
    [userId, fp.hash, fp.userAgent, fp.ipPrefix, String(TRUST_DAYS)]
  );
}

async function listDevices(userId, currentHash) {
  const r = await db.query(
    `SELECT id, device_hash, user_agent, ip_prefix, last_seen_at, expires_at, created_at
       FROM trusted_devices
      WHERE user_id = $1 AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId]
  );
  return r.rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    ipPrefix: row.ip_prefix,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    current: currentHash ? row.device_hash === currentHash : false,
  }));
}

async function revokeDevice(userId, id) {
  const r = await db.query(
    `DELETE FROM trusted_devices WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return r.rowCount > 0;
}

// ---- OTP challenge (Redis) -------------------------------------------------

// True when this user has requested too many codes recently. Increments as a
// side-effect (check-then-send without a race), mirroring apollo.tripDailyCap.
async function overSendCap(userId) {
  if (OTP_SEND_CAP <= 0) return false;
  try {
    const n = await redis.incr(sendKey(userId));
    if (n === 1) await redis.expire(sendKey(userId), OTP_SEND_WINDOW);
    return n > OTP_SEND_CAP;
  } catch {
    return false; // redis hiccup — don't lock the user out of login
  }
}

function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Create a fresh challenge for a (user, device). Returns { challengeId, code }
// or { throttled: true } when over the send cap.
async function createChallenge({ userId, email: to, fp }) {
  if (await overSendCap(userId)) return { throttled: true };
  const challengeId = crypto.randomBytes(24).toString('hex');
  const code = genCode();
  const payload = {
    userId,
    email: to,
    deviceHash: fp.hash,
    userAgent: fp.userAgent,
    ipPrefix: fp.ipPrefix,
    codeHash: sha256(code),
    attempts: 0,
  };
  await redis.set(otpKey(challengeId), JSON.stringify(payload), 'EX', OTP_TTL_SEC);
  return { challengeId, code };
}

// Verify a submitted code. `req` is used to re-fingerprint so the SAME device
// must complete the challenge. Returns a discriminated result:
//   { ok: true, userId, fp }
//   { ok: false, reason: 'expired' | 'wrong_device' | 'bad_code' | 'too_many', attemptsLeft }
async function verifyChallenge(challengeId, code, req) {
  const raw = challengeId ? await redis.get(otpKey(challengeId)) : null;
  if (!raw) return { ok: false, reason: 'expired' };
  let c;
  try { c = JSON.parse(raw); } catch { await redis.del(otpKey(challengeId)); return { ok: false, reason: 'expired' }; }

  // Same device must finish the challenge it started.
  const fp = deviceFingerprint(req, c.userId);
  if (fp.hash !== c.deviceHash) return { ok: false, reason: 'wrong_device' };

  if (sha256(String(code || '')) === c.codeHash) {
    await redis.del(otpKey(challengeId));
    return { ok: true, userId: c.userId, email: c.email, fp };
  }

  c.attempts = (c.attempts || 0) + 1;
  if (c.attempts >= OTP_MAX_ATTEMPTS) {
    await redis.del(otpKey(challengeId));
    return { ok: false, reason: 'too_many', attemptsLeft: 0 };
  }
  // Preserve the remaining TTL so attempts can't extend the window.
  const ttl = await redis.ttl(otpKey(challengeId));
  await redis.set(otpKey(challengeId), JSON.stringify(c), 'EX', ttl > 0 ? ttl : OTP_TTL_SEC);
  return { ok: false, reason: 'bad_code', attemptsLeft: OTP_MAX_ATTEMPTS - c.attempts };
}

// Mint a new code for an existing challenge (Resend). Returns
// { ok:true, code, email } | { throttled:true } | { ok:false }.
async function refreshChallenge(challengeId) {
  const raw = challengeId ? await redis.get(otpKey(challengeId)) : null;
  if (!raw) return { ok: false };
  let c;
  try { c = JSON.parse(raw); } catch { return { ok: false }; }
  if (await overSendCap(c.userId)) return { throttled: true };
  const code = genCode();
  c.codeHash = sha256(code);
  c.attempts = 0;
  await redis.set(otpKey(challengeId), JSON.stringify(c), 'EX', OTP_TTL_SEC);
  return { ok: true, code, email: c.email };
}

// ---- email -----------------------------------------------------------------

function emailHint(addr) {
  const s = String(addr || '');
  const at = s.indexOf('@');
  if (at <= 0) return s;
  const local = s.slice(0, at);
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(1, Math.min(local.length - 1, 3)))}@${s.slice(at + 1)}`;
}

// Sends the code. Returns true if a real email went out, false when SendGrid is
// unconfigured (caller surfaces a devCode in that case, mirroring onboarding).
async function sendOtpEmail(to, code) {
  if (!email.isConfigured()) {
    console.log(`[devices] OTP for ${to} (email not configured): ${code}`);
    return false;
  }
  const mins = Math.round(OTP_TTL_SEC / 60);
  await email.send({
    to,
    subject: `${code} is your DealScope verification code`,
    categories: ['device-otp'],
    html:
      `<p>Confirm this device to finish signing in to DealScope.</p>` +
      `<p style="font-size:28px;font-weight:800;letter-spacing:4px;margin:14px 0">${code}</p>` +
      `<p style="color:#6b7280;font-size:13px">This code expires in ${mins} minutes. ` +
      `If you didn't try to sign in, change your password — someone may have it.</p>`,
    text: `Your DealScope verification code is ${code}. It expires in ${mins} minutes. ` +
      `If you didn't try to sign in, change your password.`,
  });
  return true;
}

module.exports = {
  TRUST_DAYS,
  deviceFingerprint,
  clientIp,
  ipPrefix,
  isTrusted,
  trustDevice,
  listDevices,
  revokeDevice,
  createChallenge,
  verifyChallenge,
  refreshChallenge,
  emailHint,
  sendOtpEmail,
};
