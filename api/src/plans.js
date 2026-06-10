// Plan catalog — the single source of truth for tiers, the features each
// unlocks, the monthly usage caps, and the Stripe price linkage.
//
// Two orthogonal axes live on the tenant:
//   subscription_status — lifecycle (TRIAL/ACTIVE/PAST_DUE/CANCELLED/INTERNAL),
//                         decides whether the tenant may act at all.
//   plan                — tier (trial/starter/pro/enterprise/internal), decides
//                         WHAT they may do (features + caps).
// Entitlement = function of both (see entitlements.js).

// Feature keys — the gateable capabilities. The meter keys for capped actions
// deliberately match these so usage counters line up with the catalog.
const FEATURES = {
  DISCOVERY:            'discovery',             // AI prospect discovery (web sweep)
  COMPETITOR_RESEARCH:  'competitor_research',   // AI competitor/offering research
  ENGAGEMENTS:          'engagements',           // schedule AI-joined calls
  ARENA:                'arena',                 // objection practice + scorecard
  CRM:                  'crm',                   // CRM integrations
  API_TOKENS:           'api_tokens',            // MCP / API tokens
  CALENDLY:             'calendly',              // Calendly auto-booking
  MARKET_MONITORING:    'market_monitoring',     // agentic Market Watch (premium)
  SUB_ACCOUNTS:         'sub_accounts',          // manage sub-tenant workspaces (Pro/Enterprise)
};

// "Standard" features (everything except the premium Market Watch). Pro+ tiers
// add MARKET_MONITORING explicitly so trial/starter don't inherit it.
const ALL = [
  FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS,
  FEATURES.ARENA, FEATURES.CRM, FEATURES.API_TOKENS, FEATURES.CALENDLY,
];
const PREMIUM = [...ALL, FEATURES.MARKET_MONITORING, FEATURES.SUB_ACCOUNTS];
const CORE = [FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS];

// Metered actions (monthly caps). Keys match FEATURES so caps[meter] is direct.
const METERS = [FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS, FEATURES.MARKET_MONITORING, FEATURES.ARENA];

// v2 (ADR-0004) merges discovery + competitor_research into one `research`
// pool — identical COGS, and the credit system already treats them as one
// bucket. The FEATURE keys stay split (routes still gate on them); only the
// metering merges. meterKey() maps a feature-level meter to the catalog
// version's counter key.
const RESEARCH_METER = 'research';
const METERS_V2 = [RESEARCH_METER, FEATURES.ENGAGEMENTS, FEATURES.MARKET_MONITORING, FEATURES.ARENA];
function meterKey(version, meter) {
  if ((version || 1) >= 2 && (meter === FEATURES.DISCOVERY || meter === FEATURES.COMPETITOR_RESEARCH)) return RESEARCH_METER;
  return meter;
}
function metersFor(version) { return (version || 1) >= 2 ? METERS_V2 : METERS; }

const PLANS = {
  // Caps below follow ADR-0003 "Option B": generous limits on the cheap meters
  // (discovery/competitor/arena/market — near-zero marginal cost) and disciplined
  // caps on the expensive, inelastic engagement meter (a ~$1 Recall bot each — see ADR-0004 for the current cost model).
  // Free, perpetual entry tier (key kept as 'trial' for back-compat). No card,
  // no expiry. The caps are LIFETIME, not monthly (lifetimeCaps) — a one-time
  // sample sized to protect COGS: discovery is near-free so it's generous (5),
  // but each engagement is a ~$1 Recall bot so it's a single lifetime call.
  // More than the sample = upgrade to Starter, or buy add-on credits (allowed
  // on free → effectively pay-as-you-go).
  trial: {
    key: 'trial', name: 'Free', selfServe: false, monthly: 0,
    blurb: 'Free forever, no card. Try discovery, competitor battlecards and one AI-joined call — upgrade or buy credits when you need more.',
    features: [FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS],
    caps: { discovery: 5, competitor_research: 5, engagements: 1, market_monitoring: 0, arena: 0 },
    lifetimeCaps: true, // caps count over the lifetime of the account, never reset
  },
  starter: {
    key: 'starter', name: 'Starter', selfServe: true, priceEnv: 'STRIPE_PRICE_STARTER', monthly: 49,
    blurb: 'Foundation, prospect discovery, competitors, engagements and light Arena practice for a small team.',
    features: [...CORE, FEATURES.ARENA], // CORE + a limited Arena allowance (capped below)
    caps: { discovery: 75, competitor_research: 75, engagements: 15, market_monitoring: 0, arena: 40 },
  },
  pro: {
    key: 'pro', name: 'Pro', selfServe: true, priceEnv: 'STRIPE_PRICE_PRO', monthly: 149,
    blurb: 'Everything in Starter plus CRM, unlimited Arena, Calendly, API access and Market Watch — with higher limits.',
    features: PREMIUM,
    caps: { discovery: 250, competitor_research: 250, engagements: 75, market_monitoring: 500, arena: Infinity },
    subAccountLimit: 5, // sub-tenant workspaces a Pro account may create
  },
  // Enterprise is custom-priced from a sales inquiry (rep count, expected call
  // volume, etc — see billing.enterprise-inquiry). Caps stay uncapped here so a
  // contracted account is never hard-blocked mid-month; the price is set to the
  // negotiated volume. The Billing UI shows "Custom", never "unlimited".
  enterprise: {
    key: 'enterprise', name: 'Enterprise', selfServe: false, contactSales: true,
    blurb: 'Custom limits, more seats, and onboarding support — tailored to your sales org.',
    features: PREMIUM,
    caps: { discovery: Infinity, competitor_research: Infinity, engagements: Infinity, market_monitoring: Infinity, arena: Infinity },
    subAccountLimit: null, // custom — set per-account via tenants.max_subtenants (sales)
  },
  internal: {
    key: 'internal', name: 'Internal', selfServe: false,
    blurb: 'Platform/staff tenant — ungated.',
    features: PREMIUM,
    caps: { discovery: Infinity, competitor_research: Infinity, engagements: Infinity, market_monitoring: Infinity, arena: Infinity },
    subAccountLimit: Infinity,
  },
};

