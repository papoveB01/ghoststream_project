// Portfolio Manager — per-tenant CRUD for the three Intelligence Matrix
// entity tables (products, personas, competitors). All endpoints sit behind
// authMiddleware in index.js; every query is scoped by req.tenantId.
//
// Known limitation (Phase 1): the entity `id` is a global TEXT primary key,
// so two tenants can't both create an entity with the same id (the second
// gets a 409 "already exists" rather than a clean per-tenant insert). Phase 1
// onboarding doesn't let trial tenants create entities, so this isn't
// reachable yet. Fixing it properly = UUID PKs + composite junction keys.

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const watchSchedule = require('./watchSchedule');

const TABLES = {
  products:    { table: 'products',    junction: 'kb_document_products',    column: 'product_id' },
  personas:    { table: 'personas',    junction: 'kb_document_personas',    column: 'persona_id' },
  competitors: { table: 'competitors', junction: 'kb_document_competitors', column: 'competitor_id' },
};

const router = express.Router();
router.use(express.json());

for (const [resource, conf] of Object.entries(TABLES)) {
  // LIST — only this tenant's entities. Doc counts are scoped via a join on
  // kb_documents.tenant_id so a shared junction row from another tenant
  // (impossible today, but defensive) doesn't inflate the count.
  // Competitors carry location + contact columns (migration 0030); products/
  // personas don't — so only widen the select/patch for competitors.
  const contactCols = resource === 'competitors'
    ? ', e.website, e.country, e.city, e.address, e.phone, e.email, e.watch_enabled, e.watch_frequency, e.watch_day, e.watch_timezone, e.watch_email_digest, e.watch_next_run_at, e.watch_last_run_at'
    : (resource === 'products' ? ', e.ai_enriched' : '');
  router.get(`/${resource}`, async (req, res, next) => {
    try {
      const r = await db.query(
        `SELECT e.id, e.name, e.description${contactCols}, e.created_at,
                COALESCE(j.doc_count, 0)::int AS doc_count
           FROM ${conf.table} e
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS doc_count
               FROM ${conf.junction} jt
               JOIN kb_documents d ON d.id = jt.document_id
              WHERE jt.${conf.column} = e.id AND d.tenant_id = $1
           ) j ON TRUE
          WHERE e.tenant_id = $1
          ORDER BY lower(e.name)`,
        [req.tenantId]
      );
      res.json({ [resource]: r.rows });
    } catch (err) { next(err); }
  });

  // CREATE
  router.post(`/${resource}`, async (req, res, next) => {
    try {
      const { id, name, description } = req.body || {};
      if (!id || !name) return res.status(400).json({ error: 'id and name required' });
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
        return res.status(400).json({ error: 'id must be slug-shaped: [a-z0-9_-], 1-64 chars' });
      }
      // Dedupe by name within the tenant: the background foundation enrichment
      // (enrichment.js) may have already created this entity under a different
      // id scheme ("<slug>-<tenant8>"). Converge on the existing row rather than
      // minting a parallel duplicate. (products also carries a DB-level unique
      // guard on (tenant_id, lower(name)) — migration 0048 — which the catch
      // below turns into a clean 409 if a concurrent create still races in.)
      const dup = await db.query(
        `SELECT * FROM ${conf.table} WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [req.tenantId, name]
      );
      if (dup.rows[0]) {
        return res.status(200).json({ [resource.replace(/s$/, '')]: dup.rows[0] });
      }
      const r = await db.query(
        `INSERT INTO ${conf.table} (id, tenant_id, name, description)
              VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, req.tenantId, name, description || null]
      );
      res.status(201).json({ [resource.replace(/s$/, '')]: r.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: `${resource.replace(/s$/, '')} already exists` });
      }
      next(err);
    }
  });

  // PATCH — name/description only; id is immutable.
  router.patch(`/${resource}/:id`, async (req, res, next) => {
    try {
      const b = req.body || {};
      const sets = [];
      const params = [];
      if (b.name !== undefined)        { params.push(b.name);        sets.push(`name = $${params.length}`); }
      if (b.description !== undefined) { params.push(b.description); sets.push(`description = $${params.length}`); }
      if (resource === 'competitors') {
        for (const f of ['website', 'country', 'city', 'address', 'phone', 'email']) {
          if (b[f] !== undefined) { params.push(b[f] || null); sets.push(`${f} = $${params.length}`); }
        }
        // Per-entity Market Watch schedule — merge over the current row.
        if (['watchEnabled', 'watchFrequency', 'watchDay', 'watchTimezone', 'watchEmailDigest'].some((k) => b[k] !== undefined)) {
          const cur = (await db.query(`SELECT watch_enabled, watch_frequency, watch_day, watch_timezone, watch_email_digest FROM competitors WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.tenantId])).rows[0];
          if (!cur) return res.status(404).json({ error: 'not found' });
          const wm = watchSchedule.mergeWatchSchedule(cur, b);
          if (wm.error) return res.status(400).json({ error: wm.error });
          for (const [col, val] of Object.entries(wm.values)) { params.push(val); sets.push(`${col} = $${params.length}`); }
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
      params.push(req.params.id);
      params.push(req.tenantId);
      const r = await db.query(
        `UPDATE ${conf.table} SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
        params
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ [resource.replace(/s$/, '')]: r.rows[0] });
    } catch (err) { next(err); }
  });

  // DELETE — RESTRICTed by FK if any document is still tagged. Manager+ only:
  // these are shared tenant catalog entities, not a rep's own working data.
  router.delete(`/${resource}/:id`, auth.requireRole('manager'), async (req, res, next) => {
    try {
      const r = await db.query(
        `DELETE FROM ${conf.table} WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.tenantId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) {
      if (err.code === '23503') {
        const count = await db.query(
          `SELECT COUNT(*)::int AS n
             FROM ${conf.junction} jt JOIN kb_documents d ON d.id = jt.document_id
            WHERE jt.${conf.column} = $1 AND d.tenant_id = $2`,
          [req.params.id, req.tenantId]
        );
        return res.status(409).json({
          error: `cannot delete: ${count.rows[0].n} document(s) still tagged with this ${resource.replace(/s$/, '')}. Untag them first.`,
        });
      }
      next(err);
    }
  });
}

// ── Company profile (our positioning & objectives) ────────────────────────
// A first-class, editable foundation that keypoints.tenantContextText() reads
// and injects into every battlecard / prospect research / brief. One row per
// tenant (tenant_profiles), upserted.

// GET /portfolio/company-profile → { positioning, objectives, updated_at }.
router.get('/company-profile', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT positioning, objectives, ideal_customer_profile, updated_at FROM tenant_profiles WHERE tenant_id = $1`,
      [req.tenantId]
    );
    res.json({ profile: r.rows[0] || { positioning: null, objectives: null, ideal_customer_profile: null, updated_at: null } });
  } catch (err) { next(err); }
});

// PATCH /portfolio/company-profile { positioning?, objectives? } — upsert.
// Owner-only: positioning/objectives are account-level identity that feed every
// brief and battlecard.
router.patch('/company-profile', auth.requireRole('owner'), async (req, res, next) => {
  try {
    const positioning = req.body && req.body.positioning !== undefined ? (String(req.body.positioning || '').trim() || null) : undefined;
    const objectives = req.body && req.body.objectives !== undefined ? (String(req.body.objectives || '').trim() || null) : undefined;
    const icp = req.body && req.body.idealCustomerProfile !== undefined ? (String(req.body.idealCustomerProfile || '').trim() || null) : undefined;
    if (positioning === undefined && objectives === undefined && icp === undefined) {
      return res.status(400).json({ error: 'nothing to update; pass positioning, objectives and/or idealCustomerProfile' });
    }
    // Upsert: insert the row if missing, else update only the provided fields.
    const r = await db.query(
      `INSERT INTO tenant_profiles (tenant_id, positioning, objectives, ideal_customer_profile, updated_at)
            VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
            positioning = CASE WHEN $5 THEN EXCLUDED.positioning ELSE tenant_profiles.positioning END,
            objectives  = CASE WHEN $6 THEN EXCLUDED.objectives  ELSE tenant_profiles.objectives  END,
            ideal_customer_profile = CASE WHEN $7 THEN EXCLUDED.ideal_customer_profile ELSE tenant_profiles.ideal_customer_profile END,
            updated_at  = now()
       RETURNING positioning, objectives, ideal_customer_profile, updated_at`,
      [req.tenantId, positioning ?? null, objectives ?? null, icp ?? null, positioning !== undefined, objectives !== undefined, icp !== undefined]
    );
    res.json({ profile: r.rows[0] });
  } catch (err) { next(err); }
});

// POST /portfolio/company-profile/draft → AI-suggested positioning/objectives
// from our filed TENANT intel (does NOT save — the rep edits then Saves).
router.post('/company-profile/draft', async (req, res, next) => {
  try {
    const basis = await db.query(
      `SELECT d.title, string_agg(c.text, E'\n' ORDER BY c.ordinal) AS body
         FROM kb_documents d JOIN kb_chunks c ON c.document_id = d.id
        WHERE d.tenant_id = $1 AND d.scope = 'TENANT' AND d.status = 'READY'
        GROUP BY d.id, d.title, d.created_at
        ORDER BY d.created_at DESC LIMIT 6`,
      [req.tenantId]
    );
    const text = basis.rows.map((r) => `## ${r.title}\n${String(r.body || '').slice(0, 4000)}`).join('\n\n').trim();
    if (text.length < 80) {
      return res.status(422).json({ error: 'not enough company intel on file yet — add some on the Intel tab first' });
    }
    const a = await keypoints.extractCompanyAnalysis({ text, tenantId: req.tenantId, title: 'Our company' });
    if (!a) return res.status(502).json({ error: 'could not draft a profile right now — try again' });
    const posParts = [];
    if (a.executiveSummary) posParts.push(a.executiveSummary);
    if (a.marketPosition && a.marketPosition.differentiator) posParts.push(`Differentiator: ${a.marketPosition.differentiator}`);
    const objParts = [];
    if (Array.isArray(a.salesAngles) && a.salesAngles.length) objParts.push(...a.salesAngles.slice(0, 5).map((s) => `- ${s}`));
    // ICP is now its own first-class field (feeds discovery), not squashed into positioning.
    res.json({ draft: { positioning: posParts.join('\n') || null, objectives: objParts.join('\n') || null, idealCustomerProfile: a.idealCustomerProfile || null } });
  } catch (err) { next(err); }
});

// GET /portfolio/products/:id/competitors → competitors that face this product
// (reverse of the competitor_products pin), for the product drill-down.
router.get('/products/:id/competitors', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.name, c.description
         FROM competitor_products cp
         JOIN competitors c ON c.id = cp.competitor_id AND c.tenant_id = cp.tenant_id
        WHERE cp.tenant_id = $1 AND cp.product_id = $2
        ORDER BY lower(c.name)`,
      [req.tenantId, req.params.id]
    );
    res.json({ competitors: r.rows });
  } catch (err) { next(err); }
});

// GET /portfolio/competitors/threats → per-competitor threat score (0..1) for
// the Market Map, computed from persisted intelligence rather than proxies:
//   battlecard  — the "Competing-threat level: X (N/5)" line that discovery
//                 files into each competitor's BATTLECARDS intel (max across docs)
//   prospects   — share of OUR prospects whose name appears in this
//                 competitor's filed intel (entangled accounts)
//   products    — share of OUR products pinned against them (competitor_products)
//   watch       — materiality-weighted Market Watch findings, last 90 days
// Missing factors drop out and the weights renormalize, so a competitor with
// only a battlecard still scores honestly instead of being dragged to zero.
router.get('/competitors/threats', async (req, res, next) => {
  try {
    const t = req.tenantId;
    const [comps, prodTotal, pins, bc, overlap, watch] = await Promise.all([
      db.query(`SELECT id, name FROM competitors WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1`, [t]),
      db.query(`SELECT competitor_id, count(DISTINCT product_id)::int AS n
                  FROM competitor_products WHERE tenant_id = $1 GROUP BY competitor_id`, [t]),
      // Highest filed threat level per competitor, parsed from the intel text.
      db.query(`SELECT j.competitor_id,
                       max((regexp_match(ch.text, 'Competing-threat level:[^(]*\\((\\d)/5\\)'))[1]::int) AS lvl
                  FROM kb_chunks ch
                  JOIN kb_documents d ON d.id = ch.document_id
                  JOIN kb_document_competitors j ON j.document_id = d.id
                 WHERE d.tenant_id = $1 AND d.status = 'READY'
                   AND ch.text ~ 'Competing-threat level:'
                 GROUP BY j.competitor_id`, [t]),
      // Prospects named inside this competitor's intel docs (name >= 4 chars to
      // keep short names from false-matching prose).
      db.query(`SELECT j.competitor_id, count(DISTINCT co.id)::int AS n, array_agg(DISTINCT co.name) AS names
                  FROM kb_chunks ch
                  JOIN kb_documents d ON d.id = ch.document_id
                  JOIN kb_document_competitors j ON j.document_id = d.id
                  JOIN companies co ON co.tenant_id = d.tenant_id
                 WHERE d.tenant_id = $1 AND d.status = 'READY'
                   AND length(co.name) >= 4
                   AND position(lower(co.name) IN lower(ch.text)) > 0
                 GROUP BY j.competitor_id`, [t]),
      db.query(`SELECT subject_id AS competitor_id, sum(COALESCE(materiality, 3))::int AS w
                  FROM watch_findings
                 WHERE tenant_id = $1 AND scope = 'COMPETITOR'
                   AND created_at >= now() - interval '90 days'
                 GROUP BY subject_id`, [t]),
    ]);
    const prodN = prodTotal.rows[0].n || 0;
    const prospectN = (await db.query(`SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1`, [t])).rows[0].n || 0;
    const byId = (rows, k) => new Map(rows.map((r) => [r.competitor_id, r[k]]));
    const pinM = byId(pins.rows, 'n'), bcM = byId(bc.rows, 'lvl'), watchM = byId(watch.rows, 'w');
    const ovM = new Map(overlap.rows.map((r) => [r.competitor_id, r]));

    const threats = {};
    for (const c of comps.rows) {
      const factors = [];
      const lvl = bcM.get(c.id);
      if (lvl) factors.push({ k: 'battlecard', v: (lvl - 1) / 4, w: 0.4 });
      const ov = ovM.get(c.id);
      if (prospectN > 0 && ov) factors.push({ k: 'prospects', v: Math.min(1, ov.n / Math.max(3, prospectN * 0.25)), w: 0.3 });
      const pin = pinM.get(c.id);
      if (prodN > 0 && pin) factors.push({ k: 'products', v: Math.min(1, pin / prodN), w: 0.2 });
      const wsum = watchM.get(c.id);
      if (wsum) factors.push({ k: 'watch', v: Math.min(1, wsum / 15), w: 0.1 });
      const totW = factors.reduce((s, f) => s + f.w, 0);
      const score = totW ? factors.reduce((s, f) => s + f.v * f.w, 0) / totW : 0.15;
      threats[c.id] = {
        score: Math.round(score * 100) / 100,
        level: score >= 0.66 ? 'High' : score >= 0.33 ? 'Medium' : 'Low',
        factors: Object.fromEntries(factors.map((f) => [f.k, Math.round(f.v * 100) / 100])),
        overlapProspects: ov ? (ov.names || []).slice(0, 8) : [],
      };
    }
    res.json({ threats });
  } catch (err) { next(err); }
});

// ── Competitor battlecards ────────────────────────────────────────────────
// Per-competitor synthesised view of all the docs filed under them. See
// api/src/knowledge/assessment.js#extractBattlecard for the synthesis;
// these routes own persistence + merging with the rep's manual edits.

const assessment = require('./knowledge/assessment');
const web = require('./knowledge/web');
const knowledge = require('./knowledge/service');
const relevance = require('./knowledge/relevance');
const discovery = require('./knowledge/discovery');
const keypoints = require('./knowledge/keypoints');
const redis = require('./redis');
const companyBrief = require('./companyBrief');
const foundation = require('./foundation');
const gating = require('./gating');

// ── Company bootstrap (pull-from-website + confirm) ────────────────────────
// Powers the Company → Intel "welcome" flow after onboarding: scrape the
// tenant's own homepage, summarise it for them to CONFIRM, and — once they
// confirm — file the homepage as their first Basis intel doc. Suggested product
// lines from the brief are added individually by the client (POST /products).
const bootstrapKey = (tenantId) => `company:bootstrap:${tenantId}`;
const BOOTSTRAP_TTL_SEC = 600; // 10 min — long enough to confirm, then it's re-pulled

// POST /portfolio/company-bootstrap/pull — scrape tenant's website + brief it.
// Caches the scraped markdown so confirm can file it without re-scraping. Never
// hard-fails: an unreachable/unconfigured site returns { ok:false } so the UI
// degrades to manual entry.
router.post('/company-bootstrap/pull', async (req, res, next) => {
  try {
    const t = (await db.query(`SELECT name, domain FROM tenants WHERE id = $1`, [req.tenantId])).rows[0];
    if (!t) return res.status(404).json({ error: 'tenant not found' });
    if (!t.domain) return res.json({ ok: false, error: 'No company website on file — add intel manually below.' });

    const website = `https://${t.domain}`;
    const r = await companyBrief.scrapeAndBrief(website);
    if (!r.ok) return res.json({ ok: false, error: r.error });

    await redis.set(bootstrapKey(req.tenantId), JSON.stringify({
      markdown: r.markdown,
      sourceUrl: r.meta.sourceUrl,
      title: r.meta.title,
      publishedTime: r.meta.publishedTime,
    }), 'EX', BOOTSTRAP_TTL_SEC);

    const brief = r.brief || {};
    res.json({
      ok: true,
      headline: brief.headline || null,
      summary: { mission: brief.missionStatement || null, audience: brief.primaryAudience || null },
      suggestedProducts: (Array.isArray(brief.keyProducts) ? brief.keyProducts : [])
        .filter((n) => typeof n === 'string' && n.trim()).slice(0, 20)
        .map((name) => ({ name: name.trim(), description: null })),
      sourceUrl: r.meta.sourceUrl,
      scrapedTitle: r.meta.title,
    });
  } catch (err) { next(err); }
});

