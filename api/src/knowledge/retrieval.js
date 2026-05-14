// Tactical-lane retrieval: query → cosine-NN over kb_chunks.
//
// retrieveContext(query, { k, categories }) embeds the query string with
// text-embedding-004 (RETRIEVAL_QUERY task type), then orders kb_chunks by
// cosine distance (`embedding <=> $vec`) using the HNSW index.
//
// Only chunks belonging to documents with status='READY' are considered —
// ARCHIVED / PROCESSING / FAILED docs are invisible to the AI.

const db = require('../db');
const embeddings = require('./embeddings');

const DEFAULT_K = parseInt(process.env.KB_RETRIEVAL_K || '8', 10);
// Distance-tie threshold for the recency tiebreaker. When two chunks are
// within this cosine distance of each other, the newer effective_date wins.
// Locked at ε=0.05 (Omni-Sync sprint, 2026-05-10). Tunable via env without
// schema changes — only affects ordering, not which chunks come back.
const RECENCY_EPSILON = parseFloat(process.env.KB_RECENCY_EPSILON || '0.05');

// Apply the locked tiebreaker: rank by distance first, then for each adjacent
// pair within ε swap if the trailing chunk has a newer effective_date. Repeat
// until stable so a single newer item can bubble through a run of near-ties.
//
// Stays a no-op when effective_date is null on either side, or when stream
// types match and both come from the same vintage — preserves the original
// pgvector order for the canonical case.
function applyRecencyTiebreaker(chunks, eps = RECENCY_EPSILON) {
  const arr = chunks.slice().sort((a, b) => a.distance - b.distance);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < arr.length - 1; i++) {
      if (Math.abs(arr[i].distance - arr[i + 1].distance) < eps) {
        const ta = arr[i].effectiveDate     ? new Date(arr[i].effectiveDate).getTime()     : 0;
        const tb = arr[i + 1].effectiveDate ? new Date(arr[i + 1].effectiveDate).getTime() : 0;
        if (tb > ta) {
          [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
          changed = true;
        }
      }
    }
  }
  return arr;
}

function toVectorLiteral(values) {
  return `[${values.join(',')}]`;
}

// A short, prompt-stable citation: first 8 chars of the document UUID + chunk
// ordinal. Stable across retrievals so the LLM can cite consistently when we
// pass the same chunk back in subsequent calls.
function citationFor(documentId, ordinal) {
  return `${documentId.slice(0, 8)}:c${ordinal}`;
}

// Tri-Tiered KB tier resolution for one chunk. Priority: LIVE_PULSE wins
// over PROSPECT_MEMORY (a fresh scrape of *this prospect* during *this
// mission* is the most current signal) which wins over BASIS.
function deriveTier({ docCompanyId, docTransientMissionId, currentMissionId, missionCompanyId }) {
  if (currentMissionId && docTransientMissionId && docTransientMissionId === currentMissionId) {
    return 'LIVE_PULSE';
  }
  if (missionCompanyId && docCompanyId && docCompanyId === missionCompanyId) {
    return 'PROSPECT_MEMORY';
  }
  return 'BASIS';
}

// Build the engagement-profile WHERE clause for one tagging dimension.
//
// Semantics: "hard filter + global fallback" (locked 2026-05-11; array-aware
// 2026-05-11 second pass). A doc passes if EITHER (a) no filter is set for
// this dimension, OR (b) the doc is tagged with ANY of the target values, OR
// (c) the doc has no tags at all in this dimension (treated as global — e.g.
// a corporate SOC 2 report).
//
// `values` is an array (single-id callers pass `[id]`). An empty/nullish
// array means "no filter on this dimension" — same as before.
function engagementClause(table, idColumn, values, params) {
  const arr = Array.isArray(values) ? values.filter(Boolean) : (values ? [values] : []);
  if (arr.length === 0) return '';
  params.push(arr);
  const valIdx = params.length;
  return `
    AND (
      EXISTS (
        SELECT 1 FROM ${table} t
         WHERE t.document_id = d.id AND t.${idColumn} = ANY($${valIdx}::text[])
      )
      OR NOT EXISTS (
        SELECT 1 FROM ${table} t WHERE t.document_id = d.id
      )
    )`;
}

