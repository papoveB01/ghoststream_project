-- Sales Scheduler — "Mission Brief" architecture.
--
-- A scheduled meeting carries its full Intelligence Matrix scope (product +
-- persona + competitor tags), a pointer to the company being pitched, and
-- the prospect contacts. The T-24h scheduler kicks off a brief pipeline:
-- Firecrawl scrapes the company domain into a TRANSIENT kb_documents row
-- (visible only to retrieval scoped to this mission), KB chunks are pulled
-- through the engagement filter, and Gemini Pro composes a 1-page markdown
-- brief that gets persisted in pre_call_briefs.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ============================================================
-- Companies — minimal lookup table that lets us aggregate intel per-company
-- across multiple missions. Name uniqueness is case-insensitive so the
-- Schedule form's datalist can dedupe "Acme Corp" vs "acme corp" on submit.
-- ============================================================
CREATE TABLE companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  domain          TEXT,
  primary_contact TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name_lower ON companies (lower(name));
CREATE INDEX companies_domain_lower ON companies (lower(domain));

-- ============================================================
-- Scheduled meetings (Missions). Status flow:
--   PENDING    — just created
--   BRIEFED    — T-24h scheduler ran the brief pipeline successfully
--   COMPLETED  — call happened, portal generated, portal_id populated
--   CANCELLED  — rep cancelled before the call
--   FAILED     — brief pipeline crashed (error logged in updated_at touch)
-- ============================================================
CREATE TABLE scheduled_meetings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE SET NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  meeting_url     TEXT,
  prospect_emails TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','BRIEFED','COMPLETED','CANCELLED','FAILED')),
  -- v2: Recall.ai bot is scheduled at this row's creation time and the bot
  -- joins meeting_url at scheduled_at. For MVP this stays null and the rep
  -- creates the bot manually via POST /meetings.
  recall_bot_id   TEXT,
  -- Set once the call has produced a portal record (Redis).
  portal_id       TEXT,
  -- Denormalised pointer to the current pre_call_briefs.id so the API
  -- doesn't need a JOIN to surface "is this mission briefed yet?"
  brief_id        UUID,
  brief_error     TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_meetings_at     ON scheduled_meetings (scheduled_at);
CREATE INDEX scheduled_meetings_status ON scheduled_meetings (status);
CREATE INDEX scheduled_meetings_company ON scheduled_meetings (company_id);

-- ============================================================
-- Many-to-many engagement scope. Same pattern as kb_document_* tables.
-- ============================================================
CREATE TABLE scheduled_meeting_products (
  meeting_id UUID NOT NULL REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id)           ON DELETE RESTRICT,
  PRIMARY KEY (meeting_id, product_id)
);
CREATE TABLE scheduled_meeting_personas (
  meeting_id UUID NOT NULL REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL REFERENCES personas(id)           ON DELETE RESTRICT,
  PRIMARY KEY (meeting_id, persona_id)
);
CREATE TABLE scheduled_meeting_competitors (
  meeting_id    UUID NOT NULL REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
  competitor_id TEXT NOT NULL REFERENCES competitors(id)        ON DELETE RESTRICT,
  PRIMARY KEY (meeting_id, competitor_id)
);

-- ============================================================
-- Pre-Call Briefs — markdown content + a snapshot of which KB chunks fed
-- the generation, so the rep can spot-check citations and we can audit
-- "what did the AI base this on" after the call.
-- ============================================================
CREATE TABLE pre_call_briefs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_meeting_id UUID NOT NULL REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
  content_md           TEXT NOT NULL,
  retrieved_citations  JSONB NOT NULL DEFAULT '[]',
  transient_doc_ids    JSONB NOT NULL DEFAULT '[]',
  models               JSONB NOT NULL DEFAULT '{}',
  usage                JSONB NOT NULL DEFAULT '{}',
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pre_call_briefs_meeting ON pre_call_briefs (scheduled_meeting_id);

-- ============================================================
-- Transient docs: a kb_documents row that exists ONLY for one mission's
-- brief and must NOT pollute other missions' retrievals. Default retrieval
-- and the Library tab both filter `transient_for_mission_id IS NULL`. The
-- brief pipeline opts in by passing currentMissionId to retrieveContext.
-- ============================================================
ALTER TABLE kb_documents
  ADD COLUMN transient_for_mission_id UUID
    REFERENCES scheduled_meetings(id) ON DELETE CASCADE;
CREATE INDEX kb_documents_transient_mission
  ON kb_documents (transient_for_mission_id)
  WHERE transient_for_mission_id IS NOT NULL;
