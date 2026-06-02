// Brute-force protection for the password login step. Two Redis counters with
// a sliding-ish fixed window: one per source IP (blunts distributed guessing
// against many accounts) and one per account (locks a single targeted account).
// Counters increment only on FAILED credential checks and are cleared the moment
// a correct password is supplied, so legitimate users are never penalized.
//
// This complements the device-OTP send cap (devices.js), which only kicks in
// AFTER a correct password — this guards the password attempt itself.

const redis = require('./redis');
const devices = require('./devices');

const WINDOW_SEC   = parseInt(process.env.LOGIN_FAIL_WINDOW_SEC || '900', 10); // 15 min
const IP_CAP       = parseInt(process.env.LOGIN_FAIL_IP_CAP || '30', 10);
const ACCOUNT_CAP  = parseInt(process.env.LOGIN_FAIL_ACCOUNT_CAP || '8', 10);

const ipKey   = (ip) => `login_fail_ip:${ip}`;
const acctKey = (email) => `login_fail_acct:${String(email || '').toLowerCase()}`;

// Is this attempt currently blocked? Returns { locked, retryAfter } (seconds).
async function check(req, email) {
  try {
    const ip = devices.clientIp(req);
    const [ipN, acctN] = await Promise.all([
      redis.get(ipKey(ip)),
      redis.get(acctKey(email)),
    ]);
    if (Number(acctN) >= ACCOUNT_CAP) {
      return { locked: true, scope: 'account', retryAfter: Math.max(1, await redis.ttl(acctKey(email))) };
    }
    if (Number(ipN) >= IP_CAP) {
      return { locked: true, scope: 'ip', retryAfter: Math.max(1, await redis.ttl(ipKey(ip))) };
    }
    return { locked: false };
  } catch {
    return { locked: false }; // never lock people out on a Redis hiccup
  }
}

// Record one failed password attempt (increment both counters, set TTL on first).
async function recordFailure(req, email) {
  try {
    const ip = devices.clientIp(req);
    for (const key of [ipKey(ip), acctKey(email)]) {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, WINDOW_SEC);
    }
  } catch { /* best-effort */ }
}

// Clear the per-account counter after a correct password.
async function clear(email) {
  try { await redis.del(acctKey(email)); } catch { /* best-effort */ }
}

module.exports = { check, recordFailure, clear, ACCOUNT_CAP, IP_CAP };
