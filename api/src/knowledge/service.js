// Knowledge Base service — ingestion, lookup, delete, status.
//
// Ingestion pipeline (POST /knowledge/upload):
//   1. parse the uploaded buffer → plain text (+ optional page boundaries)
//   2. sha256 the normalized text → content_hash (used to dedupe re-uploads)
//   3. chunk text → ~512-token windows with 50-token overlap
//   4. embed all chunks via Gemini text-embedding-004 (768 dim)
//   5. soft-archive any prior READY doc of the same (category, title)
//   6. insert document + chunks in a single transaction → status='READY'
//   7. archive R2 object using the new document_id as the key prefix
//
// Replace-on-upload (locked decision): the prior READY doc is flipped to
// ARCHIVED with archived_at + superseded_by. Its chunks are retained for
// audit but retrieval queries filter `status = 'READY'`.

const crypto = require('crypto');
const db = require('../db');
const r2 = require('./r2');
const parsers = require('./parsers');
const chunker = require('./chunker');
const embeddings = require('./embeddings');
const keypoints = require('./keypoints');
const assessment = require('./assessment');
const globalCache = require('./globalCache');
const web = require('./web');
const social = require('./social');
const { FOUNDERS_TENANT_ID } = require('../users');

const VALID_CATEGORIES = new Set(['PRODUCT_INTEL', 'ORG_INTELLIGENCE', 'BATTLECARDS']);
const VALID_STREAM_TYPES = new Set(['FILE', 'WEB', 'SOCIAL']);
// What the document is ABOUT — the hard entity distinction:
//   TENANT     = the customer's own company (Basis / Home-Team intel)
//   PROSPECT   = a specific prospect company (Prospect Memory)
//   COMPETITOR = a competitor (battlecard material)
const VALID_SCOPES = new Set(['TENANT', 'PROSPECT', 'COMPETITOR']);
const GLOBAL_CACHE_CATEGORIES = new Set(globalCache.GLOBAL_CATEGORIES);

