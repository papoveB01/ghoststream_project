-- Market Watch — agentic monitoring of watched prospects/competitors.
--
-- Opt-in per entity (watch_enabled), tenant-wide cadence on tenant_profiles,
-- and a watch_findings review queue (notifications) kept SEPARATE from intel
-- until a rep accepts a finding (which then promotes it into kb_documents).

ALTER TABLE companies   ADD COLUMN IF NOT EXISTS watch_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS watch_enabled boolean NOT NULL DEFAULT false;

-- Tenant-wide cadence + delivery config.
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS watch_enabled      boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS watch_frequency    text NOT NULL DEFAULT 'weekly';   -- daily|weekly|monthly
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS watch_email_digest boolean NOT NULL DEFAULT true;
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS watch_last_run_at  timestamptz;
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS watch_next_run_at  timestamptz;

-- The review queue / notifications. Append-only; status drives the inbox.
CREATE TABLE IF NOT EXISTS watch_findings (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('PROSPECT', 'COMPETITOR')),
  subject_id    text NOT NULL,             -- company_id (uuid as text) or competitor id (text slug)
  subject_name  text NOT NULL,
  category      text,                       -- funding | product | leadership | partnership | m&a | regulatory | expansion | incident | other
  title         text NOT NULL,
  summary       text,
  materiality   int  NOT NULL DEFAULT 3,    -- 1..5
  source_url    text,
  source_title  text,
  published_at  timestamptz,
  dedup_key     text NOT NULL,              -- sha256(scope|subject_id|url||lower(title)) — novelty guard
  status        text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'REVIEWED', 'ACCEPTED', 'DISMISSED')),
  promoted_doc_id uuid,                      -- kb_documents id once accepted into intel
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS watch_findings_tenant_status ON watch_findings(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS watch_findings_subject ON watch_findings(tenant_id, scope, subject_id);
CREATE UNIQUE INDEX IF NOT EXISTS watch_findings_dedup ON watch_findings(tenant_id, dedup_key);

-- RLS (CC6.1 — same convention as migration 0027). The owner/superuser role
-- bypasses; the restricted app role is scoped to its tenant.
ALTER TABLE watch_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watch_findings_tenant_isolation ON watch_findings;
CREATE POLICY watch_findings_tenant_isolation ON watch_findings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
