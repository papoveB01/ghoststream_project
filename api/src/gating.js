// Subscription gating middleware.
//
//   billingGate         — global. Resolves the caller's tenant (best-effort from
//                         the JWT), attaches req.entitlements, and enforces
//                         READ-ONLY when the subscription is inactive (trial
//                         expired / past due / cancelled): GETs and a small
//                         allowlist pass; other mutations get 402.
//   requireFeature(f)   — per-route. 402 unless the plan includes feature `f`.
//   requireCapacity(m)  — per-route. Atomically consumes one unit of meter `m`
//                         against the plan cap; 402 when the cap is reached.
//
// Public/unauthenticated routes (no resolvable tenant) pass straight through —
// they're gated at their own choke points (e.g. Arena, by the portal's tenant).

const auth = require('./auth');
const tenants = require('./tenants');
const entitlements = require('./entitlements');
const usage = require('./usage');
const plans = require('./plans');

// Writes that must stay reachable while inactive so the user can recover
// (sign in/out, manage billing, edit their own profile/password, finish signup).
function isAllowlisted(path) {
  if (path.startsWith('/billing')) return true;
  if (path.startsWith('/onboarding')) return true;
  if (path.startsWith('/auth/') && !path.startsWith('/auth/tokens')) return true;
  return false;
}

async function billingGate(req, res, next) {
  try {
    // Resolve a tenant id from the JWT (cookie or bearer). PAT-authenticated and
    // anonymous requests resolve to nothing and pass through.
    let tenantId = req.tenantId;
    if (!tenantId) {
      const claims = auth.verifyToken(auth.tokenFromRequest(req));
      if (claims) tenantId = claims.tid;
    }
    if (!tenantId) return next();

    const tenant = await tenants.get(tenantId);

    // Hard suspend (platform-admin kill switch) — block ALL authenticated
    // requests for the tenant, ahead of any billing/read-only logic.
    if (tenant && tenant.suspended_at) {
      return res.status(403).json({ error: 'This organization has been suspended.', code: 'TENANT_SUSPENDED' });
    }

    // resolveEntitlementsFor inherits billing/plan from the parent for sub-tenants.
    const ent = await entitlements.resolveEntitlementsFor(tenant);
    req.entitlements = ent;
    req.tenantRecord = tenant;

    if (ent.active) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (isAllowlisted(req.path)) return next();

    return res.status(402).json({
      error: ent.reason === 'trial_expired'
        ? 'Your free trial has ended. Upgrade to keep using DealScope.'
        : 'Your subscription is inactive. Update billing to continue.',
      code: 'SUBSCRIPTION_REQUIRED',
      reason: ent.reason,
    });
  } catch (err) { next(err); }
}

// Ensure req.entitlements is populated even if billingGate was bypassed for some
// reason (defensive — feature/capacity guards depend on it).
async function ensureEntitlements(req) {
  if (req.entitlements) return req.entitlements;
  const tenant = req.tenantRecord || (req.tenantId ? await tenants.get(req.tenantId) : null);
  req.entitlements = await entitlements.resolveEntitlementsFor(tenant);
  return req.entitlements;
}

function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const ent = await ensureEntitlements(req);
      if (!ent.active) {
        return res.status(402).json({ error: 'Your subscription is inactive.', code: 'SUBSCRIPTION_REQUIRED', reason: ent.reason });
      }
      if (!entitlements.hasFeature(ent, feature)) {
        return res.status(402).json({
          error: `Your ${ent.planName} plan doesn't include this feature. Upgrade to unlock it.`,
          code: 'FEATURE_NOT_IN_PLAN', feature, plan: ent.planKey,
        });
      }
      next();
    } catch (err) { next(err); }
  };
}

// Charge one unit of `meter` against the caller's plan, mapped through the
// tenant's catalog version (v2 folds discovery/competitor_research into the
// shared `research` pool — ADR-0004), spilling to purchased credits and — for
// engagements on an overage-eligible v2 subscription — to the $2.50 Stripe
// meter as the last resort. Returns the consume() handle for refunds.
async function chargeUnit(req, meter) {
  const ent = await ensureEntitlements(req);
  if (!ent.active) {
    const e = new Error('Your subscription is inactive.');
    e.status = 402; e.code = 'SUBSCRIPTION_REQUIRED'; e.reason = ent.reason;
    throw e;
  }
  const counterKey = plans.meterKey(ent.planVersion, meter);
  const cap = ent.caps ? ent.caps[counterKey] : 0;
  const opts = { useCredits: true, lifetime: ent.lifetimeCaps };
  if (counterKey === 'engagements' && ent.overage && ent.overage.customerId) {
    const billing = require('./billing');
    opts.useOverage = () => billing.recordEngagementOverage(ent.overage.customerId, req.tenantId);
  }
  const consumed = await usage.consume(req.tenantId, counterKey, cap, opts);
  return { meter: counterKey, consumed, lifetime: ent.lifetimeCaps };
}

function requireCapacity(meter) {
  return async (req, res, next) => {
    try {
      // Remember what we charged so a handler can refund it if the action fails
      // (e.g. discovery returns no usable result → 502). See refundCapacity().
      req._capacity = await chargeUnit(req, meter);
      next();
    } catch (err) {
      if (err.code === 'SUBSCRIPTION_REQUIRED') {
        return res.status(402).json({ error: err.message, code: 'SUBSCRIPTION_REQUIRED', reason: err.reason });
      }
      if (err.code === 'USAGE_LIMIT') {
        return res.status(402).json({ error: err.message, code: 'USAGE_LIMIT', meter });
      }
      next(err);
    }
  };
}

// Refund the unit a prior requireCapacity() charged on this request — call from
// a handler when the action failed AFTER the meter was consumed, so a failure
// doesn't burn the tenant's allowance. Idempotent (only refunds once) and
// best-effort (a refund error is logged, never thrown to the client).
async function refundCapacity(req) {
  const c = req && req._capacity;
  if (!c) return;
  req._capacity = null;
  try {
    await usage.refund(req.tenantId, c.meter, c.consumed, { lifetime: c.lifetime });
  } catch (err) {
    console.warn(`[gating] refundCapacity(${c.meter}) failed: ${(err && err.message) || err}`);
  }
}

// Gate only mutating requests on a router (so listing/GET stays available to
// every plan while connect/create/import etc. need the feature).
function requireFeatureWrite(feature) {
  const guard = requireFeature(feature);
  return (req, res, next) => (req.method === 'GET' ? next() : guard(req, res, next));
}

module.exports = { billingGate, requireFeature, requireFeatureWrite, requireCapacity, refundCapacity, ensureEntitlements, chargeUnit };
