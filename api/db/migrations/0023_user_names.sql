-- Capture the user's first + last name at onboarding. The single `name` column
-- (migration 0007) is kept as the display name (set to "First Last") so existing
-- consumers keep working; these add the structured parts for personalization.

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  text;
