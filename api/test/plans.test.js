// Pricing-catalog guardrails for the v2 launch catalog (see
// docs/pricing/market-benchmark-2026.md §6). Pure config + functions — no DB,
// no Stripe. These lock the decided numbers and the anti-abuse invariant so a
// future edit to plans.js can't silently reopen a farming exploit or revert a
// launch decision.

const { test } = require('node:test');
const assert = require('node:assert');
const plans = require('../src/plans');

// Worst-case marginal COGS per unit at the 2026 cost model (ADR-0004 §3.2):
// an AI-joined call is a ~$1.00 Recall bot; a research run is ~$0.12.
const COGS = { engagements: 1.0, research: 0.12, arena: 0.02, market_monitoring: 0.02 };

test('anti-abuse invariant: every v2 seat price ≥ the COGS it unlocks (§6a.5/§6a.2)', () => {
  for (const [key, plan] of Object.entries(plans.PLANS_V2)) {
    const seats = plan.seats;
    if (!seats || !seats.perSeat || !seats.priceMonthly) continue;
    const unlockedCogs = Object.entries(seats.perSeat)
      .reduce((sum, [meter, inc]) => sum + (COGS[meter] || 0) * inc, 0);
    assert.ok(
      seats.priceMonthly >= unlockedCogs,
      `${key}: seat $${seats.priceMonthly}/mo must be ≥ $${unlockedCogs.toFixed(2)} of unlocked COGS — seat-stacking would become profitable to farm`
    );
  }
});

test('Free tier activates on the cheap bundle: Arena on, cheap meters monthly, engagement lifetime (§6a.1)', () => {
  const free = plans.PLANS_V2.trial;
  assert.ok(free.features.includes(plans.FEATURES.ARENA), 'Arena is enabled on Free');
  assert.strictEqual(free.caps.research, 20, 'research bumped to 20');
  assert.strictEqual(free.caps.arena, 10, 'Arena capped at 10');
  assert.strictEqual(free.caps.engagements, 1, 'engagement stays a single taste');
  assert.strictEqual(free.caps.market_monitoring, 0, 'Market Watch stays a Pro-only differentiator');
  // Mixed model: only engagements is lifetime; research + Arena refresh monthly.
  assert.deepStrictEqual(plans.lifetimeMetersFor(free, 2), ['engagements']);
  assert.ok(!free.lifetimeCaps, 'the old whole-plan lifetime flag is gone (mixed model now)');
});

test('Starter seat cap raised to 5, per-seat increments unchanged (§6a.2)', () => {
  const starter = plans.PLANS_V2.starter;
  assert.strictEqual(starter.seats.max, 5);
  assert.deepStrictEqual(starter.seats.perSeat, { research: 25, engagements: 5 });
  // A maxed 5-seat Starter reaches exactly Pro's base engagement allowance — accepted.
  const maxedEngagements = starter.caps.engagements + starter.seats.perSeat.engagements * (starter.seats.max - starter.seats.included);
  assert.strictEqual(maxedEngagements, 30);
});

test('Pro metered $2.50 overage is deferred (§6b.6): no overage config, price id null', () => {
  const pro = plans.PLANS_V2.pro;
  assert.strictEqual(pro.overage, undefined, 'overage key removed until the safety tooling ships');
  assert.strictEqual(plans.overagePriceIdFor('pro'), null, 'no overage price id → no meter line at checkout');
});

test('paid tiers have no lifetime meters (all monthly)', () => {
  for (const key of ['starter', 'pro']) {
    assert.deepStrictEqual(plans.lifetimeMetersFor(plans.PLANS_V2[key], 2), []);
  }
});

test('public catalog exposes per-meter lifetime info for the Billing UI', () => {
  const free = plans.catalog().find((p) => p.key === 'trial');
  assert.deepStrictEqual(free.lifetimeMeters, ['engagements']);
  assert.strictEqual(free.lifetimeCaps, false, 'legacy whole-plan flag is false on the mixed Free tier');
});

