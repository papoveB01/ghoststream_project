// Knowledge Base router. Mounted at /knowledge/ behind authMiddleware in
// src/index.js. All routes return JSON; the upload route accepts multipart.

const express = require('express');
const multer = require('multer');
const service = require('./service');
const retrieval = require('./retrieval');
const globalCache = require('./globalCache');
const web = require('./web');
const social = require('./social');
const parsers = require('./parsers');
const preview = require('./preview');
const research = require('./research');
const db = require('../db');

// Resolve the tenant a write should land in. Normal users → always their own
// tenant (req.tenantId). Platform superadmins (req.user.adm) may target a
// different tenant by passing tenantId in the body — used for concierge KB
// setup. A bogus / non-existent override falls back to the caller's tenant.
async function resolveWriteTenant(req, requestedTenantId) {
  if (req.user && req.user.adm && requestedTenantId && requestedTenantId !== req.tenantId) {
    const r = await db.query(`SELECT 1 FROM tenants WHERE id = $1`, [requestedTenantId]);
    if (r.rows.length > 0) return requestedTenantId;
  }
  return req.tenantId;
}

const MAX_MB = parseInt(process.env.KB_UPLOAD_MAX_MB || '25', 10);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
});

// Wrap multer's middleware so its rejection errors (LIMIT_FILE_SIZE,
// LIMIT_UNEXPECTED_FILE, etc.) come back as actionable HTTP responses
// instead of a generic 500. The default express error handler in index.js
// doesn't map err.code to a status, so without this wrapper an oversized
// upload returns "500 file too large" — confusing for the user.
function uploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `file too large; max ${MAX_MB}MB. Override via KB_UPLOAD_MAX_MB in .env if you need to ingest a bigger one.`,
        code: 'LIMIT_FILE_SIZE',
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'unexpected multipart field — use "file"', code: err.code });
    }
    next(err);
  });
}

const router = express.Router();

// =========================================================================
// POST /knowledge/upload — multipart with field "file" + body fields:
//   category : PRODUCT_INTEL | ORG_INTELLIGENCE | BATTLECARDS
//   title    : human-readable title (replace-on-upload key, case-insensitive)
//   metadata : optional JSON string
// =========================================================================
router.post('/upload', uploadMiddleware, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });

    let metadata = {};
    if (req.body.metadata) {
      try { metadata = JSON.parse(req.body.metadata); }
      catch { return res.status(400).json({ error: 'metadata must be valid JSON' }); }
    }

    const tenantId = await resolveWriteTenant(req, req.body.tenantId);
    const doc = await service.ingest({
      tenantId,
      file: req.file,
      category: req.body.category,
      title: req.body.title,
      metadata,
      scope:         (req.body.scope || 'TENANT').toUpperCase(),
      companyId:     req.body.companyId || null,
      productIds:    normalizeIds(req.body.productIds),
      personaIds:    normalizeIds(req.body.personaIds),
      competitorIds: normalizeIds(req.body.competitorIds),
      appliesToProductIds: normalizeIds(req.body.appliesToProductIds),
    });
    res.status(201).json({ ok: true, document: doc });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /knowledge/preview — multipart "file" → parse + structure WITHOUT
// indexing. Same preview shape as a web dry-run, so the UI renders both with
// one card. No DB writes; tenant-agnostic.
// =========================================================================
router.post('/preview', uploadMiddleware, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });
    const parsed = await parsers.parseFile(req.file);
    if (!parsed.text || parsed.text.length < 10) {
      return res.status(422).json({ error: 'extracted text too short — file may be image-only or unreadable' });
    }
    const card = await preview.buildPreview(parsed.text, {
      title: (req.body.title && req.body.title.trim()) || req.file.originalname,
      sourceType: parsed.sourceType,
      streamType: 'FILE',
      scope: (req.body.scope || 'TENANT').toUpperCase(),
      tenantId: req.tenantId,
      competitorName: req.body.competitorName || null,
      ...(parsed.meta || {}),
    });
    res.json({ ok: true, preview: { dryRun: true, ...card, originalFilename: req.file.originalname } });
  } catch (err) { next(err); }
});

