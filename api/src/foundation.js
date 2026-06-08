// Foundation Coach — scores how complete a tenant's data foundation is and turns
// gaps into concrete, deep-linked suggestions. Sparse foundations (empty ICP,
// product names without descriptions) produce generic discovery results, so this
// both surfaces the gaps (a health card) and powers inline nudges on discovery
// responses (dataHints) + a one-click multi-source enrichment.

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const enrichment = require('./enrichment');

const MIN = { icp: 120, positioning: 80, objectives: 40 }; // "substantive" thresholds (chars)

function lvl(good, thin) { return good ? 'good' : (thin ? 'thin' : 'missing'); }
const FACTOR = { good: 1, thin: 0.5, missing: 0 };

// Gather the raw counts/lengths once.
async function snapshot(tenantId) {
  const prof = (await db.query(
    `SELECT positioning, objectives, ideal_customer_profile, enriched_at FROM tenant_profiles WHERE tenant_id = $1`, [tenantId]
  )).rows[0] || {};
  const prod = (await db.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE description IS NOT NULL AND length(trim(description)) > 0)::int AS with_desc
       FROM products WHERE tenant_id = $1`, [tenantId]
  )).rows[0];
  const pers = (await db.query(`SELECT count(*)::int AS n FROM personas WHERE tenant_id = $1`, [tenantId])).rows[0];
  const comp = (await db.query(`SELECT count(*)::int AS n FROM competitors WHERE tenant_id = $1`, [tenantId])).rows[0];
  const intel = (await db.query(
    `SELECT count(*)::int AS n FROM kb_documents WHERE tenant_id = $1 AND scope = 'TENANT' AND status = 'READY'`, [tenantId]
  )).rows[0];
  const len = (s) => (s ? String(s).trim().length : 0);
  return {
    icpLen: len(prof.ideal_customer_profile),
    posLen: len(prof.positioning),
    objLen: len(prof.objectives),
    products: prod.n, productsWithDesc: prod.with_desc,
    personas: pers.n, competitors: comp.n, intelDocs: intel.n,
    enrichedAt: prof.enriched_at || null,
  };
}

// Build the weighted dimension list (weights sum to 100).
function dimensions(s) {
  const productDescStatus = s.products === 0 ? 'missing'
    : (s.productsWithDesc >= s.products ? 'good' : (s.productsWithDesc > 0 ? 'thin' : 'missing'));
  return [
    { key: 'icp', label: 'Ideal Customer Profile', weight: 25, status: lvl(s.icpLen >= MIN.icp, s.icpLen > 0),
      value: s.icpLen, canAutoFill: true, deepLink: '#company?tab=intel',
      suggestion: 'Describe who you sell to (industry, size, region, buyer roles). This is the single biggest driver of discovery quality.' },
    { key: 'positioning', label: 'Company positioning', weight: 15, status: lvl(s.posLen >= MIN.positioning, s.posLen > 0),
      value: s.posLen, canAutoFill: true, deepLink: '#company?tab=intel',
      suggestion: 'A few sentences on what you do, your market and your differentiator.' },
    { key: 'productDescriptions', label: 'Product descriptions', weight: 20, status: productDescStatus,
      value: `${s.productsWithDesc}/${s.products}`, canAutoFill: true, deepLink: '#company?tab=products',
      suggestion: 'Add a one-line description to each product so discovery searches the NEED, not just your brand name.' },
    { key: 'objectives', label: 'Sales objectives', weight: 10, status: lvl(s.objLen >= MIN.objectives, s.objLen > 0),
      value: s.objLen, canAutoFill: true, deepLink: '#company?tab=intel',
      suggestion: 'Your go-to-market priorities — helps tailor recommendations.' },
    { key: 'products', label: 'Products on file', weight: 10, status: lvl(s.products >= 2, s.products >= 1),
      value: s.products, canAutoFill: true, deepLink: '#company?tab=products',
      suggestion: 'List your product lines so competitor/prospect matching has something to anchor on.' },
    { key: 'personas', label: 'Buyer personas', weight: 10, status: lvl(s.personas >= 2, s.personas >= 1),
      value: s.personas, canAutoFill: true, deepLink: '#company?tab=personas',
      suggestion: 'The roles that buy from you — sharpens prospect targeting.' },
    { key: 'competitors', label: 'Competitors tracked', weight: 5, status: lvl(s.competitors >= 3, s.competitors >= 1),
      value: s.competitors, canAutoFill: false, deepLink: '#competitors',
      suggestion: 'Run a competitor discovery and add the relevant rivals.' },
    { key: 'intelDocs', label: 'Company intel filed', weight: 5, status: lvl(s.intelDocs >= 3, s.intelDocs >= 1),
      value: s.intelDocs, canAutoFill: false, deepLink: '#company?tab=intel',
      suggestion: 'File a few company docs (decks, one-pagers) so the AI grounds on your real material.' },
  ];
}

async function computeHealth(tenantId) {
  const s = await snapshot(tenantId);
  const dims = dimensions(s);
  const score = Math.round(dims.reduce((acc, d) => acc + d.weight * FACTOR[d.status], 0));
  const gaps = dims.filter((d) => d.status !== 'good')
    .sort((a, b) => (FACTOR[a.status] - FACTOR[b.status]) || (b.weight - a.weight));
  const band = score >= 80 ? 'strong' : score >= 50 ? 'fair' : 'sparse';
  return { score, band, enrichedAt: s.enrichedAt, dimensions: dims, topGaps: gaps.slice(0, 4) };
}

// Lightweight hints for annotating discovery/competitor responses so the results
// panel can nudge inline (no extra round-trip). Returns null when data is fine.
async function dataHints(tenantId) {
  const s = await snapshot(tenantId);
  const reasons = [];
  if (s.icpLen === 0) reasons.push('your Ideal Customer Profile is empty');
  if (s.products > 0 && s.productsWithDesc < s.products) reasons.push('most products have no description');
  if (s.posLen === 0) reasons.push('your positioning is empty');
  if (!reasons.length) return null;
  return {
    thin: true,
    reasons,
    message: `Results may be limited because ${reasons.join(' and ')}. Enriching your company foundation gives sharper, more localized matches.`,
    canAutoFill: true,
  };
}

// ─────────────────────────────────────────────────────────────────── router
const router = express.Router();
router.use(express.json());

// GET /foundation/health → score + dimensions + prioritized gaps.
router.get('/health', async (req, res, next) => {
  try { res.json(await computeHealth(req.tenantId)); }
  catch (err) { next(err); }
});

// POST /foundation/enrich { force? } → multi-source pull + auto-apply. Manager+.
router.post('/enrich', auth.requireRole('manager'), async (req, res, next) => {
  try {
    const force = !!(req.body && req.body.force);
    const r = await enrichment.enrichCompany(req.tenantId, { force });
    const health = await computeHealth(req.tenantId);
    res.json({ ...r, health });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = { router, computeHealth, dataHints };
