// Guards for two pricing rules that CLAUDE.md / docs/claude/billing-entitlements.md
// state as non-negotiable but that nothing else in the test suite actually
// checks. plans.test.js covers price *resolution* (env var -> id) and the v2
// launch-catalog decisions; this file covers the two structural invariants
// underneath the catalog itself:
//   1. v1 and v2 Stripe price ids must never resolve to the same id -- the
//      mechanism the whole grandfathering scheme depends on.
//   2. every v2 (ADR-0004) self-serve plan's caps clear the >=35%-at-full-
//      utilization gross margin floor.
//
// See docs/adr/0004-seat-based-pricing-cost-model.md before touching the
// COGS table below or any cap in plans.js.

const { test } = require('node:test');
const assert = require('node:assert');
const plans = require('../src/plans');

// ─── Invariant 1: v1 / v2 Stripe price id disjointness ─────────────────────
//
// plans.js's own comment above PLANS_V2 says it plainly: "NEVER repoint the
// v1 STRIPE_PRICE_* env vars at v2 prices -- grandfathering depends on the
// price ids staying distinct." If a v1 plan's `priceEnv` (or a v2 add-on's)
// is ever pointed at the same Stripe price id a v2 plan resolves to, every
// tenant still parked on the v1 catalog gets silently re-priced/re-featured
// onto v2 terms at their next Stripe renewal -- no error, no log line, just
// a support ticket days later when a customer notices their invoice changed.
//
// Every env var below is set to a value DERIVED FROM ITS OWN NAME, so two
// different env vars can never accidentally collide in this test -- any
// overlap the assertion finds can only come from plans.js resolving two
// catalog entries through the SAME env var name, i.e. the actual "repointed"
// mistake this test exists to catch.
const V1_PRICE_ENVS = ['STRIPE_PRICE_STARTER', 'STRIPE_PRICE_PRO'];
const V2_PRICE_ENVS = [
  'STRIPE_PRICE_STARTER_V2', 'STRIPE_PRICE_PRO_V2',
  'STRIPE_PRICE_SEAT_STARTER', 'STRIPE_PRICE_SEAT_PRO', 'STRIPE_PRICE_SUBTENANT',
];

