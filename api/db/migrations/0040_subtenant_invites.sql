-- Sub-tenant invites — a parent account invites a new workspace by email. The
-- invitee self-onboards via the tokenized link, which creates the child tenant
-- (parent_tenant_id set) + its owner user with the parent-chosen features/caps.
-- See api/src/subaccounts.js.

CREATE TABLE IF NOT EXISTS subtenant_invites (
  id               bigserial PRIMARY KEY,
  parent_tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_name     text NOT NULL,
  domain           text NOT NULL,                 -- the sub-tenant's company domain
  email            text NOT NULL,                 -- owner invite address (must be under `domain`)
  features         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- feature-key mask the parent granted
  cap_overrides    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-meter cap allocation
  token            text NOT NULL UNIQUE,          -- random; used in the join link
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REVOKED')),
  created_by       uuid,                           -- parent user who sent it
  child_tenant_id  uuid REFERENCES tenants(id) ON DELETE SET NULL, -- set on accept
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS subtenant_invites_parent ON subtenant_invites(parent_tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subtenant_invites_token ON subtenant_invites(token);

-- RLS (defense-in-depth; the authed parent router queries via the system pool
-- with an explicit parent_tenant_id filter, and the public accept path is
-- token-scoped). Policy mirrors the tenant-isolation convention: a parent sees
-- only its own invites.
ALTER TABLE subtenant_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subtenant_invites_isolation ON subtenant_invites;
CREATE POLICY subtenant_invites_isolation ON subtenant_invites
  USING (parent_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (parent_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
