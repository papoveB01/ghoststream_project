// The battlecard call site must use — and record — the `battlecard` task's
// model, not `assessment`'s (ADR-0006 §4.1).
//
// providerRouter.test.js proves the ROUTER splits the two keys. That is only
// half the property: a split key that the call site never reads changes
// nothing, and the failure is silent in both directions. `battlecard` resolving
// to Sonnet while extractBattlecard still sends `assessment`'s Haiku id is a
// worse battlecard and no error; the reverse mislabels the persisted
// `model:` field and the `usage_costs` row that ADR-0006 §6's margin table is
// computed from.
//
// So this drives the real function with the two task keys pointed at
// DISTINGUISHABLE models and asserts which one comes out where. The overrides
// must be set before knowledge/assessment.js is required, because it resolves
// both models at require time (see the note at the top of that file).

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

// gemini.js's only eager import is src/redis.js, which constructs a live ioredis
// client at require time with `lazyConnect: false` — that alone keeps the test
// process alive forever after the assertions pass. Faked in require.cache before
// gemini.js loads, exactly as geminiCacheScan.test.js does it. Neither function
// under test touches Redis, so the fake needs no behaviour.
function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(SRC, relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}
stubModule('redis.js', {});

const ASSESSMENT_PROBE = 'gemini-assessment-probe';
const BATTLECARD_PROBE = 'gemini-battlecard-probe';
process.env.GEMINI_ASSESSMENT_MODEL = ASSESSMENT_PROBE;
process.env.GEMINI_BATTLECARD_MODEL = BATTLECARD_PROBE;

const db = require(path.join(SRC, 'db.js'));
const gemini = require(path.join(SRC, 'gemini.js'));
const costs = require(path.join(SRC, 'costs.js'));
const keypoints = require(path.join(SRC, 'knowledge', 'keypoints.js'));

// Required LAST so the two env overrides above are in force when its
// module-scope modelFor() calls run.
const assessment = require(path.join(SRC, 'knowledge', 'assessment.js'));

// The generation calls the two entry points make, in order.
const calls = [];
const recorded = [];

gemini.getClient = () => ({
  models: {
    generateContent: async (req) => {
      calls.push({ model: req.model, maxOutputTokens: req.config.maxOutputTokens });
      return {
        text: JSON.stringify({
          // BATTLECARD_SCHEMA's required fields …
          verdictHeadline: 'They win on ecosystem; we win on price.',
          whereWeWin: [], whereWeLose: [], talkTrack: [], objections: [],
          // … and ASSESSMENT_SCHEMA's.
          summary: 'They lead on integrations.',
          axes: [], topImprovements: [],
        }),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      };
    },
  },
});
costs.recordGemini = (tenantId, site, model) => { recorded.push({ site, model }); };
keypoints.tenantContextText = async () => 'our context';

// extractBattlecard issues three queries; each fixture is selected by a
// discriminator that ONLY its own statement matches, never by call order.
//
// A chain of `if`s would not have given that: the competitor-dossier query
// names both `kb_document_competitors` AND `kb_documents`, so it matched two
// arms and landed on the right fixture only because that arm was tested first
// — reordering the two `if`s would have swapped the fixtures silently, and both
// fixtures parse, so the swap surfaces as a confusing assertion failure rather
// than as "your dispatcher is ambiguous". Hence: collect EVERY matching rule
// and refuse to answer unless exactly one matched.
//
//   competitor name  → `FROM competitors` (competitor_offerings does not match:
//                       the \b after `competitors` excludes `competitors_…`)
//   THEIR dossiers   → the only query that JOINs kb_document_competitors
//   OUR intel        → the only query that filters d.scope = 'TENANT'
const QUERY_FIXTURES = [
  { name: 'competitor name', match: /\bFROM competitors\b/,
    rows: [{ name: 'Acme' }] },
  { name: 'their dossiers', match: /\bJOIN\s+kb_document_competitors\b/,
    rows: [{ id: 'doc_1', title: 'Acme dossier', metadata: {}, body: 'Acme ships an API marketplace. '.repeat(40) }] },
  { name: 'our intel', match: /d\.scope\s*=\s*'TENANT'/,
    rows: [{ id: 'doc_2', title: 'Our portfolio', body: 'We ship a fraud engine. '.repeat(40), product_ids: null }] },
];

db.query = async (sql) => {
  const text = String(sql);
  const hits = QUERY_FIXTURES.filter((f) => f.match.test(text));
  if (hits.length !== 1) {
    throw new Error(
      `${hits.length === 0 ? 'unmatched' : `ambiguous (${hits.map((h) => h.name).join(' + ')})`} ` +
      `query in test — fix the discriminator, do not rely on rule order: ${text.replace(/\s+/g, ' ').slice(0, 120)}`
    );
  }
  return { rows: hits[0].rows };
};

test('the battlecard synthesis sends, records and stamps the battlecard model', async () => {
  calls.length = 0; recorded.length = 0;

  const card = await assessment.extractBattlecard('ten_1', 'cmp_1');

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, BATTLECARD_PROBE,
    'the synthesis must be generated by the battlecard task, not by the per-document scorer');
  assert.deepStrictEqual(recorded, [{ site: 'kb.battlecard', model: BATTLECARD_PROBE }],
    'usage_costs is what ADR-0006 §6 is re-computed from — a mislabelled model prices the wrong tier');
  assert.strictEqual(card.model, BATTLECARD_PROBE,
    'competitors.battlecard.model is persisted; it must name the model that produced THIS card');
});

test('the per-document scorer keeps the assessment model', async () => {
  calls.length = 0; recorded.length = 0;

  const scored = await assessment.extractCompetitiveAssessment({
    text: 'Acme ships an API marketplace and a partner network. '.repeat(10),
    tenantId: 'ten_1',
    competitorName: 'Acme',
  });

  assert.ok(scored, 'extractCompetitiveAssessment swallows its own errors — a null here means it never got to the model');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, ASSESSMENT_PROBE,
    'only the battlecard half moves; splitting the key must not re-point the scorer');
  assert.deepStrictEqual(recorded, [{ site: 'kb.assessment', model: ASSESSMENT_PROBE }]);
});
