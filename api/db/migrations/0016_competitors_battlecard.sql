-- Battlecard storage on the competitors table.
--
-- Each competitor gets ONE battlecard — the operational artefact reps read
-- before walking into a call against this competitor. Aggregated across
-- every kb_document tagged with this competitor + synthesised via Gemini
-- once on regen. The 8-axis scoreboard is computed via weighted average of
-- the per-document assessments (cheap, no Gemini call); the talk-track,
-- objection handlers, and migration story are produced by a single Gemini
-- call so they reason across all evidence at once.
--
-- Manual edits live in battlecard->'manualEdits' and override the AI fields
-- at render time. Regen rebuilds the AI part but keeps manualEdits intact;
-- a separate revert action wipes a specific manualEdits key to restore the
-- AI version of that section.
--
-- See docs/adr/0003-... (forthcoming) for the talk-track shape rationale.

ALTER TABLE competitors
  ADD COLUMN battlecard jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Tiny lookup index for the eventual "list competitors with a battlecard"
-- view. Skips empty rows so it stays small.
CREATE INDEX competitors_battlecard_refreshed
  ON competitors ((battlecard->>'lastRefreshedAt'))
  WHERE battlecard ? 'lastRefreshedAt';
