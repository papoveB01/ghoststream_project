-- Free tier migration — replace the time-boxed 14-day trial with a perpetual,
-- card-free Free tier (plan key 'trial', name "Free"; caps are LIFETIME, see
-- plans.js / entitlements.js).
--
-- Existing tenants currently on a trial (subscription_status = 'TRIAL') are moved
-- onto the Free tier: pin them to plan 'trial' and clear trial_ends_at so they
-- read as perpetually active (TRIAL + NULL end date = active, never expires) and
-- are never locked out when the old 14-day window would have elapsed. Their
-- lifetime usage starts fresh — the Free tier's caps live under a separate
-- 'lifetime' bucket in usage_counters, not the monthly periods they may already
-- have rows for, so no usage backfill is needed.
--
-- Paid tenants (ACTIVE / PAST_DUE / CANCELLED) and INTERNAL are untouched.

UPDATE tenants
   SET plan = 'trial',
       trial_ends_at = NULL
 WHERE subscription_status = 'TRIAL';
