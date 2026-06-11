-- 0052: per-user UI preferences (active tabs, view options) — replaces
-- session-scoped persistence so state follows the user across devices.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
