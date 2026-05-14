-- Hard distinction between the three kinds of thing a KB document can be about:
--
--   TENANT     — the customer's OWN company ("Home Team" / Basis intel).
--                company_id IS NULL. Retrieves as the BASIS tier for every
--                mission.
--   PROSPECT   — a specific prospect the tenant is selling to. company_id
--                points at a companies row in the same tenant. Retrieves as
--                the PROSPECT_MEMORY tier for missions against that company.
--   COMPETITOR — intel about a competitor (battlecard material). company_id
--                IS NULL; the competitor link is the kb_document_competitors
--                junction. Retrieves as the BASIS tier (org-wide).
--
-- (Mission-prep "Live Pulse" scrapes are still distinguished by
-- transient_for_mission_id — they're typically scope=PROSPECT with that flag
-- set, and deriveTier() promotes them to LIVE_PULSE for their own mission.)
--
-- The CHECK ties scope to company_id so the two can't drift: a doc is PROSPECT
-- iff it has a company_id, and TENANT/COMPETITOR docs never do.

ALTER TABLE kb_documents
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'TENANT'
    CHECK (scope IN ('TENANT', 'PROSPECT', 'COMPETITOR'));

-- Backfill from the existing shape:
--   company_id set                              → PROSPECT
--   no company_id, but tagged with a competitor → COMPETITOR
--   otherwise                                   → TENANT (the DEFAULT)
UPDATE kb_documents SET scope = 'PROSPECT' WHERE company_id IS NOT NULL;
UPDATE kb_documents d SET scope = 'COMPETITOR'
 WHERE d.company_id IS NULL
   AND EXISTS (SELECT 1 FROM kb_document_competitors c WHERE c.document_id = d.id);

-- Now lock the scope ↔ company_id invariant.
ALTER TABLE kb_documents
  ADD CONSTRAINT kb_documents_scope_company_chk
    CHECK ((scope = 'PROSPECT') = (company_id IS NOT NULL));

CREATE INDEX kb_documents_tenant_scope ON kb_documents (tenant_id, scope);
