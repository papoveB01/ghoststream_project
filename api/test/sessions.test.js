// Integration tests for server-side session revocation (sessions.js). Needs a
// reachable Redis (CI provides a service container; locally run inside the api
// container). Keys are namespaced with a unique prefix and cleaned up.
const { test, after } = require('node:test');
const assert = require('node:assert');
const sessions = require('../src/sessions');
const redis = require('../src/redis');

const now = () => Math.floor(Date.now() / 1000);

test('denyToken revokes exactly that jti', async () => {
  const claims = { sub: 'utest-1', jti: 'jtitest-deny-1', iat: now(), exp: now() + 3600 };
  assert.strictEqual(await sessions.isRevoked(claims), false);
  await sessions.denyToken(claims);
  assert.strictEqual(await sessions.isRevoked(claims), true);
  await redis.del('jti_deny:' + claims.jti);
});

test('revokeAllForUser invalidates older tokens but not freshly-issued ones', async () => {
  const uid = 'utest-2';
  const older = { sub: uid, jti: 'a', iat: now() - 30 };
  await sessions.revokeAllForUser(uid);
  assert.strictEqual(await sessions.isRevoked(older), true);
  const fresher = { sub: uid, jti: 'b', iat: now() + 30 };
  assert.strictEqual(await sessions.isRevoked(fresher), false);
  await redis.del('sess_valid_after:' + uid);
});

after(() => redis.disconnect());
