-- Intelligence Matrix: shift the KB from one undifferentiated pile to a
-- three-dimensional tagging space so retrieval can be scoped to the rep's
-- active engagement (product + persona + competitor).
--
-- Three managed entity tables and three many-to-many junction tables.
-- A document can belong to multiple products / personas / competitors —
-- a SOC 2 PDF spans the whole portfolio; a "CFO + CRO security" doc spans
-- two personas; a Battlecard can cover both Gong and Blaze.
--
-- Untagged docs (no row in the relevant junction table) are treated as
-- GLOBAL by retrieval — they match every engagement in that dimension.
-- This is the "hard filter + global fallback" decision locked 2026-05-11.

-- ============================================================
-- Managed entity tables
-- ============================================================

CREATE TABLE products (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE personas (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE competitors (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Junction tables. Document delete cascades; entity delete is RESTRICT
-- so an admin can't accidentally drop an entity that's still tagged.
-- ============================================================

CREATE TABLE kb_document_products (
  document_id uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES products(id)     ON DELETE RESTRICT,
  tagged_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, product_id)
);
CREATE INDEX kb_document_products_product ON kb_document_products (product_id);

CREATE TABLE kb_document_personas (
  document_id uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  persona_id  text NOT NULL REFERENCES personas(id)     ON DELETE RESTRICT,
  tagged_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, persona_id)
);
CREATE INDEX kb_document_personas_persona ON kb_document_personas (persona_id);

CREATE TABLE kb_document_competitors (
  document_id   uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  competitor_id text NOT NULL REFERENCES competitors(id)  ON DELETE RESTRICT,
  tagged_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, competitor_id)
);
CREATE INDEX kb_document_competitors_competitor ON kb_document_competitors (competitor_id);
