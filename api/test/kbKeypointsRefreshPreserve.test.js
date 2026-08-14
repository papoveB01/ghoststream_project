// Regression tests for the 2026-08-14 data loss in
// knowledge/service.js#regenerateKeyPoints.
//
// THE DEFECT. Four fields on a document's metadata — keyPoints, productAnalysis,
// companyAnalysis and assessment — are each refreshed by their own model call.
// Every one of those extractors caught its own failure and returned the SAME
// value it returns for a document that legitimately has nothing to extract
// (`{ points: [] }` / `null`), and the caller did `if (x) md.f = x; else delete
// md.f`. So one transient 503, rate limit, truncation or parse error during a
// refresh PERMANENTLY DESTROYED a good stored analysis while the route answered
// 200 with the document. Measured end to end against the live API: a 4,297-char
// stored companyAnalysis deleted behind `{ ok: true }` (ADR-0006 §9 item 5). It
// was live on Gemini; Claude's truncation would only have made it frequent.
//
// WHAT THESE TESTS PIN, and why each one is here:
//
//   1. one per field — a failing call must leave the STORED value alone.
//   2. legitimate absence must STILL CLEAR. Without this the next reader
//      "simplifies" the delete back in, or replaces it with an unconditional
//      preserve, and a doc re-tagged out of its old scope keeps a stale key
//      forever. The preserve and the clear are two different behaviours and both
//      have to be held down.
//   3. the scope/category-driven clears are not model results and must fire even
//      when the call for that branch failed.
//   4. partial failure is the NORMAL case — keyPoints and assessment are
//      separate calls on the same request — so one failure must neither abort
//      the request nor discard the field that succeeded.
//
// HOW. The real service.js → keypoints.js/assessment.js → aiCall chain runs;
// only `aiCall.generateStructured` is swapped, which is the same seam the live
// confidence pass drove. A version of this file that stubbed the extractors
// would pass against extractors that had gone back to swallowing.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

function stub(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(SRC, relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, children: [], paths: [], exports: exportsObj };
}

// ── module stubs, installed BEFORE service.js is required ───────────────────
//
// Requiring service.js pulls parsers → ocr → gemini → redis, whose ioredis
// client connects eagerly and retries forever with no Redis reachable — the test
// process would hang rather than fail. Nothing below is exercised by
// regenerateKeyPoints; they are here to make the require graph loadable offline.
stub('redis.js', { on: () => {}, get: async () => null, set: async () => 'OK', quit: async () => {}, disconnect: () => {} });
stub('knowledge/r2.js', {
  isConfigured: () => false, buildKey: () => '', putObject: async () => {},
  deleteObject: async () => {}, presignGet: async () => null,
});
stub('knowledge/embeddings.js', {
  embedAll: async () => { throw new Error('embeddings must not be reached by a keypoints refresh'); },
  embedQuery: async () => { throw new Error('not used'); }, MODEL: 'test-embed', DIMENSIONS: 768,
});
stub('knowledge/globalCache.js', {
  rebuildGlobalCache: async () => {}, getGlobalText: async () => '', getRow: async () => null,
  CACHE_NAME: 'kb:global', GLOBAL_CATEGORIES: ['ORG_INTELLIGENCE', 'BATTLECARDS'],
});
stub('knowledge/relevance.js', { checkDocRelevance: async () => null, shouldQuarantine: () => false });
stub('knowledge/web.js', { isConfigured: () => false, isBraveConfigured: () => false });
stub('knowledge/social.js', { isConfigured: () => false });
stub('users.js', { FOUNDERS_TENANT_ID: '00000000-0000-0000-0000-000000000001' });

// ── Postgres ────────────────────────────────────────────────────────────────
//
// One mutable document row. `persisted` is what the UPDATE actually wrote, which
// is the only thing that matters here: asserting on the returned document alone
// would pass against a function that returned the right object and stored the
// wrong one.
const TENANT = 'tenant-1';
const DOC_ID = 'doc-1';
let docRow = null;
let persisted = null;

