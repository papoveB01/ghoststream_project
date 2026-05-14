-- Deep Research on a prospect.
--
-- One row per research run for a prospect (companies row). A run scrapes the
-- prospect's own site (Firecrawl /map + /scrape) plus targeted web searches
-- (Firecrawl /search), assembles a source-tagged "dossier", and has Gemini
-- produce sales-opportunity points mapped to the tenant's product portfolio.
--
-- Runs are kept (not replaced) so you can see history; the Library shows the
-- latest per company. Fire-and-forget: the POST endpoint inserts a RUNNING
-- row and the work happens in the background; the row flips to DONE / FAILED.

CREATE TABLE prospect_research (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'RUNNING'
                  CHECK (status IN ('RUNNING','DONE','FAILED')),
  query_count   int  NOT NULL DEFAULT 0,   -- web-search queries run
  source_count  int  NOT NULL DEFAULT 0,   -- distinct sources in the dossier
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{n,url,title,date,snippet,scraped}]
  dossier_md    text,                                -- the assembled dossier (transparency)
  summary       text,                                -- 1-2 sentence headline
  opportunities jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{point,product,strength,sources:[n]}]
  models        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX prospect_research_company ON prospect_research (company_id, created_at DESC);
CREATE INDEX prospect_research_tenant  ON prospect_research (tenant_id);
