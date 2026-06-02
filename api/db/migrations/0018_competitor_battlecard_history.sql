-- 0018 — Battlecard generation history.
--
-- Each battlecard regenerate appends a dated snapshot here; the "current" card
-- still lives in competitors.battlecard (company-wide) / competitor_battlecards
-- (product-scoped), so existing reads are unchanged. product_id NULL = the
-- company-wide card.
--
-- Independence: history is keyed by (competitor, product?), so generating a
-- card for one product never touches another product's rows. Retention: when a
-- product is unpinned we drop only the live row in competitor_battlecards — the
-- history rows here are kept, so re-pinning later still surfaces past versions.
-- (A product or competitor being fully deleted does cascade its history away.)

CREATE TABLE IF NOT EXISTS competitor_battlecard_history (
  id            bigserial   PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  competitor_id text        NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  product_id    text                 REFERENCES products(id)    ON DELETE CASCADE,
  battlecard    jsonb       NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS competitor_battlecard_history_lookup
  ON competitor_battlecard_history (tenant_id, competitor_id, product_id, generated_at DESC);

-- Seed the history with whatever cards already exist so they show a baseline
-- entry rather than an empty history. generated_at mirrors the card's own
-- lastRefreshedAt. The current-pointer rows have no historyId yet; the history
-- API falls back to matching lastRefreshedAt to flag the current version.
INSERT INTO competitor_battlecard_history (tenant_id, competitor_id, product_id, battlecard, generated_at)
SELECT tenant_id, id, NULL, battlecard,
       COALESCE((battlecard->>'lastRefreshedAt')::timestamptz, now())
  FROM competitors
 WHERE battlecard ? 'lastRefreshedAt';

INSERT INTO competitor_battlecard_history (tenant_id, competitor_id, product_id, battlecard, generated_at)
SELECT tenant_id, competitor_id, product_id, battlecard,
       COALESCE((battlecard->>'lastRefreshedAt')::timestamptz, now())
  FROM competitor_battlecards
 WHERE battlecard ? 'lastRefreshedAt';
