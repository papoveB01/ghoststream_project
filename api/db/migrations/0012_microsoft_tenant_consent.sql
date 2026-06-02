-- tenant_microsoft_consent — per-(GhostStream tenant) record that the
-- customer's Microsoft IT admin has granted our multi-tenant Azure AD app
-- application-permission consent in their MS tenant.
--
-- See docs/adr/0002-microsoft-graph-direct.md §4.3 + §4.4.
--
-- Lifecycle:
--   1. Tenant owner clicks "Authorize Teams bot" → admin-consent flow.
--   2. Callback INSERTs (or UPDATEs) this row + POSTs the credentials to
--      Recall.ai /teams-bot-credentials/; the returned Recall credential id
--      lives in recall_credential_id.
--   3. missions/dispatch.js reads this row when dispatching a Teams bot:
--      if recall_credential_id is non-null and revoked_at IS NULL, it passes
--      teams_bot_credential_id to recall.createBot so the bot joins as the
--      authenticated app identity. Otherwise: anonymous-join (today's path).
--   4. Owner revokes → revoked_at set, dispatcher reverts to anonymous-join.
--      The Recall credential stays on Recall's side (idempotent re-consent
--      reuses the same recall_credential_id).
--
-- One row per tenant: PK is tenant_id. Re-consent (e.g. after a secret
-- rotation) ON CONFLICT (tenant_id) DO UPDATE — see integrations.js.
--
-- RLS: same pattern as 0011 — application-layer "Data Firewall" enforces
-- tenant scoping today. RLS comes in PR 3 of ADR-0001.

CREATE TABLE tenant_microsoft_consent (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- The customer's Microsoft tenant id (their Azure tenant GUID). Distinct
  -- from our GhostStream tenant_id — this is the OID Recall.ai uses to
  -- target their tenant when joining a Teams meeting.
  ms_tenant_id         text NOT NULL CHECK (char_length(ms_tenant_id) BETWEEN 1 AND 100),
  -- Who clicked the button. Owner role at the time, but we don't FK-enforce
  -- that — the consent belongs to the tenant, not the user, so we keep the
  -- row valid if the consenting user is deleted.
  consented_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  consented_at         timestamptz NOT NULL DEFAULT now(),
  -- What was consented to. Stored verbatim from the admin-consent response
  -- (or, when MS doesn't echo the scope, the constant we requested) so we
  -- have an audit trail of what the app was authorized to do.
  scopes               text[] NOT NULL DEFAULT '{}',
  -- The Recall.ai credential id for the Teams bot credentials we registered.
  -- NULL means consent was granted but Recall registration failed — the
  -- admin-consent callback surfaces a clear error in that case and dispatch
  -- falls back to anonymous-join.
  recall_credential_id text,
  -- Set when an owner revokes. Dispatcher checks revoked_at IS NULL before
  -- passing teams_bot_credential_id to Recall.
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Lookup index for the (rare but) case where we want to find all GhostStream
-- tenants pointing at the same MS tenant id — useful if a single Microsoft
-- tenant maps to multiple GhostStream tenants (white-label resellers, etc).
CREATE INDEX tenant_microsoft_consent_ms_tenant ON tenant_microsoft_consent (ms_tenant_id)
  WHERE revoked_at IS NULL;
