-- Subscription cancellation — self-serve "cancel at period end" + a short exit
-- survey for churn intel.
--
-- cancel_at_period_end mirrors the Stripe subscription flag onto the tenant so
-- the Billing UI can show "ends <date>, then Free" and offer a Resume button
-- without a live Stripe round-trip. When the subscription actually lapses, the
-- webhook downgrades the tenant to the Free tier (plan 'trial') rather than
-- locking them out.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

-- Exit survey captured at cancel time (3-step form). Stored durably so the
-- intel survives even if Stripe/webhook hiccups. resumed_at is set if the user
-- later resumes before the period ends.
CREATE TABLE IF NOT EXISTS cancellation_feedback (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid,                       -- submitting user (auth.sub), if resolvable
  plan          text,                       -- plan being cancelled (starter/pro)
  reason        text,                       -- primary reason (enum-ish: too_expensive/missing_features/…)
  context       text,                       -- the reason-specific follow-up answer
  would_return  text,                       -- likelihood to return (unlikely/maybe/likely)
  comments      text,                       -- free-text "anything else"
  resumed_at    timestamptz,                -- set if they resumed before the period ended
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cancellation_feedback_tenant ON cancellation_feedback(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cancellation_feedback_reason ON cancellation_feedback(reason, created_at DESC);

-- RLS (CC6.1 — same convention as migrations 0031/0035/0036).
ALTER TABLE cancellation_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cancellation_feedback_tenant_isolation ON cancellation_feedback;
CREATE POLICY cancellation_feedback_tenant_isolation ON cancellation_feedback
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
