// Regression test for the ADR-0004 margin-floor guard added this week to
// api/src/subaccounts.js: assertWithinParentCapacity().
//
// Before this fix, sanitizeCaps() only clamped a SINGLE child's allocation
// against the parent plan's full base cap — it never looked at siblings. A
// meter an allocation leaves unset still defaults to the full base cap at
// read time (entitlements.js). So a v2 Pro parent (engagements cap = 30/mo)
// with 5 children, each left at the default, committed 5 x 30 = 150
// engagements/mo against a plan that only budgets 30 — blowing through the
// >=35% gross-margin floor with no misconfiguration required.
//
// assertWithinParentCapacity is NOT exported (it's an internal helper used by
// the POST /invite and PATCH /:childId route handlers), so we drive it through
// the real PATCH /:childId handler — pulled directly off the router's stack,
// the same fake-req/res/next pattern test/rbac.test.js uses for middleware —
// rather than reimplementing its logic here. Only db is stubbed (no real
// Postgres available); plans.js is the real module so the cap arithmetic is
// checked against the actual ADR-0004 catalog, not a hand-rolled copy of it.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// subaccounts.js pulls in auth -> sessions -> redis, and users/tenants/email,
// none of which assertWithinParentCapacity (reached via PATCH /:childId)
// actually needs. Stub them all so this test never touches Redis/Postgres.
stubModule('auth.js', { COOKIE_NAME: 'gs_admin', cookieOptions: () => ({}), signToken: () => '' });
stubModule('users.js', { create: async () => ({}), hashPassword: async () => '' });
stubModule('tenants.js', { get: async () => null, invalidate: () => {} });
stubModule('email.js', { isConfigured: () => false, send: async () => {} });

// Controllable fake pool. `db.getPool()` is `sys()` inside subaccounts.js.
// Dispatches on distinctive substrings from the real queries in
// assertWithinParentCapacity / the PATCH handler's ownership check / update.
//
// Importantly, the sibling-children query DOES honor the real SQL's
// "AND id <> $2" exclusion clause (params[1] = excludeChildId) rather than
// always pre-filtering the fixture — that's what lets the excludeChildId test
// below actually exercise (and would actually fail on a regression of) the
// real query string built inside assertWithinParentCapacity, instead of just
// re-asserting whatever fixture we hand it.
let fixture; // { children: [{id, cap_overrides}], invites: [{cap_overrides}] }
stubModule('db.js', {
  getPool: () => ({
    query: async (sql, params) => {
      if (sql.includes('SELECT id FROM tenants WHERE id = $1 AND parent_tenant_id = $2')) {
        return { rowCount: 1, rows: [{ id: params[0] }] }; // ownership check passes
      }
      if (sql.includes('cap_overrides FROM tenants WHERE parent_tenant_id')) {
        const excluded = sql.includes('AND id <> $2') ? params[1] : null;
        const rows = excluded ? fixture.children.filter((r) => r.id !== excluded) : fixture.children;
        return { rows };
      }
      if (sql.includes('cap_overrides FROM subtenant_invites')) {
        return { rows: fixture.invites };
      }
      if (sql.startsWith('UPDATE tenants SET')) {
        return { rowCount: 1 };
      }
      throw new Error('unexpected query in test fixture: ' + sql);
    },
  }),
});

const subaccounts = require('../src/subaccounts');

// v2 Pro parent: caps.engagements = 30, no extra seats -> effectiveCaps is a
// pass-through of plan.caps (see plans.js effectiveCaps).
const PARENT = { id: 'parent-1', plan: 'pro', plan_version: 2, extra_seats: 0 };

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

