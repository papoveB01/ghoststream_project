// Usage metering — per-tenant, per-meter, monthly counters that back the plan
// caps. consume() is atomic (single UPSERT) so concurrent requests can't race
// past a cap. It pre-charges: the unit is counted when the action is admitted,
// not on success, which keeps the check race-free at the cost of occasionally
// counting an action that later errors out (acceptable for monthly caps).

const db = require('./db');

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The free tier's caps are LIFETIME (never reset), so its usage is bucketed
// under a fixed period key instead of the current month. Paid tiers use the
// rolling monthly period. `lifetime` is plumbed from the plan's lifetimeCaps.
const LIFETIME_PERIOD = 'lifetime';
function periodFor(lifetime) { return lifetime ? LIFETIME_PERIOD : currentPeriod(); }

async function current(tenantId, meter) {
  const r = await db.query(
    `SELECT count FROM usage_counters WHERE tenant_id = $1 AND meter = $2 AND period = $3`,
    [tenantId, meter, currentPeriod()]
  );
  return r.rows[0] ? r.rows[0].count : 0;
}

// Snapshot of all meters for the relevant period (for the Billing UI). Free-tier
// (lifetime) tenants read the fixed lifetime bucket; paid tiers the current month.
async function summary(tenantId, { lifetime = false } = {}) {
  const r = await db.query(
    `SELECT meter, count FROM usage_counters WHERE tenant_id = $1 AND period = $2`,
    [tenantId, periodFor(lifetime)]
  );
  const out = {};
  for (const row of r.rows) out[row.meter] = row.count;
  return out;
}

// Admit and count one unit if under `cap`. Unlimited (Infinity) is a no-op.
// Throws a 402 (code USAGE_LIMIT) when the cap is already reached.
//
// opts.useCredits — when the monthly cap is exhausted, fall through to any
// purchased add-on credits (see credits.js) before failing. Only USER-INITIATED
// actions set this; automated/background consumers (e.g. the Market Watch tick)
// leave it off so a scheduled job never silently drains a tenant's credits.
// A credit-funded unit is NOT added to the monthly counter (the counter tracks
// plan-allowance usage; credits are a separate bucket).
async function consume(tenantId, meter, cap, opts = {}) {
  if (!Number.isFinite(cap)) return Infinity; // unlimited
  // A zero (or negative) cap means the plan can't perform this action at all.
  // Reject up front — without this the initial INSERT would admit one unit
  // before the count-vs-cap guard ever applies (the cap is only enforced on the
  // UPDATE path). Still honour purchased credits when allowed.
  if (cap <= 0) {
    if (opts.useCredits) {
      const credits = require('./credits');
      if (await credits.tryConsume(tenantId, meter)) return { credit: true };
    }
    const e = new Error('This action is not available on your plan. Upgrade or buy add-on credits.');
    e.status = 402; e.code = 'USAGE_LIMIT';
    throw e;
  }
  const period = periodFor(opts.lifetime);
  // ON CONFLICT ... WHERE: when the existing count is already >= cap the UPDATE
  // is skipped and RETURNING yields no row → we know we're over the limit.
  const r = await db.query(
    `INSERT INTO usage_counters (tenant_id, meter, period, count)
       VALUES ($1, $2, $3, 1)
     ON CONFLICT (tenant_id, meter, period)
       DO UPDATE SET count = usage_counters.count + 1, updated_at = now()
       WHERE usage_counters.count < $4
     RETURNING count`,
    [tenantId, meter, period, cap]
  );
  if (r.rows.length === 0) {
    // Plan allowance exhausted — try purchased credits before giving up.
    if (opts.useCredits) {
      const credits = require('./credits');
      if (await credits.tryConsume(tenantId, meter)) return { credit: true };
    }
    const e = new Error(`Monthly limit reached for this action (${cap}/mo on your plan). Buy add-on credits or upgrade for a higher limit.`);
    e.status = 402; e.code = 'USAGE_LIMIT';
    throw e;
  }
  return r.rows[0].count;
}

module.exports = { currentPeriod, current, summary, consume };