stub('db.js', {
  query: async (sql, params) => {
    const s = String(sql);
    if (s.startsWith('UPDATE kb_documents SET metadata')) {
      persisted = JSON.parse(params[0]);
      docRow = { ...docRow, metadata: persisted };
      return { rows: [] };
    }
    if (s.includes('FROM kb_chunks')) return { rows: [{ body: docRow.body }] };
    if (s.includes('FROM kb_documents d')) return { rows: [docRow] };
    if (s.includes('FROM competitors')) return { rows: [{ name: 'Acme' }] };
    // products (product-analysis prompt header) and every tenantContextText
    // query: empty is fine, they only shape prompt context.
    return { rows: [] };
  },
  withTx: async () => { throw new Error('withTx must not be reached by a keypoints refresh'); },
});

const aiCall = require(path.join(SRC, 'aiCall.js'));
const service = require(path.join(SRC, 'knowledge', 'service.js'));

// ── fixtures ────────────────────────────────────────────────────────────────

// Comfortably over every extractor's floor (80 chars for keyPoints/assessment,
// 200 for the two analyses) so nothing short-circuits before the model call.
const BODY = 'DealScope sells competitive sales intelligence to revenue teams. '.repeat(20);

const STORED_KEYPOINTS = ['they undercut us on price', 'no SOC 2 report'];
const STORED_COMPANY = { executiveSummary: 'We sell sales intelligence.', services: [], strengths: [] };
const STORED_PRODUCT = { executiveSummary: 'Our gateway does X.', capabilities: [] };
const STORED_ASSESSMENT = { summary: 'we lead', axes: [], topImprovements: [], weightedAdvantage: 12 };

function seed({ scope, category, metadata, productIds = [], competitorIds = [] }) {
  persisted = null;
  docRow = {
    id: DOC_ID, tenant_id: TENANT, scope, category, title: 'Fixture doc',
    metadata, product_ids: productIds, competitor_ids: competitorIds,
    body: BODY,
  };
}

// Drive the seam. `impl` receives the call args, so a test can fail one call
// site and answer another in the same request — which is what makes the
// partial-failure case expressible at all.
async function withSeam(impl, fn) {
  const real = aiCall.generateStructured;
  const calls = [];
  aiCall.generateStructured = async (args) => { calls.push(args); return impl(args); };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.map(String).join(' '));
  try { return await fn(calls, warnings); }
  finally { aiCall.generateStructured = real; console.warn = realWarn; }
}

// A provider failure of the kind that caused the loss. Stamped `anthropic` with
// no `status`, which aiRetry classifies as non-transient, so assessment's retry
// wrapper spends exactly one attempt and the test stays fast.
const boom = () => { const e = new Error('overloaded_error'); e.provider = 'anthropic'; throw e; };

const answer = (parsed) => async () => ({
  parsed, text: JSON.stringify(parsed), usage: null, model: 'claude-sonnet-5', provider: 'anthropic',
});

// ── 1. a failed call preserves the stored value — one test per field ─────────