// Tolerant date parser: accepts ISO strings, YYYY-MM-DD, or Date instances.
// Returns Date | null. Used to interpret metadata.effectiveDate from the
// upload form and provider-supplied timestamps from Firecrawl / Phyllo.
function parseEffectiveDate(input) {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Fire-and-log: cache rebuild failure must never break an ingest/delete.
//
// The Gemini global context cache is currently a singleton built only from the
// Founders tenant's ORG_INTELLIGENCE + BATTLECARDS docs (per-tenant context
// caches are Phase 2). A non-Founders ingest in those categories therefore
// doesn't touch the cache — it would otherwise rebuild from the wrong tenant's
// content. Trial tenants don't reach those categories in Phase 1 anyway.
async function maybeRebuildGlobalCache(category, tenantId) {
  if (!GLOBAL_CACHE_CATEGORIES.has(category)) return;
  if (tenantId && tenantId !== FOUNDERS_TENANT_ID) return;
  try { await globalCache.rebuildGlobalCache(); }
  catch (err) { console.warn('[knowledge] global cache rebuild failed:', err.message); }
}

function uuid() {
  return crypto.randomUUID();
}

function assertValidCategory(category) {
  if (!VALID_CATEGORIES.has(category)) {
    const err = new Error(`invalid category: ${category}. Valid: ${[...VALID_CATEGORIES].join(', ')}`);
    err.status = 400;
    throw err;
  }
}

// pgvector accepts vectors as a string `[v1,v2,...]`. Use comma separator with
// no spaces — keeps the literal compact for large batches.
function toVectorLiteral(values) {
  return `[${values.join(',')}]`;
}

// A KB document is filed under at most ONE product line ("Fraud Solution" vs
// "Payment Gateway"); empty = company-wide / global. Personas and competitors
// stay many-to-many — only the product dimension is single-valued. Enforced in
// the app layer (with a friendly message) and at the DB level by the
// kb_document_products_one_per_doc unique index (migration 0009).
function assertSingleProductLine(productIds) {
  if (!Array.isArray(productIds)) return;
  const unique = [...new Set(productIds.filter((v) => typeof v === 'string' && v.length > 0))];
  if (unique.length > 1) {
    const e = new Error('a document can be filed under at most one product line — leave it empty for company-wide intel');
    e.status = 400;
    throw e;
  }
}

// De-duplicate and insert tag links. ON CONFLICT DO NOTHING means a doc
// already tagged with the same entity is a no-op (lets future "edit tags"
// paths reuse this helper without write-conflict handling).
async function insertTagLinks(client, table, idColumn, documentId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const unique = [...new Set(ids.filter((v) => typeof v === 'string' && v.length > 0))];
  if (unique.length === 0) return;
  for (const id of unique) {
    await client.query(
      `INSERT INTO ${table} (document_id, ${idColumn})
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [documentId, id]
    );
  }
}

// ingest() accepts a multer-shaped `file` for FILE uploads. WEB and SOCIAL
// callers (web.js / social.js) synthesize the same file shape from their
// fetched content so this function stays the single ingestion code path.
//
// Stream-type-aware parameters:
//   streamType    : 'FILE' (default) | 'WEB' | 'SOCIAL'
//   effectiveDate : Date | ISO string | null. If null, falls back to
//                   metadata.effectiveDate, then to now().
//   sourceUrl     : canonical URL of the original WEB page or SOCIAL post.
//                   Stored on the doc for citation rendering in the portal.
// Intelligence Matrix tag arrays. All three are optional — empty/missing
// means the document is GLOBAL in that dimension (matches every engagement).
// Values must already exist in the relevant entity table; the FK constraint
// will raise if a typo'd ID is passed.
async function ingest({
  tenantId = FOUNDERS_TENANT_ID,
  file, category, title, metadata = {},
  streamType = 'FILE',
  effectiveDate = null,
  sourceUrl = null,
  productIds = null,
  personaIds = null,
  competitorIds = null,
  // Mission-scoped transient docs: scraped page that only this mission's
  // brief pipeline should see. Default retrieval and Library both filter
  // these out so they don't pollute analysis across other missions.
  transientForMissionId = null,
  // Entity the doc is about. TENANT (default) → Basis; PROSPECT → companyId
  // required, doc is Prospect Memory; COMPETITOR → ≥1 competitorId required.
  scope = 'TENANT',
  // For scope=PROSPECT: the companies row this doc belongs to (same tenant).
  companyId = null,
  // For BATTLECARDS / scope=COMPETITOR: which of OUR products this battlecard
  // applies to. Stored on metadata.appliesToProductIds (NOT the kb_document_products
  // junction — that's deliberately 0-or-1 per migration 0009). Empty / null /
  // missing = applies to all products (the default).
  appliesToProductIds = null,
}) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  assertValidCategory(category);
  if (!VALID_STREAM_TYPES.has(streamType)) {
    const err = new Error(`invalid streamType: ${streamType}`);
    err.status = 400; throw err;
  }
  if (!VALID_SCOPES.has(scope)) {
    const err = new Error(`invalid scope: ${scope}. Valid: ${[...VALID_SCOPES].join(', ')}`);
    err.status = 400; throw err;
  }
  if (!file || !file.buffer) {
    const err = new Error('file required'); err.status = 400; throw err;
  }
  if (!title || typeof title !== 'string') {
    const err = new Error('title (string) required'); err.status = 400; throw err;
  }
  assertSingleProductLine(productIds);

  // ----- scope-specific validation + normalization -----
  const compIds = Array.isArray(competitorIds) ? competitorIds.filter(Boolean) : [];
  let competitorName = null;
  if (scope === 'TENANT') {
    companyId = null; // a doc about our own company never carries a prospect link
  } else if (scope === 'PROSPECT') {
    if (!companyId) {
      const e = new Error('scope=PROSPECT requires a prospect (companyId)'); e.status = 400; throw e;
    }
    const c = await db.query(`SELECT 1 FROM companies WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
    if (c.rows.length === 0) {
      const e = new Error('prospect not found in this workspace'); e.status = 404; throw e;
    }
  } else if (scope === 'COMPETITOR') {
    companyId = null;
    if (compIds.length === 0) {
      const e = new Error('scope=COMPETITOR requires at least one competitorId'); e.status = 400; throw e;
    }
    const found = await db.query(
      `SELECT id, name FROM competitors WHERE tenant_id = $1 AND id = ANY($2)`,
      [tenantId, compIds]
    );
    if (found.rows.length !== compIds.length) {
      const e = new Error('one or more competitors not found in this workspace'); e.status = 404; throw e;
    }
    competitorName = found.rows.map((r) => r.name).join(' / ');
  }

  // 1. Parse
  const parsed = await parsers.parseFile(file);
  if (!parsed.text || parsed.text.length < 10) {
    const err = new Error('extracted text too short — file may be image-only or unreadable');
    err.status = 400; throw err;
  }

  // 2. Hash (on the normalized text — stable across re-uploads of the same source)
  const contentHash = crypto.createHash('sha256').update(parsed.text).digest('hex');

  // 3. Chunk
  const chunks = chunker.chunk(parsed);
  if (chunks.length === 0) {
    const err = new Error('no chunks produced from file');
    err.status = 400; throw err;
  }

  // 4. Embed (network — slowest step; if this fails, no DB state is touched yet)
  const vectors = await embeddings.embedAll(chunks.map((c) => c.text));

  // 4b. Key points — "competitive points" for COMPETITOR docs, "opportunity
  // points" for PROSPECT docs — extracted by Gemini and stored on the document's
  // metadata so the Library can render them without re-calling the model on
  // every page load. Best-effort (never blocks ingest), and skipped for
  // transient mission-prep docs and individual social posts (too thin).
  let keyPoints = { kind: keypoints.kindFor(scope), points: [] };
  let scoreboard = null;
  if ((scope === 'COMPETITOR' || scope === 'PROSPECT') && streamType !== 'SOCIAL' && !transientForMissionId) {
    keyPoints = await keypoints.extractKeyPoints({ scope, text: parsed.text, tenantId, title });
  }
  // Competitive scoreboard — runs on COMPETITOR-scoped docs and any
  // BATTLECARDS-category doc. Stored on metadata.assessment; never blocks
  // ingest if the model call fails (returns null).
  const cleanAppliesTo = Array.isArray(appliesToProductIds)
    ? [...new Set(appliesToProductIds.filter((v) => typeof v === 'string' && v.length > 0))]
    : [];
  if ((scope === 'COMPETITOR' || category === 'BATTLECARDS') && streamType !== 'SOCIAL' && !transientForMissionId) {
    let appliesProductNames = [];
    if (cleanAppliesTo.length) {
      const pr = await db.query(
        `SELECT name FROM products WHERE tenant_id = $1 AND id = ANY($2)`,
        [tenantId, cleanAppliesTo]
      );
      appliesProductNames = pr.rows.map((r) => r.name);
    }
    scoreboard = await assessment.extractCompetitiveAssessment({
      text: parsed.text, tenantId, title, competitorName, appliesProductNames,
    });
  }

  // 5. R2 archive — best-effort. If R2 isn't configured, we still ingest but
  // store empty r2_key; the lookup endpoints handle the missing-object case.
  const documentId = uuid();
  let r2Key = '';
  if (r2.isConfigured()) {
    r2Key = r2.buildKey({ category, documentId, filename: file.originalname });
    await r2.putObject({
      key: r2Key,
      body: file.buffer,
      contentType: file.mimetype || 'application/octet-stream',
    });
  }

  const tokenCount = chunks.reduce((s, c) => s + c.tokenCount, 0);

  // 6. Single transaction: archive prior + insert new + insert chunks.
  await db.withTx(async (client) => {
    // Soft-archive any existing READY doc with the same (tenant, category,
    // lower(title)) — replace-on-upload is per-tenant.
    const archived = await client.query(
      `UPDATE kb_documents
          SET status = 'ARCHIVED',
              archived_at = now(),
              superseded_by = $1,
              updated_at = now()
        WHERE tenant_id = $2
          AND category = $3
          AND lower(title) = lower($4)
          AND status = 'READY'
      RETURNING id`,
      [documentId, tenantId, category, title]
    );

    const resolvedEffectiveDate =
      parseEffectiveDate(effectiveDate)
      || parseEffectiveDate(metadata.effectiveDate)
      || new Date();

    await client.query(
      `INSERT INTO kb_documents
         (id, tenant_id, category, title, source_type, r2_key, content_hash,
          byte_size, token_count, chunk_count, metadata, status,
          stream_type, effective_date, source_url, transient_for_mission_id,
          company_id, scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'READY',$12,$13,$14,$15,$16,$17)`,
      [
        documentId,
        tenantId,
        category,
        title,
        parsed.sourceType,
        r2Key,
        contentHash,
        file.buffer.length,
        tokenCount,
        chunks.length,
        JSON.stringify({
          ...metadata,
          ...(parsed.meta || {}),
          originalFilename: file.originalname,
          supersedes: archived.rows.map((r) => r.id),
          ...(keyPoints.points.length ? { keyPoints: keyPoints.points, keyPointsKind: keyPoints.kind } : {}),
          ...(scoreboard ? { assessment: scoreboard } : {}),
          ...(cleanAppliesTo.length ? { appliesToProductIds: cleanAppliesTo } : {}),
        }),
        streamType,
        resolvedEffectiveDate.toISOString(),
        sourceUrl,
        transientForMissionId,
        companyId,
        scope,
      ]
    );

    // Bulk-insert chunks. We parametrize each row explicitly — pg won't accept
    // a single VALUES list for a heterogeneous batch of vectors without it.
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await client.query(
        `INSERT INTO kb_chunks
           (id, document_id, ordinal, text, token_count, embedding, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::vector,$7)`,
        [
          uuid(),
          documentId,
          i,
          c.text,
          c.tokenCount,
          toVectorLiteral(vectors[i]),
          JSON.stringify(c.metadata || {}),
        ]
      );
    }

    // Intelligence Matrix tag links. INSERT ... ON CONFLICT DO NOTHING so a
    // caller passing duplicate IDs (e.g. ['cfo','cfo']) is harmless.
    await insertTagLinks(client, 'kb_document_products',    'product_id',    documentId, productIds);
    await insertTagLinks(client, 'kb_document_personas',    'persona_id',    documentId, personaIds);
    await insertTagLinks(client, 'kb_document_competitors', 'competitor_id', documentId, compIds);
  });

  // Battlecard inception: ORG_INTELLIGENCE + BATTLECARDS uploads rebuild the
  // global Gemini cache so the Arena picks up the new punchlines immediately.
  // (No-op for non-Founders tenants — see maybeRebuildGlobalCache.)
  await maybeRebuildGlobalCache(category, tenantId);

  return getDocument(tenantId, documentId);
}

// Aggregated tag subquery used by getDocument + listDocuments. Each junction
// table becomes a JSON array column on the result row.
const TAG_AGG_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(product_id ORDER BY product_id), '[]') AS product_ids
      FROM kb_document_products WHERE document_id = d.id
  ) pj ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(persona_id ORDER BY persona_id), '[]') AS persona_ids
      FROM kb_document_personas WHERE document_id = d.id
  ) sj ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(competitor_id ORDER BY competitor_id), '[]') AS competitor_ids
      FROM kb_document_competitors WHERE document_id = d.id
  ) cj ON TRUE
