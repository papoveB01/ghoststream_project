-- Proposal Engine Phase 3 — per-tenant recommendation mode.
--   DRAFT_WITH_ASSUMPTIONS (default) — always generate; thin intel is flagged
--     as assumptions (the coverage/confidence signal does the rest).
--   BLOCK — withhold generation until the prospect has prospect-specific
--     intelligence (research / filed intel / a logged call or email), instead of
--     producing a recommendation built only on our profile + generic intel.
-- Stored as a column on tenants, like the recording-privacy settings (0043).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS proposal_mode text NOT NULL DEFAULT 'DRAFT_WITH_ASSUMPTIONS';
