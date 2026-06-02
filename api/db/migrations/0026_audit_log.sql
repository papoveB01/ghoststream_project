-- Security audit log (SOC 2 CC7.2 — monitoring of security-relevant events).
--
-- An append-only record of authentication and account-management events:
-- logins (success/failure/lockout), OTP/device verification, logouts, password
-- changes, session revocation, and API-token lifecycle. Written best-effort by
-- api/src/audit.js — a logging failure must never block the underlying action.
--
-- Deliberately NO foreign key on actor_user_id/tenant_id: the trail must outlive
-- the user/tenant it describes (a FK cascade would erase history on deletion).
-- actor_email is denormalized for the same reason.

CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  action        text NOT NULL,            -- e.g. 'auth.login.success'
  result        text,                     -- 'success' | 'failure' | null
  actor_user_id uuid,                      -- null for anonymous / failed logins
  actor_email   text,
  tenant_id     uuid,
  target        text,                      -- affected resource id/label, if any
  ip            text,
  user_agent    text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_at        ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant_at ON audit_log(tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_at  ON audit_log(actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_at ON audit_log(action, at DESC);