async function patchChild(childId, caps, { children = [], invites = [] } = {}) {
  fixture = { children, invites };
  const handler = getRouteHandler(subaccounts.router, 'patch', '/:childId');
  const req = { tenantId: PARENT.id, tenantRecord: PARENT, params: { childId }, body: { caps } };
  const res = makeRes();
  let nextErr;
  await handler(req, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res;
}

// assertWithinParentCapacity loops over EVERY v2 meter (research, engagements,
// market_monitoring, arena), not just the one a test cares about — a meter
// left out of an allocation defaults to the FULL plan cap (that default-to-
// full-cap fallback is exactly the behavior the fix has to police). So to
// isolate "engagements" as the only meter under test, every fixture row and
// every proposed allocation below pins the other three meters to a token `1`
// (far under their much higher ceilings of 250/250/100) so they never
// interfere with the engagements assertion.
function mkCaps(engagements) {
  return { research: 1, engagements, market_monitoring: 1, arena: 1 };
}

test('an allocation whose committed sum (siblings + proposed) stays within the parent cap is ACCEPTED', async () => {
  // 2 siblings at engagements:10 each (sum 20) + proposing 10 for the child
  // being edited = 30, exactly at the Pro cap of 30 -> accepted.
  const res = await patchChild('child-being-edited', mkCaps(10), {
    children: [{ cap_overrides: mkCaps(10) }, { cap_overrides: mkCaps(10) }],
    invites: [],
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});

test('an allocation whose committed sum exceeds the parent cap is REJECTED with 400 and SUBACCOUNT_CAP_OVERCOMMIT', async () => {
  // Same 2 siblings (sum 20) but proposing 15 -> 35 > 30 -> rejected.
  const res = await patchChild('child-being-edited', mkCaps(15), {
    children: [{ cap_overrides: mkCaps(10) }, { cap_overrides: mkCaps(10) }],
    invites: [],
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, 'SUBACCOUNT_CAP_OVERCOMMIT');
});

test('reverting the guard\'s default-cap fallback re-creates the original defect: 5 unset children x the full 30-cap default blows the margin floor', async () => {
  // 4 existing siblings with NO cap_overrides at all (empty {}) -> each
  // defaults to the full plan cap (30) per the review's exact repro. A 5th
  // proposed allocation (also left unset -> defaults to 30) must be rejected:
  // 4*30 + 30 = 150 >> 30.
  const res = await patchChild('child-being-edited', {}, {
    children: [
      { cap_overrides: {} }, { cap_overrides: {} }, { cap_overrides: {} }, { cap_overrides: {} },
    ],
    invites: [],
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, 'SUBACCOUNT_CAP_OVERCOMMIT');
});

test('a live pending invite counts toward the committed sum, not just accepted children', async () => {
  // 1 sibling at 20 + 1 pending invite at 10 (sum 30) + proposing 5 for the
  // child being edited = 35 > 30 -> rejected. If invites were NOT counted,
  // this would wrongly be accepted (20 + 5 = 25 <= 30).
  const res = await patchChild('child-being-edited', mkCaps(5), {
    children: [{ cap_overrides: mkCaps(20) }],
    invites: [{ cap_overrides: mkCaps(10) }],
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, 'SUBACCOUNT_CAP_OVERCOMMIT');
});

test('excludeChildId omits the child being edited from its own sibling sum (no self-double-counting)', async () => {
  // The child being edited is itself present in the "all children of this
  // parent" row set (id: 'child-being-edited', currently allocated 25) with
  // no other siblings. We propose keeping it at 25.
  //
  // The fake pool's sibling query only drops that row when the SQL it
  // receives actually contains "AND id <> $2" with params[1] === the child's
  // id (see the db stub above) -- i.e. only when subaccounts.js truly passes
  // { excludeChildId } through to assertWithinParentCapacity for the PATCH
  // path. If that wiring regressed (e.g. the option got dropped from the
  // PATCH handler's call), the query would come back without the exclusion
  // clause, the fake pool would return the self-row unfiltered, and the sum
  // would double-count: 25 (self, from the unfiltered row) + 25 (proposed) =
  // 50 > 30 -> wrongly REJECTED. With the fix, the self-row is excluded:
  // 0 (siblings) + 25 (proposed) = 25 <= 30 -> ACCEPTED.
  const res = await patchChild('child-being-edited', mkCaps(25), {
    children: [{ id: 'child-being-edited', cap_overrides: mkCaps(25) }],
    invites: [],
  });
  assert.strictEqual(res.statusCode, 200, 'editing a child at its current allocation must not double-count itself as a sibling');
  assert.deepStrictEqual(res.body, { ok: true });
});
