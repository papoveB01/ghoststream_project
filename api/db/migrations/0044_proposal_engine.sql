-- Proposal Engine (Phase 1) — intelligence-driven proposal RECOMMENDATIONS.
-- Per-prospect synthesis of our profile + prospect intel + competitor intel +
-- engagement touchpoints into an outcome-based recommendation. NOT a CRM:
-- no opportunities, stages, win/loss, or pricing. See docs/design/proposal-engine.md.
--
-- New tables are tenant-scoped and must declare their own RLS (per 0027_rls_policies.sql).

-- A generated recommendation, versioned per prospect. Regenerating = a new version.
CREATE TABLE IF NOT EXISTS proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version        int  NOT NULL,
  status         text NOT NULL DEFAULT 'DRAFT',          -- DRAFT | FINAL
  content_json   jsonb NOT NULL DEFAULT '{}'::jsonb,     -- the recommendation sections
  coverage_json  jsonb NOT NULL DEFAULT '{}'::jsonb,     -- intelligence coverage/confidence + gaps
  citations_json jsonb NOT NULL DEFAULT '[]'::jsonb,     -- the numbered evidence the synthesis cited
  models         jsonb,                                  -- model id + token usage
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, version)
);
CREATE INDEX IF NOT EXISTS proposals_company ON proposals(company_id, version DESC);
CREATE INDEX IF NOT EXISTS proposals_tenant  ON proposals(tenant_id);

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposals_tenant_isolation ON proposals
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only log of every engagement touchpoint that feeds a prospect's
-- intelligence (Phase 1: CALL/MANUAL/RESEARCH; Phase 2 adds EMAIL via BCC).
CREATE TABLE IF NOT EXISTS prospect_engagement_inputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type            text NOT NULL,                         -- CALL | EMAIL | RESEARCH | MANUAL
  ref             text,                                  -- portal id, message id, etc.
  extraction_json jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pei_company ON prospect_engagement_inputs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pei_tenant  ON prospect_engagement_inputs(tenant_id);

ALTER TABLE prospect_engagement_inputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY pei_tenant_isolation ON prospect_engagement_inputs
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