`;

async function getDocument(tenantId, id) {
  const r = await db.query(
    `SELECT d.id, d.category, d.title, d.source_type, d.r2_key, d.content_hash, d.byte_size,
            d.token_count, d.chunk_count, d.metadata, d.status, d.superseded_by, d.error,
            d.created_at, d.updated_at, d.archived_at,
            d.stream_type, d.effective_date, d.source_url,
            d.scope, d.company_id, co.name AS company_name,
            pj.product_ids, sj.persona_ids, cj.competitor_ids
       FROM kb_documents d
       LEFT JOIN companies co ON co.id = d.company_id
       ${TAG_AGG_JOIN}
      WHERE d.id = $1 AND d.tenant_id = $2`,
    [id, tenantId]
  );
  return r.rows[0] || null;
}

async function listDocuments({ tenantId, category, status, streamType, scope, productId, personaId, competitorId, companyId, limit = 100 } = {}) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  const where = [];
  const params = [];
  params.push(tenantId); where.push(`d.tenant_id = $${params.length}`);
  if (category) { params.push(category); where.push(`d.category = $${params.length}`); }
  if (scope && VALID_SCOPES.has(scope)) { params.push(scope); where.push(`d.scope = $${params.length}`); }
  if (status)   { params.push(status);   where.push(`d.status = $${params.length}`); }
  if (streamType) { params.push(streamType); where.push(`d.stream_type = $${params.length}`); }
  if (productId) {
    params.push(productId);
    where.push(`EXISTS (SELECT 1 FROM kb_document_products WHERE document_id = d.id AND product_id = $${params.length})`);
  }
  if (personaId) {
    params.push(personaId);
    where.push(`EXISTS (SELECT 1 FROM kb_document_personas WHERE document_id = d.id AND persona_id = $${params.length})`);
  }
  if (competitorId) {
    params.push(competitorId);
    where.push(`EXISTS (SELECT 1 FROM kb_document_competitors WHERE document_id = d.id AND competitor_id = $${params.length})`);
  }
  // companyId filter — three-way semantics:
  //   undefined/null  → no filter
  //   '__none__'      → only Tier 1 (Basis) docs (company_id IS NULL)
  //   <uuid>          → only that company's Tier 2 (Prospect Memory) docs
  if (companyId === '__none__') {
    where.push(`d.company_id IS NULL`);
  } else if (companyId) {
    params.push(companyId);
    where.push(`d.company_id = $${params.length}`);
  }
  // Default to non-archived listing — the Library tab shows live docs.
  if (!status) where.push(`d.status <> 'ARCHIVED'`);
  // Default: hide mission-prep transient docs from the Library. They only
  // belong to one mission's brief pipeline and shouldn't clutter the human-
  // curated KB view. Pass `includeTransient: true` in the future to override.
  where.push(`d.transient_for_mission_id IS NULL`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  const r = await db.query(
    `SELECT d.id, d.category, d.title, d.source_type, d.byte_size, d.token_count, d.chunk_count,
            d.status, d.created_at, d.updated_at, d.metadata,
            d.stream_type, d.effective_date, d.source_url,
            d.scope, d.company_id, co.name AS company_name,
            pj.product_ids, sj.persona_ids, cj.competitor_ids,
            fc.first_chunk
       FROM kb_documents d
       LEFT JOIN companies co ON co.id = d.company_id
       ${TAG_AGG_JOIN}
       LEFT JOIN LATERAL (
         SELECT left(c.text, 400) AS first_chunk
           FROM kb_chunks c WHERE c.document_id = d.id ORDER BY c.ordinal LIMIT 1
       ) fc ON TRUE
       ${whereSql}
       ORDER BY d.created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function deleteDocument(tenantId, id) {
  // CASCADE on kb_chunks handles chunk removal; we also evict the R2 object.
  const r = await db.query(
    `SELECT r2_key, category FROM kb_documents WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  if (r.rows.length === 0) return false;
  const { r2_key: r2Key, category } = r.rows[0];

  await db.query(`DELETE FROM kb_documents WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);

  if (r2Key && r2.isConfigured()) {
    try { await r2.deleteObject(r2Key); }
    catch (err) { console.warn(`[knowledge] R2 delete failed for ${r2Key}: ${err.message}`); }
  }

  await maybeRebuildGlobalCache(category, tenantId);
  return true;
}