// POST /portfolio/company-bootstrap/confirm
// Body: { positioning?, objectives?, ingestHomepage?:bool }
// Files the cached homepage as a TENANT (Basis) doc and/or upserts the snapshot.
router.post('/company-bootstrap/confirm', async (req, res, next) => {
  try {
    const body = req.body || {};
    let ingested = false;

    if (body.ingestHomepage) {
      const raw = await redis.get(bootstrapKey(req.tenantId));
      if (raw) {
        const cached = JSON.parse(raw);
        const t = (await db.query(`SELECT name FROM tenants WHERE id = $1`, [req.tenantId])).rows[0] || {};
        await knowledge.ingest({
          tenantId: req.tenantId,
          file: { buffer: Buffer.from(cached.markdown, 'utf8'), mimetype: 'text/markdown', originalname: 'company-homepage.md' },
          category: 'PRODUCT_INTEL',
          title: `${t.name || 'Company'} — homepage`,
          streamType: 'WEB',
          scope: 'TENANT', // the customer's own company → Basis
          sourceUrl: cached.sourceUrl || null,
          effectiveDate: cached.publishedTime || null,
          metadata: { bootstrap: true, scrapedTitle: cached.title || null },
        });
        ingested = true;
        await redis.del(bootstrapKey(req.tenantId)); // one-shot: don't re-file on a second confirm
      }
    }

    const positioning = body.positioning !== undefined ? (String(body.positioning || '').trim() || null) : undefined;
    const objectives = body.objectives !== undefined ? (String(body.objectives || '').trim() || null) : undefined;
    // ICP ("who we sell to") — usually the scraped primaryAudience the client passes through; feeds discovery.
    const icp = body.idealCustomerProfile !== undefined ? (String(body.idealCustomerProfile || '').trim() || null) : undefined;
    if (positioning !== undefined || objectives !== undefined || icp !== undefined) {
      await db.query(
        `INSERT INTO tenant_profiles (tenant_id, positioning, objectives, ideal_customer_profile, updated_at)
              VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
              positioning = CASE WHEN $5 THEN EXCLUDED.positioning ELSE tenant_profiles.positioning END,
              objectives  = CASE WHEN $6 THEN EXCLUDED.objectives  ELSE tenant_profiles.objectives  END,
              ideal_customer_profile = CASE WHEN $7 THEN EXCLUDED.ideal_customer_profile ELSE tenant_profiles.ideal_customer_profile END,
              updated_at  = now()`,
        [req.tenantId, positioning ?? null, objectives ?? null, icp ?? null, positioning !== undefined, objectives !== undefined, icp !== undefined]
      );
    }

    res.json({ ok: true, ingested });
  } catch (err) { next(err); }
});

