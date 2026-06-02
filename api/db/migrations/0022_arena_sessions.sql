-- Arena practice sessions — durable history + coaching store.
--
-- Live sessions still run in Redis (1h TTL) for the turn-by-turn loop; this
-- table is the permanent record. A row is upserted on session start and again
-- on every turn (so the transcript survives a restart or the TTL expiring),
-- and finalized — status='completed' + an AI scorecard — when the rep ends the
-- session or hits the turn limit.
--
-- Attribution: tenant_id is derived server-side from the portal's parent
-- meeting (meeting.meta.tenantId); rep_name comes from the portal participant
-- with role='rep'. rep_user_id is captured best-effort when the session was
-- launched from an authenticated context (the portal practice flow is usually
-- anonymous, so it is frequently NULL).

CREATE TABLE IF NOT EXISTS arena_sessions (
  id           text PRIMARY KEY,                  -- mirrors the Redis session id (s_…)
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  portal_id    text NOT NULL,
  persona      text NOT NULL,
  rep_name     text,                              -- portal.participants[role=rep].name
  rep_user_id  uuid,                              -- best-effort; NULL on anonymous launches
  status       text NOT NULL DEFAULT 'active',    -- active | completed | abandoned
  objection    jsonb,                             -- the moment-of-truth being practiced
  turns        jsonb NOT NULL DEFAULT '[]'::jsonb, -- full transcript (system/rep/prospect)
  turn_count   int  NOT NULL DEFAULT 0,           -- rep exchanges only
  scorecard    jsonb,                             -- { overall, dimensions[], feedback, … }
  model        text,
  cache_mode   text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  end_reason   text,                              -- rep_ended | max_turns | abandoned
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS arena_sessions_tenant ON arena_sessions(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS arena_sessions_rep    ON arena_sessions(tenant_id, rep_name);
CREATE INDEX IF NOT EXISTS arena_sessions_status ON arena_sessions(tenant_id, status);
