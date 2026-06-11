-- 0053: person-level location on contacts — at global companies two people
-- share a title; the country is how reps tell them apart.
ALTER TABLE prospect_contacts
  ADD COLUMN IF NOT EXISTS location text;
