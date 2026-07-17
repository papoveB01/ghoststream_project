// Entitlements — what a tenant may do RIGHT NOW, derived from its lifecycle
// status (subscription_status) and its plan tier (plan). The two are combined
// here so callers never re-implement the rules.
//
//   active  — may perform writes / AI-spend actions. Inactive tenants are
//             read-only (trial expired, past due, cancelled).
//   features/caps — come from the plan tier.

const plans = require('./plans');

// Decide whether the tenant is currently allowed to act, and why.
function accessState(tenant) {
  const status = tenant && tenant.subscription_status;
  if (status === 'INTERNAL') return { active: true, reason: 'internal' };
  if (status === 'ACTIVE') return { active: true, reason: 'active' };
  if (status === 'TRIAL') {
    // The free tier is TRIAL with NO end date — perpetually active (no card, no
    // expiry). A non-null end date is a legacy time-boxed trial: active until it
    // passes, then read-only. New signups never set one.
    if (!tenant.trial_ends_at) return { active: true, reason: 'free' };
    return new Date(tenant.trial_ends_at).getTime() > Date.now()
      ? { active: true, reason: 'trial' }
      : { active: false, reason: 'trial_expired' };
  }
  if (status === 'PAST_DUE') return { active: false, reason: 'past_due' };
  if (status === 'CANCELLED') return { active: false, reason: 'cancelled' };
  return { active: false, reason: 'unknown' };
}

function trialDaysLeft(tenant) {
  if (!tenant || tenant.subscription_status !== 'TRIAL' || !tenant.trial_ends_at) return null;
  return Math.max(0, Math.ceil((new Date(tenant.trial_ends_at).getTime() - Date.now()) / 86400000));
}

// Full entitlement snapshot for a tenant row.
//
// Sub-tenants (parent_tenant_id set) inherit their billing/active state AND plan
// tier from the PARENT — pass the parent row as `opts.parent`. Their effective
// features are the parent plan's features (minus sub_accounts — children can't
// nest) intersected with the parent-chosen mask (tenant.feature_overrides), and
// their caps are the parent-allocated slice (tenant.cap_overrides) layered over
// the plan caps. Standalone tenants ignore all of this (no parent passed).
function entitlementsFor(tenant, opts = {}) {
  if (!tenant) {
    return { active: false, reason: 'no_tenant', planKey: null, planName: null, planVersion: 1, features: [], caps: {}, lifetimeCaps: false, lifetimeMeters: [], daysLeft: null, isSubtenant: false, parentTenantId: null, seats: null, overage: null };
  }
  const isSub = !!tenant.parent_tenant_id;
  const parent = isSub ? (opts.parent || null) : null;
  // Billing/active + the plan tier come from the parent for a sub-tenant. If the
  // parent row wasn't supplied (defensive), fall back to read-only.
  const billingTenant = isSub ? parent : tenant;
  const state = billingTenant ? accessState(billingTenant) : { active: false, reason: 'no_parent' };
  // plan_version selects the catalog (1 = grandfathered ADR-0003 caps,
  // 2 = ADR-0004 seat-scaled caps). Sub-tenants ride the parent's version.
  const plan = plans.planForTenant(billingTenant || tenant);
  const planVersion = ((billingTenant || tenant).plan_version) || 1;

  let features = plan.features;
  // v2: paid extra seats grow the research/engagement allowances (ADR-0004 §4.1).
  let caps = plans.effectiveCaps(plan, (billingTenant && billingTenant.extra_seats) || 0);
  let lifetimeCaps = !!plan.lifetimeCaps;
  // Per-meter lifetime set (v2 Free is mixed: engagements lifetime, the rest
  // monthly). Threaded into usage.consume/summary/refund so each meter reads and
  // writes the correct period bucket.
  let lifetimeMeters = plans.lifetimeMetersFor(plan, planVersion);
  let active = state.active;
  let reason = state.reason;

  if (isSub) {
    // Sub-accounts are a Pro/Enterprise capability. If the parent downgraded to a
    // plan that no longer includes it (or cancelled → Free), its sub-tenants go
    // read-only until the parent re-upgrades. This is pure derivation — no row
    // mutation, and it reverses automatically when the parent upgrades again.
    const parentEntitled = plan.features.includes(plans.FEATURES.SUB_ACCOUNTS);
    // Children never get the sub_accounts capability themselves (no nesting).
    const ceiling = plan.features.filter((f) => f !== plans.FEATURES.SUB_ACCOUNTS);
    const mask = Array.isArray(tenant.feature_overrides) ? tenant.feature_overrides : ceiling;
    features = parentEntitled ? ceiling.filter((f) => mask.includes(f)) : [];
    // Parent-allocated caps override the plan caps per meter; unspecified meters
    // fall back to the plan's BASE caps (a child never inherits the parent's
    // per-seat bonuses — the parent allocates explicitly via cap_overrides).
    caps = (tenant.cap_overrides && typeof tenant.cap_overrides === 'object')
      ? { ...plan.caps, ...tenant.cap_overrides } : plan.caps;
    lifetimeCaps = false; // a sub-tenant under a paid parent uses monthly caps
    lifetimeMeters = [];  // …so no meter is lifetime for a sub-tenant
    if (!parentEntitled) { active = false; reason = 'account_downgraded'; }
  }

  // Seat add-on shape for the Billing UI (v2 standalone tenants only — a
  // sub-tenant's seats are the parent's concern).
  const seats = (!isSub && planVersion >= 2 && plan.seats) ? {
    included: plan.seats.included,
    extra: (tenant.extra_seats) || 0,
    max: plan.seats.max != null ? plan.seats.max : null,
    priceMonthly: plan.seats.priceMonthly || null,
    perSeat: plan.seats.perSeat || null,
  } : null;

  // Metered engagement overage (ADR-0004 §6 step 5): eligible when the v2 plan
  // defines it, the billing tenant holds a live subscription, and the metered
  // price is configured. The actual Stripe meter event needs the CUSTOMER id —
  // carried here so gating doesn't re-fetch the tenant row.
  const planOverage = planVersion >= 2 && plan.overage && plan.overage.engagements;
  const overage = (planOverage && billingTenant && billingTenant.stripe_subscription_id && plans.overagePriceIdFor(plan.key)) ? {
    meter: 'engagements',
    priceMonthly: plan.overage.engagements.priceMonthly,
    customerId: billingTenant.stripe_customer_id || null,
  } : null;

  return {
    active,
    reason,
    status: (billingTenant || tenant).subscription_status,
    planKey: plan.key,
    planName: plan.name,
    planVersion,
    features,
    caps,
    lifetimeCaps,
    lifetimeMeters,
    seats,
    overage,
    daysLeft: trialDaysLeft(billingTenant || tenant),
    currentPeriodEnd: (billingTenant || tenant).current_period_end || null,
    isSubtenant: isSub,
    parentTenantId: tenant.parent_tenant_id || null,
  };
}

