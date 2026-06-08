// Add-on credits — top-up packs a tenant buys to keep working past a monthly
// plan cap without upgrading tier. See ADR-0003 (the deferred "engagement
// overage" item) and migration 0036 (credit_grants).
//
// Two KINDS, matching the two SKUs:
//   'engagements' — one credit = one AI-joined call past the engagements cap.
//   'research'    — a shared pool for the cheap meters (discovery /
//                   competitor_research / market_monitoring / arena).
//
// Pricing is deliberately ~38% margin (round credit counts over the 55% target —
// a knowing trade, see ADR-0003 / project memory). Credits expire 90 days after
// purchase. Consumption is the spill-over from usage.consume once the plan cap
// is hit (user-initiated actions only — see usage.consume `useCredits`).

const db = require('./db');

const CREDIT_TTL_DAYS = 90;

// Which credit bucket a meter draws from when its monthly cap is exhausted.
function kindForMeter(meter) {
  return meter === 'engagements' ? 'engagements' : 'research';
}

// The purchasable packs. unitAmount is in cents (Stripe). We bill these as
// one-time payments with inline price_data, so no pre-created Stripe products
// are needed — they go live the moment STRIPE_SECRET_KEY is set.
const PACKS = {
  eng_50:  { key: 'eng_50',  kind: 'engagements', credits: 25,  unitAmount: 5000,  name: '25 engagement credits' },
  eng_100: { key: 'eng_100', kind: 'engagements', credits: 50,  unitAmount: 10000, name: '50 engagement credits' },
  eng_200: { key: 'eng_200', kind: 'engagements', credits: 100, unitAmount: 20000, name: '100 engagement credits' },
  research_50: { key: 'research_50', kind: 'research', credits: 50, unitAmount: 1900, name: '50 research credits' },
};

function packFor(key) { return PACKS[key] || null; }

// Client-safe catalog for the Billing UI's "Buy credits" cards.
function catalog() {
  return Object.values(PACKS).map((p) => ({
    key: p.key, kind: p.kind, credits: p.credits,
    priceUsd: p.unitAmount / 100, name: p.name,
    perCredit: Math.round((p.unitAmount / p.credits)) / 100,
  }));
}

// Record a purchased (or comped/manual) pack as a live grant. Idempotent on the
// Stripe session id so webhook + /confirm replays can't double-grant.
// Returns { id } of the new grant, or null if it already existed.
async function grant({ tenantId, kind, qty, source = 'stripe', packKey = null, sessionId = null, paymentIntent = null }) {
  if (!tenantId || !kind || !(qty > 0)) {
    const e = new Error('grant requires tenantId, kind, qty>0'); e.status = 400; throw e;
  }
  const r = await db.query(
    `INSERT INTO credit_grants
       (tenant_id, kind, qty, remaining, source, pack_key, stripe_session_id, stripe_payment_intent, expires_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, now() + ($8 || ' days')::interval)
     ON CONFLICT (stripe_session_id) WHERE stripe_session_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenantId, kind, qty, source, packKey, sessionId, paymentIntent, String(CREDIT_TTL_DAYS)]
  );
  return r.rows[0] || null;
}

// Atomically spend one credit of the given meter's kind, oldest-expiry first.
// Returns true if a credit was consumed, false if none available. Race-safe:
// FOR UPDATE SKIP LOCKED means two concurrent spenders never draw the same row.
async function tryConsume(tenantId, meter) {
  const kind = kindForMeter(meter);
  const r = await db.query(
    `UPDATE credit_grants
        SET remaining = remaining - 1
      WHERE id = (
        SELECT id FROM credit_grants
         WHERE tenant_id = $1 AND kind = $2 AND remaining > 0 AND expires_at > now()
         ORDER BY expires_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, remaining`,
    [tenantId, kind]
  );
  return r.rows.length > 0;
}

// Put a refunded unit back (mirrors tryConsume's selection: the soonest-expiring
// still-unexpired grant). Used when a credit-funded action fails and we roll the
// charge back. Best-effort — if every grant has since expired the unit is lost.
async function restore(tenantId, meter) {
  const kind = kindForMeter(meter);
  await db.query(
    `UPDATE credit_grants
        SET remaining = remaining + 1
      WHERE id = (
        SELECT id FROM credit_grants
         WHERE tenant_id = $1 AND kind = $2 AND expires_at > now()
         ORDER BY expires_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )`,
    [tenantId, kind]
  );
}

// Live balance per kind (unexpired, remaining>0) for the Billing UI:
//   { engagements: { remaining, nextExpiry }, research: { remaining, nextExpiry } }
async function summary(tenantId) {
  const r = await db.query(
    `SELECT kind, SUM(remaining)::int AS remaining, MIN(expires_at) AS next_expiry
       FROM credit_grants
      WHERE tenant_id = $1 AND remaining > 0 AND expires_at > now()
      GROUP BY kind`,
    [tenantId]
  );
  const out = { engagements: { remaining: 0, nextExpiry: null }, research: { remaining: 0, nextExpiry: null } };
  for (const row of r.rows) {
    out[row.kind] = { remaining: row.remaining, nextExpiry: row.next_expiry };
  }
  return out;
}

module.exports = { CREDIT_TTL_DAYS, PACKS, PACKS_LIST: Object.values(PACKS), packFor, catalog, kindForMeter, grant, tryConsume, restore, summary };