// Max web sources surfaced/ingested per "research the web" run on a competitor
// offering. Fixed for now; intended to become subscription-plan-gated (higher
// tiers get a wider sweep) — keep callers reading this single ceiling.
const OFFERING_RESEARCH_MAX = 5;
function offeringResearchLimit(/* tenant/plan */) { return OFFERING_RESEARCH_MAX; }

// A battlecard is scoped to a matchup: (competitor, product?, competitorProduct?)
// where a NULL on either side means "the whole side". The company-wide card
// (both NULL) lives in competitors.battlecard; every other combination lives in
// competitor_battlecards. These helpers hide that split so routes read/write one
// logical "stored battlecard" regardless of scope.
//   ?product=<our product id>   ?competitorProduct=<their offering id>
function readProductScope(req) {
  const p = (req.query.product || '').trim();
  return p || null;
}
function readCompetitorProductScope(req) {
  const p = (req.query.competitorProduct || '').trim();
  return p || null;
}

async function readBattlecardRow(tenantId, competitorId, productId, competitorProductId) {
  const cr = await db.query(
    `SELECT name FROM competitors WHERE tenant_id = $1 AND id = $2`,
    [tenantId, competitorId]
  );
  if (!cr.rows[0]) return { found: false };
  if (!productId && !competitorProductId) {
    const r = await db.query(
      `SELECT battlecard FROM competitors WHERE tenant_id = $1 AND id = $2`,
      [tenantId, competitorId]
    );
    return { found: true, name: cr.rows[0].name, stored: (r.rows[0] && r.rows[0].battlecard) || {} };
  }
  const br = await db.query(
    `SELECT battlecard FROM competitor_battlecards
      WHERE tenant_id = $1 AND competitor_id = $2
        AND product_id IS NOT DISTINCT FROM $3
        AND competitor_product_id IS NOT DISTINCT FROM $4`,
    [tenantId, competitorId, productId, competitorProductId]
  );
  return { found: true, name: cr.rows[0].name, stored: (br.rows[0] && br.rows[0].battlecard) || {} };
}

