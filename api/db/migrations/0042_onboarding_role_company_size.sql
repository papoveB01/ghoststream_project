-- Onboarding now captures the signer-upper's GTM role + their company's
-- employee-count bucket (3-step wizard). Both are nullable so existing rows
-- (and any non-onboarding user creation path) are unaffected.
--
--   users.job_title    — the rep's role, stored as a stable allow-list value
--                        (founder / sales_leader / account_executive / …).
--                        Distinct from users.role, which is the TENANCY role
--                        (owner / manager / rep). Named job_title to avoid any
--                        confusion with that.
--   tenants.company_size — employee bucket: 1-10 / 11-50 / 51-200 / 201-500 / 500+.
--                          Feeds ICP/positioning signal; one per workspace.

ALTER TABLE users   ADD COLUMN job_title    text;
ALTER TABLE tenants ADD COLUMN company_size text;
