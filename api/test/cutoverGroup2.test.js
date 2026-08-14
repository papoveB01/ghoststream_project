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
const anthropic = require(path.join(SRC, 'anthropic.js'));
const aiRetry = require(path.join(SRC, 'aiRetry.js'));
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

// Drive the REAL seam down its ANTHROPIC branch, with only the SDK wrapper faked.
//
// Everything else in this file either stubs the seam (what a call site asks for)
// or fakes the Gemini client (what Gemini receives). Neither can see the params
// that exist only on the Claude side — `effort`, `thinking`, `allowTruncation`,
// the renamed `schema` — which is exactly the class of thing ADR-0006 §9 item 4
// records the SIBLING seam shipping broken: "allowTruncation was not forwarded".
//
// `flipTasks` lifts models.FLIP_BLOCKED for the duration. That set is a
// measurement, not a code fact, and a test that could not reach a blocked key
// would leave the blocked path — the one the whole gate is about — untested.
async function withAnthropic({ tasks, impl }, fn) {
  const sent = [];
  const realGenerate = anthropic.generate;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedEnv = tasks.map((t) => [models.providerEnvName(t), process.env[models.providerEnvName(t)]]);
  const savedBlocks = tasks.filter((t) => models.FLIP_BLOCKED.has(t)).map((t) => [t, models.FLIP_BLOCKED.get(t)]);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  for (const t of tasks) { process.env[models.providerEnvName(t)] = 'anthropic'; models.FLIP_BLOCKED.delete(t); }
  anthropic.generate = async (params) => { sent.push(params); return impl(params); };
  try { return await fn(sent); } finally {
    anthropic.generate = realGenerate;
    for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const [t, reason] of savedBlocks) models.FLIP_BLOCKED.set(t, reason);
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  }
}

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
  // (The `battlecard` membership assertion that used to sit here was a duplicate
  // of the loop above and could not fail on its own; the guard its comment
  // claimed — that extractBattlecard really resolves its own key — is the task
  // assertion in "assessment.js sends its two call sites to two DIFFERENT
  // tasks", which is what actually reddens when the half-done cutover is
  // simulated. A second copy of a passing assertion reads as extra coverage and
  // is none.)

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
    // Without tenantId the usage_costs row lands with tenant_id NULL and the
    // per-tenant rollup §6's margin table depends on silently loses the call —
    // the exact hole ADR-0006 §9 item 1 exists to close, and invisible in every
    // other assertion here because the answer still comes back.
    assert.deepStrictEqual(calls.map((c) => c.tenantId), ['t1', 't1', 't1']);
    // Claude-only knobs, which Gemini parity structurally cannot see: `effort`
    // is dropped on the Gemini branch and `allowTruncation` never reaches it.
    // Left to the seam defaults deliberately — see the seam-default test below
    // for why `effort` in particular is load-bearing for the flip gate.
    assert.deepStrictEqual(calls.map((c) => c.effort), [undefined, undefined, undefined],
      'these call sites take the seam default; passing one here would decouple them from it');
    assert.deepStrictEqual(calls.map((c) => c.allowTruncation), [undefined, undefined, undefined],
      'a truncated analysis must throw, not be parsed — service.js DELETES the stored ' +
      'payload when extraction returns null, so a half-answer accepted here is worse');
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
      // The two most expensive group-2 sites. Deleting `tenantId,` from either
      // one leaves every other assertion in this file green while their
      // usage_costs rows go to tenant_id NULL.
      assert.deepStrictEqual(calls.map((c) => c.tenantId), ['t1', 't1']);
      assert.deepStrictEqual(calls.map((c) => c.effort), [undefined, undefined],
        'both take the seam default; the flip gate argues about production sending "medium"');
      // allowTruncation matters most on the battlecard: it has no retry, so a
      // truncated answer accepted here is parsed and STORED as a battlecard
      // instead of surfacing as a 502. ADR-0006 §9 item 4 records the sibling
      // seam shipping exactly this defect by not forwarding the flag.
      assert.deepStrictEqual(calls.map((c) => c.allowTruncation), [undefined, undefined]);
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
  // try/finally, because geminiImpl is module state shared with every test
  // below: an assertion failure here would otherwise leave the next test driving
  // this test's fake responses, and the failure it reported would be the wrong
  // one. Same reason providerRouter.test.js restores its sets in a finally.
  try {

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

  } finally { geminiImpl = () => ({ text: '{}', usageMetadata: null }); }
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

// ── 4b. what the CLAUDE branch actually receives ────────────────────────────