// Replace all three tag dimensions on an existing document. Each `*Ids`
// param: null = leave that dimension untouched; [] = clear all tags in that
// dimension; non-empty array = replace with this exact set. This three-way
// semantics lets callers update a single dimension without having to read
// then re-pass the other two.
async function updateTags(tenantId, documentId, { productIds, personaIds, competitorIds }) {
  assertSingleProductLine(productIds);
  const doc = await getDocument(tenantId, documentId);
  if (!doc) {
    const err = new Error('document not found'); err.status = 404; throw err;
  }

  await db.withTx(async (client) => {
    if (productIds !== null && productIds !== undefined) {
      await client.query(`DELETE FROM kb_document_products WHERE document_id = $1`, [documentId]);
      await insertTagLinks(client, 'kb_document_products', 'product_id', documentId, productIds);
    }
    if (personaIds !== null && personaIds !== undefined) {
      await client.query(`DELETE FROM kb_document_personas WHERE document_id = $1`, [documentId]);
      await insertTagLinks(client, 'kb_document_personas', 'persona_id', documentId, personaIds);
    }
    if (competitorIds !== null && competitorIds !== undefined) {
      await client.query(`DELETE FROM kb_document_competitors WHERE document_id = $1`, [documentId]);
      await insertTagLinks(client, 'kb_document_competitors', 'competitor_id', documentId, competitorIds);
    }
    await client.query(`UPDATE kb_documents SET updated_at = now() WHERE id = $1 AND tenant_id = $2`, [documentId, tenantId]);
  });

  // If a BATTLECARDS or ORG_INTELLIGENCE doc's tags change, the global cache
  // doesn't structurally change (the content_text doesn't depend on tags) —
  // skip the rebuild. The retrieval-time filter handles scoping.

  return getDocument(tenantId, documentId);
}

