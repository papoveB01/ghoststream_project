// Regression tests for two billing-lifecycle fixes reviewed 2026-07-29 in
// api/src/billing.js:
//
//  1. POST /billing/checkout used to never check tenant.stripe_subscription_id,
//     so re-buying a plan from a different plan card while already subscribed
//     created a SECOND Stripe subscription — the old one kept invoicing with
//     nothing in the app able to see or cancel it (silent double-charge). The
//     fix 409s (code SUBSCRIPTION_EXISTS) before ever calling Stripe.
//
//  2. The `customer.subscription.deleted` webhook used to downgrade the tenant
//     unconditionally. Cancel-then-resubscribe mid-period (sub A cancelled,
//     sub B started) means Stripe still fires `deleted` for A once A's period
//     lapses — arriving after stripe_subscription_id already points at B. The
//     fix compares the event's subscription id against the tenant's CURRENT
//     one and skips the downgrade when they differ.
//
// Both routes/handler are pulled directly off billing.router.stack / the
// exported `webhook` function (same fake-req/res/next pattern as
// test/rbac.test.js and test/subaccountCaps.test.js) rather than booting the
// app, so no real Postgres/Redis/Stripe is ever touched. The 'stripe' npm
// package (a real dependency of api/) is stubbed in require.cache exactly like
// the in-repo modules, so billing.js's `require('stripe')(key)` resolves to a
// fake client whose calls we can spy on.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}
function stubPackage(pkgName, exportsObj) {
  const full = require.resolve(pkgName);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// ── env: make billing.js think Stripe + a v2 Starter price are configured ──
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.STRIPE_PRICE_STARTER_V2 = 'price_starter_v2_fake';

// ── fake Stripe client — records every call the routes under test can make ──
const stripeCalls = { checkoutSessionsCreate: [] };
function makeFakeStripeClient() {
  return {
    customers: { create: async (opts) => ({ id: 'cus_fake', ...opts }) },
    checkout: {
      sessions: {
        create: async (opts) => { stripeCalls.checkoutSessionsCreate.push(opts); return { id: 'cs_fake_1', url: 'https://checkout.stripe.test/session/cs_fake_1' }; },
      },
    },
    // Not exercised by these two tests, but present so nothing throws if hit.
    subscriptions: { retrieve: async (id) => ({ id }), update: async (id, patch) => ({ id, ...patch }) },
    subscriptionItems: { del: async () => {}, update: async () => {}, create: async () => {} },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test/portal' }) } },
    billing: { meterEvents: { create: async () => {} } },
    // The webhook test hands the already-parsed event object in as req.rawBody
    // and ignores the signature — there is no real signature to verify since
    // Stripe itself is stubbed; constructEvent just passes it through.
    webhooks: { constructEvent: (rawBody) => rawBody },
  };
}
stubPackage('stripe', () => makeFakeStripeClient());

// billing.js requires db/email/tenants/usage/credits directly at module load —
// none of the two routes under test touch them for real data, but they must
// be stubbed so requiring billing.js never reaches for Postgres/Redis.
// plans.js and entitlements.js are pure catalog/derivation logic (no I/O) so
// they're left real, same as test/subaccountCaps.test.js does for plans.js —
// that's what makes the plan/price lookups in these tests meaningful instead
// of re-asserting a hand-rolled fixture.
stubModule('db.js', { query: async () => ({ rows: [] }), getPool: () => ({ query: async () => ({ rows: [] }) }) });
stubModule('email.js', { isConfigured: () => false, send: async () => {} });
stubModule('usage.js', { summary: async () => ({}) });
stubModule('credits.js', { summary: async () => ({}), catalog: () => [], packFor: () => null, grant: async () => null });

let tenantGetReturn;
const tenantUpdateCalls = [];
stubModule('tenants.js', {
  get: async () => tenantGetReturn,
  update: async (id, patch) => { tenantUpdateCalls.push({ id, patch }); return null; },
  invalidate: () => {},
  findIdByStripeCustomer: async () => null,
});

const billing = require('../src/billing');

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
    end() { return this; },
  };
}

// ── Test 1: POST /billing/checkout must refuse a tenant with a live sub ────

