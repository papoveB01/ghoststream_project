-- Add-on credit grants — top-up packs a tenant buys to keep working past their
-- monthly plan cap without upgrading tier. Each purchased pack is one row: a
-- bucket of `qty` credits with `remaining` drawn down as metered actions spill
-- over the plan cap (see usage.consume fall-through + credits.js).
--
-- Two credit KINDS, matching the two SKUs (see credits.js / ADR-0003):
--   'engagements' — one credit = one AI-joined call beyond the engagements cap.
--   'research'    — a shared pool for the cheap meters (discovery /
--                   competitor_research / market_monitoring / arena).
--
-- Credits expire 90 days after purchase (expires_at); expired rows are simply
-- never selected for consumption. Source ties the grant back to its Stripe
-- one-time payment so webhook replays stay idempotent.

CREATE TABLE IF NOT EXISTS credit_grants (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('engagements', 'research')),
  qty               int  NOT NULL CHECK (qty > 0),       -- credits granted by this pack
  remaining         int  NOT NULL CHECK (remaining >= 0),-- credits still unspent
  source            text NOT NULL DEFAULT 'stripe',      -- 'stripe' | 'manual' | 'comp'
  pack_key          text,                                -- which SKU (eng_50/eng_100/…)
  stripe_session_id text,                                -- Checkout Session that paid for it
  stripe_payment_intent text,                            -- the PaymentIntent (for reconciliation)
  expires_at        timestamptz NOT NULL,                -- 90 days from purchase
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Consumption query selects the tenant's live (remaining>0, unexpired) grants of
-- a kind, oldest-expiry first — this index serves that hot path directly.
CREATE INDEX IF NOT EXISTS credit_grants_live
  ON credit_grants(tenant_id, kind, expires_at)
  WHERE remaining > 0;

-- One grant per paid Checkout Session — guarantees webhook + /confirm replays
-- can't double-grant the same purchase.
CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_session
  ON credit_grants(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- RLS (CC6.1 — same convention as migrations 0031/0035). The owner/superuser
-- role (boot, scheduler, system paths) bypasses; the restricted app role only
-- sees its own tenant's grants.
ALTER TABLE credit_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_grants_tenant_isolation ON credit_grants;
CREATE POLICY credit_grants_tenant_isolation ON credit_grants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
