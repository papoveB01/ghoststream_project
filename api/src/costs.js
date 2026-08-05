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

// ADR-0006 §5.1, retrieved 2026-08-05. Sonnet 5 carries introductory pricing
// ($2/$10) through 2026-08-31; the post-introductory rate is used here on
// purpose so nothing we model expires with the promotion.
const CLAUDE_RATES_PER_MTOK_CENTS = {
  'claude-opus-5':    { in: 500, out: 2500 },
  'claude-opus-4-8':  { in: 500, out: 2500 },
  'claude-sonnet-5':  { in: 300, out: 1500 },
  'claude-haiku-4-5': { in: 100, out: 500 },
};
// Cache pricing is a multiple of the model's own input rate, not a separate
// table, so a repricing only touches the table above. Writes cost 1.25× at the
// 5-minute TTL and 2× at the 1-hour TTL; reads cost 0.1× either way.
//
// `cache_creation_input_tokens` is the SUM across both TTLs, so it cannot be
// priced correctly on its own. Anthropic exposes a per-TTL split; when it is
// present we use it, and otherwise we fall back to the 1h rate rather than the
// 5m one. That is deliberate: ADR-0006 §4.3 puts caching on the long-lived
// prefixes (the call transcript across three analysis stages, tenant context,
// the global KB body) where 1h is the obvious TTL, so guessing 5m would
// under-report the exact spend this table exists to make visible. Over-report
// is the safe direction against a margin floor.
const CLAUDE_CACHE_WRITE_5M_MULT = 1.25;
const CLAUDE_CACHE_WRITE_1H_MULT = 2;
const CLAUDE_CACHE_READ_MULT = 0.1;

// Gemini prices cached prompt tokens at ~0.25× the input rate. `promptTokenCount`
// is the TOTAL prompt including the cached prefix — unlike Claude, where
// `input_tokens` excludes it — so the cached portion must be subtracted before
// billing the remainder at full rate.
const GEMINI_CACHE_READ_MULT = 0.25;

const APOLLO_CREDIT_CENTS = 2;     // on-plan rate (~$0.02); overage is 10× — the gap is the point of watching
const RECALL_HOUR_CENTS = 65;      // $0.50 recording + $0.15 transcription
const FIRECRAWL_PAGE_CENTS = 0.1;  // ~$0.001/page (standard mode)
const BRAVE_QUERY_CENTS = 0.1;

