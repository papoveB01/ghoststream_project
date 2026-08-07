// The registry of every structured-output schema the product sends, and where
// it comes from. Read by two things:
//
//   - test/live/smoke.js, which sends each one to a live provider (costs money,
//     never runs in `npm test`)
//   - test/liveSchemaCoverage.test.js, which is free, runs in CI, and fails if
//     src/ grows a `responseSchema:` this file does not list
//
// `schema` is a THUNK on purpose. The coverage guard only reads the metadata,
// so it never pulls express routers, db pools or the Redis client into a CI
// process that has no use for them; the live runner calls the thunk and gets
// the actual object production sends. A copy of the schema here instead of a
// require would pass the check while the real one 400s in production — which is
// the entire failure mode being guarded against.
//
// `expr` must be the call site's source text verbatim. That is what pairs a
// registry row to a line in src/, and what makes a renamed or newly-added
// schema fail the guard instead of slipping past it.
//
// `variantOf` marks a row that exercises a DIFFERENT SHAPE of an
// already-registered call site (a builder called with empty tenant data, say)
// rather than a call site of its own. The coverage guard counts non-variant
// rows against source occurrences one-for-one, so a variant cannot be mistaken
// for coverage of a second, genuinely new call site.

'use strict';

const path = require('node:path');
const SRC = path.join(__dirname, '..', '..', 'src');
const load = (rel) => require(path.join(SRC, rel));

// Fixtures for the four schemas that are BUILT per request rather than fixed.
// Their enums come from tenant data, so the shape the API validates depends on
// the caller — and a tenant with no products on file produces a MATERIALLY
// DIFFERENT schema, not just a smaller one: discovery.js's `closedSet` drops
// the `enum` entirely when the list is empty, which changes the node from
// `anyOf:[{enum,type},{type:'null'}]` to `type:['string','null']`. That is a
// different validator path, so both are registered (the `.newTenant` rows
// below) rather than assumed equivalent.
//
// `companies.productFit` needs no empty variant: companies.js returns early
// when the tenant has no products, so the empty shape is unreachable there.
const OUR_IDS = new Set(['prd_alpha', 'prd_beta']);
const INCUMBENTS = ['Acme Corp', 'Globex'];
const PEOPLE = [{ id: 'per_1' }, { id: 'per_2' }];
const PRODUCTS = [{ id: 'prd_alpha' }, { id: 'prd_beta' }];
const NO_IDS = new Set();