// ── v2 catalog (ADR-0004) ───────────────────────────────────────────────────
// Seat-scaled pricing: engagements (the only expensive meter, ~$1.00 COGS at
// 2026 Recall rates) grow with paid seats; research/watch/arena are cheap and
// generously bundled. Every line clears a ≥35% gross margin even at 100% cap
// utilization — see docs/adr/0004-seat-based-pricing-cost-model.md §4.3 before
// touching any number here.
//
// Existing tenants stay on the v1 catalog above (plan_version=1) until they
// buy through checkout; new signups and new checkouts are v2. NEVER repoint
// the v1 STRIPE_PRICE_* env vars at v2 prices — grandfathering depends on the
// price ids staying distinct.
const PLANS_V2 = {
  trial: {
    key: 'trial', version: 2, name: 'Free', selfServe: false, monthly: 0,
    blurb: 'Free forever, no card. Try discovery, competitor battlecards and one AI-joined call — upgrade or buy credits when you need more.',
    features: [FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS],
    caps: { research: 5, engagements: 1, market_monitoring: 0, arena: 0 },
    lifetimeCaps: true,
    seats: { included: 1 },
  },
  starter: {
    key: 'starter', version: 2, name: 'Starter', selfServe: true, priceEnv: 'STRIPE_PRICE_STARTER_V2', monthly: 49,
    blurb: 'Foundation, 75 researched prospects a month, AI-covered calls and Arena practice for a small team.',
    features: [...CORE, FEATURES.ARENA],
    caps: { research: 75, engagements: 10, market_monitoring: 0, arena: 25 },
    seats: { included: 1, priceMonthly: 19, priceEnv: 'STRIPE_PRICE_SEAT_STARTER', max: 3, perSeat: { research: 25, engagements: 5 } },
  },
  pro: {
    key: 'pro', version: 2, name: 'Pro', selfServe: true, priceEnv: 'STRIPE_PRICE_PRO_V2', monthly: 149,
    blurb: 'Everything in Starter plus CRM, Calendly, API access and Market Watch — allowances that grow with your team.',
    features: PREMIUM,
    caps: { research: 250, engagements: 30, market_monitoring: 250, arena: 100 },
    seats: { included: 2, priceMonthly: 35, priceEnv: 'STRIPE_PRICE_SEAT_PRO', max: null, perSeat: { research: 25, engagements: 15 } },
    subAccountLimit: 5,
    subTenants: { included: 1, priceMonthly: 29, priceEnv: 'STRIPE_PRICE_SUBTENANT' },
    // Past the engagement allowance (and any purchased credits) each extra
    // AI-joined call is metered at $2.50 via a Stripe billing meter — the
    // ADR-0003 "engagement overage" item, finally shipped.
    overage: { engagements: { priceMonthly: 2.5, priceEnv: 'STRIPE_PRICE_ENG_OVERAGE' } },
  },
  enterprise: {
    key: 'enterprise', version: 2, name: 'Enterprise', selfServe: false, contactSales: true,
    blurb: 'Custom limits, more seats, and onboarding support — tailored to your sales org.',
    features: PREMIUM,
    caps: { research: Infinity, engagements: Infinity, market_monitoring: Infinity, arena: Infinity },
    seats: { included: null }, // negotiated
    subAccountLimit: null,
  },
  internal: {
    key: 'internal', version: 2, name: 'Internal', selfServe: false,
    blurb: 'Platform/staff tenant — ungated.',
    features: PREMIUM,
    caps: { research: Infinity, engagements: Infinity, market_monitoring: Infinity, arena: Infinity },
    seats: { included: null },
    subAccountLimit: Infinity,
  },
};

