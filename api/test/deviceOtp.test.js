// Regression test for the device-OTP fail-open fix (api/src/devices.js,
// sendOtpEmail).
//
// The defect: when SendGrid was unconfigured, sendOtpEmail logged the raw
// OTP to console and returned false unconditionally. The login route
// (api/src/index.js) treated a falsy return as "email didn't go out" and
// echoed the code back to the unauthenticated caller as `devCode` — so an
// absent/rotated-out SENDGRID_API_KEY turned new-device 2FA into a no-op in
// production. The fix: sendOtpEmail now THROWS when NODE_ENV=production and
// email isn't configured (fail closed), and never logs the code at all, in
// any environment.
//
// No Postgres/Redis/SendGrid available here, so db/redis/email are stubbed
// via require.cache before devices.js is loaded.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// devices.js requires db/redis/email at module top-level even though
// sendOtpEmail itself only touches email — all three must resolve.
stubModule('db', { query: async () => ({ rows: [], rowCount: 0 }) });
stubModule('redis', {
  incr: async () => 1, expire: async () => 1, ttl: async () => -1,
  get: async () => null, set: async () => 'OK', del: async () => 0,
});

let emailConfigured = false;
let sendCalls = [];
stubModule('email', {
  isConfigured: () => emailConfigured,
  send: async (msg) => { sendCalls.push(msg); },
});

const devices = require('../src/devices');

// Capture console.log/warn/error during fn(), restoring the real console
// afterward regardless of whether fn() resolves or rejects.
async function captureConsole(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.warn = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const val = await fn();
    return { ok: true, val, logs };
  } catch (err) {
    return { ok: false, err, logs };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

test('sendOtpEmail fails closed: throws in production when email is unconfigured', async () => {
  emailConfigured = false;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      () => devices.sendOtpEmail('user@example.com', '123456'),
      (err) => err instanceof Error && /not configured/i.test(err.message),
      'production + unconfigured email must reject/throw, not resolve with a value ' +
      'the caller could mistake for "code delivered" or fall back to a devCode'
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test('the OTP code is never written to console, in production (throw path)', async () => {
  emailConfigured = false;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const code = '654321';
  const result = await captureConsole(() => devices.sendOtpEmail('user@example.com', code));
  process.env.NODE_ENV = prevEnv;

  assert.strictEqual(result.ok, false, 'must reject rather than resolve');
  const allOutput = result.logs.join('\n');
  assert.ok(
    !allOutput.includes(code),
    'the raw OTP must never appear in anything written to console — stdout ends up in ' +
    'docker logs, which would leak a usable code to anyone with log access'
  );
});

test('the OTP code is never written to console outside production either (dev fallback path)', async () => {
  emailConfigured = false;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const code = '111222';
  const result = await captureConsole(() => devices.sendOtpEmail('user@example.com', code));
  process.env.NODE_ENV = prevEnv;

  // Dev/staging keep the non-throwing fallback (so local work doesn't need
  // real email) but must still never print the code itself.
  assert.strictEqual(result.ok, true, 'dev/staging fallback should not throw');
  assert.strictEqual(result.val, false, 'fallback still reports that no real email went out');
  const allOutput = result.logs.join('\n');
  assert.ok(
    !allOutput.includes(code),
    'even the dev console fallback must not print the raw code — only the recipient address'
  );
});

test('control: sends via the email module and returns true when configured', async () => {
  emailConfigured = true;
  sendCalls = [];
  const result = await devices.sendOtpEmail('user@example.com', '999999');
  assert.strictEqual(result, true);
  assert.strictEqual(sendCalls.length, 1, 'email.send should be called exactly once');
  assert.strictEqual(sendCalls[0].to, 'user@example.com');
});
