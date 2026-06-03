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
    return { active: false, reason: 'no_tenant', planKey: null, planName: null, features: [], caps: {}, lifetimeCaps: false, daysLeft: null, isSubtenant: false, parentTenantId: null };
  }
  const isSub = !!tenant.parent_tenant_id;
  const parent = isSub ? (opts.parent || null) : null;
  // Billing/active + the plan tier come from the parent for a sub-tenant. If the
  // parent row wasn't supplied (defensive), fall back to read-only.
  const billingTenant = isSub ? parent : tenant;
  const state = billingTenant ? accessState(billingTenant) : { active: false, reason: 'no_parent' };
  const plan = plans.planFor(billingTenant ? billingTenant.plan : tenant.plan);

  let features = plan.features;
  let caps = plan.caps;
  let lifetimeCaps = !!plan.lifetimeCaps;

  if (isSub) {
    // Children never get the sub_accounts capability (no nesting).
    const ceiling = plan.features.filter((f) => f !== plans.FEATURES.SUB_ACCOUNTS);
    const mask = Array.isArray(tenant.feature_overrides) ? tenant.feature_overrides : ceiling;
    features = ceiling.filter((f) => mask.includes(f));
    // Parent-allocated caps override the plan caps per meter; unspecified meters
    // fall back to the plan cap.
    caps = (tenant.cap_overrides && typeof tenant.cap_overrides === 'object')
      ? { ...plan.caps, ...tenant.cap_overrides } : plan.caps;
    lifetimeCaps = false; // a sub-tenant under a paid parent uses monthly caps
  }

  return {
    active: state.active,
    reason: state.reason,
    status: (billingTenant || tenant).subscription_status,
    planKey: plan.key,
    planName: plan.name,
    features,
    caps,
    lifetimeCaps,
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

// Client-safe projection (caps with Infinity → null).
function toJson(ent) {
  return {
    active: ent.active,
    reason: ent.reason,
    status: ent.status || null,
    plan: ent.planKey,
    planName: ent.planName,
    features: ent.features,
    caps: {
      discovery: plans.capForJson(ent.caps.discovery),
      competitor_research: plans.capForJson(ent.caps.competitor_research),
      engagements: plans.capForJson(ent.caps.engagements),
      market_monitoring: plans.capForJson(ent.caps.market_monitoring),
      arena: plans.capForJson(ent.caps.arena),
    },
    lifetimeCaps: !!ent.lifetimeCaps,
    daysLeft: ent.daysLeft,
    currentPeriodEnd: ent.currentPeriodEnd || null,
    isSubtenant: !!ent.isSubtenant,
  };
}

module.exports = { accessState, entitlementsFor, resolveEntitlementsFor, hasFeature, trialDaysLeft, toJson };
