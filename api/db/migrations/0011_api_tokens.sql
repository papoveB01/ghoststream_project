-- api_tokens — long-lived API tokens for non-browser clients (Lili MCP
-- server, future MCP consumers, scripts).
-- See docs/rfcs/0001-lili-integration.md §5.
--
-- Token format: gs_pat_v1_<8-char-prefix>_<32-char-secret>
--   prefix     indexed lookup key (no full-table bcrypt scan)
--   secret     bcrypt-hashed in token_hash; compared at auth time
--   plaintext  returned ONCE at mint; never stored or recoverable
--
-- Tenant binding is recorded at mint time: a single token authenticates
-- exactly one (tenant, user) pair. To switch tenants, mint a new token.
--
-- RLS note: ADR-0001 mentions RLS as defence-in-depth, but the current
-- codebase enforces the "Data Firewall" in the API layer only (every query
-- says `WHERE tenant_id = $current`). This table follows the same pattern.
-- If/when RLS lands repo-wide, api_tokens should get the standard policy.

CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  prefix        text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Za-z0-9]{8}$'),
  token_hash    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE INDEX api_tokens_tenant_user ON api_tokens (tenant_id, user_id);

-- Partial index — only non-revoked tokens. We can't include
-- `expires_at > now()` in the predicate because Postgres requires index
-- predicates to be IMMUTABLE, and `now()` is STABLE. Expired-token
-- filtering happens at query time in auth-tokens.js via the WHERE clause
-- `(expires_at IS NULL OR expires_at > now())` — which DOES use the index
-- (postgres will scan partial-index rows and filter expired post-scan).
CREATE INDEX api_tokens_active_user ON api_tokens (user_id)
  WHERE revoked_at IS NULL;
