// ADR-0006 §9 item 5, group 2: keypoints + assessment + battlecard on Claude.
//
// A sibling of cutoverGroup1.test.js rather than an extension of it, because the
// two groups fail differently and the assertions do not overlap. Group 1's file
// is about a fail-OPEN guard and a frontend badge; this one is about four things
// that are specific to these six call sites and silent if wrong:
//
//   1. ALL THREE KEYS FLIP TOGETHER. knowledge/assessment.js holds two call
//      sites resolving two different keys. Migrating `assessment` alone leaves
//      extractBattlecard on the Gemini SDK and NOTHING ERRORS — it keeps sending
//      a Gemini model id and returns a normal battlecard, so the cutover looks
//      complete while §6's margin table prices a task that never moved.
//   2. THE GEMINI REQUEST DOES NOT MOVE. `keypoints` and `battlecard` are
//      re-tiered for Claude only (models.js `anthropicTier`), so every one of
//      these five schemas must still reach Gemini with the same model, budget,
//      temperature and thinking config it had before the seam existed. That is
//      asserted by driving the REAL seam into a fake Gemini client, not by
//      reading the source.
//   3. THE MODEL IS RESOLVED PER CALL. Both files froze it at require time
//      (`modelFor('keypoints')`, `modelFor('assessment')`,
//      `modelFor('battlecard')`) — the personas.js hazard of §9 item 4.
//   4. THE RETRY DECISION IS PER CALL SITE, and it is not symmetric: the scorer
//      keeps its wrapper, the rep-facing synthesis deliberately has none.
//
// The seam is exercised for real in (2) and (3) and stubbed in the rest; a
// stub-only file could not have caught a config key silently changing spelling.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

// ── module stubs, installed BEFORE anything under test is required ──────────
//
// gemini.js pulls in redis.js, which opens an ioredis client at module load and
// retries forever with no Redis reachable — `node --test` then hangs rather than
// failing. Neither file under test requires it any more, but aiCall.js does, and
// aiCall's Gemini branch is half of what this file asserts. So the stub is a
// working fake client, not a thrower: `geminiCalls` is what the provider would
// have received on the wire.
const geminiCalls = [];
let geminiImpl = () => ({ text: '{}', usageMetadata: null });
const geminiPath = require.resolve(path.join(SRC, 'gemini.js'));
require.cache[geminiPath] = {
  id: geminiPath, filename: geminiPath, loaded: true, children: [], paths: [],
  exports: {
    getClient: () => ({
      models: {
        generateContent: async (req) => { geminiCalls.push(req); return geminiImpl(req); },
      },
    }),
  },
};

