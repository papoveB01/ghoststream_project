-- Ideal Customer Profile — a first-class "who we sell to" field, distinct from
-- positioning ("what we do"). Discovery (prospects + competitors) grounds on it
-- so the model targets the tenant's BUYERS, not companies like the tenant.
-- Auto-populated from the website-scrape audience / AI analysis; rep-editable.
ALTER TABLE tenant_profiles ADD COLUMN IF NOT EXISTS ideal_customer_profile text;
