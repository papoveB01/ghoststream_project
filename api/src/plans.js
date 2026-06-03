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
};

// "Standard" features (everything except the premium Market Watch). Pro+ tiers
// add MARKET_MONITORING explicitly so trial/starter don't inherit it.
const ALL = [
  FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS,
  FEATURES.ARENA, FEATURES.CRM, FEATURES.API_TOKENS, FEATURES.CALENDLY,
];
const PREMIUM = [...ALL, FEATURES.MARKET_MONITORING];
const CORE = [FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS];

// Metered actions (monthly caps). Keys match FEATURES so caps[meter] is direct.
const METERS = [FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS, FEATURES.MARKET_MONITORING, FEATURES.ARENA];

const PLANS = {
  // Caps below follow ADR-0003 "Option B": generous limits on the cheap meters
  // (discovery/competitor/arena/market — near-zero marginal cost) and disciplined
  // caps on the expensive, inelastic engagement meter (a ~$1.20 Recall bot each).
  trial: {
    key: 'trial', name: 'Trial', selfServe: false,
    blurb: '14-day free trial — explore the Pro feature set with a small monthly allowance.',
    features: ALL,
    caps: { discovery: 15, competitor_research: 15, engagements: 5, market_monitoring: 0, arena: 5 },
  },
  starter: {
    key: 'starter', name: 'Starter', selfServe: true, priceEnv: 'STRIPE_PRICE_STARTER', monthly: 49,
    trialDays: parseInt(process.env.STARTER_TRIAL_DAYS || '14', 10), // free trial lives on Starter only
    blurb: 'Foundation, prospect discovery, competitors, engagements and light Arena practice for a small team.',
    features: [...CORE, FEATURES.ARENA], // CORE + a limited Arena allowance (capped below)
    caps: { discovery: 75, competitor_research: 75, engagements: 15, market_monitoring: 0, arena: 40 },
  },
  pro: {
    key: 'pro', name: 'Pro', selfServe: true, priceEnv: 'STRIPE_PRICE_PRO', monthly: 149,
    blurb: 'Everything in Starter plus CRM, unlimited Arena, Calendly, API access and Market Watch — with higher limits.',
    features: PREMIUM,
    caps: { discovery: 250, competitor_research: 250, engagements: 75, market_monitoring: 500, arena: Infinity },
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
  },
  internal: {
    key: 'internal', name: 'Internal', selfServe: false,
    blurb: 'Platform/staff tenant — ungated.',
    features: PREMIUM,
    caps: { discovery: Infinity, competitor_research: Infinity, engagements: Infinity, market_monitoring: Infinity, arena: Infinity },
  },
};

function planFor(key) {
  return PLANS[key] || PLANS.trial;
}

// The Stripe price id for a self-serve plan, from its configured env var.
function priceIdFor(key) {
  const p = PLANS[key];
  return p && p.priceEnv ? (process.env[p.priceEnv] || null) : null;
}

// Free-trial length for a plan (0 = no trial). Only Starter offers one.
function trialDaysFor(key) {
  const p = PLANS[key];
  return p && p.trialDays ? p.trialDays : 0;
}

// JSON can't carry Infinity — render unlimited caps as null for the client.
function capForJson(v) { return Number.isFinite(v) ? v : null; }

// Public, client-safe catalog for the Billing UI (no env/internal fields).
function catalog() {
  return ['starter', 'pro', 'enterprise'].map((k) => {
    const p = PLANS[k];
    return {
      key: p.key, name: p.name, blurb: p.blurb,
      monthly: p.monthly || null,
      selfServe: !!p.selfServe,
      contactSales: !!p.contactSales,
      hasPrice: !!priceIdFor(p.key),
      features: p.features,
      caps: {
        discovery: capForJson(p.caps.discovery),
        competitor_research: capForJson(p.caps.competitor_research),
        engagements: capForJson(p.caps.engagements),
        market_monitoring: capForJson(p.caps.market_monitoring),
        arena: capForJson(p.caps.arena),
      },
    };
  });
}

module.exports = { FEATURES, ALL, METERS, PLANS, planFor, priceIdFor, trialDaysFor, catalog, capForJson };
