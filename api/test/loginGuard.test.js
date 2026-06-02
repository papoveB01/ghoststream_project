// Integration tests for the login brute-force guard (loginGuard.js). Needs Redis.
const { test, after } = require('node:test');
const assert = require('node:assert');
const loginGuard = require('../src/loginGuard');
const redis = require('../src/redis');

const req = { headers: { 'x-forwarded-for': '198.51.100.23' }, socket: {} };
const EMAIL = 'guardtest@example.com';

async function cleanup() {
  await redis.del('login_fail_acct:' + EMAIL);
  const ipKeys = await redis.keys('login_fail_ip:*');
  if (ipKeys.length) await redis.del(...ipKeys);
}

test('account locks after the failure cap and clears on success', async () => {
  await cleanup();
  assert.strictEqual((await loginGuard.check(req, EMAIL)).locked, false);
  for (let i = 0; i < loginGuard.ACCOUNT_CAP; i++) await loginGuard.recordFailure(req, EMAIL);
  assert.strictEqual((await loginGuard.check(req, EMAIL)).locked, true);
  await loginGuard.clear(EMAIL); // correct password resets the account counter
  assert.strictEqual((await loginGuard.check(req, EMAIL)).locked, false);
  await cleanup();
});

after(() => redis.disconnect());
