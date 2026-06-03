-- Market Watch: let the tenant pick WHICH day the schedule runs, not just the
-- cadence. watch_day is interpreted by watch_frequency:
--   weekly  → day-of-week 0..6 (0=Sunday … 6=Saturday); default 1 = Monday
--   monthly → day-of-month 1..28 (capped at 28 so every month has it)
--   daily   → ignored
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS watch_day int NOT NULL DEFAULT 1;