// Postgres: both files under test read tenant context, and extractBattlecard is
// most of a query pipeline. Matched on a distinctive fragment of each statement
// so a test can say what a query returns without reproducing it.
let dbRows = () => ({ rows: [] });
const dbPath = require.resolve(path.join(SRC, 'db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { query: async (sql, params) => dbRows(String(sql), params) },
};

const aiCall = require(path.join(SRC, 'aiCall.js'));
const models = require(path.join(SRC, 'models.js'));
const keypoints = require(path.join(SRC, 'knowledge', 'keypoints.js'));
const assessment = require(path.join(SRC, 'knowledge', 'assessment.js'));

// Replace the seam itself, for the assertions that are about what a call site
// ASKS FOR rather than what the provider receives.
async function withSeam(impl, fn) {
  const real = aiCall.generateStructured;
  const calls = [];
  aiCall.generateStructured = async (args) => { calls.push(args); return impl(args); };
  try { return await fn(calls); } finally { aiCall.generateStructured = real; }
}

const ok = (parsed, model = 'claude-sonnet-5', provider = 'anthropic') => async () => ({
  parsed, text: JSON.stringify(parsed), usage: null, model, provider,
});

// Enough of a competitor dossier for extractBattlecard to reach the model.
function battlecardDb() {
  return (sql) => {
    if (sql.includes('FROM competitors')) return { rows: [{ name: 'Acme' }] };
    if (sql.includes('kb_document_competitors')) {
      return { rows: [{ id: 'd1', title: 'Acme pricing', metadata: {}, body: 'z'.repeat(900) }] };
    }
    if (sql.includes('kb_document_products')) {
      return { rows: [{ id: 'd2', title: 'Our overview', body: 'w'.repeat(900), product_ids: [] }] };
    }
    return { rows: [] };
  };
}

const BATTLECARD_ANSWER = {
  verdictHeadline: 'They win on brand, we win on price.',
  whereWeWin: [], whereWeLose: [], talkTrack: [], objections: [],
  migrationStory: null, axesScored: null,
};

// normalize() fills every missing axis with an `unknown` placeholder, so an
// empty axes array is a legitimate answer shape — the values are not what any
// assertion here is about.
const ASSESSMENT_ANSWER = { summary: 's', axes: [], topImprovements: [] };

// ── 1. the three keys, together ─────────────────────────────────────────────

test('group 2 is dispatch-ready — all three keys, because two of them share a file', () => {
  for (const t of ['keypoints', 'assessment', 'battlecard']) {
    assert.ok(models.DISPATCH_READY.has(t), `${t} was migrated, so it must be eligible`);
  }
  // The half-done cutover has no error to look for, so this is the only thing
  // that would catch it: `assessment` without `battlecard` leaves half of
  // knowledge/assessment.js on the Gemini SDK, returning perfectly normal
  // battlecards from a task the margin table has already re-priced.
  assert.ok(models.DISPATCH_READY.has('battlecard'),
    'extractBattlecard resolves its own key since PR #53 — flipping only `assessment` ' +
    'moves the scorer and silently leaves the synthesis behind');

  // Still not migrated, and each for its own reason. `compare` is the one that
  // matters most here: it shares knowledge/preview.js with an ALREADY-migrated
  // key, which is the same one-file-two-keys shape as assessment.js — and the
  // opposite answer, because its call site has not moved.
  for (const t of ['compare', 'research', 'discovery']) {
    assert.ok(!models.DISPATCH_READY.has(t),
      `${t}'s call site still speaks to the Gemini SDK — adding it would 404 every call`);
  }
});

// ── 2. what the call sites ask the seam for ─────────────────────────────────

test('all three keypoints call sites go through the seam as ONE task, with their own labels', async () => {
  dbRows = () => ({ rows: [] });
  await withSeam(ok({ points: ['a'], executiveSummary: 'e' }), async (calls) => {
    await keypoints.extractKeyPoints({ scope: 'COMPETITOR', text: 'x'.repeat(300), tenantId: 't1' });
    await keypoints.extractCompanyAnalysis({ text: 'x'.repeat(300), tenantId: 't1' });
    await keypoints.extractProductAnalysis({ text: 'x'.repeat(300), tenantId: 't1', productId: 'p1' });

    assert.deepStrictEqual(calls.map((c) => c.task), ['keypoints', 'keypoints', 'keypoints'],
      'one key, three call sites — this is the "every one of them has been migrated" half of ' +
      "DISPATCH_READY's rule");
    assert.deepStrictEqual(calls.map((c) => c.site),
      ['kb.keypoints', 'kb.companyAnalysis', 'kb.productAnalysis'],
      'the cost-telemetry labels are per call site, not per task');
    // The output budgets and determinism settings the Gemini call sites had. On
    // Claude max_tokens covers thinking too, but thinking is off, so they hold.
    assert.deepStrictEqual(calls.map((c) => c.maxTokens), [900, 2200, 2200]);
    assert.deepStrictEqual(calls.map((c) => c.temperature), [0.3, 0.3, 0.3]);
    assert.deepStrictEqual(calls.map((c) => c.tenantId), ['t1', 't1', 't1']);
    // Identity, not shape: `responseSchema` keeps Gemini's spelling so
    // liveSchemaCoverage.test.js's scan for the literal token still finds these.
    assert.strictEqual(calls[0].responseSchema, keypoints.KEYPOINTS_SCHEMA);
    assert.strictEqual(calls[1].responseSchema, keypoints.COMPANY_ANALYSIS_SCHEMA);
    assert.strictEqual(calls[2].responseSchema, keypoints.PRODUCT_ANALYSIS_SCHEMA);
  });
});

test('assessment.js sends its two call sites to two DIFFERENT tasks', async () => {
  dbRows = battlecardDb();
  await withSeam(async (args) => ok(args.task === 'battlecard' ? BATTLECARD_ANSWER : ASSESSMENT_ANSWER)(),
    async (calls) => {
      await assessment.extractCompetitiveAssessment({ text: 'x'.repeat(300), tenantId: 't1', competitorName: 'Acme' });
      await assessment.extractBattlecard('t1', 'c1');

      assert.deepStrictEqual(calls.map((c) => c.task), ['assessment', 'battlecard'],
        'one file, two keys, two tiers on Claude — the whole point of the §4.1 split');
      assert.deepStrictEqual(calls.map((c) => c.site), ['kb.assessment', 'kb.battlecard']);
      assert.deepStrictEqual(calls.map((c) => c.maxTokens), [2400, 2600]);
      assert.deepStrictEqual(calls.map((c) => c.temperature), [0.25, 0.3]);
      assert.strictEqual(calls[0].responseSchema, assessment.ASSESSMENT_SCHEMA);
      assert.strictEqual(calls[1].responseSchema, assessment.BATTLECARD_SCHEMA);
    });
});

// ── 3. what GEMINI receives, which must not have moved ──────────────────────

test('[GEMINI-PARITY] every group-2 call site still sends Gemini exactly what it did before', async () => {
  // The re-tiering in models.js is `anthropicTier`, i.e. Claude-only. Gemini
  // serves 100% of this traffic today, so a cutover PR that changes ANY of these
  // five requests is changing live behaviour under cover of a provider swap —
  // and a per-file diff cannot show it, because the request is now assembled in
  // aiCall.js from arguments spread across two other files.
  //
  // Driven through the REAL seam so what is compared is the object handed to
  // @google/genai, not the arguments on the way in.
  geminiCalls.length = 0;
  geminiImpl = (req) => ({
    text: JSON.stringify(req.config.responseSchema === assessment.BATTLECARD_SCHEMA
      ? BATTLECARD_ANSWER
      : { points: ['a'], executiveSummary: 'e', summary: 's', axes: [], topImprovements: [] }),
    usageMetadata: null,
  });
  dbRows = battlecardDb();

  await keypoints.extractKeyPoints({ scope: 'COMPETITOR', text: 'x'.repeat(300), tenantId: 't1' });
  await keypoints.extractCompanyAnalysis({ text: 'x'.repeat(300), tenantId: 't1' });
  await keypoints.extractProductAnalysis({ text: 'x'.repeat(300), tenantId: 't1', productId: 'p1' });
  await assessment.extractCompetitiveAssessment({ text: 'x'.repeat(300), tenantId: 't1', competitorName: 'Acme' });
  await assessment.extractBattlecard('t1', 'c1');

  const expected = [
    ['keypoints',  900,  0.3,  keypoints.KEYPOINTS_SCHEMA],
    ['keypoints',  2200, 0.3,  keypoints.COMPANY_ANALYSIS_SCHEMA],
    ['keypoints',  2200, 0.3,  keypoints.PRODUCT_ANALYSIS_SCHEMA],
    ['assessment', 2400, 0.25, assessment.ASSESSMENT_SCHEMA],
    ['battlecard', 2600, 0.3,  assessment.BATTLECARD_SCHEMA],
  ];
  assert.strictEqual(geminiCalls.length, expected.length,
    `expected one generateContent per call site, got ${geminiCalls.length}`);

  expected.forEach(([task, maxOutputTokens, temperature, schema], i) => {
    const req = geminiCalls[i];
    // The model the deleted require-time constant would have held, resolved now.
    assert.strictEqual(req.model, models.modelFor(task),
      `call site ${i} must still get the ${task} task's Gemini model`);
    assert.match(req.model, /^gemini-/, 'the Gemini branch must never be handed a Claude id');
    assert.deepStrictEqual(req.config, {
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
      temperature,
      responseMimeType: 'application/json',
      responseSchema: schema,
    }, `call site ${i} (${task}) changed what Gemini receives`);
    assert.strictEqual(req.contents.length, 1);
    assert.strictEqual(req.contents[0].role, 'user');
    assert.ok(req.contents[0].parts[0].text.length > 0);
  });

  geminiImpl = () => ({ text: '{}', usageMetadata: null });
});

test('the model is resolved PER CALL, not frozen when the module was required', async () => {
  // Both files captured it at require time, which is the personas.js hazard of
  // ADR-0006 §9 item 4: the id outlives the routing decision that produced it,
  // and provider and model can end up disagreeing. These modules were required
  // at the top of this file, long before the override below existed — so if the
  // constant were still there, this env var could not reach the wire.
  const saved = process.env.GEMINI_KEYPOINTS_MODEL;
  geminiCalls.length = 0;
  geminiImpl = () => ({ text: JSON.stringify({ points: ['a'] }), usageMetadata: null });
  dbRows = () => ({ rows: [] });
  try {
    process.env.GEMINI_KEYPOINTS_MODEL = 'gemini-resolved-at-call-time';
    await keypoints.extractKeyPoints({ scope: 'COMPETITOR', text: 'x'.repeat(300), tenantId: 't1' });
    assert.strictEqual(geminiCalls[0].model, 'gemini-resolved-at-call-time');
  } finally {
    if (saved === undefined) delete process.env.GEMINI_KEYPOINTS_MODEL;
    else process.env.GEMINI_KEYPOINTS_MODEL = saved;
    geminiImpl = () => ({ text: '{}', usageMetadata: null });
  }
});

// ── 4. the retry decision, which is asymmetric on purpose ───────────────────

test('the scorer retries a transient failure and the rep-facing synthesis does NOT', async () => {
  // §9 item 5: the seam does not retry, so every forLabel() binding is a
  // caller's decision. Group 2 made it once per call site rather than copying
  // the sibling, and this asserts the two answers are actually different —
  // a wrapper inherited by reflex would turn a fast 502 into three attempts with
  // backoff while a rep watches the regenerate button.
  dbRows = battlecardDb();

  let attempts = 0;
  await withSeam(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('503 UNAVAILABLE');  // classify() → transient
    return { parsed: ASSESSMENT_ANSWER, text: '{}', usage: null, model: 'm', provider: 'gemini' };
  }, async () => {
    const out = await assessment.extractCompetitiveAssessment({
      text: 'x'.repeat(300), tenantId: 't1', competitorName: 'Acme',
    });
    assert.ok(out, 'a transient failure must not cost the document its scoreboard');
  });
  assert.strictEqual(attempts, 2, 'extractCompetitiveAssessment keeps its aiRetry wrapper');

  let bcAttempts = 0;
  await withSeam(async () => { bcAttempts += 1; throw new Error('503 UNAVAILABLE'); }, async () => {
    const err = await assessment.extractBattlecard('t1', 'c1').then(() => null, (e) => e);
    assert.ok(err, 'the synthesis surfaces its failure rather than swallowing it');
    assert.strictEqual(err.status, 502, 'and the route layer still sees a 502');
  });
  assert.strictEqual(bcAttempts, 1,
    'extractBattlecard is synchronous behind POST /portfolio/competitors/:id/battlecard/regenerate — ' +
    'the same transient that is worth retrying at ingest is not worth three attempts with a rep waiting');
});

