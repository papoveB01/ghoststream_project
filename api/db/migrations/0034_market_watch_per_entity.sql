-- Market Watch goes per-entity: each watched prospect/competitor carries its OWN
-- schedule instead of one tenant-wide cadence. The tenant_profiles.watch_* columns
-- (migrations 0031–0033) are now unused and left in place (non-destructive).
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS watch_frequency   text        NOT NULL DEFAULT 'weekly';
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS watch_day         int         NOT NULL DEFAULT 1;       -- weekly 0..6 (Sun..Sat), monthly 1..28
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS watch_timezone    text        NOT NULL DEFAULT 'UTC';
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS watch_email_digest boolean    NOT NULL DEFAULT true;
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS watch_next_run_at timestamptz;
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS watch_last_run_at timestamptz;

ALTER TABLE competitors ADD COLUMN IF NOT EXISTS watch_frequency   text        NOT NULL DEFAULT 'weekly';
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS watch_day         int         NOT NULL DEFAULT 1;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS watch_timezone    text        NOT NULL DEFAULT 'UTC';
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS watch_email_digest boolean    NOT NULL DEFAULT true;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS watch_next_run_at timestamptz;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS watch_last_run_at timestamptz;

-- The scheduler scans these every tick — index the due-set per table.
CREATE INDEX IF NOT EXISTS companies_watch_due   ON companies   (watch_next_run_at) WHERE watch_enabled;
CREATE INDEX IF NOT EXISTS competitors_watch_due ON competitors (watch_next_run_at) WHERE watch_enabled;
