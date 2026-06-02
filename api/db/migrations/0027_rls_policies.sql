-- Row-Level Security policies (SOC 2 CC6.1 — defense-in-depth tenant isolation).
--
-- Enables RLS on every tenant-scoped table and adds a policy keyed on the
-- `app.tenant_id` GUC that the app sets per request (see api/src/db.js). The
-- owner/superuser role (POSTGRES_USER) BYPASSES RLS by default, so this is inert
-- for migrations / system / superadmin paths; only the restricted role
-- (DATABASE_APP_USER), used when RLS_ENFORCE=on, is constrained.
--
-- The GUC expression NULLIF(current_setting('app.tenant_id', true),'')::uuid
-- yields NULL when unset → matches no rows → safe deny (never an error).
--
-- CONVENTION: any NEW tenant-scoped table added in a later migration MUST add
-- its own `ENABLE ROW LEVEL SECURITY` + isolation policy here-style, or it will
-- be wide-open to the restricted role.

-- Direct tenant_id tables ---------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'api_tokens','arena_sessions','companies','competitor_battlecard_history',
    'competitor_battlecards','competitor_offerings','competitor_products',
    'competitors','crm_connections','kb_documents','personas','pre_call_briefs',
    'products','prospect_contacts','prospect_research','scheduled_meetings',
    'tenant_profiles','usage_counters','users'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- tenants: keyed on id (a tenant can see only its own row via the app role;
-- creating tenants happens on the system pool during onboarding). ------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self_isolation ON tenants;
CREATE POLICY tenants_self_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- audit_log: app role may INSERT events for its own tenant (or tenant-less,
-- e.g. pre-auth flows) and read only its own; superadmin reads all via sysPool.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Indirect tables: scoped via their tenant-owned parent ---------------------
-- children of kb_documents (document_id)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kb_chunks','kb_document_products','kb_document_personas','kb_document_competitors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        USING (EXISTS (SELECT 1 FROM kb_documents d WHERE d.id = %I.document_id
               AND d.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
        WITH CHECK (EXISTS (SELECT 1 FROM kb_documents d WHERE d.id = %I.document_id
               AND d.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
    $f$, t || '_tenant_isolation', t, t, t);
  END LOOP;
END $$;

-- children of scheduled_meetings (meeting_id)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduled_meeting_products','scheduled_meeting_personas','scheduled_meeting_competitors','mission_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        USING (EXISTS (SELECT 1 FROM scheduled_meetings m WHERE m.id = %I.meeting_id
               AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
        WITH CHECK (EXISTS (SELECT 1 FROM scheduled_meetings m WHERE m.id = %I.meeting_id
               AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
    $f$, t || '_tenant_isolation', t, t, t);
  END LOOP;
END $$;

-- trusted_devices: scoped via its owning user.
ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trusted_devices_tenant_isolation ON trusted_devices;
CREATE POLICY trusted_devices_tenant_isolation ON trusted_devices
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = trusted_devices.user_id
         AND u.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = trusted_devices.user_id
         AND u.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

-- kb_global_cache: a single shared row (not per-tenant) — allow the app role
-- to read/maintain it. schema_migrations is left without RLS (system-only).
ALTER TABLE kb_global_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kb_global_cache_all ON kb_global_cache;
CREATE POLICY kb_global_cache_all ON kb_global_cache USING (true) WITH CHECK (true);