// retrieveContext(query, { k, categories, engagementProfile, currentMissionId, missionCompanyId })
//
//   engagementProfile = { productIds, personaIds, competitorIds } — any subset.
//   Each is an array; empty/missing means "no filter" on that dimension.
//   Single-id legacy fields (`productId`, etc.) are also accepted and lifted
//   into a 1-element array — keeps older callers working during transition.
// (Original placeholder line below is left for grep-continuity.)
//
//   engagementProfile = { productId, personaId, competitorId } — any subset.
//   Each dimension applies a hard-filter-with-global-fallback to the chunk
//   pool BEFORE the cosine-NN sort runs. Untagged-in-dimension docs always
//   match; cross-product docs (e.g. a SOC 2 report tagged 'global') stay
//   visible even when an engagement is active.
//
//   Tri-Tiered tier labelling (locked 2026-05-11, Simple OR bucketing):
//     LIVE_PULSE      = chunk's doc.transient_for_mission_id = currentMissionId
//     PROSPECT_MEMORY = chunk's doc.company_id = missionCompanyId
//     BASIS           = otherwise (the default lane)
//   No quota — all three lanes are ranked together by cosine + recency.
async function retrieveContext(query, {
  // Tenant scope — REQUIRED. Every chunk that comes back must belong to a
  // document owned by this tenant. The brief pipeline passes mission.tenant_id;
  // the analysis pipeline passes the meeting's tenant; the admin search probe
  // passes req.tenantId.
  tenantId,
  k = DEFAULT_K,
  categories = null,
  engagementProfile = null,
  // Mission-scoped retrieval: pass the current mission id to ADDITIONALLY
  // include kb_documents.transient_for_mission_id = this id. Default
  // retrieval (no currentMissionId) excludes all transient docs across all
  // missions, so analysis and search probes stay clean.
  currentMissionId = null,
  // Tier 2 (Prospect Memory) scope. When set, chunks whose document is
  // tagged company_id = missionCompanyId get tier='PROSPECT_MEMORY' on the
  // return shape. Does NOT filter the pool — Basis docs still rank.
  missionCompanyId = null,
} = {}) {
  if (!tenantId) { const e = new Error('retrieveContext: tenantId required'); e.status = 400; throw e; }
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { chunks: [], query: query || '' };
  }

  const vec = await embeddings.embedQuery(query);
  const literal = toVectorLiteral(vec);

  const params = [literal];
  params.push(tenantId);
  const tenantClause = `AND d.tenant_id = $${params.length}`;
  let categoryClause = '';
  if (Array.isArray(categories) && categories.length > 0) {
    params.push(categories);
    categoryClause = `AND d.category = ANY($${params.length})`;
  }

  const prof = engagementProfile || {};
  // Accept either array fields (productIds[]) or legacy single ids (productId).
  const lift = (arr, single) => Array.isArray(arr) ? arr : (single ? [single] : []);
  const productClause    = engagementClause('kb_document_products',    'product_id',    lift(prof.productIds,    prof.productId),    params);
  const personaClause    = engagementClause('kb_document_personas',    'persona_id',    lift(prof.personaIds,    prof.personaId),    params);
  const competitorClause = engagementClause('kb_document_competitors', 'competitor_id', lift(prof.competitorIds, prof.competitorId), params);

  // Transient-doc scope. Without currentMissionId we exclude every transient
  // doc; with it, we include this mission's transient docs alongside the
  // permanent KB. Cross-mission leakage is prevented by the FK on mission id.
  let transientClause;
  if (currentMissionId) {
    params.push(currentMissionId);
    transientClause = `AND (d.transient_for_mission_id IS NULL OR d.transient_for_mission_id = $${params.length})`;
  } else {
    transientClause = `AND d.transient_for_mission_id IS NULL`;
  }

  params.push(Math.max(1, Math.min(k, 50)));

  const r = await db.query(
    `SELECT
        c.id              AS chunk_id,
        c.ordinal         AS ordinal,
        c.text            AS text,
        c.token_count     AS token_count,
        c.metadata        AS chunk_metadata,
        d.id              AS document_id,
        d.title           AS document_title,
        d.category        AS category,
        d.source_type     AS source_type,
        d.stream_type     AS stream_type,
        d.effective_date  AS effective_date,
        d.source_url      AS source_url,
        d.scope           AS scope,
        d.company_id      AS company_id,
        d.transient_for_mission_id AS transient_for_mission_id,
        (c.embedding <=> $1::vector) AS distance
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      WHERE d.status = 'READY'
        ${tenantClause}
        ${categoryClause}
        ${productClause}
        ${personaClause}
        ${competitorClause}
        ${transientClause}
      ORDER BY c.embedding <=> $1::vector
      LIMIT $${params.length}`,
    params
  );

  const chunks = r.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    category: row.category,
    sourceType: row.source_type,
    streamType: row.stream_type,
    effectiveDate: row.effective_date,
    sourceUrl: row.source_url,
    scope: row.scope,
    companyId: row.company_id,
    ordinal: row.ordinal,
    text: row.text,
    tokenCount: row.token_count,
    metadata: row.chunk_metadata || {},
    distance: Number(row.distance),
    citation: citationFor(row.document_id, row.ordinal),
    tier: deriveTier({
      docCompanyId:           row.company_id,
      docTransientMissionId:  row.transient_for_mission_id,
      currentMissionId,
      missionCompanyId,
    }),
  }));

  // Re-rank with the recency tiebreaker. The list is small (k ≤ 50), so the
  // bubble-pass cost is negligible — clearer than a custom non-transitive
  // comparator and produces a deterministic stable order.
  const ranked = applyRecencyTiebreaker(chunks);
  return { chunks: ranked, query };
}

// Render chunks into the [Grounded Knowledge] block format used by the
// analysis prompt. The LLM is instructed to cite chunks using the same
// `doc-id:c-N` token that prefixes each block. The tier label (BASIS /
// PROSPECT_MEMORY / LIVE_PULSE) is rendered alongside so the LLM can give
// extra weight to prospect-specific snippets when composing.
function formatForPrompt(chunks) {
  if (!chunks || chunks.length === 0) {
    return '(no relevant Knowledge Base entries found for this transcript)';
  }
  return chunks.map((c) => {
    const pageRef = c.metadata?.page ? ` p.${c.metadata.page}` : '';
    const tier = c.tier ? `[${c.tier}] ` : '';
    return `${tier}[${c.citation}] (${c.category} · ${c.documentTitle}${pageRef})\n${c.text}`;
  }).join('\n\n---\n\n');
}

// Cheap existence check — used by analysis.js to skip the entity-extraction
// pass entirely when this tenant's KB is empty (saves a Flash-Lite call).
async function hasReadyDocuments(tenantId) {
  if (!tenantId) { const e = new Error('hasReadyDocuments: tenantId required'); e.status = 400; throw e; }
  const r = await db.query(
    `SELECT 1 FROM kb_documents WHERE tenant_id = $1 AND status = 'READY' LIMIT 1`,
    [tenantId]
  );
  return r.rows.length > 0;
}

module.exports = {
  retrieveContext,
  formatForPrompt,
  hasReadyDocuments,
  citationFor,
  deriveTier,
  applyRecencyTiebreaker,
  DEFAULT_K,
  RECENCY_EPSILON,
};