// Multipart form-data can deliver multi-select values as either an array
// (when N>1) or a single string (when N=1), and the admin UI sometimes
// joins them into a comma-separated string. Normalize all three shapes
// into a string array.
function normalizeIds(input) {
  if (input == null) return null;
  if (Array.isArray(input)) return input.filter(Boolean);
  if (typeof input === 'string') {
    return input.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

// =========================================================================
// GET /knowledge/documents?category=&status=
// =========================================================================
router.get('/documents', async (req, res, next) => {
  try {
    const rows = await service.listDocuments({
      tenantId: req.tenantId,
      category: req.query.category,
      status: req.query.status,
      streamType: req.query.streamType,
      scope: req.query.scope ? String(req.query.scope).toUpperCase() : undefined,
      productId: req.query.productId,
      personaId: req.query.personaId,
      competitorId: req.query.competitorId,
      companyId: req.query.companyId,
      limit: Math.min(parseInt(req.query.limit || '100', 10), 500),
    });
    res.json({ documents: rows });
  } catch (err) { next(err); }
});

router.get('/documents/:id', async (req, res, next) => {
  try {
    const doc = await service.getDocument(req.tenantId, req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.json({ document: doc });
  } catch (err) { next(err); }
});

router.get('/documents/:id/download', async (req, res, next) => {
  try {
    const url = await service.getDownloadUrl(req.tenantId, req.params.id);
    if (!url) return res.status(404).json({ error: 'document or R2 object not available' });
    res.json({ url, expiresInSec: 300 });
  } catch (err) { next(err); }
});

router.patch('/documents/:id/tags', express.json(), async (req, res, next) => {
  try {
    const { productIds, personaIds, competitorIds } = req.body || {};
    const doc = await service.updateTags(req.tenantId, req.params.id, {
      productIds:    productIds === undefined    ? null : productIds,
      personaIds:    personaIds === undefined    ? null : personaIds,
      competitorIds: competitorIds === undefined ? null : competitorIds,
    });
    res.json({ ok: true, document: doc });
  } catch (err) { next(err); }
});

// POST /knowledge/documents/:id/keypoints — (re)run AI key-point extraction on
// this document and persist it onto the doc's metadata. Used to backfill docs
// that predate the feature, or to refresh the points.
router.post('/documents/:id/keypoints', async (req, res, next) => {
  try {
    const doc = await service.regenerateKeyPoints(req.tenantId, req.params.id);
    res.json({ ok: true, document: doc });
  } catch (err) { next(err); }
});

// =========================================================================
// Deep Research on a prospect (companies row).
//   GET  /knowledge/research                 → latest run per company (Library)
//   GET  /knowledge/research/:companyId       → latest run for one prospect
//   POST /knowledge/research/:companyId       → start a run (fire-and-forget;
//                                               returns the RUNNING row)
// =========================================================================
router.get('/research', async (req, res, next) => {
  try { res.json({ research: await research.listForTenant(req.tenantId) }); }
  catch (err) { next(err); }
});

router.get('/research/:companyId', async (req, res, next) => {
  try { res.json({ research: await research.latest(req.tenantId, req.params.companyId) }); }
  catch (err) { next(err); }
});

router.post('/research/:companyId', async (req, res, next) => {
  try { res.status(202).json({ ok: true, research: await research.start(req.tenantId, req.params.companyId) }); }
  catch (err) { next(err); }
});

router.delete('/documents/:id', async (req, res, next) => {
  try {
    const ok = await service.deleteDocument(req.tenantId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /knowledge/web-sync — Firecrawl-backed WEB ingestion.
// Body: { url, category, title?, dryRun? }
// =========================================================================
router.post('/web-sync', express.json(), async (req, res, next) => {
  try {
    const { url, category, title, dryRun, scope, competitorName, productIds, personaIds, competitorIds, companyId, appliesToProductIds } = req.body || {};
    if (!url || !category) {
      return res.status(400).json({ error: 'url and category required' });
    }
    const tenantId = await resolveWriteTenant(req, req.body.tenantId);
    const result = await web.syncUrl({
      tenantId,
      url, category, title, dryRun: !!dryRun,
      scope: (scope || 'TENANT').toUpperCase(),
      competitorName: competitorName || null,
      companyId: companyId || null,
      productIds, personaIds, competitorIds, appliesToProductIds,
    });
    res.status(dryRun ? 200 : 201).json({ ok: true, ...(dryRun ? { preview: result } : { document: result }) });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /knowledge/social-sync — Phyllo-backed SOCIAL ingestion.
// Body: { accountId, category, since?, limit?, dryRun? }
// =========================================================================
router.post('/social-sync', express.json(), async (req, res, next) => {
  try {
    const { accountId, category, since, limit, dryRun, scope, productIds, personaIds, competitorIds, companyId, appliesToProductIds } = req.body || {};
    if (!accountId || !category) {
      return res.status(400).json({ error: 'accountId and category required' });
    }
    const tenantId = await resolveWriteTenant(req, req.body.tenantId);
    const result = await social.syncAccount({
      tenantId,
      accountId, category, since,
      limit: limit ? parseInt(limit, 10) : undefined,
      dryRun: !!dryRun,
      scope: (scope || 'TENANT').toUpperCase(),
      companyId: companyId || null,
      productIds, personaIds, competitorIds, appliesToProductIds,
    });
    res.status(dryRun ? 200 : 201).json({ ok: true, ...(dryRun ? { preview: result } : { result }) });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /knowledge/search — manual retrieval probe.
// Body: { query: string, k?: number, categories?: string[] }
// =========================================================================
router.post('/search', express.json(), async (req, res, next) => {
  try {
    const { query, k, categories } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query (string) required' });
    }
    const result = await retrieval.retrieveContext(query, { tenantId: req.tenantId, k, categories });
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// POST /knowledge/global-cache/rebuild — force a rebuild of the global
// Gemini Context Cache. The global cache is Founders-only for now (per-tenant
// caches are Phase 2); other tenants get a 403.
// =========================================================================
router.post('/global-cache/rebuild', async (req, res, next) => {
  try {
    if (!req.user || !req.user.adm) return res.status(403).json({ error: 'global cache is platform-admin only' });
    const row = await globalCache.rebuildGlobalCache({ force: true });
    res.json({ ok: true, globalCache: row });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /knowledge/status — what the AI is currently "trained" on (per tenant).
// =========================================================================
router.get('/status', async (req, res, next) => {
  try { res.json(await service.getStatus(req.tenantId)); }
  catch (err) { next(err); }
});

module.exports = { router };