test('checkout 409s with SUBSCRIPTION_EXISTS and never calls Stripe when the tenant already has a subscription', async () => {
  stripeCalls.checkoutSessionsCreate.length = 0;
  tenantGetReturn = { id: 'tenant-a', stripe_subscription_id: 'sub_existing_123', stripe_customer_id: 'cus_1' };

  const handler = getRouteHandler(billing.router, 'post', '/checkout');
  const req = { tenantId: 'tenant-a', user: { email: 'owner@acme.com' }, body: { plan: 'starter' } };
  const res = makeRes();
  let nextErr;
  await handler(req, res, (err) => { nextErr = err; });

  assert.strictEqual(nextErr, undefined);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, 'SUBSCRIPTION_EXISTS');
  // The defect this guards against: reverting it lets execution fall through
  // to createCheckout(), which calls stripe().checkout.sessions.create() —
  // that's the second, orphaned subscription. Asserting zero calls here is
  // exactly what catches a regression of the guard.
  assert.strictEqual(stripeCalls.checkoutSessionsCreate.length, 0, 'must not create a Stripe checkout session for a tenant with an existing subscription');
});

test('checkout proceeds normally (creates a session) for a tenant with no existing subscription', async () => {
  stripeCalls.checkoutSessionsCreate.length = 0;
  tenantGetReturn = { id: 'tenant-b', stripe_subscription_id: null, stripe_customer_id: 'cus_2' };

  const handler = getRouteHandler(billing.router, 'post', '/checkout');
  const req = { tenantId: 'tenant-b', user: { email: 'owner@newco.com' }, body: { plan: 'starter' } };
  const res = makeRes();
  let nextErr;
  await handler(req, res, (err) => { nextErr = err; });

  assert.strictEqual(nextErr, undefined);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.url, 'https://checkout.stripe.test/session/cs_fake_1');
  assert.strictEqual(stripeCalls.checkoutSessionsCreate.length, 1, 'a tenant without a subscription must still be able to check out');
  assert.strictEqual(stripeCalls.checkoutSessionsCreate[0].line_items[0].price, 'price_starter_v2_fake');
});

// ── Test 2: customer.subscription.deleted must ignore a stale subscription id ─

function subscriptionDeletedEvent(subId, tenantId) {
  return { type: 'customer.subscription.deleted', data: { object: { id: subId, customer: 'cus_x', metadata: { tenantId } } } };
}
function makeWebhookReqRes(event) {
  const req = { rawBody: event, get: () => 'test-signature' };
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  return { req, res };
}

test('subscription.deleted for a STALE subscription id leaves the tenant untouched (no UPDATE issued)', async () => {
  tenantUpdateCalls.length = 0;
  // Tenant currently points at sub_B (they cancelled sub_A, then re-subscribed
  // as sub_B); Stripe's belated `deleted` event for the now-defunct sub_A
  // arrives after the fact.
  tenantGetReturn = { id: 'tenant-c', stripe_subscription_id: 'sub_B', subscription_status: 'ACTIVE', plan: 'pro' };
  const event = subscriptionDeletedEvent('sub_A', 'tenant-c');
  const { req, res } = makeWebhookReqRes(event);

  await billing.webhook(req, res);

  assert.strictEqual(res.body.received, true);
  // The defect this guards against: reverting the stale-id check applies the
  // downgrade unconditionally, resetting a currently-paying tenant (on sub_B)
  // to Free/TRIAL and nulling stripe_subscription_id (which pointed at the
  // still-live sub_B) — for up to a full billing cycle. Zero update calls here
  // is exactly what a regression of that check would violate.
  assert.strictEqual(tenantUpdateCalls.length, 0, 'a deleted event for a non-current subscription must not trigger any tenant update');
});

test('subscription.deleted for the tenant\'s CURRENT subscription id performs the downgrade', async () => {
  tenantUpdateCalls.length = 0;
  tenantGetReturn = { id: 'tenant-d', stripe_subscription_id: 'sub_current', subscription_status: 'ACTIVE', plan: 'pro' };
  const event = subscriptionDeletedEvent('sub_current', 'tenant-d');
  const { req, res } = makeWebhookReqRes(event);

  await billing.webhook(req, res);

  assert.strictEqual(res.body.received, true);
  assert.strictEqual(tenantUpdateCalls.length, 1, 'a deleted event matching the tenant\'s current subscription must downgrade it');
  const { id, patch } = tenantUpdateCalls[0];
  assert.strictEqual(id, 'tenant-d');
  assert.strictEqual(patch.subscription_status, 'TRIAL');
  assert.strictEqual(patch.plan, 'trial');
  assert.strictEqual(patch.stripe_subscription_id, null);
});
