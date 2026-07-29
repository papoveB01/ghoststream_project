// Regression tests for two sub-account invite fixes reviewed 2026-07-29 in
// api/src/subaccounts.js:
//
//  3. POST /invite used to call billing.syncSubtenantQuantity() (a prorated
//     Stripe charge for the new sub-tenant slot) BEFORE validating the invite
//     email's format, its company-domain match, and duplicate-invite status.
//     A typo'd or duplicate invite still bumped (and prorated) the paid
//     quantity with no invite row ever created to account for it. The fix
//     moves every validation check ahead of the billing.syncSubtenantQuantity
//     call.
//
//  4. usedCount() (which POST /invite's team-member-limit check and GET /'s
//     `used` field both read) counted every PENDING invite with no
//     `expires_at` filter, and nothing ever transitions an expired invite out
//     of PENDING — so an invite nobody accepted in time occupied a billed
//     sub-account slot forever. The fix adds `AND expires_at > now()` to the
//     count query.
//
// Both routes are pulled directly off subaccounts.router.stack (same
// fake-req/res/next pattern as test/rbac.test.js and test/subaccountCaps.test.js)
// rather than booting the app, so no real Postgres/Redis is ever touched.
// plans.js is left real (pure catalog logic, no I/O) so the cap/plan checks
// exercised along the way are the actual ADR-0004 catalog, not a hand-rolled
// stand-in for it.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// subaccounts.js pulls in auth -> sessions -> redis, plus users/tenants/email —
// none of which the /invite or / routes actually need here.
stubModule('auth.js', { COOKIE_NAME: 'gs_admin', cookieOptions: () => ({}), signToken: () => '' });
stubModule('users.js', { create: async () => ({}), hashPassword: async () => '' });
stubModule('tenants.js', { get: async () => null, invalidate: () => {} });
stubModule('email.js', { isConfigured: () => false, send: async () => {} });

// billing.js is required LAZILY inside the route handler body
// (`const billing = require('./billing');`) — stubbing it in require.cache
// ahead of time is what lets us spy on syncSubtenantQuantity without pulling
// in Stripe/db for real.
const syncCalls = [];
let syncShouldThrow = null;
stubModule('billing.js', {
  syncSubtenantQuantity: async (parentTenant, used) => {
    syncCalls.push([parentTenant, used]);
    if (syncShouldThrow) throw syncShouldThrow;
    return { paid: Math.max(0, used - 1) };
  },
});

// ── controllable fake pool ──────────────────────────────────────────────────
// fixture shape: { childCount, invites: [{ status, expires_at }], dupeExists }
let fixture;
stubModule('db.js', {
  getPool: () => ({
    query: async (sql, params) => {
      // GET / — full children list (id/name/... for the list view).
      if (sql.includes('SELECT t.id, t.name, t.subscription_status')) {
        return { rows: [] };
      }
      // GET / — full pending-invites list (for the invites panel).
      if (sql.includes('SELECT id, company_name, domain, email, features, cap_overrides, status, expires_at, created_at')) {
        return { rows: (fixture.invites || []).filter((r) => r.status === 'PENDING') };
      }
      // usedCount() — children count.
      if (sql.includes('SELECT count(*)::int AS n FROM tenants WHERE parent_tenant_id')) {
        return { rows: [{ n: fixture.childCount || 0 }] };
      }
      // usedCount() — PENDING invite count. THIS is the query the fix changed:
      // assert the expires_at > now() predicate is actually present, and only
      // then apply it — so a regression that drops the predicate makes this
      // stub itself blow up (loud test failure) instead of silently
      // reproducing the old, unfiltered count.
      if (sql.includes("SELECT count(*)::int AS n FROM subtenant_invites") && sql.includes("status = 'PENDING'")) {
        if (!sql.includes('expires_at > now()')) {
          throw new Error("usedCount()'s invite-count query is missing its 'expires_at > now()' filter — this is the exact regression the fix addressed");
        }
        const now = Date.now();
        const n = (fixture.invites || []).filter((r) => r.status === 'PENDING' && new Date(r.expires_at).getTime() > now).length;
        return { rows: [{ n }] };
      }
      // POST /invite — duplicate-pending-invite check.
      if (sql.includes('lower(email) = $2')) {
        return { rowCount: fixture.dupeExists ? 1 : 0, rows: [] };
      }
      // assertWithinParentCapacity — sibling children / invites cap_overrides.
      if (sql.includes('cap_overrides FROM tenants WHERE parent_tenant_id')) {
        return { rows: [] };
      }
      if (sql.includes('cap_overrides FROM subtenant_invites')) {
        return { rows: [] };
      }
      // POST /invite — the insert itself (only reached once validation +
      // billing have both passed).
      if (sql.startsWith('INSERT INTO subtenant_invites')) {
        return { rows: [{ id: 'invite-new', company_name: params[1], email: params[3], status: 'PENDING', expires_at: new Date(Date.now() + 14 * 86400000).toISOString() }] };
      }
      throw new Error('unexpected query in test fixture: ' + sql);
    },
  }),
});