test('v1 and v2 Stripe price ids resolve to disjoint sets (grandfathering depends on it)', () => {
  const allEnvNames = [...V1_PRICE_ENVS, ...V2_PRICE_ENVS];
  const saved = {};
  for (const name of allEnvNames) {
    saved[name] = process.env[name];
    process.env[name] = 'price_test_' + name.toLowerCase();
  }

  try {
    // Resolve every v1 plan price through the real accessor.
    const v1Ids = Object.keys(plans.PLANS)
      .map((key) => plans.priceIdFor(key, 1))
      .filter(Boolean);

    // Resolve every v2 plan price PLUS every v2 add-on price (seats,
    // sub-tenant, overage) through the real accessors.
    const v2Ids = [
      ...Object.keys(plans.PLANS_V2).map((key) => plans.priceIdFor(key, 2)),
      ...Object.keys(plans.PLANS_V2).map((key) => plans.seatPriceIdFor(key)),
      ...Object.keys(plans.PLANS_V2).map((key) => plans.subTenantPriceIdFor(key)),
      ...Object.keys(plans.PLANS_V2).map((key) => plans.overagePriceIdFor(key)),
    ].filter(Boolean);

    // Sanity: prove this test is exercising real resolution (the env vars
    // set above), not silently no-op-ing because everything resolved null.
    assert.ok(v1Ids.length >= 2, 'expected both v1 self-serve plans (starter, pro) to resolve a price id');
    assert.ok(v2Ids.length >= 2, 'expected both v2 self-serve plans (starter, pro) to resolve a price id');

    const overlap = v1Ids.filter((id) => v2Ids.includes(id));
    assert.deepStrictEqual(overlap, [],
      'v1 price id(s) [' + overlap.join(', ') + '] also resolve on the v2 side. ' +
      'Grandfathering depends on v1 and v2 Stripe price ids staying distinct ' +
      '(CLAUDE.md; ADR-0004 §6): if a v1 STRIPE_PRICE_* is ever repointed at, or ' +
      'coded to reuse, a v2 price, every tenant still on the v1 catalog gets ' +
      'silently re-priced/re-featured onto v2 terms with no error -- the only ' +
      'signal is a customer billing complaint after the fact.');
  } finally {
    for (const name of allEnvNames) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

// ─── Invariant 2: ADR-0004 §4.3 margin floor on v2 plan caps ───────────────
//
// Per-unit worst-case COGS at the 2026 vendor rates ADR-0004 §3.2 derives
// (its "Per-unit COGS (normative)" table). Mirrors that table exactly --
// re-check it against §3.2 and re-run this file whenever a vendor (Recall.ai,
// Gemini, Apollo, Firecrawl) reprices; the ADR itself flags this as a live
// risk (§3.3 "Known COGS risks", §8 "Open questions").
//   engagement (1hr AI-joined call):                  $1.00
//   research run (discovery/competitor; merged as
//     the single `research` meter on v2):             $0.12
//   market-watch unit (one entity-tick):               $0.06
//   arena session (<=24 turns, cached persona):        $0.15
const COGS_PER_UNIT = {
  research: 0.12,
  engagements: 1.00,
  market_monitoring: 0.06,
  arena: 0.15,
};

// Stripe's cut on every revenue line (ADR-0004 §3.1: "2.9% + $0.30/txn").
const STRIPE_PCT = 0.029;
const STRIPE_FLAT = 0.30;

const MARGIN_FLOOR = 0.35; // ADR-0004 §4.3: >=35% gross margin at 100% cap utilization

// The floor is a v2 (ADR-0004) policy: it was adopted specifically to
// replace v1/ADR-0003's weaker "~55% margin at *expected* usage" modeling
// with a guaranteed worst-case number (ADR-0004 §1, §7 "Hold the
// 55%-at-expected-usage policy ... Adopted instead [the new floor]"). v1 is
// intentionally grandfathered at its old, pre-ADR-0004 caps/prices for
// existing tenants and plans.js's own comment says v1 must never be sold or
// repointed going forward -- so the *new* floor was never meant to apply
// retroactively to it (confirmed by checking: v1 Starter's current caps
// compute to ~17% worst-case margin under today's COGS, which is exactly why
// ADR-0004 tightened the caps for v2 rather than editing v1 in place).
// Only the plans a tenant can actually buy TODAY are in scope: PLANS_V2,
// and only the ones with a real self-serve price -- Free is $0/mo and
// Enterprise is negotiated (see the unbounded-cap guard below).
const PAID_V2_PLAN_KEYS = Object.keys(plans.PLANS_V2).filter((key) => {
  const p = plans.PLANS_V2[key];
  return p.selfServe && typeof p.monthly === 'number' && p.monthly > 0;
});

test('sanity: the v2 paid-plan set under test is exactly Starter and Pro', () => {
  assert.deepStrictEqual(PAID_V2_PLAN_KEYS.sort(), ['pro', 'starter']);
});

test('every v2 self-serve plan cap clears the ADR-0004 §4.3 >=35% worst-case margin floor', () => {
  for (const key of PAID_V2_PLAN_KEYS) {
    const plan = plans.PLANS_V2[key];
    const meters = Object.keys(plan.caps);

    // A plan with ANY unbounded (Infinity) cap has unbounded worst-case COGS
    // by construction -- there is no "100% utilization" to price against.
    // None of today's self-serve v2 plans (starter/pro) have an Infinity
    // cap; Enterprise/Internal do, and are excluded by the selfServe filter
    // above -- Enterprise is priced via ADR-0004 §4.1's negotiated $699
    // floor + constructed unit rates instead of this static-catalog check.
    // If a self-serve plan ever grows an uncapped meter, fail loudly here
    // rather than silently dropping it from the sum and under-counting COGS.
    const unboundedMeters = meters.filter((m) => !Number.isFinite(plan.caps[m]));
    assert.deepStrictEqual(unboundedMeters, [],
      key + ' has an unbounded cap on [' + unboundedMeters.join(', ') + ']. A ' +
      'self-serve plan cannot carry an uncapped meter and still be margin-checked ' +
      'at "100% utilization" -- either give it a real cap or move the plan to the ' +
      'negotiated-Enterprise path (ADR-0004 §4.1).');

    const worstCaseCogs = meters.reduce((sum, meter) => {
      const perUnit = COGS_PER_UNIT[meter];
      assert.ok(perUnit !== undefined,
        'no COGS entry for meter "' + meter + '" -- add it to COGS_PER_UNIT from ADR-0004 §3.2 before this test can trust the total');
      return sum + plan.caps[meter] * perUnit;
    }, 0);
    const stripeFee = plan.monthly * STRIPE_PCT + STRIPE_FLAT;
    const totalCogs = worstCaseCogs + stripeFee;
    const margin = (plan.monthly - totalCogs) / plan.monthly;

    assert.ok(margin >= MARGIN_FLOOR,
      key + ': worst-case margin is ' + (margin * 100).toFixed(1) + '% ' +
      '($' + totalCogs.toFixed(2) + ' COGS of $' + plan.monthly.toFixed(2) + '), ' +
      'below ADR-0004 §4.3\'s >=35% floor. That floor exists so NO tier goes ' +
      'underwater even if a tenant maxes every cap every month -- a cap bump that ' +
      'looks harmless in isolation (more research, more arena) can silently push a ' +
      'plan underwater once engagement COGS (the one genuinely expensive meter, ' +
      '~$1.00/call) is added back in. Re-run docs/adr/0004-seat-based-pricing-cost-model.md ' +
      '§4.3\'s worked table before raising any cap on this plan.');
  }
});

// Cross-check against the ADR's own worked example (§4.3): Starter base is
// stated as $49.00, ~$24.50 full-utilization COGS, ~50% worst-case margin.
// This pins the COGS table/arithmetic above to the ADR's literal numbers,
// not just "some number >= 35%" -- if this ever drifts, either the COGS
// table above is stale or the ADR needs re-running (ADR-0004 §5 "residual
// risk": "vendor repricing ... can move the table -- re-run §4.3 on any
// vendor change").
test('Starter v2 worst-case COGS/margin matches the ADR-0004 §4.3 worked example (~$24.50, ~50%)', () => {
  const starter = plans.PLANS_V2.starter;
  const cogs = starter.caps.research * COGS_PER_UNIT.research
    + starter.caps.engagements * COGS_PER_UNIT.engagements
    + starter.caps.arena * COGS_PER_UNIT.arena
    + (starter.caps.market_monitoring || 0) * COGS_PER_UNIT.market_monitoring;
  const fee = starter.monthly * STRIPE_PCT + STRIPE_FLAT;
  const totalCogs = cogs + fee;
  const margin = (starter.monthly - totalCogs) / starter.monthly;

  assert.ok(Math.abs(totalCogs - 24.50) < 0.5,
    'expected ~$24.50 full-utilization COGS per ADR-0004 §4.3, got $' + totalCogs.toFixed(2));
  assert.ok(Math.abs(margin - 0.50) < 0.03,
    'expected ~50% worst-case margin per ADR-0004 §4.3, got ' + (margin * 100).toFixed(1) + '%');
});