// Longest-prefix match against a rate table. Model ids are versioned strings
// ('gemini-2.5-flash-lite' contains 'gemini-2.5-flash'), so the longest match
// has to win or a lite call bills at the flash rate.
function rateFor(table, model) {
  const m = String(model || '').toLowerCase();
  let best = null;
  for (const [prefix, rate] of Object.entries(table)) {
    if (m.includes(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, rate };
  }
  return best ? best.rate : null;
}

function geminiRateFor(model) {
  return rateFor(GEMINI_RATES_PER_MTOK_CENTS, model);
}

function claudeRateFor(model) {
  return rateFor(CLAUDE_RATES_PER_MTOK_CENTS, model);
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
  const cached = usage.cachedContentTokenCount || 0;
  // The whole point of gemini.js is to serve most of the prompt from a
  // cachedContent resource at a quarter of the input rate. Billing the cached
  // prefix at full rate reports the Arena and global-KB paths at up to 4× their
  // real cost and shows the caching layer as worthless — and it is the exact
  // error recordClaude() below is written to avoid, so the two must agree.
  const fresh = Math.max(0, tin - cached);
  const tout = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  const rate = geminiRateFor(model);
  const cents = rate
    ? (fresh * rate.in + cached * rate.in * GEMINI_CACHE_READ_MULT + tout * rate.out) / 1e6
    : null;
  return record({
    tenantId, service: 'gemini', site, units: tin + tout, unitKind: 'tokens',
    estCostCents: cents != null ? Math.round(cents * 1000) / 1000 : null,
    meta: { model, tokensIn: tin, tokensOut: tout, cached },
  });
}

// One Claude generation. Unused until ADR-0006 phase 3 moves a task across;
// it lands now so the provider swap doesn't ship with cost telemetry dark.
//
// The trap this function exists to avoid: Claude's `input_tokens` is the
// UNCACHED REMAINDER, not the whole prompt. Total prompt tokens are
// input + cache_creation + cache_read, and the three bill at different rates
// (full, 1.25×, 0.1×). Renaming Gemini's promptTokenCount → input_tokens and
// stopping there under-reports every cached call — which would be exactly the
// calls ADR-0006 §4.3 relies on to hold the margin floor.
function recordClaude(tenantId, site, model, usage) {
  if (!usage) return Promise.resolve();
  const fresh = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const tout = usage.output_tokens || 0;  // thinking tokens bill as output and are already counted here
  // Per-TTL split when the response carries it, else the aggregate at the 1h
  // rate — see the constants above for why the fallback is 1h and not 5m.
  const split = usage.cache_creation || null;
  const write5m = split ? (split.ephemeral_5m_input_tokens || 0) : 0;
  const write1h = split
    ? (split.ephemeral_1h_input_tokens || 0)
    : (usage.cache_creation_input_tokens || 0);
  const cacheWrite = write5m + write1h;
  const rate = claudeRateFor(model);
  const cents = rate
    ? (fresh * rate.in
       + write5m * rate.in * CLAUDE_CACHE_WRITE_5M_MULT
       + write1h * rate.in * CLAUDE_CACHE_WRITE_1H_MULT
       + cacheRead * rate.in * CLAUDE_CACHE_READ_MULT
       + tout * rate.out) / 1e6
    : null;
  return record({
    tenantId, service: 'claude', site,
    units: fresh + cacheWrite + cacheRead + tout, unitKind: 'tokens',
    estCostCents: cents != null ? Math.round(cents * 1000) / 1000 : null,
    meta: { model, tokensIn: fresh, tokensOut: tout, cacheWrite, cacheRead },
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

// ── Read path ───────────────────────────────────────────────────────────────
// Until this existed, usage_costs was write-only: rows went in and nothing ever
// read them, so "what does a tenant cost us to serve" was unanswerable from the
// running system. Both queries aggregate in Postgres (never row-by-row into the
// api process) and carry a LIMIT — the table grows one row per external call,
// so an unbounded read here would be the next queryBounds.test.js entry.

const ROLLUP_MAX_DAYS = 365;
const ROLLUP_ROW_LIMIT = 2000;

function clampDays(days) {
  const n = Number(days);
  // `< 1`, not `<= 0`: Math.floor(0.5) is 0, and '0 days' is a zero-length
  // window that returns nothing while looking like a successful query.
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(Math.floor(n), ROLLUP_MAX_DAYS);
}

// Spend per tenant per service over a window. `tenantId` narrows to one tenant;
// omitted, it spans all of them (superadmin cross-tenant view).
async function rollupByTenant({ days = 30, tenantId = null } = {}) {
  const d = clampDays(days);
  const params = [d];
  if (tenantId) params.push(tenantId);
  const r = await db.query(
    `SELECT tenant_id, service,
            COUNT(*)::int                             AS calls,
            COALESCE(SUM(units), 0)::bigint           AS units,
            COALESCE(SUM(est_cost_cents), 0)::numeric AS cents,
            COUNT(*) FILTER (WHERE est_cost_cents IS NULL)::int AS unpriced
       FROM usage_costs
      WHERE created_at >= NOW() - ($1 || ' days')::interval
        ${tenantId ? 'AND tenant_id = $2' : ''}
      GROUP BY tenant_id, service
      ORDER BY cents DESC
      LIMIT ${ROLLUP_ROW_LIMIT}`,
    params
  );
  return r.rows.map((row) => ({
    tenantId: row.tenant_id,
    service: row.service,
    calls: row.calls,
    units: Number(row.units),
    cents: Number(row.cents),
    unpriced: row.unpriced,
  }));
}

// Spend per instrumented call site. Doubles as the coverage signal: a site
// missing from this list is a site nobody is recording, which is the failure
// mode that left this table empty in the first place. Read it as "what we can
// see", not "what we spend".
async function rollupBySite({ days = 30, tenantId = null } = {}) {
  const d = clampDays(days);
  const params = [d];
  if (tenantId) params.push(tenantId);
  const r = await db.query(
    `SELECT service, site,
            COUNT(*)::int                             AS calls,
            COALESCE(SUM(units), 0)::bigint           AS units,
            COALESCE(SUM(est_cost_cents), 0)::numeric AS cents,
            COUNT(*) FILTER (WHERE est_cost_cents IS NULL)::int AS unpriced,
            MIN(created_at)                           AS first_seen,
            MAX(created_at)                           AS last_seen
       FROM usage_costs
      WHERE created_at >= NOW() - ($1 || ' days')::interval
        ${tenantId ? 'AND tenant_id = $2' : ''}
      GROUP BY service, site
      ORDER BY cents DESC
      LIMIT ${ROLLUP_ROW_LIMIT}`,
    params
  );
  return r.rows.map((row) => ({
    service: row.service,
    site: row.site,
    calls: row.calls,
    units: Number(row.units),
    cents: Number(row.cents),
    unpriced: row.unpriced,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));
}

module.exports = {
  record, recordGemini, recordClaude, recordApollo, recordRecallDispatch,
  recordFirecrawl, recordBrave, rollupByTenant, rollupBySite,
  // exported for tests and the admin coverage view
  GEMINI_RATES_PER_MTOK_CENTS, CLAUDE_RATES_PER_MTOK_CENTS,
};
