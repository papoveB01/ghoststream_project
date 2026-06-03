-- Market Watch: run the schedule at 08:00 in the tenant's OWN timezone, not UTC.
-- IANA name (e.g. 'America/New_York'); 'UTC' keeps prior behaviour.
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS watch_timezone text NOT NULL DEFAULT 'UTC';
