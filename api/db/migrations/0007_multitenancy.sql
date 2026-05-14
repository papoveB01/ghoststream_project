-- Multi-tenancy retrofit — "Shared Database, Row-Level Isolation".
--
-- Two new top-level entities own everything else:
--   tenants  — the organization (one per signed-up company)
--   users    — the individual login (belongs to exactly one tenant)
--
-- Every user-data table gains a tenant_id FK. The "Data Firewall" is enforced
-- in the API layer: each request derives tenant_id from the JWT and every
-- query is scoped `WHERE tenant_id = $current`. This migration only puts the
-- columns + constraints in place; the query scoping lands with the auth
-- refactor.
--
-- Backfill strategy ("Founders Backfill"): a fixed-UUID "Founders" tenant
-- absorbs all pre-existing rows so the demo data keeps working. tenant_id is
-- NOT NULL with a DEFAULT pointing at Founders, so the current single-tenant
-- code path keeps inserting successfully until it's updated to pass the
-- request's tenant explicitly. The default is a deliberate safety net — a
-- forgotten tenant_id lands in Founders rather than violating NOT NULL.
--
-- Known limitations punted to a follow-up (Phase 2):
--   * products / personas / competitors keep their TEXT primary keys. Two
--     tenants choosing the same entity id would collide. Phase-1 onboarding
--     does NOT let new tenants create entities (they only get the Firecrawl
--     "Basis" KB), so no collision is reachable yet.
--   * kb_global_cache stays a singleton (one shared Gemini context cache).
--     New tenants in Phase 1 only ingest PRODUCT_INTEL (the homepage scrape),
--     which doesn't trigger a global-cache rebuild, so this is inert for now.

-- The Founders tenant — fixed UUID so application code can reference it as a
-- constant (FOUNDERS_TENANT_ID).
-- 00000000-0000-0000-0000-000000000001

-- =========================================================================
-- tenants
-- =========================================================================
CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  -- The authenticated corporate domain (e.g. 'acme.com'). Onboarding looks a
  -- tenant up by this to offer "join your team" instead of creating a dup.
  -- NULL for the internal Founders tenant. UNIQUE allows multiple NULLs in PG.
  domain              text UNIQUE,
  subscription_status text NOT NULL DEFAULT 'TRIAL'
                        CHECK (subscription_status IN ('TRIAL','ACTIVE','PAST_DUE','CANCELLED','INTERNAL')),
  trial_ends_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenants_domain_lower ON tenants (lower(domain));

INSERT INTO tenants (id, name, domain, subscription_status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Founders', NULL, 'INTERNAL')
ON CONFLICT (id) DO NOTHING;

-- =========================================================================
-- users
-- =========================================================================
-- email is globally unique — a person has one GhostStream account. role is the
-- in-tenant permission level; is_admin is the platform-superadmin flag (only
-- the Founders tenant's owner has it). password_hash is bcrypt; the Founders
-- admin's hash is written at app boot from ADMIN_PASSWORD (this migration
-- leaves the table empty so it stays pure SQL).
CREATE TABLE users (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email                    text NOT NULL,
  password_hash            text NOT NULL,
  name                     text,
  role                     text NOT NULL DEFAULT 'owner'
                             CHECK (role IN ('owner','manager','rep')),
  is_admin                 boolean NOT NULL DEFAULT false,
  email_verified           boolean NOT NULL DEFAULT false,
  email_verification_token text,
  email_verified_at        timestamptz,
  last_login_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));
CREATE INDEX users_tenant ON users (tenant_id);
CREATE INDEX users_verification_token ON users (email_verification_token)
  WHERE email_verification_token IS NOT NULL;

-- =========================================================================
-- Retrofit tenant_id onto the user-data tables.
--
-- Pattern per table: ADD COLUMN nullable → backfill to Founders → SET NOT NULL
-- + DEFAULT Founders → index. The DEFAULT is what keeps the existing
-- single-tenant INSERTs working unchanged.
-- =========================================================================

-- companies
ALTER TABLE companies ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE companies SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE companies ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE companies ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
CREATE INDEX companies_tenant ON companies (tenant_id);
-- Company-name uniqueness becomes per-tenant: two tenants may each have an
-- "Acme Corp" prospect. Drop the global unique, recreate scoped.
DROP INDEX IF EXISTS companies_name_lower;
CREATE UNIQUE INDEX companies_tenant_name_lower ON companies (tenant_id, lower(name));

-- products / personas / competitors (TEXT pk kept — see header note)
ALTER TABLE products    ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE personas    ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE competitors ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE products    SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE personas    SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE competitors SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE products    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE personas    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE competitors ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE products    ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE personas    ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE competitors ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
CREATE INDEX products_tenant    ON products    (tenant_id);
CREATE INDEX personas_tenant    ON personas    (tenant_id);
CREATE INDEX competitors_tenant ON competitors (tenant_id);

-- kb_documents
ALTER TABLE kb_documents ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE kb_documents SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE kb_documents ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE kb_documents ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
CREATE INDEX kb_documents_tenant ON kb_documents (tenant_id);
-- "At most one READY per (category, title)" becomes per-tenant.
DROP INDEX IF EXISTS kb_documents_ready_uniq;
CREATE UNIQUE INDEX kb_documents_tenant_ready_uniq
  ON kb_documents (tenant_id, category, lower(title))
  WHERE status = 'READY';

-- scheduled_meetings
ALTER TABLE scheduled_meetings ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE scheduled_meetings SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE scheduled_meetings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE scheduled_meetings ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
CREATE INDEX scheduled_meetings_tenant ON scheduled_meetings (tenant_id);

-- pre_call_briefs
ALTER TABLE pre_call_briefs ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
UPDATE pre_call_briefs SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE pre_call_briefs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE pre_call_briefs ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
CREATE INDEX pre_call_briefs_tenant ON pre_call_briefs (tenant_id);

-- Junction tables (kb_document_*, scheduled_meeting_*) and kb_chunks inherit
-- their tenant via the parent row; no direct column needed. Retrieval already
-- JOINs kb_documents, so the tenant filter rides along.
