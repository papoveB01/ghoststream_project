-- Hierarchical tenancy — a parent "account" tenant owns sub-tenant workspaces.
-- Billing is centralized at the parent; sub-tenants inherit their active/inactive
-- state and plan tier from the parent (see entitlements.js). The parent chooses,
-- per sub-tenant, which features it may use (feature_overrides) and how much of
-- the plan's usage pool it gets (cap_overrides). Standalone tenants leave all of
-- these NULL and behave exactly as before.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
-- Enterprise sub-tenant ceiling (set per-account via sales/superadmin). NULL =>
-- use the plan-derived default (Pro = 5; see plans.subAccountLimitFor).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_subtenants int;
-- Per-sub-tenant feature mask: a JSON array of feature keys the parent enabled
-- (subset of the parent plan's features). NULL on standalone/parent tenants.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feature_overrides jsonb;
-- Per-sub-tenant cap allocation: a JSON object of { meter: cap } the parent
-- allocated from its pool. NULL on standalone/parent tenants.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cap_overrides jsonb;

CREATE INDEX IF NOT EXISTS tenants_parent ON tenants(parent_tenant_id) WHERE parent_tenant_id IS NOT NULL;
