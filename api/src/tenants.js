// Tenant model — read/update the org row, with a short-lived in-process cache so
// the global billing gate doesn't hit Postgres on every request. The cache is
// invalidated on any update (and on Stripe webhook changes via update()).

const db = require('./db');

const CACHE_TTL_MS = 30_000;
const _cache = new Map(); // tenantId -> { tenant, exp }

const COLUMNS = `
  id, name, domain, subscription_status, plan, plan_version, extra_seats,
  trial_ends_at, current_period_end,
  stripe_customer_id, stripe_subscription_id, cancel_at_period_end, suspended_at,
  parent_tenant_id, max_subtenants, feature_overrides, cap_overrides, created_at, updated_at
`;

async function get(tenantId, { fresh = false } = {}) {
  if (!tenantId) return null;
  if (!fresh) {
    const c = _cache.get(tenantId);
    if (c && c.exp > Date.now()) return c.tenant;
  }
  const r = await db.query(`SELECT ${COLUMNS} FROM tenants WHERE id = $1`, [tenantId]);
  const tenant = r.rows[0] || null;
  if (tenant) _cache.set(tenantId, { tenant, exp: Date.now() + CACHE_TTL_MS });
  return tenant;
}

function invalidate(tenantId) { _cache.delete(tenantId); }

// Patch allowed columns only. Returns the fresh row.
const UPDATABLE = new Set([
  'name', 'domain', 'subscription_status', 'plan', 'trial_ends_at',
  'current_period_end', 'stripe_customer_id', 'stripe_subscription_id', 'suspended_at',
  'cancel_at_period_end', 'parent_tenant_id', 'max_subtenants', 'feature_overrides', 'cap_overrides',
  'plan_version', 'extra_seats',
]);
async function update(tenantId, patch) {
  const sets = []; const vals = []; let i = 1;
  for (const [k, v] of Object.entries(patch || {})) {
    if (UPDATABLE.has(k)) { sets.push(`${k} = $${i++}`); vals.push(v); }
  }
  if (sets.length) {
    vals.push(tenantId);
    await db.query(`UPDATE tenants SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i}`, vals);
    invalidate(tenantId);
  }
  return get(tenantId, { fresh: true });
}

async function findIdByStripeCustomer(customerId) {
  if (!customerId) return null;
  const r = await db.query(`SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1`, [customerId]);
  return r.rows[0] ? r.rows[0].id : null;
}

module.exports = { get, update, invalidate, findIdByStripeCustomer };
