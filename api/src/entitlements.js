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
function entitlementsFor(tenant) {
  if (!tenant) {
    return { active: false, reason: 'no_tenant', planKey: null, planName: null, features: [], caps: {}, lifetimeCaps: false, daysLeft: null };
  }
  const state = accessState(tenant);
  const plan = plans.planFor(tenant.plan);
  return {
    active: state.active,
    reason: state.reason,
    status: tenant.subscription_status,
    planKey: plan.key,
    planName: plan.name,
    features: plan.features,
    caps: plan.caps,
    lifetimeCaps: !!plan.lifetimeCaps,
    daysLeft: trialDaysLeft(tenant),
    currentPeriodEnd: tenant.current_period_end || null,
  };
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
  };
}

module.exports = { accessState, entitlementsFor, hasFeature, trialDaysLeft, toJson };
