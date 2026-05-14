-- Omni-Sync schema: each document now carries the lane it came from and
-- the calendar date it's authoritative as-of.
--
--   stream_type    FILE | WEB | SOCIAL
--                  FILE   — admin-uploaded PDF / Markdown / text
--                  WEB    — Firecrawl-scraped page or whole-site crawl
--                  SOCIAL — Phyllo-fetched post from a connected handle
--
--   effective_date When the content is true-as-of. For FILE, this comes
--                  from the upload form (metadata.effectiveDate) and falls
--                  back to created_at. For WEB, Firecrawl's publishedTime
--                  or fetch time. For SOCIAL, the post's timestamp.
--
-- The retrieval-side tiebreaker prefers the newer effective_date when two
-- chunks score within ε of each other on cosine distance.

ALTER TABLE kb_documents
  ADD COLUMN stream_type    text        NOT NULL DEFAULT 'FILE'
              CHECK (stream_type IN ('FILE','WEB','SOCIAL')),
  ADD COLUMN effective_date timestamptz,
  ADD COLUMN source_url     text;

-- Backfill existing docs: they're all FILE uploads, effective as-of upload.
UPDATE kb_documents
   SET effective_date = COALESCE(effective_date, created_at)
 WHERE effective_date IS NULL;

CREATE INDEX kb_documents_stream_effective
  ON kb_documents (stream_type, effective_date DESC);
