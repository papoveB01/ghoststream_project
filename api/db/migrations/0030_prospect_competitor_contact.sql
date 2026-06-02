-- Persist the location + public contact details discovery collects for a
-- prospect (companies) or competitor (competitors) when the rep adds one.
-- All nullable / free-text; populated from discovery results and rep-editable.
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS city    text;
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS phone   text;
ALTER TABLE companies   ADD COLUMN IF NOT EXISTS email   text;

ALTER TABLE competitors ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS city    text;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS phone   text;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS email   text;
