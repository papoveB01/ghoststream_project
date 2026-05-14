// Gemini embeddings client.
//
// MODEL CHOICE: `gemini-embedding-2` (Matryoshka-rep model, GA as of May 2026).
// 8,192-token input window — 4× the 2,048 ceiling of gemini-embedding-001 —
// which matters for chunking long technical manuals where a single section
// (a pricing table or SLA block) can exceed 2,000 tokens.
//
// Decision history: locked target was `text-embedding-004` (deprecated by
// Google), pivoted to `gemini-embedding-001` (works but 2k input limit),
// then settled on `gemini-embedding-2` once it went GA. All three produce
// vectors in *incompatible* spaces — switching models against a populated KB
// requires re-embedding every chunk, since query embeddings must come from
// the same model as document embeddings.
//
// We request `outputDimensionality: 768` to keep the existing
// kb_chunks.embedding vector(768) schema valid. Other supported dimensions
// are 1536 and 3072; if you change that here, also update the vector(N)
// column and re-embed all chunks.
//
// We re-use the GoogleGenAI singleton from src/gemini.js so embeddings and
// generation share auth + transport.

const gemini = require('../gemini');

const MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const EXPECTED_DIM = parseInt(process.env.GEMINI_EMBEDDING_DIM || '768', 10);
// Concurrency across embedContent calls. Higher = faster ingestion, but
// Gemini enforces per-minute request quotas; 4 is a safe default that keeps
// well under the free-tier 1500 req/min and most paid quotas while still
// finishing a 100-chunk doc in seconds.
const CONCURRENCY = parseInt(process.env.KB_EMBED_CONCURRENCY || '4', 10);

// Single-text embed call. The SDK's embedContent expects ONE content per
// request; passing an array of strings concatenates them into a single
// embedding (1 vector back, not N) — that was the "embed mismatch" bug.
async function embedOne(text, taskType) {
  const client = gemini.getClient();
  const response = await client.models.embedContent({
    model: MODEL,
    contents: text,
    config: {
      taskType,
      outputDimensionality: EXPECTED_DIM,
    },
  });
  const values = response.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIM) {
    throw new Error(
      `embedding has unexpected dimension: got ${values?.length}, want ${EXPECTED_DIM}`
    );
  }
  return values;
}

// Worker-pool fan-out: keeps at most CONCURRENCY in flight, preserves
// input order in the returned array. Used for ingest-side (asymmetric
// RETRIEVAL_DOCUMENT) embeddings of one document's chunks.
async function embedAll(texts) {
  if (texts.length === 0) return [];

  const vectors = new Array(texts.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= texts.length) return;
      vectors[idx] = await embedOne(texts[idx], 'RETRIEVAL_DOCUMENT');
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, texts.length) },
    () => worker()
  );
  await Promise.all(workers);
  return vectors;
}

// Single-string convenience for retrieval-side queries; uses RETRIEVAL_QUERY
// task type to match Gemini's asymmetric-retrieval recommendation.
async function embedQuery(text) {
  return embedOne(text, 'RETRIEVAL_QUERY');
}

module.exports = {
  embedAll,
  embedQuery,
  MODEL,
  DIMENSIONS: EXPECTED_DIM,
};
