// Vendor-spend telemetry (ADR-0004 §6 step 6) — one row per billable external
// call, with a best-effort cost estimate at recording time. This is what turns
// the ADR's modeled per-unit COGS (engagement $1.00, research run $0.12, ...)
// into observed numbers per tenant; the two least-certain inputs (Arena
// sessions, Apollo reveals) are exactly the ones this instruments.
//
// record() is FIRE-AND-FORGET: telemetry must never fail, slow down, or roll
// back the action it observes. Errors are logged once and swallowed.

const db = require('./db');

// Estimate inputs — vendor list prices as of 2026-06 (cents). Estimates only:
// good enough to watch margins per tenant, not an invoice. Re-check against
// ADR-0004 §3.1 when a vendor reprices.
const GEMINI_RATES_PER_MTOK_CENTS = {
  // family-prefix match, longest wins
  'gemini-2.5-flash-lite': { in: 10, out: 40 },
  'gemini-2.5-flash':      { in: 30, out: 250 },
  'gemini-2.5-pro':        { in: 125, out: 1000 },
};
const APOLLO_CREDIT_CENTS = 2;     // on-plan rate (~$0.02); overage is 10× — the gap is the point of watching
const RECALL_HOUR_CENTS = 65;      // $0.50 recording + $0.15 transcription
const FIRECRAWL_PAGE_CENTS = 0.1;  // ~$0.001/page (standard mode)
const BRAVE_QUERY_CENTS = 0.1;

function geminiRateFor(model) {
  const m = String(model || '').toLowerCase();
  let best = null;
  for (const [prefix, rate] of Object.entries(GEMINI_RATES_PER_MTOK_CENTS)) {
    if (m.includes(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, rate };
  }
  return best ? best.rate : null;
}

// Insert one telemetry row. Never throws; never awaited by callers that don't
// want to be slowed down (it returns a promise for tests).
function record({ tenantId = null, service, site = null, units = 1, unitKind = null, estCostCents = null, meta = null }) {
  if (!service) return Promise.resolve();
  return db.query(
    `INSERT INTO usage_costs (tenant_id, service, site, units, unit_kind, est_cost_cents, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, service, site, units, unitKind, estCostCents, meta ? JSON.stringify(meta) : null]
  ).catch((e) => console.warn(`[costs] record(${service}/${site}) failed: ${(e && e.message) || e}`));
}

// One Gemini generation: tokens from the response's usageMetadata, cost from
// the model's list rate. Total tokens land in `units`; the in/out split rides
// in meta.
function recordGemini(tenantId, site, model, usage) {
  if (!usage) return Promise.resolve();
  const tin = usage.promptTokenCount || 0;
  const tout = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  const rate = geminiRateFor(model);
  const cents = rate ? (tin * rate.in + tout * rate.out) / 1e6 : null;
  return record({
    tenantId, service: 'gemini', site, units: tin + tout, unitKind: 'tokens',
    estCostCents: cents != null ? Math.round(cents * 1000) / 1000 : null,
    meta: { model, tokensIn: tin, tokensOut: tout, cached: usage.cachedContentTokenCount || 0 },
  });
}

// One Apollo credit spent (org enrich / people search / reveal / org search).
function recordApollo(tenantId, site, credits = 1) {
  return record({ tenantId, service: 'apollo', site, units: credits, unitKind: 'credits', estCostCents: credits * APOLLO_CREDIT_CENTS });
}

// One Recall bot dispatched. Duration isn't known at dispatch — estimate one
// recording hour (the ADR's modeling unit).
function recordRecallDispatch(tenantId, site, meta = null) {
  return record({ tenantId, service: 'recall', site, units: 1, unitKind: 'hours', estCostCents: RECALL_HOUR_CENTS, meta });
}

function recordFirecrawl(tenantId, site, pages = 1) {
  return record({ tenantId, service: 'firecrawl', site, units: pages, unitKind: 'pages', estCostCents: Math.round(pages * FIRECRAWL_PAGE_CENTS * 1000) / 1000 });
}

function recordBrave(tenantId, site, queries = 1) {
  return record({ tenantId, service: 'brave', site, units: queries, unitKind: 'queries', estCostCents: Math.round(queries * BRAVE_QUERY_CENTS * 1000) / 1000 });
}

module.exports = { record, recordGemini, recordApollo, recordRecallDispatch, recordFirecrawl, recordBrave };
