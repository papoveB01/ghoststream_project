-- Proposal Engine Phase 2 — per-prospect inbound email token.
-- A rep BCCs/forwards a prospect's emails to <token>@<INBOUND_PARSE_DOMAIN>;
-- SendGrid Inbound Parse POSTs them to our webhook, which maps the token back to
-- the prospect and files the email as PROSPECT intel (feeding research + the
-- proposal synthesis) + an engagement-input log row. One token per company.

CREATE TABLE IF NOT EXISTS prospect_inbound_tokens (
  token       text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id)
);
CREATE INDEX IF NOT EXISTS pit_tenant ON prospect_inbound_tokens(tenant_id);

ALTER TABLE prospect_inbound_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY pit_tenant_isolation ON prospect_inbound_tokens
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
