-- Subscription plans + usage metering.
--
-- `subscription_status` (migration 0007) is the lifecycle: TRIAL | ACTIVE |
-- PAST_DUE | CANCELLED | INTERNAL. This adds the *plan tier* (what you're
-- entitled to) alongside it, plus the Stripe linkage and a per-tenant monthly
-- usage counter that backs the per-plan caps.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'trial'
  CHECK (plan IN ('trial','starter','pro','enterprise','internal'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id     text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS current_period_end     timestamptz;

-- Backfill existing tenants from their lifecycle status.
UPDATE tenants SET plan = 'internal' WHERE subscription_status = 'INTERNAL' AND plan = 'trial';
UPDATE tenants SET plan = 'pro'      WHERE subscription_status = 'ACTIVE'   AND plan = 'trial';
-- The Founders/platform tenant is internal + ungated.
UPDATE tenants SET subscription_status = 'INTERNAL', plan = 'internal'
  WHERE id = '00000000-0000-0000-0000-000000000001';

CREATE INDEX IF NOT EXISTS tenants_stripe_customer ON tenants(stripe_customer_id);

-- Per-tenant, per-meter, per-month counter. One row per (tenant, meter, period);
-- `period` is the UTC 'YYYY-MM'. Backs the plan usage caps (discovery, etc).
CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meter      text NOT NULL,
  period     text NOT NULL,
  count      int  NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, meter, period)
);