const subaccounts = require('../src/subaccounts');

// v2 Pro parent: features include sub_accounts, subAccountLimit = 5, plenty of
// cap headroom for a first invite with default (unset) caps.
const PARENT = { id: 'parent-1', domain: 'acme.com', plan: 'pro', plan_version: 2, extra_seats: 0 };

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function makeRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}
async function postInvite(body, { childCount = 0, invites = [], dupeExists = false } = {}) {
  fixture = { childCount, invites, dupeExists };
  syncCalls.length = 0;
  const handler = getRouteHandler(subaccounts.router, 'post', '/invite');
  const req = { tenantId: PARENT.id, tenantRecord: PARENT, body };
  const res = makeRes();
  let nextErr;
  await handler(req, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res;
}
async function getIndex({ childCount = 0, invites = [] } = {}) {
  fixture = { childCount, invites };
  const handler = getRouteHandler(subaccounts.router, 'get', '/');
  const req = { tenantId: PARENT.id, tenantRecord: PARENT };
  const res = makeRes();
  let nextErr;
  await handler(req, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res;
}

// ── Test 3: validation must run before the Stripe sync ─────────────────────

test('an invite with a malformed email is rejected and never reaches syncSubtenantQuantity', async () => {
  const res = await postInvite({ email: 'not-an-email' });
  assert.strictEqual(res.statusCode, 400);
  // The defect: reverting the reordering runs the Stripe sync unconditionally
  // before this check, so a typo'd email would still bump (and prorate) the
  // paid sub-tenant quantity even though no invite row is ever created.
  assert.strictEqual(syncCalls.length, 0, 'malformed email must not trigger a billing sync');
});

test('an invite whose email domain does not match the parent company domain is rejected and never reaches syncSubtenantQuantity', async () => {
  const res = await postInvite({ email: 'newhire@totally-different.com' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /company domain/);
  assert.strictEqual(syncCalls.length, 0, 'domain mismatch must not trigger a billing sync');
});

test('a duplicate pending invite for the same email is rejected (409) and never reaches syncSubtenantQuantity', async () => {
  const res = await postInvite({ email: 'newhire@acme.com' }, { dupeExists: true });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(syncCalls.length, 0, 'a duplicate pending invite must not trigger a billing sync');
});

test('a valid invite passes all validation and DOES call syncSubtenantQuantity exactly once', async () => {
  const res = await postInvite({ email: 'newhire@acme.com' });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(syncCalls.length, 1, 'a valid invite must still charge the sub-tenant slot');
  assert.strictEqual(syncCalls[0][0], PARENT);
  assert.strictEqual(syncCalls[0][1], 1); // used(0) + 1
});

// ── Test 4: expired PENDING invites must not hold a billed slot ─────────────
//
// NOTE ON TEST STRENGTH: the actual filtering this fix relies on happens
// inside the SQL predicate itself (`AND expires_at > now()`), evaluated by
// Postgres — there is no separate in-JS filtering step for the fake pool to
// bypass. Since these tests run with NO real Postgres, the fake pool below
// has to reimplement that predicate's semantics in JS to produce a count at
// all. To keep this from degenerating into "the test re-asserts what the
// stub does," the stub first asserts the real query text still contains the
// `expires_at > now()` predicate (throwing loudly if a regression removes it)
// and only then applies the filter — but this is still fundamentally a
// golden-SQL-text check plus a hand-written reimplementation of the intended
// behavior, not a verification of Postgres actually filtering the rows. A
// true end-to-end check would need a real database.

test('usedCount excludes an expired-but-PENDING invite and includes a live one (GET / "used" field)', async () => {
  const res = await getIndex({
    childCount: 0,
    invites: [
      { status: 'PENDING', expires_at: new Date(Date.now() - 86400000).toISOString() }, // expired yesterday
      { status: 'PENDING', expires_at: new Date(Date.now() + 86400000).toISOString() }, // still live
    ],
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.used, 1, 'an expired PENDING invite must not count toward the billed slot total');
});

test('the team-member-limit check in POST /invite also excludes an expired-but-PENDING invite', async () => {
  // Parent's Pro subAccountLimit is 5. 4 children + 1 EXPIRED pending invite
  // should still allow a 5th invite (used must read as 4, not 5) — before the
  // fix this would wrongly read 5 and reject with SUBACCOUNT_LIMIT.
  const res = await postInvite({ email: 'newhire@acme.com' }, {
    childCount: 4,
    invites: [{ status: 'PENDING', expires_at: new Date(Date.now() - 86400000).toISOString() }],
  });
  assert.strictEqual(res.statusCode, 201, 'an expired pending invite must not consume the team-member limit');
  assert.strictEqual(syncCalls.length, 1);
  assert.strictEqual(syncCalls[0][1], 5); // used(4) + 1
});
