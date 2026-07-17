// Unit tests for entitlementsFor() — the pure function that decides what a
// tenant may do RIGHT NOW (features + caps + lifetime buckets + overage), from
// its lifecycle status and plan tier. No DB: entitlementsFor takes the tenant
// row directly. These lock the v2 launch-catalog behavior (see
// docs/pricing/market-benchmark-2026.md §6) and the sub-tenant inheritance rules.

const { test } = require('node:test');
const assert = require('node:assert');
const ent = require('../src/entitlements');
const plans = require('../src/plans');

const FREE_V2   = { id: 'f', plan: 'trial',      plan_version: 2, subscription_status: 'TRIAL' };
const STARTER   = { id: 's', plan: 'starter',    plan_version: 2, subscription_status: 'ACTIVE' };
const PRO       = { id: 'p', plan: 'pro',        plan_version: 2, subscription_status: 'ACTIVE' };
const ENTERPRISE= { id: 'e', plan: 'enterprise', plan_version: 2, subscription_status: 'ACTIVE' };

// ── Free tier: the §6a.1 activation shape ───────────────────────────────────
test('Free v2 is active with the cheap-bundle activation caps and mixed lifetime meters', () => {
  const e = ent.entitlementsFor(FREE_V2);
  assert.strictEqual(e.active, true);
  assert.strictEqual(e.reason, 'free');
  assert.ok(e.features.includes(plans.FEATURES.ARENA), 'Arena is on for Free');
  assert.strictEqual(e.caps.research, 20);
  assert.strictEqual(e.caps.arena, 10);
  assert.strictEqual(e.caps.engagements, 1);
  assert.strictEqual(e.caps.market_monitoring, 0);
  assert.deepStrictEqual(e.lifetimeMeters, ['engagements'], 'only the bot is lifetime');
  assert.strictEqual(e.overage, null);
});

// ── Seat scaling (§6a.2) ────────────────────────────────────────────────────
test('Starter caps scale with paid extra seats; cap is 5', () => {
  const e = ent.entitlementsFor({ ...STARTER, extra_seats: 2 });
  assert.strictEqual(e.caps.research, 75 + 25 * 2, 'research +25/seat');
  assert.strictEqual(e.caps.engagements, 10 + 5 * 2, 'engagements +5/seat');
  assert.strictEqual(e.seats.max, 5);
  assert.strictEqual(e.seats.extra, 2);
  assert.deepStrictEqual(e.lifetimeMeters, [], 'paid tiers are fully monthly');
});

// ── Deferred meter (§6b.6): overage must stay null at the entitlement layer ──
test('Pro v2 exposes NO overage even with a live subscription (meter deferred)', () => {
  const e = ent.entitlementsFor({ ...PRO, stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1' });
  assert.strictEqual(e.overage, null, 're-adding pro.overage without the tooling would fail here');
  assert.ok(e.features.includes(plans.FEATURES.MARKET_MONITORING));
  assert.ok(e.features.includes(plans.FEATURES.SUB_ACCOUNTS));
});

// ── Lifecycle matrix (accessState) ──────────────────────────────────────────
test('accessState covers the lifecycle matrix', () => {
  const day = 86400000;
  assert.deepStrictEqual(ent.accessState({ subscription_status: 'INTERNAL' }), { active: true, reason: 'internal' });
  assert.deepStrictEqual(ent.accessState({ subscription_status: 'ACTIVE' }), { active: true, reason: 'active' });
  // Free tier: TRIAL with no end date is perpetually active.
  assert.deepStrictEqual(ent.accessState({ subscription_status: 'TRIAL', trial_ends_at: null }), { active: true, reason: 'free' });
  // Legacy time-boxed trial: active while unexpired, read-only after.
  assert.strictEqual(ent.accessState({ subscription_status: 'TRIAL', trial_ends_at: new Date(Date.now() + 5 * day) }).active, true);
  assert.deepStrictEqual(ent.accessState({ subscription_status: 'TRIAL', trial_ends_at: new Date(Date.now() - day) }), { active: false, reason: 'trial_expired' });
  assert.strictEqual(ent.accessState({ subscription_status: 'PAST_DUE' }).active, false);
  assert.strictEqual(ent.accessState({ subscription_status: 'CANCELLED' }).active, false);
  assert.strictEqual(ent.accessState({ subscription_status: 'unknown-status' }).reason, 'unknown');
});

// ── Sub-tenant inheritance ──────────────────────────────────────────────────
test('sub-tenant inherits from an entitled parent, masked + cap-overridden, never lifetime', () => {
  const child = { id: 'c', parent_tenant_id: 'p', cap_overrides: { research: 50 }, feature_overrides: [plans.FEATURES.DISCOVERY, plans.FEATURES.ARENA] };
  const e = ent.entitlementsFor(child, { parent: PRO });
  assert.strictEqual(e.active, true);
  assert.strictEqual(e.isSubtenant, true);
  assert.deepStrictEqual(e.features.sort(), [plans.FEATURES.DISCOVERY, plans.FEATURES.ARENA].sort(), 'features intersect parent ceiling ∩ mask');
  assert.ok(!e.features.includes(plans.FEATURES.SUB_ACCOUNTS), 'children never nest');
  assert.strictEqual(e.caps.research, 50, 'cap_overrides win');
  assert.deepStrictEqual(e.lifetimeMeters, [], 'a sub-tenant is never lifetime');
});

test('sub-tenant goes read-only when the parent lacks SUB_ACCOUNTS (downgrade)', () => {
  const child = { id: 'c', parent_tenant_id: 'f' };
  const e = ent.entitlementsFor(child, { parent: FREE_V2 }); // Free has no sub_accounts
  assert.strictEqual(e.active, false);
  assert.strictEqual(e.reason, 'account_downgraded');
  assert.deepStrictEqual(e.features, []);
});

// ── JSON projection ─────────────────────────────────────────────────────────
test('toJson projects Infinity caps to null and carries lifetimeMeters', () => {
  const j = ent.toJson(ent.entitlementsFor(ENTERPRISE));
  assert.strictEqual(j.caps.research, null, 'unlimited → null on the wire');
  assert.strictEqual(j.caps.engagements, null);
  assert.ok(Array.isArray(j.lifetimeMeters));

  const jf = ent.toJson(ent.entitlementsFor(FREE_V2));
  assert.strictEqual(jf.caps.research, 20);
  assert.deepStrictEqual(jf.lifetimeMeters, ['engagements']);
  assert.strictEqual(jf.lifetimeCaps, false, 'legacy whole-plan flag is false on the mixed tier');
});

test('a null tenant is safely read-only with empty lifetimeMeters', () => {
  const e = ent.entitlementsFor(null);
  assert.strictEqual(e.active, false);
  assert.deepStrictEqual(e.lifetimeMeters, []);
});
