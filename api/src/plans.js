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
const METERS = [FEATURES.DISCOVERY, FEATURES.COMPETITOR_RESEARCH, FEATURES.ENGAGEMENTS, FEATURES.MARKET_MONITORING];

const PLANS = {
  trial: {
    key: 'trial', name: 'Trial', selfServe: false,
    blurb: '14-day free trial — full Pro features, Starter usage caps.',
    features: ALL,
    caps: { discovery: 10, competitor_research: 10, engagements: 20, market_monitoring: 0 },
  },
  starter: {
    key: 'starter', name: 'Starter', selfServe: true, priceEnv: 'STRIPE_PRICE_STARTER', monthly: 49,
    trialDays: parseInt(process.env.STARTER_TRIAL_DAYS || '14', 10), // free trial lives on Starter only
    blurb: 'Foundation, prospect discovery, competitors and engagements for a small team.',
    features: CORE,
    caps: { discovery: 10, competitor_research: 10, engagements: 20, market_monitoring: 0 },
  },
  pro: {
    key: 'pro', name: 'Pro', selfServe: true, priceEnv: 'STRIPE_PRICE_PRO', monthly: 149,
    blurb: 'Everything in Starter plus CRM, Arena practice, Calendly, API access and Market Watch — with higher limits.',
    features: PREMIUM,
    caps: { discovery: 50, competitor_research: 50, engagements: 100, market_monitoring: 150 },
  },
  enterprise: {
    key: 'enterprise', name: 'Enterprise', selfServe: false, contactSales: true,
    blurb: 'Custom limits, more seats, and onboarding support. Talk to us.',
    features: PREMIUM,
    caps: { discovery: Infinity, competitor_research: Infinity, engagements: Infinity, market_monitoring: Infinity },
  },
  internal: {
    key: 'internal', name: 'Internal', selfServe: false,
    blurb: 'Platform/staff tenant — ungated.',
    features: PREMIUM,
    caps: { discovery: Infinity, competitor_research: Infinity, engagements: Infinity, market_monitoring: Infinity },
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
      },
    };
  });
}

module.exports = { FEATURES, ALL, METERS, PLANS, planFor, priceIdFor, trialDaysFor, catalog, capForJson };
