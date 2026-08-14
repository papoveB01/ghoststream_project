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

// The route guard at the bottom requires knowledge/index.js, which pulls
// src/auth.js — that refuses to load without a secret rather than accepting a
// forgeable default. Same defaults as routeContract.test.js; CI sets real ones.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-test-jwt-secret-at-least-32-bytes-long-xx';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-test-encryption-key-not-a-real-secret';

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
// Names the id-lookup in the assessment branch resolves metadata.appliesToProductIds
// to. Only that one query — matched on its exact text, because tenantContextText
// also reads `products` and must keep getting nothing.
let appliesProductRows = [];

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
    if (s.includes('FROM products WHERE tenant_id = $1 AND id = ANY($2)')) {
      return { rows: appliesProductRows.map((name) => ({ name })) };
    }
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

function seed({ scope, category, metadata, productIds = [], competitorIds = [], appliesProductNames = [] }) {
  persisted = null;
  appliesProductRows = appliesProductNames;
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

test('the reported provider is the one that failed, and UNSTAMPED says so', async () => {
  // The case that matters most is the one with no stamp at all. Raw @google/genai
  // errors carry no `provider`, and `keypoints` is FLIP_BLOCKED (models.js), so
  // Gemini serves 100% of this path today — 'unknown' is what essentially every
  // real failure here reports, and a fixture that only ever stamps 'anthropic'
  // cannot tell that apart from a hard-coded literal. It is the same guard
  // test/cutoverGroup2.test.js puts on the sibling extractors' log lines.
  for (const [stamped, expected] of [['anthropic', 'anthropic'], ['gemini', 'gemini'], [null, 'unknown']]) {
    seed({ scope: 'TENANT', category: 'ORG_INTELLIGENCE', metadata: { companyAnalysis: STORED_COMPANY } });
    const out = await withSeam(() => {
      const e = new Error('down');
      if (stamped) e.provider = stamped;
      throw e;
    }, async (_calls, warnings) => {
      const r = await service.regenerateKeyPoints(TENANT, DOC_ID);
      assert.ok(warnings.some((w) => w.includes(`failed on ${expected}`)),
        `a failure stamped ${stamped} must log "failed on ${expected}": ${warnings.join(' | ')}`);
      return r;
    });
    for (const f of out.refreshFailures) {
      assert.strictEqual(f.provider, expected,
        `a failure stamped ${stamped} must be reported as ${expected} — naming a provider by ` +
        'default prints a guess as a fact, and here the default would name the one not running');
    }
  }
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

// ── 2c. the refresh scores the same document ingest scored ──────────────────

test('the refresh applies the card\'s product scope, the way ingest does', async () => {
  // metadata.appliesToProductIds is what makes a battlecard "Fraud Solution vs
  // Acme" rather than "us vs Acme". ingest resolves it to names and passes them,
  // which restricts ourScore to those products; this path never read it, so one
  // click on ↻ refresh analysis silently replaced the product-scoped axes with
  // portfolio-wide ones — 200, refreshFailures [], and the metadata (and so the
  // UI's label) still saying product-scoped.
  seed({
    scope: 'COMPETITOR', category: 'BATTLECARDS', competitorIds: ['comp-1'],
    metadata: { assessment: STORED_ASSESSMENT, appliesToProductIds: ['prod-9'] },
    appliesProductNames: ['Fraud Solution'],
  });
  const sent = await withSeam(answer({ summary: 'ok', axes: [], topImprovements: [], points: [] }),
    async (calls) => {
      await service.regenerateKeyPoints(TENANT, DOC_ID);
      return calls.find((c) => c.task === 'assessment');
    });

  assert.match(sent.prompt, /specific products: Fraud Solution/,
    'the scoring lens must name the products this card is filed against');
  assert.ok(!/full portfolio/.test(sent.prompt),
    'and must NOT fall back to the portfolio-wide lens for a product-scoped card');
});

test('a card with no product scope still scores the full portfolio', async () => {
  // The other half: absent metadata means "all our products", and reading it
  // must not turn an unscoped card into a scoped one.
  seed({
    scope: 'COMPETITOR', category: 'BATTLECARDS', competitorIds: ['comp-1'],
    metadata: { assessment: STORED_ASSESSMENT },
  });
  const sent = await withSeam(answer({ summary: 'ok', axes: [], topImprovements: [], points: [] }),
    async (calls) => {
      await service.regenerateKeyPoints(TENANT, DOC_ID);
      return calls.find((c) => c.task === 'assessment');
    });

  assert.match(sent.prompt, /full portfolio/);
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

test('a company-wide doc sheds a stale productAnalysis even when its own call failed', async () => {
  // The mirror of the test above, and the one clear of the four that nothing was
  // holding down: a doc re-tagged OFF a product line onto company-wide keeps a
  // productAnalysis from its previous life unless this delete fires, and it must
  // fire on the branch where the companyAnalysis call threw — otherwise a
  // provider outage silently reinstates the stale key.
  seed({
    scope: 'TENANT', category: 'ORG_INTELLIGENCE',
    metadata: { productAnalysis: STORED_PRODUCT, companyAnalysis: STORED_COMPANY },
  });
  await withSeam(boom, () => service.regenerateKeyPoints(TENANT, DOC_ID));

  assert.ok(!('productAnalysis' in persisted),
    'an ORG_INTELLIGENCE doc must lose the product-scoped analysis from its previous life');
  assert.deepStrictEqual(persisted.companyAnalysis, STORED_COMPANY,
    'and the field whose call failed still keeps its stored value');
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
//
// The guard below, and the ones in §5b, all replace source-scraping guards that
// could not fail. This one read a window that ended before the line it was
// checking (the first `});` in the handler is the one inside res.json), so
// deleting `refreshFailures` from the RESPONSE left it green; it now invokes the
// handler and reads what was emitted.

test('the route emits refreshFailures in the body, not merely in its destructuring', async () => {
  // Invoked, not read. The handler needs no auth, tenancy or multer — those are
  // mounted above it in src/index.js — so the only stub required is the service
  // call it wraps.
  const { router } = require(path.join(SRC, 'knowledge', 'index.js'));
  const layer = router.stack.find((l) => l.route && l.route.path === '/documents/:id/keypoints'
    && l.route.methods && l.route.methods.post);
  assert.ok(layer, 'POST /documents/:id/keypoints is no longer mounted on the knowledge router');

  const FAILURES = [{ field: 'assessment', provider: 'gemini' }];
  const realRegen = service.regenerateKeyPoints;
  service.regenerateKeyPoints = async () => ({
    document: { id: DOC_ID, metadata: { keyPoints: STORED_KEYPOINTS } },
    refreshFailures: FAILURES,
  });
  // Only the LAST layer. The earlier ones are express middleware — the sibling
  // PATCH /documents/:id/tags already carries express.json() — and driving those
  // with a plain object for `req` throws for reasons that have nothing to do
  // with what this guard is about. Adding a body parser here must not red it.
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  // Every body, not the last one: a handler that answers twice (a second
  // res.json from an error path, say) would otherwise be judged on the body the
  // client never sees — real Express sends the FIRST and only warns about the
  // second. So a double-send with the lossy body first has to be a failure here.
  const bodies = [];
  let failedNext = null;
  try {
    await handler(
      { tenantId: TENANT, params: { id: DOC_ID }, body: {}, query: {} },
      { json: (b) => { bodies.push(b); }, status() { return this; } },
      (err) => { failedNext = err || new Error('next() called with no error'); }
    );
  } finally { service.regenerateKeyPoints = realRegen; }

  assert.ifError(failedNext);
  assert.strictEqual(bodies.length, 1,
    `the handler must answer exactly once; it answered ${bodies.length} time(s)`);
  const sent = bodies[0];
  assert.strictEqual(sent.ok, true);
  assert.deepStrictEqual(sent.refreshFailures, FAILURES,
    'the EMITTED body must carry refreshFailures — destructuring it out of the service result ' +
    'and then not forwarding it deletes this PR\'s entire user-visible mechanism and leaves ' +
    'warnPartialKeypointsRefresh dead code, with the rep back in the silence');
  assert.strictEqual(sent.document.id, DOC_ID, 'and the document still comes back');
});

// ── 5b. what the rep is actually shown ───────────────────────────────────────
//
// EXECUTED, not read. Every guard this file has had over the SPA warning was a
// string search across admin.js, and each one pinned a property nobody cares
// about. The first counted occurrences of an identifier, so moving the call into
// the catch — where it gets an Error and can never fire — kept the count at 3.
// Its replacement checked WHERE the identifier appears, which is stronger and
// still the wrong method: `warnPartialKeypointsRefresh(r)` instead of `(body)`
// leaves the position untouched, makes the warning permanently dead, and stays
// green. Neither an occurrence count nor a position is a property that can see
// it. And the helper's actual output — the label map, the kept-vs-still-empty
// split — had no coverage at all.
//
// So both are sliced out of admin.js and RUN, with their globals injected:
// `warnPartialKeypointsRefresh` (pure — a response body in, one alert string
// out) and `kbRegenKeyPoints`, the ↻ refresh handler that calls it. admin.js
// cannot be required (one ~12k-line IIFE against a live DOM), and a copy of
// either pasted into this file would pass happily against an admin.js that had
// stopped resembling it.

const ADMIN_JS = path.join(__dirname, '..', '..', 'web', 'admin', 'admin.js');

// Brace-matched rather than line-matched so a reindent or a reflow does not fail
// this file for a non-reason — the lesson of the guard this replaces, which went
// red on a no-op `if (!r.ok) throw` → `if (!r.ok) { throw }`.
function sliceFn(src, header, from = 0) {
  const fnAt = src.indexOf(header, from);
  assert.notStrictEqual(fnAt, -1, `web/admin/admin.js no longer contains \`${header}\``);
  let depth = 0;
  for (let i = src.indexOf('{', fnAt); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { start: fnAt, end: i + 1 };
  }
  return assert.fail(`could not find the end of \`${header}\``);
}

// A mis-extraction that swallowed half the SPA would still "run", and would then
// be measuring something else entirely. Make it loud instead.
function checkSlice(slice, mustContain, limit, what) {
  assert.ok(slice.includes(mustContain),
    `the extracted ${what} does not contain \`${mustContain}\``);
  assert.ok(slice.length < limit, `extracted ${slice.length} chars for ${what}; the slice is wrong`);
  return slice;
}

// The label map plus the helper. Exactly one binding is injected, so a helper
// that started reaching for `document`, `fetch` or any other SPA global fails
// here loudly rather than quietly picking up a Node one.
function loadWarnHelper(src) {
  const admin = src || fs.readFileSync(ADMIN_JS, 'utf8');
  const labelsAt = admin.indexOf('const KB_REFRESH_FIELD_LABELS');
  assert.notStrictEqual(labelsAt, -1, 'web/admin/admin.js lost KB_REFRESH_FIELD_LABELS — the ' +
    'refresh failures are back to being shown to a sales rep as raw api metadata keys');
  const { end } = sliceFn(admin, 'function warnPartialKeypointsRefresh(', labelsAt);
  const slice = checkSlice(admin.slice(labelsAt, end), 'alert(', 4000, 'the warning helper');
  const alerts = [];
  // eslint-disable-next-line no-new-func
  const factory = new Function('alert', `${slice}\nreturn warnPartialKeypointsRefresh;`);
  return { warn: factory((m) => alerts.push(String(m))), alerts };
}

// The ↻ refresh handler itself, with every global it touches injected and
// recorded. This is what no string search can do: it sees which VALUE reaches
// the warning and in what ORDER relative to the reload — the two things the
// previous guards' green runs were hiding.
function loadRegenHandler({ response, jsonBody, reloadThrows, label = 'Generate analysis' }) {
  const admin = fs.readFileSync(ADMIN_JS, 'utf8');
  const { start, end } = sliceFn(admin, 'async function kbRegenKeyPoints(');
  const slice = checkSlice(admin.slice(start, end), 'warnPartialKeypointsRefresh(', 4000,
    'the refresh handler');

  const log = [];
  const alerts = [];
  const warnArgs = [];
  // The caller chooses the seeded label, because a fixture that seeds the same
  // literal admin.js contains cannot see a hard-coded restore. See the non-200
  // test below, which runs both of the labels this button really carries.
  const btn = { disabled: false, textContent: label };
  const env = {
    fetch: async () => ({ ...response, json: async () => jsonBody }),
    alert: (m) => { alerts.push(String(m)); },
    warnPartialKeypointsRefresh: (b) => { log.push('warn'); warnArgs.push(b); },
    loadKbLibrary: async () => {
      log.push('reload');
      if (reloadThrows) throw new Error(reloadThrows);
    },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${slice}\nreturn kbRegenKeyPoints;`);
  const kbRegenKeyPoints = factory(...names.map((n) => env[n]));
  return { run: () => kbRegenKeyPoints(DOC_ID, btn), log, alerts, warnArgs, btn };
}

test('a mixed failure names the kept field and the still-empty one, in the rep\'s words', () => {
  const { warn, alerts } = loadWarnHelper();
  warn({
    document: { id: DOC_ID, metadata: { keyPoints: STORED_KEYPOINTS } },
    refreshFailures: [{ field: 'keyPoints', provider: 'gemini' }, { field: 'companyAnalysis', provider: 'gemini' }],
  });

  assert.strictEqual(alerts.length, 1, 'a partial failure must produce exactly one warning');
  const msg = alerts[0];
  assert.match(msg, /Kept what you already had: Key points\./,
    `the field that still holds its stored value must be reported as kept: ${msg}`);
  assert.match(msg, /Still empty[^\n]*: Company analysis\./,
    `the field that has nothing must NOT be reported as kept: ${msg}`);
  assert.match(msg, /Nothing you had was lost/, msg);
  assert.ok(!/keyPoints|companyAnalysis/.test(msg),
    `raw api metadata keys reached the rep: ${msg} — every other surface in this SPA labels these`);
});

test('when every failed field was already stored, nothing claims a count it does not have', () => {
  const { warn, alerts } = loadWarnHelper();
  warn({
    document: { id: DOC_ID, metadata: { keyPoints: STORED_KEYPOINTS, assessment: STORED_ASSESSMENT } },
    refreshFailures: [{ field: 'keyPoints', provider: 'gemini' }, { field: 'assessment', provider: 'gemini' }],
  });

  const msg = alerts[0];
  assert.match(msg, /Kept what you already had: Key points, Competitive scoreboard\./, msg);
  assert.ok(!/Still empty/.test(msg), `nothing was empty here: ${msg}`);
  assert.ok(!/partly/i.test(msg),
    `"partly" is unknowable from this response — it lists which fields FAILED, never how many ` +
    `were attempted — and is plainly false when every one of them failed: ${msg}`);
});

test('a first-ever generate does not tell the rep it kept a version that never existed', () => {
  // The round-1 falsehood, and the reason the wording is read off the document
  // rather than off the failure list: click "generate analysis" on a doc that
  // has none while the provider is down, and `md` is `{}`.
  const { warn, alerts } = loadWarnHelper();
  warn({
    document: { id: DOC_ID, metadata: {} },
    refreshFailures: [{ field: 'keyPoints', provider: 'gemini' }, { field: 'assessment', provider: 'gemini' }],
  });

  const msg = alerts[0];
  assert.match(msg, /Still empty[^\n]*: Key points, Competitive scoreboard\./, msg);
  assert.ok(!/Kept what you already had/.test(msg),
    `nothing was kept — there was no previous version to keep: ${msg}`);
  assert.ok(!/previous version/i.test(msg),
    `the warning asserts a previous version that does not exist: ${msg}`);
});

test('an unrecognised field is reported by its raw key rather than dropped', () => {
  const { warn, alerts } = loadWarnHelper();
  warn({
    document: { id: DOC_ID, metadata: {} },
    refreshFailures: [{ field: 'sentimentAnalysis', provider: 'gemini' }],
  });

  assert.strictEqual(alerts.length, 1);
  assert.match(alerts[0], /sentimentAnalysis/,
    'a field the label map does not know must still be named — dropping it is a failure the ' +
    'rep is never told about, which is the silence this PR exists to remove');
});

test('with no document in the response, the warning does not invent kept-or-empty', () => {
  // A concurrent delete between the write and the re-read, or an older API
  // build. `md` falls back to `{}`, which would report every preserved field as
  // "still empty — nothing had been generated yet": round 1's falsehood again,
  // pointing the other way.
  const { warn, alerts } = loadWarnHelper();
  warn({ refreshFailures: [{ field: 'keyPoints', provider: 'gemini' }, { field: 'assessment', provider: 'gemini' }] });

  const msg = alerts[0];
  assert.match(msg, /Couldn't be regenerated: Key points, Competitive scoreboard\./, msg);
  assert.ok(!/Still empty/.test(msg), `it cannot know these were empty: ${msg}`);
  assert.ok(!/Kept what you already had/.test(msg), `nor that they were kept: ${msg}`);
});

test('a response with no refreshFailures warns about nothing', () => {
  // Deploy skew is the case that matters: `refreshFailures` is absent from an
  // older api build, and silence is that build's correct, pre-existing
  // behaviour. A helper that warned here would fire on every clean refresh.
  const { warn, alerts } = loadWarnHelper();
  const quiet = [
    undefined,
    null,
    {},
    { document: { id: DOC_ID, metadata: { keyPoints: STORED_KEYPOINTS } } },
    { document: { id: DOC_ID, metadata: {} }, refreshFailures: [] },
    { document: { id: DOC_ID, metadata: {} }, refreshFailures: 'assessment' },
    // Entries with no `field`: nothing nameable, so a headline naming nothing
    // would be worse than silence.
    { document: { id: DOC_ID, metadata: {} }, refreshFailures: [{ provider: 'gemini' }] },
  ];
  for (const body of quiet) warn(body);

  assert.deepStrictEqual(alerts, [],
    'a clean refresh, and an older API build that has no refreshFailures at all, must be silent');
});

// ── 5c. the ↻ refresh handler, executed ──────────────────────────────────────

test('the refresh handler hands the warning the PARSED BODY, before the reload runs', async () => {
  // What every string search over this file has missed. `warnPartialKeypointsRefresh(r)`
  // instead of `(body)` passes the fetch Response — no `refreshFailures` on it,
  // ever — so the warning is permanently dead while its position, its name and
  // its occurrence count are all untouched. Only running it can see that.
  const body = {
    ok: true,
    document: { id: DOC_ID, metadata: { assessment: STORED_ASSESSMENT } },
    refreshFailures: [{ field: 'assessment', provider: 'gemini' }],
  };
  const h = loadRegenHandler({ response: { ok: true, status: 200 }, jsonBody: body });
  await h.run();

  assert.deepStrictEqual(h.warnArgs, [body],
    'the warning must be given the parsed response body — anything else (the Response, the ' +
    'document alone) has no refreshFailures on it and can never fire');
  assert.deepStrictEqual(h.log, ['warn', 'reload'],
    'the warning must run BEFORE the re-render, not after it');
});

test('a reload that throws still shows the warning, and blames the reload, not the generate', async () => {
  // The measured defect: integration hit `DSText is not defined` out of
  // loadKbLibrary on a 200 whose document was written. With the reload inside
  // the same try the rep was told "Couldn't generate key points: DSText is not
  // defined" — wrong twice — and the partial-refresh warning was swallowed.
  const body = { ok: true, document: { id: DOC_ID, metadata: {} }, refreshFailures: [{ field: 'keyPoints', provider: 'gemini' }] };
  const h = loadRegenHandler({
    response: { ok: true, status: 200 }, jsonBody: body, reloadThrows: 'DSText is not defined',
  });
  await h.run();

  assert.deepStrictEqual(h.warnArgs, [body], 'a failing reload must not swallow the warning');
  assert.deepStrictEqual(h.log, ['warn', 'reload']);
  assert.strictEqual(h.alerts.length, 1);
  assert.match(h.alerts[0], /list couldn't be refreshed: DSText is not defined/,
    `a render failure must say it is a render failure: ${h.alerts[0]}`);
  assert.ok(!/Couldn't generate key points/.test(h.alerts[0]),
    `the refresh succeeded and its document was written; saying it failed is a second wrong ` +
    `signal from one unrelated throw: ${h.alerts[0]}`);
});

test('a non-200 warns about nothing and restores the button\'s own label', async () => {
  // BOTH labels, because one of them is not a test. Seeding the fixture with the
  // literal that also sits in admin.js means `btn.textContent = '↻ Refresh
  // analysis'` in place of the captured `origLabel` restores the right string by
  // accident — measured: that mutation left this file green. The button really
  // carries two labels ("Generate analysis" on a document with no analysis yet,
  // "↻ Refresh analysis" on one that has), so running both makes any hard-coded
  // literal wrong for one of them.
  for (const label of ['Generate analysis', '↻ Refresh analysis']) {
    const h = loadRegenHandler({
      response: { ok: false, status: 503 }, jsonBody: { error: 'upstream unavailable' }, label,
    });
    await h.run();

    assert.deepStrictEqual(h.log, [],
      'nothing may warn or re-render on a response that is not a 200');
    assert.deepStrictEqual(h.alerts, ["Couldn't generate key points: upstream unavailable"]);
    assert.strictEqual(h.btn.disabled, false, 'the button must be usable again');
    assert.strictEqual(h.btn.textContent, label,
      `the label must be captured, not assumed: seeded "${label}" and got back ` +
      `"${h.btn.textContent}" — a hard-coded restore relabels the button`);
  }
});

test('both admin SPA call sites warn on the success path, before anything re-renders', () => {
  // The one property execution cannot see: WHERE the call sits. Everything the
  // helper does is pinned above by running it; what is left is ordering, and the
  // ordering is the defect this PR fixed twice — a throw out of the re-render
  // lands in the catch, reports "Couldn't generate key points: <unrelated
  // message>" on a 200 whose document was written, and swallows the warning.
  // Deliberately kept small: a string search is a bad instrument and every extra
  // thing it pins is a future false red.
  const admin = fs.readFileSync(ADMIN_JS, 'utf8');

  const sites = [];
  for (let i = admin.indexOf('/keypoints`'); i !== -1; i = admin.indexOf('/keypoints`', i + 1)) sites.push(i);
  assert.strictEqual(sites.length, 2,
    `expected the two POST …/keypoints call sites in the admin SPA, found ${sites.length} — ` +
    'if a third was added it needs the same warning, and this guard needs to know about it');

  for (const at of sites) {
    const after = admin.slice(at);
    // `if (!r.ok)`, not `if (!r.ok) throw`: bracing the throw is a no-op and
    // must not fail this test.
    const okCheck = after.indexOf('if (!r.ok)');
    const endOfTry = after.indexOf('} catch');   // NOT `.catch(` — a block, not a method
    const warnAt = after.indexOf('warnPartialKeypointsRefresh(');
    const where = `admin.js offset ${at}`;
    assert.ok(okCheck !== -1, `${where}: no \`if (!r.ok)\` — the success path is not identifiable`);
    assert.ok(warnAt !== -1, `${where}: this call site does not warn at all`);
    assert.ok(endOfTry > okCheck, `${where}: no catch closing the try that holds the fetch`);
    assert.ok(warnAt > okCheck,
      `${where}: warnPartialKeypointsRefresh must run AFTER the !r.ok check, or it is warning ` +
      'about a body it has not established is a 200');
    assert.ok(warnAt < endOfTry,
      `${where}: warnPartialKeypointsRefresh is outside the try — in the catch it receives an ` +
      'Error and can never fire, and after the catch a re-render that throws swallows it. The ' +
      'rep gets a 200, a document that looks refreshed, and the silence this PR removed');

    // Nothing that re-renders may run between the 200 and the warning. Written
    // as "not in the window" rather than "warnAt < indexOf(x)" because neither
    // call site contains both names, and an absent name would otherwise pass or
    // fail by accident depending on what happens to sit further down the file.
    //
    // Comments come out first: both call sites carry a comment EXPLAINING this
    // ordering, and both name the very calls being looked for. Reading those as
    // code is how a guard fails for editing the prose that documents it.
    const beforeWarn = after.slice(okCheck, warnAt)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    for (const rerender of ['loadKbLibrary', 'closeIntelDocModal', 'onChange(']) {
      assert.ok(!beforeWarn.includes(rerender),
        `${where}: ${rerender} runs before warnPartialKeypointsRefresh. A throw out of it lands ` +
        'in the catch, tells the rep the generate failed on a 200 that wrote the document, and ' +
        'the partial-refresh warning — the only signal there is — is never shown');
    }

    // And that it is handed the PARSED BODY. §5c proves this by execution for
    // kbRegenKeyPoints; the modal's handler is a listener nested inside a
    // ~200-line builder that cannot be sliced out and run, so for that one site
    // this stays textual — matched against whatever `await r.json()` was
    // assigned to, so a rename is fine and passing `r` is not.
    const parsed = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+r\.json\(\)/.exec(after);
    assert.ok(parsed, `${where}: no \`await r.json()\` — cannot tell what the warning is given`);
    assert.ok(after.startsWith(`warnPartialKeypointsRefresh(${parsed[1]})`, warnAt),
      `${where}: the warning is not given \`${parsed[1]}\`, the parsed response body. Handed the ` +
      'Response, or the document alone, it never sees refreshFailures and can never fire — with ' +
      'its name, its position and its occurrence count all still exactly right');
  }
});
