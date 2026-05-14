-- Knowledge Base — Dynamic Context Layer
--
-- Three tables:
--   kb_documents     — one row per uploaded source file (PDF / Markdown / text)
--   kb_chunks        — one row per ~512-token chunk with a 768-dim embedding
--                      (Gemini text-embedding-004)
--   kb_global_cache  — singleton tracking the current Gemini Context Cache that
--                      bundles ORG_INTELLIGENCE + BATTLECARDS "punchlines"
--
-- Soft-delete contract for replace-on-upload:
--   * status='READY' means the document is live and retrievable.
--   * status='ARCHIVED' means superseded by a newer version of the same
--     (category, title). Chunks remain for audit but retrieval filters READY.
--   * A partial unique index enforces at most one READY per (category, title).
--   * status='PROCESSING' and 'FAILED' are transient ingestion states.

-- =========================================================================
-- kb_documents
-- =========================================================================
CREATE TABLE kb_documents (
  id            uuid PRIMARY KEY,
  category      text NOT NULL
                  CHECK (category IN ('PRODUCT_INTEL','ORG_INTELLIGENCE','BATTLECARDS')),
  title         text NOT NULL,
  source_type   text NOT NULL
                  CHECK (source_type IN ('pdf','markdown','text')),
  r2_key        text NOT NULL,
  content_hash  text NOT NULL,
  byte_size     bigint NOT NULL DEFAULT 0,
  token_count   int    NOT NULL DEFAULT 0,
  chunk_count   int    NOT NULL DEFAULT 0,
  metadata      jsonb  NOT NULL DEFAULT '{}'::jsonb,
  status        text   NOT NULL
                  CHECK (status IN ('PROCESSING','READY','FAILED','ARCHIVED')),
  superseded_by uuid REFERENCES kb_documents(id) ON DELETE SET NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

-- At most one READY document per (category, title) — replace-on-upload key.
CREATE UNIQUE INDEX kb_documents_ready_uniq
  ON kb_documents (category, lower(title))
  WHERE status = 'READY';

CREATE INDEX kb_documents_category_status ON kb_documents (category, status);
CREATE INDEX kb_documents_created_at_desc ON kb_documents (created_at DESC);

-- =========================================================================
-- kb_chunks
-- =========================================================================
CREATE TABLE kb_chunks (
  id           uuid PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  ordinal      int  NOT NULL,
  text         text NOT NULL,
  token_count  int  NOT NULL,
  embedding    vector(768) NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);

-- HNSW on cosine distance — fast approximate-NN for k<=20 retrieval.
CREATE INDEX kb_chunks_hnsw ON kb_chunks
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX kb_chunks_document_id ON kb_chunks (document_id);

-- =========================================================================
-- kb_global_cache (singleton — id is always 1)
-- =========================================================================
CREATE TABLE kb_global_cache (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cache_name    text,
  content_hash  text,
  token_count   int NOT NULL DEFAULT 0,
  documents     jsonb NOT NULL DEFAULT '[]'::jsonb,
  refreshed_at  timestamptz
);
INSERT INTO kb_global_cache (id) VALUES (1) ON CONFLICT DO NOTHING;
