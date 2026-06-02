-- 0020 — A first-class, editable company profile (positioning + objectives).
--
-- Why: the tenant's own positioning/objectives are the single most leveraged
-- input to the AI — keypoints.tenantContextText() injects "our company" context
-- into every competitor scoreboard, prospect research run, battlecard, and
-- pre-call brief. Until now that context was inferred from "whatever 5 TENANT
-- docs were uploaded most recently". This table makes it an explicit, editable
-- field the rep controls, which tenantContextText() reads first. One row per
-- tenant (upserted); free-text for v1.
CREATE TABLE IF NOT EXISTS tenant_profiles (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  positioning text,
  objectives  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
