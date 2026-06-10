-- Pricing v2 (ADR-0004): seat-scaled allowances, paid sub-tenants, metered
-- engagement overage, and vendor-cost telemetry.
--
-- plan_version selects the catalog row in plans.js:
--   1 = ADR-0003 catalog (grandfathered — every existing tenant stays here
--       until it buys a new plan through checkout)
--   2 = ADR-0004 catalog (merged `research` meter, seat-scaled caps)
-- extra_seats is the count of PAID additional seats (beyond the plan's
-- included seats); the seat subscription item's quantity mirrors it.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS extra_seats  integer NOT NULL DEFAULT 0;

-- Vendor-spend telemetry (ADR-0004 §6 step 6). One row per billable external
-- call (Apollo credit, Firecrawl page, Gemini generation, Recall bot, ...).
-- est_cost_cents is our estimate at recording time — margins per tenant become
-- observable instead of modeled. Append-only; pruning is a future ops concern.
CREATE TABLE IF NOT EXISTS usage_costs (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  service        text NOT NULL,            -- 'gemini' | 'apollo' | 'firecrawl' | 'brave' | 'recall' | ...
  site           text,                     -- call site, e.g. 'research.synthesis', 'apollo.reveal'
  units          numeric NOT NULL DEFAULT 1, -- tokens, credits, pages, bot-hours — per `unit_kind`
  unit_kind      text,                     -- 'tokens_in' | 'tokens_out' | 'credits' | 'calls' | 'hours'
  est_cost_cents numeric,                  -- best-effort estimate; NULL when unknown
  meta           jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_costs_tenant_created_idx
  ON usage_costs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_costs_service_created_idx
  ON usage_costs (service, created_at DESC);