async function writeBattlecardRow(tenantId, competitorId, productId, competitorProductId, json) {
  const payload = JSON.stringify(json);
  if (!productId && !competitorProductId) {
    await db.query(
      `UPDATE competitors SET battlecard = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, competitorId, payload]
    );
    return;
  }
  await db.query(
    `INSERT INTO competitor_battlecards (tenant_id, competitor_id, product_id, competitor_product_id, battlecard)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT competitor_battlecards_scope
       DO UPDATE SET battlecard = EXCLUDED.battlecard`,
    [tenantId, competitorId, productId, competitorProductId, payload]
  );
}

// Append a dated snapshot to this matchup's history. Keyed by the full scope so
// it never touches another matchup's versions. generated_at mirrors the card's
// own lastRefreshedAt when present.
async function recordBattlecardHistory(tenantId, competitorId, productId, competitorProductId, json) {
  const r = await db.query(
    `INSERT INTO competitor_battlecard_history
            (tenant_id, competitor_id, product_id, competitor_product_id, battlecard, generated_at)
          VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
       RETURNING id, generated_at`,
    [tenantId, competitorId, productId, competitorProductId, JSON.stringify(json), json.lastRefreshedAt || null]
  );
  return r.rows[0];
}

// GET /portfolio/competitors/:id/battlecard[?product=<id>] — returns the
// stored battlecard for the (competitor, product?) scope, merged with manual
// edits. If no battlecard yet, returns { empty: true } so the UI can show a
// "Regenerate" prompt.
router.get('/competitors/:id/battlecard', async (req, res, next) => {
  try {
    const productId = readProductScope(req);
    const competitorProductId = readCompetitorProductScope(req);
    const row = await readBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId);
    if (!row.found) return res.status(404).json({ error: 'not found' });
    if (!row.stored.lastRefreshedAt) {
      return res.json({ competitorName: row.name, productId, competitorProductId, battlecard: null, empty: true });
    }
    res.json({ competitorName: row.name, productId, competitorProductId, battlecard: assessment.mergeBattlecard(row.stored) });
  } catch (err) { next(err); }
});

// GET /portfolio/competitors/:id/battlecards/summary — stored verdicts for every
// matchup that has a card, so the product-centric node list can show "we lead /
// trail X%" at a glance in ONE call (no synthesis, no per-node round-trips).
// Returns [{ productId, competitorProductId, weightedAdvantage, lastRefreshedAt }];
// the node list keys on the default our-side rows (productId === null).
router.get('/competitors/:id/battlecards/summary', async (req, res, next) => {
  try {
    const cw = await db.query(
      `SELECT battlecard FROM competitors WHERE tenant_id = $1 AND id = $2`,
      [req.tenantId, req.params.id]
    );
    if (!cw.rows.length) return res.status(404).json({ error: 'competitor not found' });
    const summary = [];
    const company = cw.rows[0].battlecard || {};
    if (company.lastRefreshedAt) {
      summary.push({ productId: null, competitorProductId: null, weightedAdvantage: Number(company.weightedAdvantage) || 0, lastRefreshedAt: company.lastRefreshedAt });
    }
    const scoped = await db.query(
      `SELECT product_id, competitor_product_id, battlecard
         FROM competitor_battlecards
        WHERE tenant_id = $1 AND competitor_id = $2`,
      [req.tenantId, req.params.id]
    );
    for (const r of scoped.rows) {
      const bc = r.battlecard || {};
      if (!bc.lastRefreshedAt) continue;
      summary.push({ productId: r.product_id, competitorProductId: r.competitor_product_id, weightedAdvantage: Number(bc.weightedAdvantage) || 0, lastRefreshedAt: bc.lastRefreshedAt });
    }
    res.json({ summary });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/battlecard/regenerate[?product=<id>] — runs
// the Gemini synthesis + persists. Keeps any existing manualEdits intact.
router.post('/competitors/:id/battlecard/regenerate', async (req, res, next) => {
  try {
    const productId = readProductScope(req);
    const competitorProductId = readCompetitorProductScope(req);
    const existing = await readBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId);
    if (!existing.found) return res.status(404).json({ error: 'not found' });
    const manualEdits = (existing.stored && existing.stored.manualEdits) || {};

    const fresh = await assessment.extractBattlecard(req.tenantId, req.params.id, productId, competitorProductId);
    const base = { ...fresh, manualEdits };
    // Snapshot this generation into history first, then point the live card at
    // that history row so the UI can flag which version is current.
    const hist = await recordBattlecardHistory(req.tenantId, req.params.id, productId, competitorProductId, base);
    const next = { ...base, historyId: hist.id };
    await writeBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId, next);
    res.json({ battlecard: assessment.mergeBattlecard(next) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /portfolio/competitors/:id/battlecard[?product=<id>] — store/update a
// manual edit for one section. Body: { section, value } or { section, revert: true }.
router.patch('/competitors/:id/battlecard', async (req, res, next) => {
  try {
    const productId = readProductScope(req);
    const competitorProductId = readCompetitorProductScope(req);
    const { section, value, revert } = req.body || {};
    const VALID_SECTIONS = new Set(['verdictHeadline', 'whereWeWin', 'whereWeLose', 'talkTrack', 'objections', 'migrationStory']);
    if (!VALID_SECTIONS.has(section)) {
      return res.status(400).json({ error: `invalid section. Valid: ${[...VALID_SECTIONS].join(', ')}` });
    }
    const existing = await readBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId);
    if (!existing.found) return res.status(404).json({ error: 'not found' });
    const stored = existing.stored || {};
    const manualEdits = { ...(stored.manualEdits || {}) };
    if (revert) {
      delete manualEdits[section];
    } else {
      manualEdits[section] = value;
    }
    const next = { ...stored, manualEdits };
    await writeBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId, next);
    res.json({ battlecard: assessment.mergeBattlecard(next) });
  } catch (err) { next(err); }
});

// GET /portfolio/competitors/:id/battlecard/history[?product=<id>] — dated list
// of past generations for this (competitor, product?) scope, newest first. Each
// entry carries the full merged battlecard so the UI can preview a version
// without another round-trip. `current` flags the version the live card points
// at (falls back to lastRefreshedAt for cards generated before history existed).
router.get('/competitors/:id/battlecard/history', async (req, res, next) => {
  try {
    const productId = readProductScope(req);
    const competitorProductId = readCompetitorProductScope(req);
    const cur = await readBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId);
    if (!cur.found) return res.status(404).json({ error: 'not found' });
    const currentHistoryId = cur.stored && cur.stored.historyId != null ? String(cur.stored.historyId) : null;
    const curRefreshed = cur.stored && cur.stored.lastRefreshedAt ? new Date(cur.stored.lastRefreshedAt).getTime() : null;
    const r = await db.query(
      `SELECT id, generated_at, battlecard
         FROM competitor_battlecard_history
        WHERE tenant_id = $1 AND competitor_id = $2
          AND product_id IS NOT DISTINCT FROM $3
          AND competitor_product_id IS NOT DISTINCT FROM $4
        ORDER BY generated_at DESC, id DESC
        LIMIT 50`,
      [req.tenantId, req.params.id, productId, competitorProductId]
    );
    const versions = r.rows.map((row) => {
      const bc = assessment.mergeBattlecard(row.battlecard) || {};
      const isCurrent = currentHistoryId
        ? String(row.id) === currentHistoryId
        : (curRefreshed != null && new Date(row.generated_at).getTime() === curRefreshed);
      return {
        id: String(row.id),
        generatedAt: row.generated_at,
        current: isCurrent,
        model: bc.model || null,
        weightedAdvantage: typeof bc.weightedAdvantage === 'number' ? bc.weightedAdvantage : null,
        verdictHeadline: bc.verdictHeadline || null,
        sourceDocCount: Array.isArray(bc.sourceDocIds) ? bc.sourceDocIds.length : 0,
        battlecard: bc,
      };
    });
    res.json({ productId, currentHistoryId, versions });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/battlecard/history/:histId/restore[?product=<id>]
// — make a past version the live card again. Snapshot is copied verbatim (incl.
// its manual edits) and the live card re-points at that history row.
router.post('/competitors/:id/battlecard/history/:histId/restore', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.histId)) return res.status(400).json({ error: 'invalid version id' });
    const productId = readProductScope(req);
    const competitorProductId = readCompetitorProductScope(req);
    const cur = await readBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId);
    if (!cur.found) return res.status(404).json({ error: 'not found' });
    const r = await db.query(
      `SELECT id, battlecard FROM competitor_battlecard_history
        WHERE tenant_id = $1 AND competitor_id = $2 AND id = $3
          AND product_id IS NOT DISTINCT FROM $4
          AND competitor_product_id IS NOT DISTINCT FROM $5`,
      [req.tenantId, req.params.id, req.params.histId, productId, competitorProductId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'version not found' });
    const next = { ...(r.rows[0].battlecard || {}), historyId: r.rows[0].id };
    await writeBattlecardRow(req.tenantId, req.params.id, productId, competitorProductId, next);
    res.json({ battlecard: assessment.mergeBattlecard(next) });
  } catch (err) { next(err); }
});

// ── Competitor's OWN products (offerings) ─────────────────────────────────
// The products the competitor sells. These form the "their side" axis of the
// battlecard matchup matrix, so a card can be scoped to our product vs theirs.
function slugifyOffering(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || null;
}

// GET /portfolio/competitors/:id/offerings — list this competitor's products.
router.get('/competitors/:id/offerings', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT o.id, o.name, o.description, o.created_at,
              EXISTS (SELECT 1 FROM competitor_battlecards b
                       WHERE b.competitor_id = o.competitor_id
                         AND b.competitor_product_id = o.id) AS has_battlecard
         FROM competitor_offerings o
        WHERE o.tenant_id = $1 AND o.competitor_id = $2
        ORDER BY lower(o.name)`,
      [req.tenantId, req.params.id]
    );
    // hasMainIntel gates all their-product work: the frontend hides the
    // add-product panel / per-offering intel tabs and the "Their product" intel
    // mode until the competitor has at least one main-company doc on file.
    const hasMainIntel = await knowledge.competitorHasMainIntel(req.tenantId, req.params.id);
    res.json({ offerings: r.rows, hasMainIntel });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/offerings { name, id?, description? }
router.post('/competitors/:id/offerings', async (req, res, next) => {
  try {
    const name = (req.body && req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = ((req.body && req.body.id || '').trim().toLowerCase()) || slugifyOffering(name);
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      return res.status(400).json({ error: 'invalid id slug (lowercase letters, numbers, - and _; max 64)' });
    }
    const description = (req.body && req.body.description || '').trim() || null;
    const comp = await db.query(`SELECT name FROM competitors WHERE tenant_id = $1 AND id = $2`, [req.tenantId, req.params.id]);
    if (!comp.rows[0]) return res.status(404).json({ error: 'competitor not found' });
    // Establish the competitor first: no breaking out their products until
    // there's main-company intel on file.
    if (!(await knowledge.competitorHasMainIntel(req.tenantId, req.params.id))) {
      return res.status(409).json({ error: knowledge.MAIN_INTEL_REQUIRED_MSG });
    }
    try {
      await db.query(
        `INSERT INTO competitor_offerings (tenant_id, competitor_id, id, name, description)
              VALUES ($1, $2, $3, $4, $5)`,
        [req.tenantId, req.params.id, id, name, description]
      );
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'an offering with that id already exists' });
      throw e;
    }
    // Non-blocking sanity check: warn (don't block) if the competitor probably
    // doesn't sell a product by this name — catches invented/foreign products.
    let warning = null;
    const verdict = await relevance.checkOfferingPlausibility({ competitorName: comp.rows[0].name, productName: name });
    if (verdict && verdict.plausible === false) {
      warning = verdict.reason || `${comp.rows[0].name} may not sell a product called "${name}".`;
    }
    res.status(201).json({ offering: { id, name, description }, warning });
  } catch (err) { next(err); }
});