// ── effectiveCaps / meterKey math ───────────────────────────────────────────
test('effectiveCaps adds per-seat increments only to finite, per-seat meters', () => {
  const caps = plans.effectiveCaps(plans.PLANS_V2.starter, 2);
  assert.strictEqual(caps.research, 75 + 25 * 2);
  assert.strictEqual(caps.engagements, 10 + 5 * 2);
  assert.strictEqual(caps.arena, 25, 'arena has no per-seat increment → unchanged');
  // Zero extra seats is a pass-through of the base caps object.
  assert.strictEqual(plans.effectiveCaps(plans.PLANS_V2.pro, 0), plans.PLANS_V2.pro.caps);
});

test('meterKey folds discovery/competitor_research into the shared research pool on v2 only', () => {
  assert.strictEqual(plans.meterKey(2, 'discovery'), 'research');
  assert.strictEqual(plans.meterKey(2, 'competitor_research'), 'research');
  assert.strictEqual(plans.meterKey(2, 'engagements'), 'engagements');
  assert.strictEqual(plans.meterKey(1, 'discovery'), 'discovery', 'v1 keeps them split');
});

// ── Stripe price-id resolution ──────────────────────────────────────────────
test('priceIdFor / seatPriceIdFor resolve from env; overagePriceIdFor is null while the meter is deferred', () => {
  process.env.STRIPE_PRICE_PRO_V2 = 'price_pro_test';
  process.env.STRIPE_PRICE_SEAT_STARTER = 'price_seat_starter_test';
  assert.strictEqual(plans.priceIdFor('pro'), 'price_pro_test');
  assert.strictEqual(plans.seatPriceIdFor('starter'), 'price_seat_starter_test');
  assert.strictEqual(plans.overagePriceIdFor('pro'), null, 'no overage config → no price id (§6b.6)');
  delete process.env.STRIPE_PRICE_PRO_V2;
  assert.strictEqual(plans.priceIdFor('pro'), null, 'unset env → null (endpoint 503s rather than mis-selling)');
});

// ── subAccountLimitFor ──────────────────────────────────────────────────────
test('subAccountLimitFor: 0 without the feature, plan default with it, per-account override wins', () => {
  assert.strictEqual(plans.subAccountLimitFor({ plan: 'trial', plan_version: 2 }), 0, 'Free has no sub-accounts');
  assert.strictEqual(plans.subAccountLimitFor({ plan: 'pro', plan_version: 2 }), 5, 'Pro default');
  assert.strictEqual(plans.subAccountLimitFor({ plan: 'enterprise', plan_version: 2, max_subtenants: 20 }), 20, 'sales override wins');
});

// ── Catalog integrity guard-rails ───────────────────────────────────────────
test('catalog integrity: exactly the four buyable tiers, no internal fields leak', () => {
  const cat = plans.catalog();
  assert.deepStrictEqual(cat.map((p) => p.key), ['trial', 'starter', 'pro', 'enterprise']);
  for (const p of cat) {
    assert.ok(!('priceEnv' in p), `${p.key} leaks priceEnv`);
    if (p.seats) assert.ok(!('priceEnv' in p.seats), `${p.key} seats leak priceEnv`);
  }
});

test('catalog integrity: every cap key is a known meter and every feature is a real FEATURE', () => {
  const validMeters = new Set(plans.metersFor(2));
  const validFeatures = new Set(Object.values(plans.FEATURES));
  for (const p of plans.catalog()) {
    for (const capKey of Object.keys(p.caps)) {
      assert.ok(validMeters.has(capKey), `${p.key} has unknown cap meter "${capKey}"`);
    }
    for (const f of p.features) {
      assert.ok(validFeatures.has(f), `${p.key} references unknown feature "${f}"`);
    }
  }
});

test('catalog integrity: self-serve plans carry a configured priceEnv', () => {
  for (const key of ['starter', 'pro']) {
    assert.ok(plans.PLANS_V2[key].priceEnv, `${key} must have a priceEnv to be buyable`);
  }
  assert.ok(!plans.PLANS_V2.trial.priceEnv, 'Free has no price');
});
