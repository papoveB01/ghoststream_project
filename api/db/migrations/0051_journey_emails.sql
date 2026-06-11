-- 0051: dedupe ledger for activation drip emails — one row per (tenant, kind)
-- means each nudge sends exactly once, however often the cron fires.
CREATE TABLE IF NOT EXISTS journey_emails (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