const ENTRIES = [
  // ── analysis ──────────────────────────────────────────────────────────────
  { site: 'analysis.entities',  cluster: 'analysis', task: 'callEntities', file: 'analysis.js', expr: 'ENTITIES_SCHEMA',
    schema: () => load('analysis.js').ENTITIES_SCHEMA },
  { site: 'analysis.moments',   cluster: 'analysis', task: 'callAnalysis', file: 'analysis.js', expr: 'MOMENTS_SCHEMA',
    schema: () => load('analysis.js').MOMENTS_SCHEMA },
  { site: 'analysis.followups', cluster: 'analysis', task: 'content',      file: 'analysis.js', expr: 'FOLLOWUP_SCHEMA',
    schema: () => load('analysis.js').FOLLOWUP_SCHEMA },

  // ── proposals ─────────────────────────────────────────────────────────────
  { site: 'proposals.synthesize', cluster: 'proposals', task: 'proposal', file: 'proposals.js', expr: 'PROPOSAL_SCHEMA',
    schema: () => load('proposals.js').PROPOSAL_SCHEMA },

  // ── watch ─────────────────────────────────────────────────────────────────
  { site: 'watch.extract',       cluster: 'watch', task: 'marketWatch', file: 'watch.js', expr: 'DEV_SCHEMA',
    schema: () => load('watch.js').DEV_SCHEMA },
  { site: 'watch.trend',         cluster: 'watch', task: 'marketWatch', file: 'watch.js', expr: 'TREND_SCHEMA',
    schema: () => load('watch.js').TREND_SCHEMA },
  { site: 'watch.trendDiscover', cluster: 'watch', task: 'marketWatch', file: 'watch.js', expr: 'TRENDS_DISCOVERED_SCHEMA',
    schema: () => load('watch.js').TRENDS_DISCOVERED_SCHEMA },

  // ── assessment ────────────────────────────────────────────────────────────
  { site: 'kb.assessment', cluster: 'assessment', task: 'assessment', file: 'knowledge/assessment.js', expr: 'ASSESSMENT_SCHEMA',
    schema: () => load('knowledge/assessment.js').ASSESSMENT_SCHEMA },
  // `task` is what resolveFor() sends this schema to, so it must track the
  // call site: knowledge/assessment.js's battlecard synthesis resolves
  // `battlecard`, which is FLASH on Claude while `assessment` is LITE. Keyed to
  // `assessment` this row would have validated BATTLECARD_SCHEMA against Haiku
  // and reported green for a schema production sends to Sonnet.
  //
  // The CLUSTER deliberately stays `assessment`: ADR-0006 §9 item 5 groups
  // keypoints + assessment as one cutover, and its runbook is "run the check
  // for a group before flipping it (--cluster=)". A `battlecard` cluster would
  // quietly drop this schema out of `--cluster=assessment`, which is the one
  // command that group is told to run.
  { site: 'kb.battlecard', cluster: 'assessment', task: 'battlecard', file: 'knowledge/assessment.js', expr: 'BATTLECARD_SCHEMA',
    schema: () => load('knowledge/assessment.js').BATTLECARD_SCHEMA },

  // ── discovery ─────────────────────────────────────────────────────────────
  { site: 'discovery.queries',           cluster: 'discovery', task: 'discovery', file: 'knowledge/discovery.js', expr: 'QUERIES_SCHEMA',
    schema: () => load('knowledge/discovery.js').QUERIES_SCHEMA },
  { site: 'discovery.competitorProducts', cluster: 'discovery', task: 'discovery', file: 'knowledge/discovery.js', expr: 'buildCompetitorProductsSchema(ourIds)',
    schema: () => load('knowledge/discovery.js').buildCompetitorProductsSchema(OUR_IDS) },
  { site: 'discovery.competitors',       cluster: 'discovery', task: 'discovery', file: 'knowledge/discovery.js', expr: 'buildCompetitorsSchema(ourIds, incumbentNames)',
    schema: () => load('knowledge/discovery.js').buildCompetitorsSchema(OUR_IDS, INCUMBENTS) },
  { site: 'discovery.prospects',         cluster: 'discovery', task: 'discovery', file: 'knowledge/discovery.js', expr: 'buildProspectsSchema(ourIds)',
    schema: () => load('knowledge/discovery.js').buildProspectsSchema(OUR_IDS) },
  // The same three builders as a tenant with nothing on file yet — i.e. every
  // tenant's first discovery run, which is also the first request that would
  // hit a provider after a flip.
  { site: 'discovery.competitorProducts.newTenant', variantOf: 'discovery.competitorProducts', cluster: 'discovery', task: 'discovery', file: 'knowledge/discovery.js', expr: 'buildCompetitorProductsSchema(ourIds)',
    schema: () => load('knowledge/discovery.js').buildCompetitorProductsSchema(NO_IDS) },
  { site: 'discovery.competitors.newTenant', variantOf: 'discovery.competitors', cluster: 'discovery', task: 'discovery', file: 'knowledge/discovery.js', expr: 'buildCompetitorsSchema(ourIds, incumbentNames)',
    schema: () => load('knowledge/discovery.js').buildCompetitorsSchema(NO_IDS, []) },
  { site: 'discovery.prospects.newTenant', variantOf: 'discovery.prospects', cluster: 'discovery', task: 'discovery', file: 'knowledge/discovery.js', expr: 'buildProspectsSchema(ourIds)',
    schema: () => load('knowledge/discovery.js').buildProspectsSchema(NO_IDS) },

  // ── relevance (fails OPEN — see the export comment in relevance.js) ────────
  { site: 'kb.relevanceDoc',      cluster: 'relevance', task: 'relevance', file: 'knowledge/relevance.js', expr: 'DOC_SCHEMA',
    schema: () => load('knowledge/relevance.js').DOC_SCHEMA },
  { site: 'kb.relevanceOffering', cluster: 'relevance', task: 'relevance', file: 'knowledge/relevance.js', expr: 'OFFERING_SCHEMA',
    schema: () => load('knowledge/relevance.js').OFFERING_SCHEMA },

  // ── keypoints ─────────────────────────────────────────────────────────────
  { site: 'kb.keypoints',       cluster: 'keypoints', task: 'keypoints', file: 'knowledge/keypoints.js', expr: 'KEYPOINTS_SCHEMA',
    schema: () => load('knowledge/keypoints.js').KEYPOINTS_SCHEMA },
  { site: 'kb.companyAnalysis', cluster: 'keypoints', task: 'keypoints', file: 'knowledge/keypoints.js', expr: 'COMPANY_ANALYSIS_SCHEMA',
    schema: () => load('knowledge/keypoints.js').COMPANY_ANALYSIS_SCHEMA },
  { site: 'kb.productAnalysis', cluster: 'keypoints', task: 'keypoints', file: 'knowledge/keypoints.js', expr: 'PRODUCT_ANALYSIS_SCHEMA',
    schema: () => load('knowledge/keypoints.js').PRODUCT_ANALYSIS_SCHEMA },

  // ── preview / compare ─────────────────────────────────────────────────────
  { site: 'kb.preview', cluster: 'preview', task: 'preview', file: 'knowledge/preview.js', expr: 'SUMMARY_SCHEMA',
    schema: () => load('knowledge/preview.js').SUMMARY_SCHEMA },
  { site: 'kb.compare', cluster: 'preview', task: 'compare', file: 'knowledge/preview.js', expr: 'COMPARISON_SCHEMA',
    schema: () => load('knowledge/preview.js').COMPARISON_SCHEMA },

  // ── research ──────────────────────────────────────────────────────────────
  { site: 'research.analyze', cluster: 'research', task: 'research', file: 'knowledge/research.js', expr: 'ANALYSIS_SCHEMA',
    schema: () => load('knowledge/research.js').ANALYSIS_SCHEMA },

  // ── foundation ────────────────────────────────────────────────────────────
  { site: 'foundation.synthesize',  cluster: 'foundation', task: 'content',      file: 'enrichment.js',   expr: 'FOUNDATION_SCHEMA',
    schema: () => load('enrichment.js').FOUNDATION_SCHEMA },
  { site: 'foundation.companyBrief', cluster: 'foundation', task: 'companyBrief', file: 'companyBrief.js', expr: 'BRIEF_SCHEMA',
    schema: () => load('companyBrief.js').BRIEF_SCHEMA },

  // ── arena ─────────────────────────────────────────────────────────────────
  { site: 'arena.score', cluster: 'arena', task: 'personas', file: 'arenaHistory.js', expr: 'SCORECARD_SCHEMA',
    schema: () => load('arenaHistory.js').SCORECARD_SCHEMA },

  // ── contacts / companies ──────────────────────────────────────────────────
  { site: 'companies.productFit', cluster: 'contacts', task: 'content', file: 'companies.js', expr: 'PRODUCT_FIT_SCHEMA',
    schema: () => load('companies.js').buildProductFitSchema(PEOPLE, PRODUCTS) },
  { site: 'contacts.draftEmail',  cluster: 'contacts', task: 'content', file: 'contacts.js',  expr: 'DRAFT_EMAIL_SCHEMA',
    schema: () => load('contacts.js').DRAFT_EMAIL_SCHEMA },
];

const CLUSTERS = [...new Set(ENTRIES.map((e) => e.cluster))];

module.exports = { ENTRIES, CLUSTERS };