test('a real flip sends the seam defaults — effort "medium", thinking off, no truncation', async () => {
  // `assessment` is the one group-2 key that is migrated AND not flip-blocked,
  // so this is the whole live path for it: env var → resolve → aiCall's
  // anthropic branch → the wrapper.
  //
  // `effort` is load-bearing far beyond determinism. The flip gate's whole
  // argument — in models.js and in ADR-0006 §9 item 5 — is that PRODUCTION sends
  // effort 'medium' while test/live/smoke.js sends 'low', which is why a green
  // smoke run does not clear a flip. Nothing asserted that production value, so
  // changing the seam default to 'low' left the suite green and quietly made
  // that argument false.
  dbRows = battlecardDb();
  await withAnthropic({
    tasks: ['assessment'],
    impl: () => ({ text: JSON.stringify(ASSESSMENT_ANSWER), usage: null, stopReason: 'end_turn', model: 'claude-haiku-4-5' }),
  }, async (sent) => {
    const out = await assessment.extractCompetitiveAssessment({
      text: 'x'.repeat(300), tenantId: 't1', competitorName: 'Acme',
    });
    assert.ok(out, 'the flip must actually produce a scoreboard');
    assert.strictEqual(sent.length, 1, 'one upstream generation, not a retry storm');
    const p = sent[0];
    assert.strictEqual(p.model, 'claude-haiku-4-5', 'assessment is LITE on claude');
    assert.strictEqual(p.effort, 'medium',
      'the seam default, and the value the flip gate\'s smoke-check argument compares against');
    assert.strictEqual(p.thinking, false, 'thinkingBudget:0 maps to thinking:false, not to disabled thinking');
    assert.ok(!p.allowTruncation, 'a truncated scoreboard must throw rather than normalize to garbage');
    assert.strictEqual(p.temperature, 0.25, 'Haiku 4.5 accepts it; dropping it here was a real determinism loss');
    assert.strictEqual(p.site, 'kb.assessment');
    assert.strictEqual(p.tenantId, 't1');
    // Gemini's spelling on the way in, Claude's on the way out — one vocabulary
    // at the seam, which is what keeps liveSchemaCoverage's token scan working.
    assert.strictEqual(p.schema, assessment.ASSESSMENT_SCHEMA);
  });
});

test('the MEASURED battlecard malformation: 502, attributed, and NOT retried', async () => {
  // This is the finding that put `battlecard` in FLIP_BLOCKED, and until now
  // nothing exercised it — the retry test above builds `new Error('down')` by
  // hand, which is the "errors built by hand" shape ADR-0006 §9 item 5 names as
  // the reason aiRetry.test.js could not fail.
  //
  // The malformation is the real one: valid-looking JSON with a trailing comma
  // inside an `objections` item, HTTP 200, stop_reason 'end_turn'.
  const MALFORMED = '{"verdictHeadline":"x","whereWeWin":[],"whereWeLose":[],' +
    '"talkTrack":[],"objections":[{"claim":"a","response":"b"},]}';
  dbRows = battlecardDb();
  let upstream = 0;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.map(String).join(' '));
  let err;
  try {
    await withAnthropic({
      tasks: ['battlecard'],
      impl: () => { upstream += 1; return { text: MALFORMED, usage: null, stopReason: 'end_turn', model: 'claude-sonnet-5' }; },
    }, async () => {
      err = await assessment.extractBattlecard('t1', 'c1').then(() => null, (e) => e);
    });
  } finally { console.warn = realWarn; }

  assert.ok(err, 'a malformed answer must not be swallowed on the rep-facing path');
  assert.strictEqual(err.status, 502, 'the route layer turns this into a 502 the rep sees');
  assert.strictEqual(upstream, 1,
    'un-retried by design — and this is the number the flip PR has to change, which is why ' +
    'it is pinned here rather than assumed');
  assert.ok(warnings.some((w) => /\[battlecard\] synthesis failed on anthropic/.test(w)),
    `the parse error must carry the provider that produced it: ${warnings.join(' | ')}`);

  // The load-bearing half: the OBVIOUS remediation does not work. aiCall stamps
  // the SyntaxError `provider: 'anthropic'`, and classify()'s anthropic branch
  // is `transient: !perDay && !sdkRetried && status === 429` — a parse error has
  // no status. So wrapping this call in aiRetry would retry it ZERO times and a
  // retry test would go green over an unchanged 2.5% failure rate (measured
  // 2 unparseable in 80 live extractBattlecard calls — ADR-0006 §9 item 5).
  const parseErr = await withAnthropic({
    tasks: ['battlecard'],
    impl: () => ({ text: MALFORMED, usage: null, stopReason: 'end_turn', model: 'claude-sonnet-5' }),
  }, async () => aiCall.generateStructured({
    task: 'battlecard', prompt: 'p', responseSchema: assessment.BATTLECARD_SCHEMA, site: 'kb.battlecard',
  }).then(() => null, (e) => e));
  assert.ok(parseErr instanceof SyntaxError, 'the seam surfaces the parse failure itself');
  assert.strictEqual(parseErr.provider, 'anthropic');
  assert.strictEqual(aiRetry.classify(parseErr).transient, false,
    'if this ever becomes true, a retry wrapper starts working and FLIP_BLOCKED can be revisited — ' +
    'until then, adding aiRetry.POLICIES.battlecard changes nothing but the appearance of a fix');
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
