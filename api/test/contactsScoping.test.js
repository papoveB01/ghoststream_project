// Regression test for CRITICAL finding C4 (2026-07-29 code review) in
// api/src/contacts.js.
//
// Defect part A: FROM_JOIN joined `companies` with NO tenant predicate —
// `LEFT JOIN companies c ON c.id = pc.company_id` — while the adjacent
// personas/products joins both carried `AND x.tenant_id = pc.tenant_id`.
// Since companies.id is a bare FK (not tenant-scoped by itself), a contact
// row carrying another tenant's company_id rendered THAT tenant's
// company_name/company_domain straight into this tenant's contact list
// (ADR-0001 knowledge-isolation violation).
//
// Defect part B: create() never verified the caller-supplied companyId
// belonged to the caller's tenant before the INSERT. The FK is tenant-blind
// (satisfied by ANY companies.id in the table), so nothing stopped a tenant
// from attaching a contact to another tenant's company and reading it back
// through the (buggy) join in part A.
//
// Node's built-in test runner only (node:test + node:assert) — no Postgres,
// no Redis, no npm deps beyond what's already installed. `db` is a fake that
// RECORDS every SQL string + params it's given, dispatching canned responses
// by matching on distinctive substrings of the real queries in
// api/src/contacts.js — so these assertions are checked against the actual
// query text the module builds, not a hand-rolled copy of it.

'use strict';

const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// contacts.js requires `./gating` unconditionally at module load (its router
// wires `gating.requireFeature('engagements')` as a route middleware factory
// AT REQUIRE TIME). The real gating.js pulls in auth -> sessions -> redis and
// a real Postgres pool, none of which list()/get()/create() need — stub it
// out so requiring contacts.js can't touch Redis/Postgres.
stubModule('gating.js', {
  requireFeature: () => (req, res, next) => next(),
  requireCapacity: () => (req, res, next) => next(),
  billingGate: (req, res, next) => next(),
});

// Recorded calls: [{ sql, params }], reset before each test.
let calls = [];
// Set of `${tenantId}:${companyId}` combos the fake companies table "owns".
let ownedCompanyIds = new Set();

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

stubModule('db.js', {
  query: async (sql, params) => {
    const s = norm(sql);
    calls.push({ sql: s, params });

    if (s.startsWith('INSERT INTO prospect_contacts')) {
      return { rows: [{ id: 'new-contact-1' }] };
    }
    if (s.startsWith('SELECT 1 FROM companies WHERE id = $1 AND tenant_id = $2')) {
      const [companyId, tenantId] = params;
      const owned = ownedCompanyIds.has(`${tenantId}:${companyId}`);
      return { rows: owned ? [{ '?column?': 1 }] : [] };
    }
    if (s.startsWith('SELECT id FROM personas')) {
      // No matching persona row — inferPersonaIdForRole() returns null. Not
      // the point of this test.
      return { rows: [] };
    }
    if (s.includes('FROM prospect_contacts pc') && s.includes('pc.id = $2')) {
      // get(tenantId, id) — the post-insert re-fetch in create(), or a direct get().
      return {
        rows: [{
          id: params[1],
          company_id: 'company-owned',
          name: 'Jane Doe',
          email: 'jane@prospect.example.com',
          company_name: 'Owned Co',
          company_domain: 'owned.example.com',
        }],
      };
    }
    if (s.includes('FROM prospect_contacts pc')) {
      // list()
      return { rows: [] };
    }
    throw new Error(`contactsScoping.test.js: unstubbed query: ${s}`);
  },
});

const contacts = require('../src/contacts');

beforeEach(() => {
  calls = [];
  ownedCompanyIds = new Set();
});

// (a) SQL-TEXT ASSERTION ONLY — the whole failure mode of part A is a
// silently-missing predicate, so there is no behavioral difference to drive
// through a fake in-memory table; we can only check the query text itself.
// If the tenant predicate on the companies join is ever removed again, this
// fails immediately instead of waiting for a cross-tenant data leak to be
// noticed in production.
test('contact list/get SQL scopes the companies join by tenant_id (C4 part A)', async () => {
  await contacts.list('tenant-A', {});
  const listCall = calls.find((c) => c.sql.includes('FROM prospect_contacts pc') && c.sql.includes('LIMIT 500'));
  assert.ok(listCall, 'expected a list() query to have been recorded');
  assert.ok(
    listCall.sql.includes('LEFT JOIN companies c ON c.id = pc.company_id AND c.tenant_id = pc.tenant_id'),
    `companies join is missing its tenant_id predicate — got: ${listCall.sql}`
  );
});

// (b) BEHAVIORAL — companyId belongs to a different tenant than the caller.
// Reverting part B (deleting the ownership check block in create()) makes
// this test fail: the INSERT would be reached and issued unconditionally.
test('create() rejects with 404 and never reaches INSERT when companyId is not owned by the caller (C4 part B)', async () => {
  // Note: companyId 'company-other-tenant' is deliberately NOT added to
  // ownedCompanyIds for 'tenant-A' — simulates a companyId that belongs to
  // (or simply doesn't exist under) a different tenant.
  await assert.rejects(
    contacts.create('tenant-A', 'user-1', {
      companyId: 'company-other-tenant',
      name: 'Jane Doe',
      email: 'jane@prospect.example.com',
      role: 'CFO',
    }),
    (err) => {
      assert.strictEqual(err.status, 404);
      return true;
    }
  );
  const insertCalls = calls.filter((c) => c.sql.startsWith('INSERT INTO prospect_contacts'));
  assert.strictEqual(insertCalls.length, 0, 'INSERT must never be issued for an unowned companyId');
});

// (c) BEHAVIORAL — companyId does belong to the caller's tenant: create()
// should proceed normally past the ownership check to the INSERT.
test('create() proceeds to INSERT when companyId is owned by the caller', async () => {
  ownedCompanyIds.add('tenant-A:company-owned');
  const created = await contacts.create('tenant-A', 'user-1', {
    companyId: 'company-owned',
    name: 'Jane Doe',
    email: 'jane@prospect.example.com',
    role: 'CFO',
  });
  assert.ok(created);
  const insertCalls = calls.filter((c) => c.sql.startsWith('INSERT INTO prospect_contacts'));
  assert.strictEqual(insertCalls.length, 1, 'expected exactly one INSERT for an owned companyId');
  assert.deepStrictEqual(insertCalls[0].params.slice(0, 2), ['tenant-A', 'company-owned']);
});
