-- CRM integrations: per-tenant connection to an external CRM (Salesforce, HubSpot,
-- Zoho, Pipedrive, Dynamics) used to PULL prospects into companies + contacts.
-- One connection per (tenant, provider). The access token lives in `credentials`
-- and is NEVER returned to the client.

CREATE TABLE IF NOT EXISTS crm_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider          text NOT NULL,                    -- hubspot|salesforce|zoho|pipedrive|dynamics
  status            text NOT NULL DEFAULT 'connected', -- connected|error
  credentials       jsonb NOT NULL DEFAULT '{}'::jsonb, -- { token, ...provider-specific }
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at      timestamptz,
  last_sync_summary jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS crm_connections_tenant ON crm_connections(tenant_id);
