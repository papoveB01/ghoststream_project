// Global Knowledge Cache builder.
//
// Concatenates every READY document in the ORG_INTELLIGENCE and BATTLECARDS
// categories into a single text body, registers it as a Gemini Context Cache
// under the name "kb:global", and stores both the cache pointer and the
// assembled text in the kb_global_cache singleton row.
//
// The text body is stored alongside the cache pointer because Gemini only
// accepts ONE cachedContent per generateContent call — so the Arena (which
// uses its slot for the persona cache) reads `content_text` directly and
// pastes it inline into the grounding system message.
//
// Triggered automatically from service.ingest() and service.deleteDocument()
// whenever a document in those two categories changes, and manually via
// POST /knowledge/global-cache/rebuild.

const crypto = require('crypto');
const db = require('../db');
const gemini = require('../gemini');
const { FOUNDERS_TENANT_ID } = require('../users');

const CACHE_NAME = 'kb:global';
const CACHE_MODEL = process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-pro';
const CACHE_TTL_SEC = parseInt(process.env.KB_GLOBAL_CACHE_TTL_SEC || '3600', 10);

const GLOBAL_CATEGORIES = ['ORG_INTELLIGENCE', 'BATTLECARDS'];

const SYSTEM_INSTRUCTION =
  'You are GhostStream\'s grounded sales-intelligence layer. The following ' +
  'content represents the company\'s ORG INTELLIGENCE (escalation paths, ' +
  'subject-matter experts, brand voice) and BATTLECARD punchlines (competitor ' +
  'weaknesses, pre-approved objection handles). Treat it as authoritative when ' +
  'evaluating rep claims or generating prospect responses. Always prefer ' +
  'guidance from this content over generic best-practices.';

// Pull all READY ORG_INTELLIGENCE + BATTLECARDS docs and their chunks (in
// ordinal order). We concatenate chunks per document — overlap means there's
// some duplicated text across chunk boundaries, but for a cached block that's
// rebuilt rarely the trade-off (simpler than de-duping windows) is fine.
async function assembleContent() {
  // The global Gemini context cache is currently a singleton built only from
  // the Founders tenant's ORG_INTELLIGENCE + BATTLECARDS docs. Per-tenant
  // context caches are Phase 2; until then this is explicitly "the Founders
  // company-intelligence cache" and the Arena (a Founders feature) reads it.
  const docs = await db.query(
    `SELECT id, category, title, source_type, metadata, token_count
       FROM kb_documents
      WHERE tenant_id = $1 AND status = 'READY' AND category = ANY($2)
      ORDER BY category ASC, lower(title) ASC`,
    [FOUNDERS_TENANT_ID, GLOBAL_CATEGORIES]
  );

  if (docs.rows.length === 0) {
    return { text: '', documents: [], tokenCount: 0 };
  }

  const sections = [];
  const docManifest = [];

  for (const d of docs.rows) {
    const chunks = await db.query(
      `SELECT ordinal, text FROM kb_chunks
        WHERE document_id = $1 ORDER BY ordinal ASC`,
      [d.id]
    );
    const body = chunks.rows.map((c) => c.text).join('\n\n');
    sections.push(
      `## [${d.category}] ${d.title}\n` +
      `(source: ${d.source_type} · document_id: ${d.id})\n\n` +
      body
    );
    docManifest.push({
      documentId: d.id,
      title: d.title,
      category: d.category,
      tokenCount: d.token_count,
    });
  }

  const text = `# GhostStream Company Intelligence\n\n${sections.join('\n\n---\n\n')}`;
  // Token count from the source docs is a good-enough approximation; we don't
  // re-tokenize the concatenated text.
  const tokenCount = docs.rows.reduce((s, d) => s + (d.token_count || 0), 0);
  return { text, documents: docManifest, tokenCount };
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Rebuild the global cache. Returns the new singleton row.
//
// Skip-if-unchanged: when the assembled text hash matches the stored
// content_hash AND a cache_name is present, we don't touch Gemini — the
// existing cache is still valid until TTL.
async function rebuildGlobalCache({ force = false } = {}) {
  const assembled = await assembleContent();
  const existing = (await db.query(`SELECT * FROM kb_global_cache WHERE id = 1`)).rows[0] || {};

  // Empty KB: clear any prior cache + zero the row.
  if (!assembled.text) {
    if (existing.cache_name) {
      try { await gemini.invalidate(CACHE_NAME); }
      catch (err) { console.warn('[globalCache] invalidate failed:', err.message); }
    }
    await db.query(
      `UPDATE kb_global_cache
          SET cache_name = NULL,
              content_hash = NULL,
              content_text = NULL,
              char_count = 0,
              token_count = 0,
              documents = '[]'::jsonb,
              refreshed_at = now()
        WHERE id = 1`
    );
    return getRow();
  }

  const newHash = hash(assembled.text);
  if (!force && existing.content_hash === newHash && existing.cache_name) {
    return getRow();
  }

  // Invalidate any stale Gemini cache for this name before recreating.
  if (existing.cache_name) {
    try { await gemini.invalidate(CACHE_NAME); }
    catch (err) { console.warn('[globalCache] invalidate failed:', err.message); }
  }

  // Build the new cache. getOrCreateCache transparently falls back to inline
  // mode if the content is under the model's min-cacheable threshold; that's
  // fine — content_text is the canonical store anyway.
  let cacheRecord;
  try {
    cacheRecord = await gemini.getOrCreateCache({
      name: CACHE_NAME,
      model: CACHE_MODEL,
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: [{ role: 'user', parts: [{ text: assembled.text }] }],
      ttlSec: CACHE_TTL_SEC,
    });
  } catch (err) {
    console.error('[globalCache] gemini cache build failed:', err.message);
    cacheRecord = null;
  }

  await db.query(
    `UPDATE kb_global_cache
        SET cache_name = $1,
            content_hash = $2,
            content_text = $3,
            char_count = $4,
            token_count = $5,
            documents = $6::jsonb,
            refreshed_at = now()
      WHERE id = 1`,
    [
      cacheRecord && cacheRecord.mode === 'cached' ? cacheRecord.cacheName : null,
      newHash,
      assembled.text,
      assembled.text.length,
      assembled.tokenCount,
      JSON.stringify(assembled.documents),
    ]
  );

  return getRow();
}

async function getRow() {
  const r = await db.query(`SELECT * FROM kb_global_cache WHERE id = 1`);
  return r.rows[0] || null;
}

// Read just the content_text — used by arena.js to inject the punchlines into
// the persona grounding. Returns '' if no cache has been built yet.
async function getGlobalText() {
  const r = await db.query(
    `SELECT content_text FROM kb_global_cache WHERE id = 1`
  );
  return r.rows[0]?.content_text || '';
}

module.exports = {
  rebuildGlobalCache,
  getGlobalText,
  getRow,
  CACHE_NAME,
  GLOBAL_CATEGORIES,
};
