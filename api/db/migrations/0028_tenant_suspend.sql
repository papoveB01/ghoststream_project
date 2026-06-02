-- Tenant suspension (platform-admin kill switch). A non-null suspended_at locks
-- the tenant out entirely: new logins are refused and every authenticated
-- request is blocked at billingGate (api/src/gating.js). Distinct from
-- subscription_status (which only gates read-only-vs-write). Reactivate = NULL.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