test('keyPoints: a failed extraction keeps the stored points instead of deleting them', async () => {
  seed({
    scope: 'COMPETITOR', category: 'ORG_INTELLIGENCE',
    metadata: { keyPoints: STORED_KEYPOINTS, keyPointsKind: 'competitive' },
  });
  const out = await withSeam(boom, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.deepStrictEqual(persisted.keyPoints, STORED_KEYPOINTS,
    'the stored key points were destroyed by a failed model call');
  assert.strictEqual(persisted.keyPointsKind, 'competitive',
    'keyPointsKind is deleted alongside keyPoints — preserving one without the other leaves a torn record');
  assert.deepStrictEqual(out.refreshFailures.map((f) => f.field), ['keyPoints', 'assessment'],
    'both call sites on a COMPETITOR doc failed and both must be reported');
  assert.strictEqual(out.refreshFailures[0].provider, 'anthropic',
    'the failure names the provider that produced it, not a default');
  // The shape is pinned exactly, not just checked for what it must contain: the
  // failure object is rendered in a browser, and `err.message` is the upstream
  // SDK string — provider JSON with quota metric and project identifiers on a
  // 429, or a fragment of the model's own answer on a parse failure. A field
  // added here leaks to the rep by default, so adding one has to be deliberate
  // enough to edit this line.
  for (const f of out.refreshFailures) {
    assert.deepStrictEqual(Object.keys(f).sort(), ['field', 'provider'],
      `refreshFailures entries carry exactly { field, provider }; got ${JSON.stringify(f)} — ` +
      'the provider\'s raw error text belongs in the log, not in a browser-visible body');
  }
});

test('companyAnalysis: a failed extraction keeps the stored analysis instead of deleting it', async () => {
  // This is the exact field, scope and category of the measured live loss.
  seed({ scope: 'TENANT', category: 'ORG_INTELLIGENCE', metadata: { companyAnalysis: STORED_COMPANY } });
  const out = await withSeam(boom, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.deepStrictEqual(persisted.companyAnalysis, STORED_COMPANY,
    'the stored company analysis was destroyed by a failed model call — this is the shipped defect');
  assert.ok(out.refreshFailures.some((f) => f.field === 'companyAnalysis'));
});

test('productAnalysis: a failed extraction keeps the stored analysis instead of deleting it', async () => {
  seed({
    scope: 'TENANT', category: 'PRODUCT_INTEL', productIds: ['prod-1'],
    metadata: { productAnalysis: STORED_PRODUCT },
  });
  const out = await withSeam(boom, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.deepStrictEqual(persisted.productAnalysis, STORED_PRODUCT,
    'the stored product analysis was destroyed by a failed model call');
  assert.ok(out.refreshFailures.some((f) => f.field === 'productAnalysis'));
});

test('assessment: a failed extraction keeps the stored competitive scoreboard', async () => {
  seed({
    scope: 'COMPETITOR', category: 'BATTLECARDS', competitorIds: ['comp-1'],
    metadata: { assessment: STORED_ASSESSMENT },
  });
  const out = await withSeam(boom, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.deepStrictEqual(persisted.assessment, STORED_ASSESSMENT,
    'the stored scoreboard was destroyed by a failed model call — extractBattlecard aggregates ' +
    'these per-doc scoreboards, so losing them silently degrades the battlecard too');
  assert.ok(out.refreshFailures.some((f) => f.field === 'assessment'));
});

test('a failed refresh does not throw, and says which field failed and on which provider', async () => {
  seed({ scope: 'TENANT', category: 'ORG_INTELLIGENCE', metadata: { companyAnalysis: STORED_COMPANY } });
  const out = await withSeam(boom, async (_calls, warnings) => {
    // The route turns this into a 200 (knowledge/index.js). A rejection here
    // would be a 500 instead — the document survives either way, but a 500 on a
    // refresh whose stored data is intact is the wrong signal.
    const r = await service.regenerateKeyPoints(TENANT, DOC_ID);
    assert.ok(warnings.some((w) => w.includes('companyAnalysis') && w.includes('anthropic') && w.includes(DOC_ID)),
      `the failure must leave a log line naming the field, the provider and the document: ${warnings.join(' | ')}`);
    return r;
  });
  assert.strictEqual(out.document.id, DOC_ID, 'the document is still returned');
  // keyPoints runs on every scope, so a TENANT doc has two failing calls here.
  assert.deepStrictEqual(out.refreshFailures.map((f) => f.field), ['keyPoints', 'companyAnalysis']);
});

// ── 2. legitimate absence still clears ──────────────────────────────────────

test('a SUCCESSFUL extraction that finds nothing still clears the stored value', async () => {
  // The other half of the fix, and the one that quietly rots: if the preserve is
  // ever widened to "never delete", a doc re-tagged out of its old scope keeps a
  // stale key from its previous life forever. An empty answer from a call that
  // WORKED is a real "this document has none".
  seed({
    scope: 'COMPETITOR', category: 'ORG_INTELLIGENCE',
    metadata: { keyPoints: STORED_KEYPOINTS, keyPointsKind: 'competitive', assessment: STORED_ASSESSMENT },
  });
  // `summary` is what makes the scoreboard half of this answer a real "nothing
  // to score" rather than a blank one: an answer with no scored axis AND no
  // summary is a degenerate success and now throws (see the two tests below).
  const out = await withSeam(
    answer({ points: [], summary: 'The doc has no evidence about this competitor.', axes: [], topImprovements: [] }),
    () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.ok(!('keyPoints' in persisted), 'an empty successful extraction must still clear keyPoints');
  assert.ok(!('keyPointsKind' in persisted), 'keyPointsKind must be cleared with it');
  assert.deepStrictEqual(out.refreshFailures, [], 'nothing failed — this is a clean refresh');
});

test('a document too thin to analyse clears the analysis, because that is not a failure', async () => {
  // Below extractCompanyAnalysis's 200-char floor: it returns null WITHOUT
  // calling the model. That null means "nothing to extract" and must clear.
  seed({ scope: 'TENANT', category: 'ORG_INTELLIGENCE', metadata: { companyAnalysis: STORED_COMPANY } });
  docRow.body = 'too short';
  const out = await withSeam(
    () => { throw new Error('the model must not be called for a body under the floor'); },
    () => service.regenerateKeyPoints(TENANT, DOC_ID)
  );

  assert.ok(!('companyAnalysis' in persisted),
    'a doc with nothing in it must lose its stale analysis — only a FAILED call preserves');
  assert.deepStrictEqual(out.refreshFailures, []);
});

// ── 2b. a DEGENERATE success is a failure, not an empty document ────────────
//
// The other door into the same outcome. The fix above closed "the call threw →
// delete"; these two close "the call returned 200 with nothing usable in it →
// overwrite". Both end at a good stored analysis replaced by nothing, behind a
// 200 with `refreshFailures: []` — which is worse than the throw case, because
// nothing anywhere records that it happened.

test('an answer with no points array is a failed call, not a document with no points', async () => {
  // `points` is required in KEYPOINTS_SCHEMA. An answer that parses but omits it
  // did not come back the way the schema says it must — a repaired truncation, a
  // provider shape change. Coerced to [] (as it was until 2026-08-14) it reads
  // as "this document genuinely has none" and the stored list is deleted.
  seed({
    scope: 'COMPETITOR', category: 'ORG_INTELLIGENCE',
    metadata: { keyPoints: STORED_KEYPOINTS, keyPointsKind: 'competitive' },
  });
  const out = await withSeam(answer({ summary: 'x', axes: [], topImprovements: [] }),
    () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.deepStrictEqual(persisted.keyPoints, STORED_KEYPOINTS,
    'a malformed answer must preserve, not delete — this is the throw case wearing a 200');
  assert.deepStrictEqual(out.refreshFailures.map((f) => f.field), ['keyPoints'],
    'and it must be REPORTED: a preserve nobody is told about is the silence this PR removed');
  assert.strictEqual(out.refreshFailures[0].provider, 'anthropic',
    'the error is ours, so it can name the serving provider from the answer itself');
});

test('a scoreboard that scores no axis and has no summary is a failed call', async () => {
  // assessment.normalize() cannot return null and cannot throw — it fills all 8
  // axes with unknown/0 placeholders so the UI shape is stable. So `{}` from the
  // model comes back looking like a complete, confident, all-zero scoreboard,
  // and writing it over a good one is a silent loss that also degrades the
  // battlecard, which averages these per-doc scoreboards.
  seed({
    scope: 'COMPETITOR', category: 'BATTLECARDS', competitorIds: ['comp-1'],
    metadata: { assessment: STORED_ASSESSMENT, keyPoints: STORED_KEYPOINTS },
  });
  const out = await withSeam((args) => {
    if (args.task === 'assessment') return answer({})();
    return answer({ points: ['still fine'] })();
  }, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.deepStrictEqual(persisted.assessment, STORED_ASSESSMENT,
    'an all-unknown, summary-less scoreboard must not overwrite a real one');
  assert.deepStrictEqual(out.refreshFailures.map((f) => f.field), ['assessment']);
  assert.deepStrictEqual(persisted.keyPoints, ['still fine'],
    'and the sibling call that answered properly is still written');
});

test('a scoreboard that scores nothing but SAYS SO is a real answer and is stored', async () => {
  // The boundary of the rule above, and the reason it is not "any all-unknown
  // scoreboard is a failure": `summary` is required in ASSESSMENT_SCHEMA, so a
  // model that read the doc and honestly found no basis for a verdict still
  // writes the sentence. That is a judgement, and it must replace the stored one
  // — otherwise a doc that has genuinely stopped being about this competitor
  // keeps a favourable scoreboard from its previous life forever.
  seed({
    scope: 'COMPETITOR', category: 'BATTLECARDS', competitorIds: ['comp-1'],
    metadata: { assessment: STORED_ASSESSMENT },
  });
  const out = await withSeam(answer({ summary: 'Nothing in this doc supports a verdict.', axes: [], topImprovements: [], points: [] }),
    () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.strictEqual(persisted.assessment.summary, 'Nothing in this doc supports a verdict.',
    'an honest no-verdict answer is a successful extraction and overwrites');
  assert.deepStrictEqual(out.refreshFailures, []);
});

// ── 3. the scope/category clears are not model results ──────────────────────

test('the re-tagging clears fire even when that branch\'s model call failed', async () => {
  // A doc re-tagged from company-wide to a product line must shed
  // companyAnalysis. That clear is driven by the doc's own category, not by the
  // model, so a failed productAnalysis call must not suppress it — otherwise a
  // provider outage silently reinstates a stale key.
  seed({
    scope: 'TENANT', category: 'PRODUCT_INTEL', productIds: ['prod-1'],
    metadata: { companyAnalysis: STORED_COMPANY, productAnalysis: STORED_PRODUCT },
  });
  await withSeam(boom, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.ok(!('companyAnalysis' in persisted),
    'the cross-clear is category-driven and must survive a failed productAnalysis call');
  assert.deepStrictEqual(persisted.productAnalysis, STORED_PRODUCT,
    'and the failed field still keeps its stored value');
});

test('a doc re-scoped out of TENANT and out of competitive sheds both stale keys', async () => {
  seed({
    scope: 'PROSPECT', category: 'ORG_INTELLIGENCE',
    metadata: {
      companyAnalysis: STORED_COMPANY, productAnalysis: STORED_PRODUCT, assessment: STORED_ASSESSMENT,
      keyPoints: STORED_KEYPOINTS, keyPointsKind: 'competitive',
    },
  });
  await withSeam(boom, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.ok(!('companyAnalysis' in persisted), 'non-TENANT scope clears companyAnalysis unconditionally');
  assert.ok(!('productAnalysis' in persisted), 'non-TENANT scope clears productAnalysis unconditionally');
  assert.ok(!('assessment' in persisted), 'non-competitive clears the scoreboard unconditionally');
  assert.deepStrictEqual(persisted.keyPoints, STORED_KEYPOINTS,
    'but the one field whose CALL failed is still preserved');
});

// ── 4. partial failure ──────────────────────────────────────────────────────

test('one field failing neither aborts the request nor discards the field that succeeded', async () => {
  // The normal case, not an edge case: a COMPETITOR doc runs two independent
  // calls in one request. An implementation that wrapped the whole function in a
  // single try, or that bailed on the first failure, passes every test above and
  // fails this one.
  seed({
    scope: 'COMPETITOR', category: 'ORG_INTELLIGENCE', competitorIds: ['comp-1'],
    metadata: { keyPoints: STORED_KEYPOINTS, keyPointsKind: 'competitive', assessment: STORED_ASSESSMENT },
  });
  const fresh = ['they just raised a Series C'];
  const out = await withSeam((args) => {
    if (args.task === 'assessment') return boom();
    return answer({ points: fresh })();
  }, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.deepStrictEqual(persisted.keyPoints, fresh,
    'the field whose call SUCCEEDED must be written — a failure elsewhere must not roll it back');
  assert.deepStrictEqual(persisted.assessment, STORED_ASSESSMENT,
    'the field whose call FAILED must keep its stored value');
  assert.deepStrictEqual(out.refreshFailures.map((f) => f.field), ['assessment'],
    'exactly the failed field is reported, not the whole request');
});

// ── 5. the failure has to reach a human ─────────────────────────────────────

test('the route and the admin SPA both carry refreshFailures through to the rep', async () => {
  // A preserve nobody is told about is its own defect: the rep sees a 200 and a
  // document that looks refreshed, re-clicks, and gets the same silence. This is
  // a source guard rather than a live request because the route needs auth,
  // tenancy and multer to reach; it fails loudly if the wiring is unpicked.
  const route = fs.readFileSync(path.join(SRC, 'knowledge', 'index.js'), 'utf8');
  const handler = route.slice(route.indexOf("router.post('/documents/:id/keypoints'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.match(body, /refreshFailures/,
    'POST /documents/:id/keypoints must forward refreshFailures — without it the service ' +
    'preserves the data and nothing tells the rep the refresh was partial');

  const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'admin', 'admin.js'), 'utf8');
  assert.ok(admin.includes('function warnPartialKeypointsRefresh'),
    'web/admin/admin.js lost the partial-refresh warning helper');
  const calls = admin.match(/warnPartialKeypointsRefresh\(/g) || [];
  assert.strictEqual(calls.length, 3,
    'both POST …/keypoints call sites in the admin SPA must call warnPartialKeypointsRefresh ' +
    `(1 declaration + 2 call sites = 3 occurrences; found ${calls.length}) — a refresh button ` +
    'that swallows the warning puts the rep back in the silence this PR removed');
});
