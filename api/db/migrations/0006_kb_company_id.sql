-- Tri-Tiered Knowledge Model — Tier 2 (Prospect Memory).
--
-- A kb_documents row tagged to a company_id is "Prospect Memory": KB content
-- specific to one company (their RFP responses, decks we built for them,
-- historical email threads pasted in, prior meeting recaps, etc.). It's
-- persistent — survives across missions — and the brief pipeline retrieves it
-- alongside Tier 1 (Basis: untagged / global) and Tier 3 (Live Pulse:
-- transient_for_mission_id) chunks.
--
-- Nullable: docs with company_id IS NULL are Tier 1 (Basis). The retrieval
-- layer computes the tier per chunk at query time; no enum column needed.
--
-- ON DELETE SET NULL: if a company row is hard-deleted, its docs become
-- Tier 1 rather than disappearing — same conservative posture we took on
-- scheduled_meetings.company_id (0005).

ALTER TABLE kb_documents
  ADD COLUMN company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX kb_documents_company
  ON kb_documents (company_id)
  WHERE company_id IS NOT NULL;