// Async wrapper that resolves a sub-tenant's parent before computing entitlements.
// Use this at the request boundary (billingGate, capacity/feature guards) so
// inheritance is always applied; the sync entitlementsFor stays available for
// callers that already hold both rows.
async function resolveEntitlementsFor(tenant) {
  if (!tenant) return entitlementsFor(null);
  if (!tenant.parent_tenant_id) return entitlementsFor(tenant);
  const tenants = require('./tenants');
  const parent = await tenants.get(tenant.parent_tenant_id);
  return entitlementsFor(tenant, { parent });
}

function hasFeature(ent, feature) {
  return !!ent && Array.isArray(ent.features) && ent.features.includes(feature);
}

// Client-safe projection (caps with Infinity → null). The cap keys follow the
// tenant's catalog version (v1: discovery/competitor_research/...; v2: the
// merged research pool) — the Billing UI renders whichever keys arrive.
function toJson(ent) {
  const caps = {};
  for (const m of plans.metersFor(ent.planVersion)) caps[m] = plans.capForJson(ent.caps[m]);
  return {
    active: ent.active,
    reason: ent.reason,
    status: ent.status || null,
    plan: ent.planKey,
    planName: ent.planName,
    planVersion: ent.planVersion || 1,
    features: ent.features,
    caps,
    lifetimeCaps: !!ent.lifetimeCaps,
    lifetimeMeters: Array.isArray(ent.lifetimeMeters) ? ent.lifetimeMeters : [],
    seats: ent.seats || null,
    overage: ent.overage ? { meter: ent.overage.meter, priceMonthly: ent.overage.priceMonthly } : null,
    daysLeft: ent.daysLeft,
    currentPeriodEnd: ent.currentPeriodEnd || null,
    isSubtenant: !!ent.isSubtenant,
  };
}

module.exports = { accessState, entitlementsFor, resolveEntitlementsFor, hasFeature, trialDaysLeft, toJson };
