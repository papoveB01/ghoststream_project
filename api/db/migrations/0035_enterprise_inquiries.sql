-- Enterprise sales inquiries — captured from the "Contact sales" form on the
-- Billing page. The inputs (rep count, expected call volume, monitored
-- entities, CRM) are the pricing signals sales uses to quote a custom plan.
-- Stored durably so a dropped/blocked notification email never loses a lead.

CREATE TABLE IF NOT EXISTS enterprise_inquiries (
  id                    bigserial PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid,                       -- submitting user (auth.sub), if resolvable
  contact_name          text,
  contact_email         text NOT NULL,
  company_name          text,
  sales_reps            int,                        -- # of sales reps / seats — primary price signal
  monthly_engagements   int,                        -- expected AI-joined calls per month (cost driver)
  watched_entities      int,                        -- prospects/competitors to monitor (Market Watch)
  monthly_research_runs int,                        -- discovery + competitor research runs per month
  crm                   text,                       -- CRM in use (HubSpot/Salesforce/…)
  notes                 text,
  status                text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'WON', 'LOST')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enterprise_inquiries_tenant ON enterprise_inquiries(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS enterprise_inquiries_status ON enterprise_inquiries(status, created_at DESC);

-- RLS (CC6.1 — same convention as migration 0031). The owner/superuser role
-- (used by sales/ops tooling) bypasses; the restricted app role only sees its
-- own tenant's submissions.
ALTER TABLE enterprise_inquiries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enterprise_inquiries_tenant_isolation ON enterprise_inquiries;
CREATE POLICY enterprise_inquiries_tenant_isolation ON enterprise_inquiries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
