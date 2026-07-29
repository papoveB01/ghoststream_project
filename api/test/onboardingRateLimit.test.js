// Regression test for the 2026-07-29 fix to api/src/onboarding.js
// (POST /onboarding/start): the route used to run bcrypt (cost 12,
// ~0.9 CPU-sec/call) and queue a SendGrid verification email to an
// arbitrary caller-supplied address BEFORE any throttle. Because this route
// is public/unauthenticated and the corporate-email/domain gate is
// self-satisfied (the attacker supplies BOTH the website and the victim
// email in the same request), that made it both a CPU sink and an
// arbitrary-recipient mail relay (~54k emails/hour past nginx's own rate
// limit). The fix moves checkSignupRateLimit() (per-IP AND per-target-email
// caps) BEFORE users.hashPassword()/email.send() — ordering is the entire
// point of the fix, not just "a limiter exists somewhere in the file".
//
// This test drives the real router.post('/start', ...) handler directly
// (no HTTP server, no supertest) with fake req/res objects, and spies on
// users.hashPassword and email.send to prove neither runs once the per-IP
// cap trips, while a request under the cap still proceeds normally.
//
// No Postgres/Redis available — every module onboarding.js requires
// (redis, db, users, auth, email, billing, plans, enrichment) is stubbed
// via require.cache before onboarding.js loads. devices.js (lazily
// required inside checkSignupRateLimit for clientIp()) is left as the REAL
// file — it's pure w.r.t. the IP-fingerprint logic exercised here, and its
// own db/redis/email requires resolve through these same stubs since
// Node's require cache keys on the resolved absolute path regardless of
// which module requires it first.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// Small IP cap so the test doesn't need a long loop; a much larger email cap
// so these IP-focused assertions never trip the *other* bucket first
// (checkSignupRateLimit checks IP, then email, returning on the first cap
// hit — see api/src/onboarding.js checkSignupRateLimit).
process.env.ONBOARDING_RL_IP_CAP = '2';
process.env.ONBOARDING_RL_IP_WINDOW_SEC = '3600';
process.env.ONBOARDING_RL_EMAIL_CAP = '1000';
process.env.ONBOARDING_RL_EMAIL_WINDOW_SEC = String(24 * 60 * 60);
process.env.ONBOARDING_MIN_PASSWORD_LEN = '12';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://dealscope.test';

// --- fake Redis: in-memory store + call log, same shape as the other rate
// limit regression test in this suite (passwordResetRateLimit.test.js). ---
function makeFakeRedis() {
  const store = new Map(); // key -> { value, expiresAtMs }
  return {
    async incr(key) {
      const entry = store.get(key);
      const val = entry ? parseInt(entry.value, 10) + 1 : 1;
      store.set(key, { value: String(val), expiresAtMs: entry ? entry.expiresAtMs : null });
      return val;
    },
    async expire(key, sec) {
      const entry = store.get(key);
      if (entry) entry.expiresAtMs = Date.now() + sec * 1000;
      return 1;
    },
    async ttl(key) {
      const entry = store.get(key);
      if (!entry || !entry.expiresAtMs) return -1;
      return Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000));
    },
    async get(key) {
      const entry = store.get(key);
      return entry ? entry.value : null;
    },
    async set(key, value) {
      store.set(key, { value: String(value), expiresAtMs: null });
      return 'OK';
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

// --- spies -----------------------------------------------------------------
let hashCalls = 0;
let sendCalls = 0;

stubModule('redis', makeFakeRedis());
stubModule('db', { query: async () => ({ rows: [] }) }); // no existing tenant, ever
stubModule('users', {
  findByEmail: async () => null, // no existing user, ever
  hashPassword: async (plain) => { hashCalls += 1; return `hashed:${plain}`; },
});
stubModule('email', {
  isConfigured: () => true,
  send: async () => { sendCalls += 1; return { ok: true, statusCode: 202 }; },
});
// Unused by POST /start (only touched by /verify) but required at module top
// level — stub as inert so onboarding.js's require chain resolves without
// pulling in Stripe/plan-catalog/enrichment machinery.
stubModule('auth', {});
stubModule('billing', {});
stubModule('plans', {});
stubModule('enrichment', {});

const onboarding = require('../src/onboarding');

// --- extract the real POST /start handler off the router, no HTTP server --
function findRouteHandler(method, routePath) {
  const layer = onboarding.router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not found on onboarding.router`);
  return layer.route.stack[0].handle;
}
const startHandler = findRouteHandler('post', '/start');

function makeReq({ ip, body }) {
  return { headers: { 'x-real-ip': ip }, body, socket: {} };
}
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    set(name, val) { this.headers[name] = val; return this; },
  };
}

let bodyCounter = 0;
function validBody(overrides = {}) {
  bodyCounter += 1;
  const domain = `signup-test-${bodyCounter}.example`;
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    companyName: 'Acme Corp',
    industry: onboarding.INDUSTRIES[0],
    companySize: '1-10',
    jobTitle: 'founder',
    website: `https://${domain}`,
    email: `owner@${domain}`,
    password: 'SuperSecret12345!',
    ...overrides,
  };
}

