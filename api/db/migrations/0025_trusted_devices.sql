-- Trusted devices — the durable half of new-device email-OTP verification.
--
-- On a password login we compute a device fingerprint server-side
-- (sha256 of userId + User-Agent + the client IP's /24, see api/src/devices.js)
-- and look it up here. A non-expired row means "this device already passed an
-- email OTP" → skip the code. Otherwise we email a 6-digit code (held in Redis,
-- not here) and only write a row when the user verifies AND ticks "trust this
-- device". Trust is time-boxed (default 30 days, DEVICE_TRUST_DAYS) and the user
-- can revoke a row early from the Profile page (lost-laptop kill switch).
--
-- Scope: password logins only. Onboarding signup auto-login and PAT/API-token
-- auth never touch this table.

CREATE TABLE IF NOT EXISTS trusted_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash  text NOT NULL,                       -- sha256(userId | UA | ip/24)
  user_agent   text,                                -- raw UA, for the "your devices" display
  ip_prefix    text,                                -- e.g. 203.0.113.0/24, display only
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,                -- re-verify after this
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_hash)
);

CREATE INDEX IF NOT EXISTS trusted_devices_user ON trusted_devices(user_id, last_seen_at DESC);
