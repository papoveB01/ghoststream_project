// Unit tests for in-tenant RBAC middleware (auth.requireRole / requireRoleWrite).
// Pure logic — we drive the middleware with fake req/res/next and assert the
// branch taken. (Importing auth pulls the redis singleton, hence the teardown.)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-at-least-32-bytes!!';

const { test, after } = require('node:test');
const assert = require('node:assert');
const auth = require('../src/auth');

// Returns 'ALLOW' if next() was called, else the HTTP status the mw set.
function run(mw, user, method = 'POST') {
  let result = 'ALLOW';
  const req = { user, method };
  const res = { status: (c) => ({ json: () => { result = c; } }) };
  mw(req, res, () => { result = 'ALLOW'; });
  return result;
}

test('requireRole enforces the owner > manager > rep hierarchy', () => {
  assert.strictEqual(run(auth.requireRole('manager'), { role: 'rep' }), 403);
  assert.strictEqual(run(auth.requireRole('manager'), { role: 'manager' }), 'ALLOW');
  assert.strictEqual(run(auth.requireRole('manager'), { role: 'owner' }), 'ALLOW');
  assert.strictEqual(run(auth.requireRole('owner'), { role: 'manager' }), 403);
  assert.strictEqual(run(auth.requireRole('owner'), { role: 'owner' }), 'ALLOW');
});

test('superadmin (adm) bypasses every role check', () => {
  assert.strictEqual(run(auth.requireRole('owner'), { role: 'rep', adm: true }), 'ALLOW');
});

test('unknown / missing role is denied; no user is 401', () => {
  assert.strictEqual(run(auth.requireRole('rep'), { role: 'nonsense' }), 403);
  assert.strictEqual(run(auth.requireRole('rep'), null), 401);
});

test('requireRoleWrite lets any role read but gates writes', () => {
  assert.strictEqual(run(auth.requireRoleWrite('manager'), { role: 'rep' }, 'GET'), 'ALLOW');
  assert.strictEqual(run(auth.requireRoleWrite('manager'), { role: 'rep' }, 'HEAD'), 'ALLOW');
  assert.strictEqual(run(auth.requireRoleWrite('manager'), { role: 'rep' }, 'POST'), 403);
  assert.strictEqual(run(auth.requireRoleWrite('manager'), { role: 'manager' }, 'DELETE'), 'ALLOW');
});

after(() => { try { require('../src/redis').disconnect(); } catch { /* ignore */ } });
