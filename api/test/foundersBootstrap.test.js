// Regression test for a finding from the 2026-07-29 code review in
// api/src/users.js, bootstrapFoundersAdmin().
//
// Defect: it looked up ADMIN_EMAIL across the WHOLE users table (no tenant
// scoping) and unconditionally set is_admin = true on whatever row it found.
// Pointing ADMIN_EMAIL at an address a self-serve customer already owned
// (a rotated admin identity, a fresh prod stand-up, a typo) silently flipped
// that customer's account to platform superadmin on the next boot — their
// next JWT carries adm:true, which passes requireSuperadmin and skips RLS
// entirely.
//
// The fix scopes the "does this email already have a row" lookup to the
// Founders tenant specifically, and only promotes (issues the UPDATE) when
// the match is IN Founders; a match in any other tenant is logged and
// skipped, never promoted.
//
// Node's built-in test runner only (node:test + node:assert) — no Postgres,
// no Redis. `db` is a fake that records every SQL string + params it's given.
// BCRYPT_ROUNDS is dropped to keep the real bcryptjs hashing (left
// un-stubbed, since it's a pure npm dependency, not a src/ module) fast.

'use strict';

const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// Recorded calls: [{ sql, params }], reset before each test.
let calls = [];
// Drives which branch the fake `users` table takes:
//   'different-tenant' — the email belongs to a row in a NON-Founders tenant
//   'founders-tenant'  — the email belongs to a row already in Founders
//   'new'              — no row anywhere owns the email yet
let scenario;

const OTHER_TENANT_USER_ID = 'other-tenant-user-1';
const FOUNDERS_USER_ID = 'founders-user-1';

stubModule('db.js', {
  query: async (sql, params) => {
    const s = norm(sql);
    calls.push({ sql: s, params });

    // Founders-scoped existing-row lookup: `... AND tenant_id = $2 LIMIT 1`.
    if (s.startsWith('SELECT id FROM users') && s.includes('AND tenant_id = $2')) {
      if (scenario === 'founders-tenant') return { rows: [{ id: FOUNDERS_USER_ID }] };
      return { rows: [] };
    }
    // The scoped promotion UPDATE.
    if (s.startsWith('UPDATE users') && s.includes('is_admin = true')) {
      return { rows: [] };
    }
    // Unscoped "does this email exist ANYWHERE" lookup (the elsewhere check).
    if (s.startsWith('SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1')) {
      if (scenario === 'different-tenant') return { rows: [{ id: OTHER_TENANT_USER_ID }] };
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO users')) {
      return { rows: [{ id: 'brand-new-founders-admin' }] };
    }
    throw new Error(`foundersBootstrap.test.js: unstubbed query: ${s}`);
  },
});

const users = require('../src/users');

beforeEach(() => {
  calls = [];
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD = 'super-secret-password-1';
});

// BEHAVIORAL — reverting the fix (looking ADMIN_EMAIL up across the whole
// table and promoting whatever it finds) makes this fail: the unscoped
// lookup would find OTHER_TENANT_USER_ID and the UPDATE setting is_admin
// would be issued against it.
test('bootstrapFoundersAdmin never promotes a user that belongs to a different tenant', async () => {
  scenario = 'different-tenant';
  const result = await users.bootstrapFoundersAdmin();
  assert.strictEqual(result, null, 'must refuse to promote/return an id for a non-Founders match');

  const updateCalls = calls.filter((c) => c.sql.startsWith('UPDATE users') && c.sql.includes('is_admin'));
  assert.strictEqual(updateCalls.length, 0, 'no UPDATE setting is_admin may be issued for a cross-tenant email match');
});

// BEHAVIORAL + params check — a genuine Founders-tenant match DOES get
// promoted, and both the lookup and the promotion UPDATE must be scoped by
// the Founders tenant id (not just "any row with this id").
test('bootstrapFoundersAdmin promotes when the match is already in the Founders tenant, scoped by tenant id', async () => {
  scenario = 'founders-tenant';
  const result = await users.bootstrapFoundersAdmin();
  assert.strictEqual(result, FOUNDERS_USER_ID);

  const selectCall = calls.find((c) => c.sql.startsWith('SELECT id FROM users') && c.sql.includes('AND tenant_id = $2'));
  assert.ok(selectCall, 'expected the Founders-scoped SELECT to have run');
  assert.strictEqual(selectCall.params[1], users.FOUNDERS_TENANT_ID);

  const updateCall = calls.find((c) => c.sql.startsWith('UPDATE users') && c.sql.includes('is_admin'));
  assert.ok(updateCall, 'expected the promotion UPDATE to have run');
  assert.strictEqual(updateCall.params[2], users.FOUNDERS_TENANT_ID);
  assert.strictEqual(updateCall.params[1], FOUNDERS_USER_ID);
});