// PATCH /portfolio/competitors/:id/offerings/:offeringId { name?, description? }
router.patch('/competitors/:id/offerings/:offeringId', async (req, res, next) => {
  try {
    const name = (req.body && req.body.name || '').trim();
    const description = (req.body && typeof req.body.description === 'string')
      ? (req.body.description.trim() || null) : undefined;
    const sets = []; const vals = [req.tenantId, req.params.id, req.params.offeringId]; let n = 4;
    if (name) { sets.push(`name = $${n++}`); vals.push(name); }
    if (description !== undefined) { sets.push(`description = $${n++}`); vals.push(description); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    const r = await db.query(
      `UPDATE competitor_offerings SET ${sets.join(', ')}
        WHERE tenant_id = $1 AND competitor_id = $2 AND id = $3`,
      vals
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /portfolio/competitors/:id/offerings/:offeringId — removes the offering
// and (via FK cascade) its live matchup cards. Version history is retained.
// Evidence filed under the product is PRESERVED: its competitorProductId tag is
// cleared so it folds back into the competitor's Company-wide intel (no orphans,
// no data loss). Returns movedDocs = how many were refiled.
router.delete('/competitors/:id/offerings/:offeringId', async (req, res, next) => {
  try {
    const exists = await db.query(
      `SELECT 1 FROM competitor_offerings WHERE tenant_id = $1 AND competitor_id = $2 AND id = $3`,
      [req.tenantId, req.params.id, req.params.offeringId]
    );
    if (!exists.rows[0]) return res.status(404).json({ error: 'not found' });
    let movedDocs = 0;
    await db.withTx(async (client) => {
      const upd = await client.query(
        `UPDATE kb_documents d
            SET metadata = d.metadata - 'competitorProductId', updated_at = now()
          WHERE d.tenant_id = $1
            AND d.metadata->>'competitorProductId' = $3
            AND EXISTS (SELECT 1 FROM kb_document_competitors j
                         WHERE j.document_id = d.id AND j.competitor_id = $2)`,
        [req.tenantId, req.params.id, req.params.offeringId]
      );
      movedDocs = upd.rowCount || 0;
      await client.query(
        `DELETE FROM competitor_offerings WHERE tenant_id = $1 AND competitor_id = $2 AND id = $3`,
        [req.tenantId, req.params.id, req.params.offeringId]
      );
    });
    res.json({ ok: true, movedDocs });
  } catch (err) { next(err); }
});

// Resolve (competitor name, offering name) for an offering, or null if missing.
async function resolveOffering(tenantId, competitorId, offeringId) {
  const r = await db.query(
    `SELECT c.name AS competitor_name, o.name AS offering_name
       FROM competitor_offerings o
       JOIN competitors c ON c.id = o.competitor_id AND c.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1 AND o.competitor_id = $2 AND o.id = $3`,
    [tenantId, competitorId, offeringId]
  );
  return r.rows[0] || null;
}

// POST /portfolio/competitors/:id/offerings/:offeringId/research — a wide web
// search by "<competitor> <offering>". Returns hits for the rep to PICK from;
// nothing is ingested here (preview step). Result count is plan-gated.
router.post('/competitors/:id/offerings/:offeringId/research', async (req, res, next) => {
  try {
    if (!web.isConfigured() && !web.isBraveConfigured()) {
      return res.status(503).json({ error: 'web search is not configured on this workspace' });
    }
    const o = await resolveOffering(req.tenantId, req.params.id, req.params.offeringId);
    if (!o) return res.status(404).json({ error: 'offering not found' });
    if (!(await knowledge.competitorHasMainIntel(req.tenantId, req.params.id))) {
      return res.status(409).json({ error: knowledge.MAIN_INTEL_REQUIRED_MSG });
    }
    const limit = offeringResearchLimit();
    const query = `${o.competitor_name} ${o.offering_name}`;
    const hits = await web.search(query, { limit });
    const seen = new Set();
    const results = [];
    for (const h of (hits || [])) {
      if (!h.url || seen.has(h.url)) continue;
      seen.add(h.url);
      results.push({ url: h.url, title: h.title || h.url, description: h.description || '' });
      if (results.length >= limit) break;
    }
    res.json({ query, limit, results });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/offerings/:offeringId/research/ingest
// { urls: [] } — scrape + file the chosen URLs as COMPETITOR intel tagged to
// this offering, so they feed the product-vs-product battlecard.
router.post('/competitors/:id/offerings/:offeringId/research/ingest', async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body && req.body.urls) ? req.body.urls : [];
    const urls = [...new Set(raw.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))]
      .slice(0, offeringResearchLimit());
    if (!urls.length) return res.status(400).json({ error: 'urls (array of http[s] URLs) required' });
    const o = await resolveOffering(req.tenantId, req.params.id, req.params.offeringId);
    if (!o) return res.status(404).json({ error: 'offering not found' });
    if (!(await knowledge.competitorHasMainIntel(req.tenantId, req.params.id))) {
      return res.status(409).json({ error: knowledge.MAIN_INTEL_REQUIRED_MSG });
    }
    const settled = await Promise.allSettled(urls.map((url) => web.syncUrl({
      tenantId: req.tenantId,
      url,
      category: 'BATTLECARDS',
      scope: 'COMPETITOR',
      competitorIds: [req.params.id],
      competitorProductId: req.params.offeringId,
    })));
    const ingested = settled.filter((s) => s.status === 'fulfilled').length;
    res.json({ ingested, failed: settled.length - ingested });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/research — company-wide web search by the
// competitor's name. The offering-agnostic twin of the offering research route,
// so the "Company-wide" node gets the same file/URL/web-search trio. No
// main-intel guard — this is a primary way to BOOTSTRAP that main intel.
router.post('/competitors/:id/research', async (req, res, next) => {
  try {
    if (!web.isConfigured() && !web.isBraveConfigured()) {
      return res.status(503).json({ error: 'web search is not configured on this workspace' });
    }
    const c = await db.query(`SELECT name FROM competitors WHERE tenant_id = $1 AND id = $2`, [req.tenantId, req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'competitor not found' });
    const limit = offeringResearchLimit();
    const query = c.rows[0].name;
    const hits = await web.search(query, { limit });
    const seen = new Set();
    const results = [];
    for (const h of (hits || [])) {
      if (!h.url || seen.has(h.url)) continue;
      seen.add(h.url);
      results.push({ url: h.url, title: h.title || h.url, description: h.description || '' });
      if (results.length >= limit) break;
    }
    res.json({ query, limit, results });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/research/ingest { urls: [] } — scrape + file
// the chosen URLs as COMPANY-WIDE competitor intel (no competitorProductId).
router.post('/competitors/:id/research/ingest', async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body && req.body.urls) ? req.body.urls : [];
    const urls = [...new Set(raw.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))]
      .slice(0, offeringResearchLimit());
    if (!urls.length) return res.status(400).json({ error: 'urls (array of http[s] URLs) required' });
    const c = await db.query(`SELECT 1 FROM competitors WHERE tenant_id = $1 AND id = $2`, [req.tenantId, req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'competitor not found' });
    const settled = await Promise.allSettled(urls.map((url) => web.syncUrl({
      tenantId: req.tenantId,
      url,
      category: 'BATTLECARDS',
      scope: 'COMPETITOR',
      competitorIds: [req.params.id],
    })));
    const ingested = settled.filter((s) => s.status === 'fulfilled').length;
    res.json({ ingested, failed: settled.length - ingested });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/discover-products — web-search the competitor's
// product lineup and map each to the most directly-competing one of OUR products.
// Read-only research (no ingest, no main-intel gate) — returns the comparison
// table; the rep turns relevant rows into matchups (offering creation IS gated).
router.post('/competitors/:id/discover-products', async (req, res, next) => {
  try {
    if (!web.isConfigured() && !web.isBraveConfigured()) {
      return res.status(503).json({ error: 'web search is not configured on this workspace' });
    }
    const c = await db.query(`SELECT name, description FROM competitors WHERE tenant_id = $1 AND id = $2`, [req.tenantId, req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'competitor not found' });
    const pr = await db.query(
      `SELECT id, name, description FROM products WHERE tenant_id = $1 ORDER BY lower(name)`,
      [req.tenantId]
    );
    const ourProducts = pr.rows;

    // The competitor's OWN domain — so discovery searches/scrapes their site and
    // only surfaces THEIR products. Prefer the source_url of their filed
    // company-wide intel (the homepage); fall back to a URL in the description.
    let competitorDomain = '';
    const dr = await db.query(
      `SELECT d.source_url FROM kb_documents d
         JOIN kb_document_competitors j ON j.document_id = d.id
        WHERE d.tenant_id = $1 AND j.competitor_id = $2 AND d.source_url IS NOT NULL
          AND COALESCE(d.metadata->>'competitorProductId','') = ''
        ORDER BY d.created_at DESC LIMIT 1`,
      [req.tenantId, req.params.id]
    );
    if (dr.rows[0] && dr.rows[0].source_url) competitorDomain = dr.rows[0].source_url;
    else {
      const m = String(c.rows[0].description || '').match(/https?:\/\/[^\s)]+/i);
      if (m) competitorDomain = m[0];
    }

    const result = await discovery.discoverCompetitorProducts({ competitorName: c.rows[0].name, competitorDomain, ourProducts });
    if (!result) return res.status(502).json({ error: 'discovery could not analyze this competitor right now — try again' });
    res.json({ products: result.products, ourProducts: ourProducts.map((p) => ({ id: p.id, name: p.name })) });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/discover — web-search for companies that compete
// with OUR company, optionally focused on a region. Read-only research (no
// ingest, no creation): returns candidates; the rep adds the relevant ones one
// by one via POST /portfolio/competitors. Existing competitors are flagged.
// Body: { region?: string }
router.post('/competitors/discover', gating.requireFeature('competitor_research'), gating.requireCapacity('competitor_research'), async (req, res, next) => {
  try {
    if (!web.isConfigured() && !web.isBraveConfigured()) {
      return res.status(503).json({ error: 'web search is not configured on this workspace' });
    }
    const broadRegion = String((req.body && req.body.region) || '').trim();
    const country = String((req.body && req.body.country) || '').trim();
    const city = String((req.body && req.body.city) || '').trim();
    // Competitors (rival vendors) are usually national/global — scope their search
    // to Country/Region, NOT the city; pass City as buyer-market CONTEXT instead.
    const region = country || broadRegion;
    const buyerMarket = [city, country].filter(Boolean).join(', ');
    const tenant = (await db.query(`SELECT name FROM tenants WHERE id = $1`, [req.tenantId])).rows[0];
    if (!tenant || !tenant.name) return res.status(422).json({ error: 'set your company name first (Company page) so we know who to find rivals for' });
    const prof = (await db.query(`SELECT positioning, objectives, ideal_customer_profile FROM tenant_profiles WHERE tenant_id = $1`, [req.tenantId])).rows[0] || {};
    const ourProducts = (await db.query(
      `SELECT id, name, description FROM products WHERE tenant_id = $1 ORDER BY lower(name)`,
      [req.tenantId]
    )).rows;

    // Our existing prospects → competitor analysis flags any competitor already
    // entrenched at one of them ("incumbent at account").
    const prospectRows = await db.query(`SELECT name FROM companies WHERE tenant_id = $1`, [req.tenantId]);
    // Optional scoped intelligence: a specific prospect (who competes with us
    // AT that account) or a specific product (who threatens it).
    let focusProspect = null, focusProduct = null;
    const prospectId = String((req.body && req.body.prospectId) || '').trim();
    const productId = String((req.body && req.body.productId) || '').trim();
    if (prospectId) {
      const r = (await db.query(`SELECT name, domain FROM companies WHERE id = $1 AND tenant_id = $2`, [prospectId, req.tenantId])).rows[0];
      if (!r) return res.status(404).json({ error: 'prospect not found' });
      focusProspect = { name: r.name, domain: r.domain || null };
    }
    if (productId) {
      const r = (await db.query(`SELECT id, name, description FROM products WHERE id = $1 AND tenant_id = $2`, [productId, req.tenantId])).rows[0];
      if (!r) return res.status(404).json({ error: 'product not found' });
      focusProduct = r;
    }
    const trackedNames = (await db.query(`SELECT name FROM competitors WHERE tenant_id = $1`, [req.tenantId])).rows.map((r) => r.name);
    const result = await discovery.discoverCompetitors({
      companyName: tenant.name,
      ourProducts,
      positioning: prof.positioning || '',
      objectives: prof.objectives || '',
      idealCustomerProfile: prof.ideal_customer_profile || '',
      region,
      buyerMarket,
      prospects: prospectRows.rows,
      excludeNames: trackedNames,
      focusProspect,
      focusProduct,
    });
    if (!result) {
      await gating.refundCapacity(req); // don't charge for a failed discovery
      return res.status(502).json({ error: 'discovery could not find competitors right now — try again' });
    }

    // Competitors we already track never come back as candidates — they're
    // split into `existing` (with watch state) so the UI offers update-intel
    // instead of a dead Add button.
    const tracked = (await db.query(
      `SELECT id, name, website, watch_enabled FROM competitors WHERE tenant_id = $1`, [req.tenantId]
    )).rows;
    const byName = new Map(tracked.map((r) => [r.name.toLowerCase(), r]));
    const byDomain = new Map(tracked.filter((r) => r.website).map((r) => [String(r.website).toLowerCase().replace(/^www\./, ''), r]));
    const competitors = [];
    const existingHit = new Map();
    for (const c of result.competitors) {
      const dom = String(c.website || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      const match = byName.get(c.name.toLowerCase()) || (dom && byDomain.get(dom));
      if (match) existingHit.set(match.id, { id: match.id, name: match.name, website: match.website, watchEnabled: !!match.watch_enabled });
      else competitors.push(c);
    }
    const dataHints = await foundation.dataHints(req.tenantId);
    res.json({ competitors, existing: [...existingHit.values()], region, dataHints });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/discover/add — add a discovered competitor AND
// file its discovery analysis as COMPANY-WIDE intel (so the product-breakout gate
// unlocks immediately). Body = a candidate from /competitors/discover:
//   { id, name, description, website, region, whyRelevant, theirStrength,
//     threatToProductNames[], threatLevel }
router.post('/competitors/discover/add', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    let id = String(b.id || '').trim().toLowerCase();
    if (!id) id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'competitor';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      return res.status(400).json({ error: 'id must be slug-shaped: [a-z0-9_-], 1-64 chars' });
    }

    // A short, human-readable description carries the at-a-glance read on the card.
    const descBits = [];
    if (b.description) descBits.push(String(b.description).trim());
    if (b.theirStrength) descBits.push(`Strength: ${String(b.theirStrength).trim()}.`);
    const threatNames = Array.isArray(b.threatToProductNames) ? b.threatToProductNames.filter(Boolean) : [];
    if (threatNames.length) descBits.push(`Threatens: ${threatNames.join(', ')}.`);
    if (b.whyRelevant) descBits.push(`Why relevant: ${String(b.whyRelevant).trim()}.`);
    if (b.region) descBits.push(`Region: ${String(b.region).trim()}.`);
    const description = descBits.join(' ').slice(0, 1000) || null;

    const website = String(b.website || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || null;
    const ct = {
      country: String(b.country || '').trim() || null, city: String(b.city || '').trim() || null,
      address: String(b.address || '').trim() || null, phone: String(b.phone || '').trim() || null,
      email: String(b.email || '').trim() || null,
    };

    // Create the competitor (idempotent on a same-tenant id collision).
    let competitor;
    try {
      competitor = (await db.query(
        `INSERT INTO competitors (id, tenant_id, name, description, website, country, city, address, phone, email)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [id, req.tenantId, name, description, website, ct.country, ct.city, ct.address, ct.phone, ct.email]
      )).rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err;
      const existing = await db.query(`SELECT * FROM competitors WHERE id = $1 AND tenant_id = $2`, [id, req.tenantId]);
      if (!existing.rows[0]) return res.status(409).json({ error: 'a competitor with this id already exists' });
      competitor = existing.rows[0]; // same-tenant re-add → reuse, then (re)file intel
    }

    // Synthesize the discovery analysis into a COMPANY-WIDE competitor intel doc.
    // This satisfies competitorHasMainIntel() → unlocks per-product intel/matchups.
    const THREAT = { 5: 'Critical', 4: 'High', 3: 'Medium', 2: 'Low', 1: 'Minimal' };
    const lvl = Math.max(1, Math.min(5, Math.round(Number(b.threatLevel) || 3)));
    const md = [
      `# ${name} — Company overview`,
      '',
      b.description ? String(b.description).trim() : '',
      '',
      b.website ? `- Website: ${String(b.website).trim()}` : '',
      b.region ? `- Region: ${String(b.region).trim()}` : '',
      b.theirStrength ? `- Primary strength: ${String(b.theirStrength).trim()}` : '',
      b.whyRelevant ? `- Why they compete with us: ${String(b.whyRelevant).trim()}` : '',
      `- Competing-threat level: ${THREAT[lvl]} (${lvl}/5)`,
      threatNames.length ? `- Directly threatens our products: ${threatNames.join(', ')}` : '',
      '',
      '_Filed automatically from competitor discovery — review and enrich with deeper intel._',
    ].filter((line) => line !== '').join('\n');

    let intelFiled = false;
    try {
      await knowledge.ingest({
        tenantId: req.tenantId,
        file: { buffer: Buffer.from(md, 'utf8'), mimetype: 'text/markdown', originalname: 'company-overview.md' },
        category: 'BATTLECARDS',
        scope: 'COMPETITOR',
        competitorIds: [id],
        title: `${name} — company overview`,
        streamType: 'WEB',
        sourceUrl: b.website ? `https://${String(b.website).trim().replace(/^https?:\/\//i, '')}` : null,
        metadata: { discovered: true },
      });
      intelFiled = await knowledge.competitorHasMainIntel(req.tenantId, id);
    } catch (err) {
      console.warn(`[portfolio] discover/add intel ingest failed for ${id}: ${err.message}`);
    }

    res.status(201).json({ competitor, intelFiled });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/manual-add { id, name, website } — manual add that,
// when a website is given, scrapes the competitor's homepage and files it as the
// first COMPANY-WIDE intel (unlocks per-product work). Best-effort scrape: the
// competitor is still created if the site can't be read.
router.post('/competitors/manual-add', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    let id = String(b.id || '').trim().toLowerCase();
    if (!id) id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'competitor';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      return res.status(400).json({ error: 'id must be slug-shaped: [a-z0-9_-], 1-64 chars' });
    }
    const websiteRaw = String(b.website || '').trim();
    const website = websiteRaw ? (/^https?:\/\//i.test(websiteRaw) ? websiteRaw : `https://${websiteRaw}`) : null;

    let competitor;
    try {
      competitor = (await db.query(
        `INSERT INTO competitors (id, tenant_id, name, description) VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, req.tenantId, name, website || null]
      )).rows[0];
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'a competitor with this id already exists' });
      throw err;
    }

    // Pull the homepage as company-wide intel (best-effort). Scraping the
    // competitor's OWN site → relevance passes → competitorHasMainIntel unlocks.
    let intelFiled = false;
    if (website && web.isConfigured()) {
      try {
        const data = await web.scrape(website);
        const markdown = String((data && data.markdown) || '').trim();
        if (markdown.length >= 50) {
          const meta = data.metadata || {};
          await knowledge.ingest({
            tenantId: req.tenantId,
            file: { buffer: Buffer.from(markdown, 'utf8'), mimetype: 'text/markdown', originalname: 'company-homepage.md' },
            category: 'BATTLECARDS', scope: 'COMPETITOR', competitorIds: [id],
            title: `${name} — homepage`, streamType: 'WEB',
            sourceUrl: meta.sourceURL || meta.url || website,
            effectiveDate: meta.publishedTime || meta.modifiedTime || null,
            metadata: { manualAdd: true },
          });
          intelFiled = await knowledge.competitorHasMainIntel(req.tenantId, id);
          // Give the competitor a real description from page metadata if we got one.
          const desc = String(meta.description || meta.title || '').trim();
          if (desc) {
            await db.query(`UPDATE competitors SET description = $1 WHERE id = $2 AND tenant_id = $3`, [desc.slice(0, 1000), id, req.tenantId]);
            competitor.description = desc.slice(0, 1000);
          }
        }
      } catch (err) {
        console.warn(`[portfolio] manual-add scrape/ingest failed for ${id}: ${err.message}`);
      }
    }

    res.status(201).json({ competitor, intelFiled, website });
  } catch (err) { next(err); }
});

// ── Competitor ⇄ our products ─────────────────────────────────────────────
// Which of OUR product lines compete with this competitor. Mirrors how
// product lines hang off the company; drives the per-product battlecard
// selector. Attaching an existing product, not creating one.

// GET /portfolio/competitors/:id/products — product lines pinned to this
// competitor (id, name, description), plus whether a product-scoped
// battlecard has been generated for each.
router.get('/competitors/:id/products', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.name, p.description,
              (cb.product_id IS NOT NULL) AS has_battlecard
         FROM competitor_products cp
         JOIN products p ON p.id = cp.product_id AND p.tenant_id = cp.tenant_id
         LEFT JOIN competitor_battlecards cb
                ON cb.competitor_id = cp.competitor_id AND cb.product_id = cp.product_id
        WHERE cp.tenant_id = $1 AND cp.competitor_id = $2
        ORDER BY lower(p.name)`,
      [req.tenantId, req.params.id]
    );
    res.json({ products: r.rows });
  } catch (err) { next(err); }
});

// POST /portfolio/competitors/:id/products { productId } — pin a product.
router.post('/competitors/:id/products', async (req, res, next) => {
  try {
    const productId = (req.body && req.body.productId || '').trim();
    if (!productId) return res.status(400).json({ error: 'productId required' });
    // Both the competitor and the product must belong to this tenant.
    const own = await db.query(
      `SELECT (SELECT 1 FROM competitors WHERE tenant_id = $1 AND id = $2) AS comp,
              (SELECT 1 FROM products    WHERE tenant_id = $1 AND id = $3) AS prod`,
      [req.tenantId, req.params.id, productId]
    );
    if (!own.rows[0].comp) return res.status(404).json({ error: 'competitor not found' });
    if (!own.rows[0].prod) return res.status(404).json({ error: 'product not found' });
    await db.query(
      `INSERT INTO competitor_products (tenant_id, competitor_id, product_id)
            VALUES ($1, $2, $3)
       ON CONFLICT (competitor_id, product_id) DO NOTHING`,
      [req.tenantId, req.params.id, productId]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /portfolio/competitors/:id/products/:productId — unpin a product.
// Also drops the product-scoped battlecard (it no longer has a home).
router.delete('/competitors/:id/products/:productId', async (req, res, next) => {
  try {
    const r = await db.query(
      `DELETE FROM competitor_products
        WHERE tenant_id = $1 AND competitor_id = $2 AND product_id = $3`,
      [req.tenantId, req.params.id, req.params.productId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    await db.query(
      `DELETE FROM competitor_battlecards
        WHERE tenant_id = $1 AND competitor_id = $2 AND product_id = $3`,
      [req.tenantId, req.params.id, req.params.productId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { router };
