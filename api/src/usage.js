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

async function current(tenantId, meter) {
  const r = await db.query(
    `SELECT count FROM usage_counters WHERE tenant_id = $1 AND meter = $2 AND period = $3`,
    [tenantId, meter, currentPeriod()]
  );
  return r.rows[0] ? r.rows[0].count : 0;
}

// Snapshot of all meters for the current period (for the Billing UI).
async function summary(tenantId) {
  const r = await db.query(
    `SELECT meter, count FROM usage_counters WHERE tenant_id = $1 AND period = $2`,
    [tenantId, currentPeriod()]
  );
  const out = {};
  for (const row of r.rows) out[row.meter] = row.count;
  return out;
}

// Admit and count one unit if under `cap`. Unlimited (Infinity) is a no-op.
// Throws a 402 (code USAGE_LIMIT) when the cap is already reached.
async function consume(tenantId, meter, cap) {
  if (!Number.isFinite(cap)) return Infinity; // unlimited
  const period = currentPeriod();
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
    const e = new Error(`Monthly limit reached for this action (${cap}/mo on your plan). Upgrade for a higher limit.`);
    e.status = 402; e.code = 'USAGE_LIMIT';
    throw e;
  }
  return r.rows[0].count;
}

module.exports = { currentPeriod, current, summary, consume };