// ── 5. what lands in stored payloads ────────────────────────────────────────

test('the stored `model` names the model that SERVED the call, not a constant', async () => {
  // Three payloads carry it: companyAnalysis and productAnalysis onto
  // kb_documents.metadata, and the battlecard onto competitors.battlecard. It
  // was a require-time constant, so after a flip every row would have been
  // stamped with the model of whichever provider the process booted against.
  // All three readers render it as text and none branch on it, which is what
  // makes re-pointing it safe for rows already stored.
  dbRows = battlecardDb();
  await withSeam(ok({ ...BATTLECARD_ANSWER, executiveSummary: 'e' }, 'claude-sonnet-5'), async () => {
    const company = await keypoints.extractCompanyAnalysis({ text: 'x'.repeat(300), tenantId: 't1' });
    const product = await keypoints.extractProductAnalysis({ text: 'x'.repeat(300), tenantId: 't1' });
    const card = await assessment.extractBattlecard('t1', 'c1');
    assert.strictEqual(company.model, 'claude-sonnet-5');
    assert.strictEqual(product.model, 'claude-sonnet-5');
    assert.strictEqual(card.model, 'claude-sonnet-5');
  });
});

// ── 6. the failure lines, which are the only evidence these paths leave ─────

test('every group-2 failure names the provider that produced it', async () => {
  // All five call sites swallow or re-wrap their failure, so the warn line is
  // the whole of the signal. 'gemini' as a default would have been a guess
  // printed as a fact for every Claude-side failure — group 1 fixed exactly this
  // in relevance.js, preview.js and companyBrief.js.
  dbRows = battlecardDb();
  const runs = [
    ['[keypoints]',        () => keypoints.extractKeyPoints({ scope: 'COMPETITOR', text: 'x'.repeat(300) })],
    ['[company-analysis]', () => keypoints.extractCompanyAnalysis({ text: 'x'.repeat(300) })],
    ['[product-analysis]', () => keypoints.extractProductAnalysis({ text: 'x'.repeat(300) })],
    ['[assessment]',       () => assessment.extractCompetitiveAssessment({ text: 'x'.repeat(300), competitorName: 'Acme' })],
    ['[battlecard]',       () => assessment.extractBattlecard('t1', 'c1').catch(() => null)],
  ];
  for (const [tag, run] of runs) {
    for (const [stamped, expected] of [['anthropic', 'anthropic'], [null, 'unknown']]) {
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (...a) => warnings.push(a.map(String).join(' '));
      try {
        await withSeam(async () => {
          // Not a transient message: extractCompetitiveAssessment is wrapped, and
          // this loop is about the log line, not about the backoff.
          const err = new Error('down');
          if (stamped) err.provider = stamped;
          throw err;
        }, run);
      } finally { console.warn = realWarn; }
      assert.ok(warnings.some((w) => w.includes(tag) && w.includes(`failed on ${expected}`)),
        `${tag} (provider=${stamped}) must log "failed on ${expected}": ${warnings.join(' | ')}`);
    }
  }
});