function planFor(key, version) {
  if ((version || 1) >= 2) return PLANS_V2[key] || PLANS_V2.trial;
  return PLANS[key] || PLANS.trial;
}

// Resolve a tenant row to its catalog entry (plan key + plan_version).
function planForTenant(tenant) {
  return planFor(tenant && tenant.plan, (tenant && tenant.plan_version) || 1);
}

// Effective caps for a v2 tenant: plan base + per-seat increments for each
// PAID extra seat. v1 plans have no seat config so this is a pass-through.
function effectiveCaps(plan, extraSeats = 0) {
  const per = plan && plan.seats && plan.seats.perSeat;
  const n = Math.max(0, parseInt(extraSeats, 10) || 0);
  if (!per || n === 0) return plan.caps;
  const caps = { ...plan.caps };
  for (const [meter, inc] of Object.entries(per)) {
    if (Number.isFinite(caps[meter])) caps[meter] += inc * n;
  }
  return caps;
}

// The Stripe price id for a self-serve plan, from its configured env var.
// New checkouts always sell the v2 catalog (ADR-0004 grandfathering: v1 lives
// on only for subscriptions that already exist).
function priceIdFor(key, version = 2) {
  const p = planFor(key, version);
  return p && p.priceEnv ? (process.env[p.priceEnv] || null) : null;
}

// Env-configured price id for an add-on (seats / sub-tenants / overage) on a
// v2 plan. Returns null when the add-on doesn't exist on the plan or the env
// var isn't set (the endpoint then 503s like the plan prices do).
function seatPriceIdFor(planKey) {
  const p = PLANS_V2[planKey];
  return p && p.seats && p.seats.priceEnv ? (process.env[p.seats.priceEnv] || null) : null;
}
function subTenantPriceIdFor(planKey) {
  const p = PLANS_V2[planKey];
  return p && p.subTenants && p.subTenants.priceEnv ? (process.env[p.subTenants.priceEnv] || null) : null;
}
function overagePriceIdFor(planKey) {
  const p = PLANS_V2[planKey];
  return p && p.overage && p.overage.engagements ? (process.env[p.overage.engagements.priceEnv] || null) : null;
}

// Free-trial length for a plan (0 = no trial). Only Starter offers one.
function trialDaysFor(key) {
  const p = PLANS[key];
  return p && p.trialDays ? p.trialDays : 0;
}

// How many sub-tenant workspaces a tenant may create. 0 = the plan doesn't
// include sub-accounts at all. An explicit per-account override
// (tenants.max_subtenants, set by sales/superadmin) always wins — that's how
// Enterprise gets its negotiated limit (and how a Pro account can be bumped).
function subAccountLimitFor(tenant) {
  const plan = planForTenant(tenant);
  if (!plan.features.includes(FEATURES.SUB_ACCOUNTS)) return 0;
  if (plan.subAccountLimit === Infinity) return Infinity;
  if (tenant && Number.isInteger(tenant.max_subtenants)) return Math.max(0, tenant.max_subtenants);
  return Number.isInteger(plan.subAccountLimit) ? plan.subAccountLimit : 0;
}

// JSON can't carry Infinity — render unlimited caps as null for the client.
function capForJson(v) { return Number.isFinite(v) ? v : null; }

// Public, client-safe catalog for the Billing UI (no env/internal fields).
// Always the v2 catalog — these are the plans a tenant can buy TODAY. A
// grandfathered v1 tenant's CURRENT caps come from its entitlements, not from
// these cards.
function catalog() {
  return ['trial', 'starter', 'pro', 'enterprise'].map((k) => {
    const p = PLANS_V2[k];
    const caps = {};
    for (const m of METERS_V2) caps[m] = capForJson(p.caps[m]);
    return {
      key: p.key, name: p.name, blurb: p.blurb,
      version: 2,
      monthly: p.monthly != null ? p.monthly : null, // 0 = free, null = custom (Enterprise)
      selfServe: !!p.selfServe,
      contactSales: !!p.contactSales,
      lifetimeCaps: !!p.lifetimeCaps,
      hasPrice: !!priceIdFor(p.key, 2),
      features: p.features,
      caps,
      seats: p.seats ? {
        included: p.seats.included,
        priceMonthly: p.seats.priceMonthly || null,
        max: p.seats.max != null ? p.seats.max : null,
        perSeat: p.seats.perSeat || null,
      } : null,
      subTenants: p.subTenants ? { included: p.subTenants.included, priceMonthly: p.subTenants.priceMonthly } : null,
      overage: p.overage ? { engagements: p.overage.engagements.priceMonthly } : null,
    };
  });
}

module.exports = {
  FEATURES, ALL, METERS, METERS_V2, RESEARCH_METER, PLANS, PLANS_V2,
  planFor, planForTenant, effectiveCaps, meterKey, metersFor,
  priceIdFor, seatPriceIdFor, subTenantPriceIdFor, overagePriceIdFor,
  trialDaysFor, subAccountLimitFor, catalog, capForJson,
};