// Re-run AI key-point extraction on an existing document and persist the result
// onto its metadata (keyPoints / keyPointsKind). Used to backfill docs ingested
// before key points existed, or to refresh them. Returns the updated document.
async function regenerateKeyPoints(tenantId, documentId) {
  const doc = await getDocument(tenantId, documentId);
  if (!doc) { const err = new Error('document not found'); err.status = 404; throw err; }
  const r = await db.query(
    `SELECT string_agg(text, E'\n' ORDER BY ordinal) AS body FROM kb_chunks WHERE document_id = $1`,
    [documentId]
  );
  const text = (r.rows[0] && r.rows[0].body) || '';
  const { kind, points } = await keypoints.extractKeyPoints({
    scope: doc.scope, text, tenantId, title: doc.title,
  });
  const md = { ...(doc.metadata || {}) };
  if (points.length) { md.keyPoints = points; md.keyPointsKind = kind; }
  else { delete md.keyPoints; delete md.keyPointsKind; }

  // Refresh the competitive scoreboard alongside key points whenever it
  // applies (COMPETITOR scope or BATTLECARDS category). Cleared on null
  // so a doc that's been re-scoped away from competitive doesn't keep a
  // stale scoreboard.
  if (doc.scope === 'COMPETITOR' || doc.category === 'BATTLECARDS') {
    const competitorName = Array.isArray(doc.competitor_ids) && doc.competitor_ids.length
      ? (await db.query(
          `SELECT name FROM competitors WHERE tenant_id = $1 AND id = ANY($2)`,
          [tenantId, doc.competitor_ids]
        )).rows.map((r) => r.name).join(' / ')
      : null;
    const scoreboard = await assessment.extractCompetitiveAssessment({
      text, tenantId, title: doc.title, competitorName,
    });
    if (scoreboard) md.assessment = scoreboard;
    else delete md.assessment;
  } else {
    delete md.assessment;
  }
  await db.query(
    `UPDATE kb_documents SET metadata = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify(md), documentId, tenantId]
  );

  // BATTLECARDS docs feed the Arena's global cache. Refreshing the
  // scoreboard changes what the persona sees, so rebuild.
  if (doc.category === 'BATTLECARDS') {
    await maybeRebuildGlobalCache(doc.category, tenantId);
  }
  return getDocument(tenantId, documentId);
}

async function getDownloadUrl(tenantId, id) {
  const doc = await getDocument(tenantId, id);
  if (!doc) return null;
  if (!doc.r2_key) return null;
  return r2.presignGet(doc.r2_key, 300);
}

// Full indexed text of a document — the chunks concatenated in ordinal order.
// Powers the "View full document" collapse on intel cards. Soft-capped so a
// pathologically large doc can't blow up the response; `truncated` tells the
// UI to show a notice. Returns null when the doc isn't in this tenant.
const DOC_TEXT_CAP = parseInt(process.env.KB_DOC_TEXT_CAP || '600000', 10);
async function getDocumentText(tenantId, id) {
  const doc = await getDocument(tenantId, id);
  if (!doc) return null;
  const r = await db.query(
    `SELECT string_agg(text, E'\n\n' ORDER BY ordinal) AS body,
            COUNT(*)::int AS n
       FROM kb_chunks WHERE document_id = $1`,
    [id]
  );
  let text = (r.rows[0] && r.rows[0].body) || '';
  const truncated = text.length > DOC_TEXT_CAP;
  if (truncated) text = text.slice(0, DOC_TEXT_CAP);
  return {
    id: doc.id,
    title: doc.title,
    sourceUrl: doc.source_url || null,
    chunkCount: (r.rows[0] && r.rows[0].n) || 0,
    text,
    truncated,
  };
}

// Status payload — drives the Admin "Knowledge Status" page. Scoped to one
// tenant.
async function getStatus(tenantId) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  const perCat = await db.query(
    `SELECT category,
            COUNT(*) FILTER (WHERE status = 'READY') AS ready_docs,
            COALESCE(SUM(chunk_count) FILTER (WHERE status = 'READY'), 0) AS ready_chunks,
            COALESCE(SUM(token_count) FILTER (WHERE status = 'READY'), 0) AS ready_tokens
       FROM kb_documents
      WHERE tenant_id = $1
      GROUP BY category`,
    [tenantId]
  );
  const byCategory = { PRODUCT_INTEL: zero(), ORG_INTELLIGENCE: zero(), BATTLECARDS: zero() };
  for (const row of perCat.rows) {
    byCategory[row.category] = {
      documents: parseInt(row.ready_docs, 10),
      chunks: parseInt(row.ready_chunks, 10),
      tokens: parseInt(row.ready_tokens, 10),
    };
  }

  const totals = Object.values(byCategory).reduce(
    (acc, c) => ({
      documents: acc.documents + c.documents,
      chunks:    acc.chunks    + c.chunks,
      tokens:    acc.tokens    + c.tokens,
    }),
    { documents: 0, chunks: 0, tokens: 0 }
  );

  // Pending / failed counts — surfaces stuck ingests in the UI.
  const stateCounts = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM kb_documents WHERE tenant_id = $1 GROUP BY status`,
    [tenantId]
  );
  const byStatus = {};
  for (const row of stateCounts.rows) byStatus[row.status] = row.n;

  // FILE / WEB / SOCIAL split for the Omni-Sync banner in the admin UI.
  const streamCounts = await db.query(
    `SELECT stream_type, COUNT(*)::int AS n
       FROM kb_documents WHERE tenant_id = $1 AND status = 'READY'
      GROUP BY stream_type`,
    [tenantId]
  );
  const byStreamType = { FILE: 0, WEB: 0, SOCIAL: 0 };
  for (const row of streamCounts.rows) byStreamType[row.stream_type] = row.n;

  // Global Gemini cache is Founders-only for now; non-Founders tenants see an
  // empty cache block until per-tenant context caches land (Phase 2).
  const cacheRow = (tenantId === FOUNDERS_TENANT_ID)
    ? await db.query(`SELECT * FROM kb_global_cache WHERE id = 1`)
    : { rows: [] };
  const cache = cacheRow.rows[0] || {};

  return {
    active: totals.documents > 0,
    summary: totals.documents > 0
      ? 'GhostStream Intelligence: Active'
      : 'GhostStream Intelligence: Awaiting first upload',
    byCategory,
    totals,
    byStatus,
    byStreamType,
    globalCache: {
      cacheName: cache.cache_name || null,
      tokenCount: cache.token_count || 0,
      charCount: cache.char_count ? Number(cache.char_count) : 0,
      refreshedAt: cache.refreshed_at || null,
      documents: cache.documents || [],
      mode: cache.cache_name ? 'cached' : (cache.content_text ? 'inline' : 'empty'),
    },
    embedding: {
      model: embeddings.MODEL,
      dimensions: embeddings.DIMENSIONS,
    },
    storage: { r2Configured: r2.isConfigured() },
    providers: {
      firecrawl: web.isConfigured(),
      brave: web.isBraveConfigured(),
      phyllo: social.isConfigured(),
    },
  };

  function zero() { return { documents: 0, chunks: 0, tokens: 0 }; }
}

module.exports = {
  ingest,
  getDocument,
  listDocuments,
  deleteDocument,
  getDownloadUrl,
  getDocumentText,
  updateTags,
  regenerateKeyPoints,
  getStatus,
  VALID_CATEGORIES,
  VALID_STREAM_TYPES,
  VALID_SCOPES,
};
