-- 0019 — Competitor's own products ("offerings") + the full (our × their)
-- battlecard matchup matrix.
--
-- Until now a battlecard was strictly us-vs-one-competitor, optionally scoped to
-- one of OUR product lines. This adds the competitor's OWN products so a card
-- can be scoped on BOTH sides:
--   (product_id, competitor_product_id) where NULL on a side = "the whole side".
--   (—,    —    ) company-wide          → stays in competitors.battlecard
--   (ourP, —    ) our product vs them    → competitor_battlecards
--   (—,    theirP) us vs their product   → competitor_battlecards
--   (ourP, theirP) our product vs theirs → competitor_battlecards

-- The competitor's own products. Slug id is unique within a competitor (two
-- competitors may each have a "core" offering), so the PK is composite.
CREATE TABLE IF NOT EXISTS competitor_offerings (
  tenant_id     uuid        NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  competitor_id text        NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  id            text        NOT NULL,
  name          text        NOT NULL,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competitor_id, id)
);
CREATE INDEX IF NOT EXISTS competitor_offerings_tenant
  ON competitor_offerings (tenant_id, competitor_id);

-- Generalise the per-product battlecard table into the matchup matrix. Existing
-- rows (product_id set, competitor_product_id NULL) stay valid unchanged.
-- Drop the old PK FIRST — a column can't lose NOT NULL while it's in a PK.
ALTER TABLE competitor_battlecards DROP CONSTRAINT IF EXISTS competitor_battlecards_pkey;
ALTER TABLE competitor_battlecards ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE competitor_battlecards ADD COLUMN IF NOT EXISTS competitor_product_id text;

-- Replace it with a NULLS-NOT-DISTINCT unique key across both product axes, so
-- each matchup has exactly one current card and NULL ("whole side") collapses
-- to a single row. (PG15+.)
ALTER TABLE competitor_battlecards
  ADD CONSTRAINT competitor_battlecards_scope
  UNIQUE NULLS NOT DISTINCT (competitor_id, product_id, competitor_product_id);

-- Deleting an offering cascades away its live cards (composite FK; NULL rows are
-- unaffected since a NULL member skips FK enforcement).
ALTER TABLE competitor_battlecards
  ADD CONSTRAINT competitor_battlecards_offering_fk
  FOREIGN KEY (competitor_id, competitor_product_id)
  REFERENCES competitor_offerings (competitor_id, id) ON DELETE CASCADE;

-- History gains the same axis. Plain column (no FK) so version history survives
-- even if the offering is later deleted.
ALTER TABLE competitor_battlecard_history ADD COLUMN IF NOT EXISTS competitor_product_id text;
