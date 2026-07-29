// Regression test for the password-reset rate-limit IP bucketing fix
// (api/src/passwordReset.js, checkRateLimit).
//
// The defect: the per-IP bucket used to be keyed off the LEFTMOST
// X-Forwarded-For entry. nginx only APPENDS to whatever XFF the client sent,
// so the leftmost token is entirely client-supplied — an attacker could
// rotate it on every request and land in a fresh Redis bucket each time,
// meaning the per-IP cap never tripped. The fix routes through
// devices.clientIp(req), which (absent X-Real-IP) uses the RIGHTMOST XFF
// entry — the hop the nearest trusted proxy actually observed.
//
// No Postgres/Redis available here, so every external module is stubbed via
// require.cache before passwordReset.js (and the devices.js it lazily
// requires) are loaded.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// --- fake Redis: an in-memory store plus a call log so tests can assert on
// exactly which keys checkRateLimit asked for. ---------------------------
function makeFakeRedis() {
  const store = new Map(); // key -> { value, expiresAtMs }
  const calls = { incr: [], expire: [], ttl: [], get: [], set: [], del: [] };
  return {
    calls,
    async incr(key) {
      calls.incr.push(key);
      const entry = store.get(key);
      const val = entry ? parseInt(entry.value, 10) + 1 : 1;
      store.set(key, { value: String(val), expiresAtMs: entry ? entry.expiresAtMs : null });
      return val;
    },
    async expire(key, sec) {
      calls.expire.push(key);
      const entry = store.get(key);
      if (entry) entry.expiresAtMs = Date.now() + sec * 1000;
      return 1;
    },
    async ttl(key) {
      calls.ttl.push(key);
      const entry = store.get(key);
      if (!entry || !entry.expiresAtMs) return -1;
      return Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000));
    },
    async get(key) {
      calls.get.push(key);
      const entry = store.get(key);
      return entry ? entry.value : null;
    },
    async set(key, value) {
      calls.set.push(key);
      store.set(key, { value: String(value), expiresAtMs: null });
      return 'OK';
    },
    async del(key) {
      calls.del.push(key);
      return store.delete(key) ? 1 : 0;
    },
  };
}

// Small cap so the "trips at the configured limit" assertion doesn't need a
// long loop, and a much larger email cap so these IP-focused tests never
// trip the *other* bucket first (checkRateLimit checks email, then IP, and
// returns on the first cap it hits).
process.env.PWRESET_RL_IP_CAP = '3';
process.env.PWRESET_RL_EMAIL_CAP = '1000';
process.env.PWRESET_RL_WINDOW_SEC = '3600';

const fakeRedis = makeFakeRedis();
stubModule('redis', fakeRedis);
stubModule('email', { send: async () => {}, isConfigured: () => true });
// devices.js (lazily required by checkRateLimit) also pulls in db + redis;
// db is unused by clientIp/checkRateLimit but must resolve without Postgres.
stubModule('db', { query: async () => ({ rows: [], rowCount: 0 }) });

const passwordReset = require('../src/passwordReset');

function reqWithXff(xff) {
  return { headers: { 'x-forwarded-for': xff }, socket: {} };
}

test('forged leftmost X-Forwarded-For does not evade the per-IP bucket', async () => {
  const addr = 'same-bucket-test@example.com';
  const REAL_IP = '203.0.113.9'; // the hop nearest the app — the true client

  // Two requests differing ONLY in an attacker-forged leftmost XFF hop; the
  // rightmost (real) hop is identical, mirroring what nginx would actually
  // forward for the same physical client rotating a spoofed header.
  const reqA = reqWithXff(`6.6.6.6, ${REAL_IP}`);
  const reqB = reqWithXff(`7.7.7.7, ${REAL_IP}`);

  await passwordReset.checkRateLimit(reqA, addr);
  const incrAfterA = fakeRedis.calls.incr.slice();
  await passwordReset.checkRateLimit(reqB, addr);
  const incrAfterB = fakeRedis.calls.incr.slice();

  // Each call increments [email key, ip key]; the ip key is the 2nd of each pair.
  const ipKeyA = incrAfterA[1];
  const ipKeyB = incrAfterB[3];

  assert.ok(ipKeyA, 'expected an IP-bucket increment on the first call');
  assert.strictEqual(
    ipKeyB,
    ipKeyA,
    'two requests sharing the real (rightmost) hop must land in the SAME IP bucket ' +
    'regardless of what the client put in the leftmost X-Forwarded-For entry — ' +
    'if this fails, the rate limiter is reading the client-controlled leftmost hop again'
  );
});

test('per-IP cap trips at the configured limit and stays tripped', async () => {
  const addr = 'ip-cap-trip-test@example.com';
  const req = reqWithXff('198.51.100.1, 203.0.113.77'); // stable rightmost hop

  const cap = parseInt(process.env.PWRESET_RL_IP_CAP, 10);
  for (let i = 0; i < cap; i++) {
    const r = await passwordReset.checkRateLimit(req, addr);
    assert.strictEqual(r.ok, true, `request ${i + 1} (at/under cap) should be allowed`);
  }

  const tripped = await passwordReset.checkRateLimit(req, addr);
  assert.strictEqual(tripped.ok, false, 'request beyond the cap must be rejected');
  assert.ok(tripped.retryAfter > 0, 'a rejected request must report a positive retryAfter');

  // And it stays tripped for a subsequent attempt within the window.
  const stillTripped = await passwordReset.checkRateLimit(req, addr);
  assert.strictEqual(stillTripped.ok, false, 'the cap must remain tripped within the window');
});

test('rotating the forged leftmost XFF hop past the cap still trips (the actual regression)', async () => {
  const addr = 'rotation-attack-test@example.com';
  const REAL_IP = '203.0.113.42';
  const cap = parseInt(process.env.PWRESET_RL_IP_CAP, 10);

  // An attacker rotating the leftmost XFF hop on every request, as the
  // pre-fix code would have let through indefinitely.
  for (let i = 0; i < cap; i++) {
    const req = reqWithXff(`10.0.0.${i + 1}, ${REAL_IP}`);
    const r = await passwordReset.checkRateLimit(req, addr);
    assert.strictEqual(r.ok, true, `request ${i + 1} (at/under cap) should be allowed`);
  }

  const req = reqWithXff(`10.0.0.${cap + 1}, ${REAL_IP}`);
  const tripped = await passwordReset.checkRateLimit(req, addr);
  assert.strictEqual(
    tripped.ok,
    false,
    'rotating the forged leftmost XFF hop must NOT reset the counter — if this passes as ok:true, ' +
    'the limiter is bucketing by the attacker-controlled leftmost hop again'
  );
});
