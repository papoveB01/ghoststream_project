-- Data Foundation release: multi-source company enrichment + foundation health.
--
-- Track which fields were AI-enriched (so the UI can flag them "review & edit",
-- per the auto-apply-clearly-flagged decision) and when/what the enrichment last
-- pulled. No new tables — discovery/foundation read existing products,
-- tenant_profiles, personas, competitors, kb_documents.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ai_enriched boolean NOT NULL DEFAULT false;

ALTER TABLE tenant_profiles
  ADD COLUMN IF NOT EXISTS enriched_at        timestamptz,
  ADD COLUMN IF NOT EXISTS enrichment_sources jsonb NOT NULL DEFAULT '{}'::jsonb;
