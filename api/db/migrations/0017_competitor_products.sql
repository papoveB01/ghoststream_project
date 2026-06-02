-- 0017 — Attach OUR product lines to a competitor profile, and store
-- per-(competitor, product) battlecards.
--
-- Why: a battlecard is "our side vs ONE competitor". Which of OUR products
-- competes with a given competitor varies, and the talk track differs per
-- product. `competitor_products` lets a rep pin the relevant product lines
-- onto a competitor (mirrors how product lines hang off the company), and
-- `competitor_battlecards` holds the product-scoped synthesis. The
-- company-wide card (no product) continues to live in competitors.battlecard.

-- Which of our products compete with this competitor. Deleting either side
-- cleans up the link (CASCADE) — unlike kb_document_* junctions, an empty
-- association here is meaningful ("no product pinned" = company-wide only).
CREATE TABLE IF NOT EXISTS competitor_products (
  tenant_id     uuid NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  competitor_id text NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  product_id    text NOT NULL REFERENCES products(id)    ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competitor_id, product_id)
);
CREATE INDEX IF NOT EXISTS competitor_products_tenant_comp
  ON competitor_products (tenant_id, competitor_id);

-- Per-product battlecards. Same JSONB shape as competitors.battlecard
-- (AI sections + manualEdits + lastRefreshedAt). The (competitor, NULL)
-- card is NOT stored here — it stays in competitors.battlecard — so the
-- PK can be a plain composite without NULL-uniqueness gymnastics.
CREATE TABLE IF NOT EXISTS competitor_battlecards (
  tenant_id     uuid  NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  competitor_id text  NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  product_id    text  NOT NULL REFERENCES products(id)    ON DELETE CASCADE,
  battlecard    jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (competitor_id, product_id)
);
CREATE INDEX IF NOT EXISTS competitor_battlecards_tenant_comp
  ON competitor_battlecards (tenant_id, competitor_id);
