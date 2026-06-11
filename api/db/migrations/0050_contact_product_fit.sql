-- 0050: which of OUR products a contact is most likely the buyer for.
-- Set by AI at contact discovery (title/seniority vs product portfolio),
-- shown on the saved contact list and used to focus outreach drafts.
ALTER TABLE prospect_contacts
  ADD COLUMN IF NOT EXISTS likely_product_id text;