async function callStart(req, res) {
  let thrown = null;
  await startHandler(req, res, (err) => { thrown = err; });
  if (thrown) throw thrown;
  return res;
}

test('a request under the per-IP cap proceeds: hashPassword and email.send both run', async () => {
  hashCalls = 0; sendCalls = 0;
  const req = makeReq({ ip: '203.0.113.50', body: validBody() });
  const res = await callStart(req, makeRes());

  assert.strictEqual(res.statusCode, 201, `expected 201, got ${res.statusCode} (body: ${JSON.stringify(res.body)})`);
  assert.strictEqual(hashCalls, 1, 'a normal, under-cap signup must still hash the password');
  assert.strictEqual(sendCalls, 1, 'a normal, under-cap signup must still send the verification email');
});

test('once the per-IP cap is exceeded, /start 429s and neither hashPassword nor email.send run for the rejected request', async () => {
  const ip = '203.0.113.77'; // distinct from the previous test's IP bucket
  const cap = parseInt(process.env.ONBOARDING_RL_IP_CAP, 10);

  for (let i = 0; i < cap; i++) {
    hashCalls = 0; sendCalls = 0;
    const req = makeReq({ ip, body: validBody() });
    const res = await callStart(req, makeRes());
    assert.strictEqual(res.statusCode, 201, `request ${i + 1} (at/under cap) should succeed`);
    assert.strictEqual(hashCalls, 1, `request ${i + 1} (at/under cap) should still hash the password`);
    assert.strictEqual(sendCalls, 1, `request ${i + 1} (at/under cap) should still send the verification email`);
  }

  // One more from the same IP — over the cap.
  hashCalls = 0; sendCalls = 0;
  const req = makeReq({ ip, body: validBody() });
  const res = await callStart(req, makeRes());

  assert.strictEqual(res.statusCode, 429, 'the request beyond the per-IP cap must be rejected with 429');
  assert.strictEqual(res.body && res.body.code, 'RATE_LIMITED');
  assert.ok(res.headers['Retry-After'], 'a 429 response must set Retry-After');

  assert.strictEqual(
    hashCalls, 0,
    'users.hashPassword must NOT run once the caller is over the per-IP cap — this is the actual ' +
    'CPU-sink fix (bcrypt cost 12 running before any throttle); a limiter that exists but is checked ' +
    'AFTER hashPassword would still pass a naive "some limit exists" test but fails this one'
  );
  assert.strictEqual(
    sendCalls, 0,
    'email.send must NOT run once the caller is over the per-IP cap — this is the arbitrary-recipient ' +
    'mail-relay fix; a limiter checked after email.send would still let ~54k unsolicited emails/hour ' +
    'through to attacker-chosen addresses'
  );
});
