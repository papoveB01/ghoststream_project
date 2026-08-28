// ADR-0006 §9 item 5, group 3 (the `research` half): knowledge/research.js on
// the provider seam.
//
// A sibling of cutoverGroup1/2.test.js rather than an extension, because what is
// specific to this group is not the swap — it is one call site, and the swap is
// four lines. What is specific is that the ONE call site is reached from TWO
// routes with opposite latency contracts under ONE aiRetry label:
//
//   1. THE GEMINI REQUEST DOES NOT MOVE. `research` gets no anthropicTier, so
//      Gemini must still receive the same model, budget, temperature, thinking
//      config and schema object it received before the seam existed. Asserted by
//      driving the REAL seam into a fake Gemini client, not by reading source.
//   2. THE MODEL IS RESOLVED PER CALL. research.js froze it at require time
//      (`modelFor('research')`) — the personas.js hazard of §9 item 4, fixed
//      three times before this one. Pinned BEHAVIOURALLY: the env var is set
//      after the module was required, and the fake client is asserted to see it.
//   3. THE RETRY BUDGET IS ONE POLICY OVER TWO CONTRACTS, and it was kept rather
//      than inherited. Both routes get 3 attempts; the arithmetic that says that
//      fits nginx's 180s window is at the call site, and the Claude half of it —
//      that the wrapper does NOT multiply a 120s Anthropic timeout by 3 — is
//      asserted here rather than quoted, because it is the load-bearing claim.
//   4. THE STORED `model` NAMES THE SERVING MODEL. prospect_research.models
//      carried a boot-time constant; it now carries what answered.
//
// The seam is exercised for real in (1), (2) and (4) and stubbed in (3).

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

// ── module stubs, installed BEFORE anything under test is required ──────────
//
// gemini.js pulls in redis.js, which opens an ioredis client at module load and
// retries forever with no Redis reachable — `node --test` then hangs rather than
// failing. research.js no longer requires it, but aiCall.js does, and aiCall's
// Gemini branch is half of what this file asserts. So the stub is a working fake
// client: `geminiCalls` is what the provider would have received on the wire.
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

// Postgres. research.js reads the company and the run row, keypoints.js reads
// tenant context, and reanalyze() writes the result back. Matched on a
// distinctive fragment of each statement, and every write is recorded rather
// than dropped — the stored `model` assertion below is about a write.
const dbWrites = [];
let dbRows = () => ({ rows: [] });
const dbPath = require.resolve(path.join(SRC, 'db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: {
    query: async (sql, params) => {
      if (/^\s*UPDATE/i.test(String(sql))) dbWrites.push({ sql: String(sql), params });
      return dbRows(String(sql), params);
    },
  },
};

// redis.js opens an ioredis client at module load. research.js reaches it
// through knowledge/apollo.js, and an open handle keeps `node --test` alive
// after the last assertion — the suite passes and then hangs, which is worse
// than failing. Nothing in this file exercises Apollo, so the client is faked
// away entirely rather than pointed at a server.
const redisPath = require.resolve(path.join(SRC, 'redis.js'));
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true, children: [], paths: [],
  exports: {
    getClient: () => ({ get: async () => null, set: async () => 'OK', incr: async () => 1, expire: async () => 1 }),
  },
};

// knowledge/service.js — required LAZILY by research.js (effectiveDossier and
// persistSynthesisDoc) to break the service↔web↔research import cycle. Stubbed
// so no document is listed, nothing is re-ingested, and no embedding is bought.
const servicePath = require.resolve(path.join(SRC, 'knowledge', 'service.js'));
require.cache[servicePath] = {
  id: servicePath, filename: servicePath, loaded: true, children: [], paths: [],
  exports: {
    listDocuments: async () => [],
    getDocumentText: async () => null,
    ingest: async () => ({ id: 'stub' }),
  },
};

const aiCall = require(path.join(SRC, 'aiCall.js'));
const models = require(path.join(SRC, 'models.js'));
const anthropic = require(path.join(SRC, 'anthropic.js'));
const aiRetry = require(path.join(SRC, 'aiRetry.js'));
const research = require(path.join(SRC, 'knowledge', 'research.js'));

const TENANT = 'dfb3aad7-t';
const COMPANY = '4183b2c3-c';

// A dossier long enough to clear reanalyze()'s `length < 100` guard, with one
// numbered source so semantics.citableNumbers has something to keep.
const DOSSIER = `## [1] Acme homepage\nURL: https://acme.test\n\n${'signal '.repeat(40)}`;

// The rows reanalyze() reads, in the order it reads them.
function researchDb() {
  return (sql) => {
    if (sql.includes('FROM companies')) return { rows: [{ company_id: COMPANY, name: 'Acme' }] };
    if (sql.includes('FROM prospect_research')) {
      return { rows: [{ id: 'r1', sources: [], dossier_md: DOSSIER, source_count: 1, opportunities: [] }] };
    }
    return { rows: [] };
  };
}

const ANSWER = {
  summary: 'Acme is scaling.',
  opportunities: [
    { title: 'Capacity — Volume surge', analysis: 'They are scaling fast.', products: ['Queue AI'], strength: 'strong', sources: [1] },
  ],
};

// Replace the seam itself, for the assertions that are about what the call site
// ASKS FOR rather than what a provider receives.
async function withSeam(impl, fn) {
  const real = aiCall.generateStructured;
  const calls = [];
  aiCall.generateStructured = async (args) => { calls.push(args); return impl(args); };
  try { return await fn(calls); } finally { aiCall.generateStructured = real; }
}

const ok = (parsed, model = 'gemini-2.5-flash', provider = 'gemini') => async () => ({
  parsed, text: JSON.stringify(parsed), usage: { totalTokenCount: 1 }, model, provider,
});

// Drive the REAL seam down its ANTHROPIC branch, with only the SDK wrapper
// faked. Neither the seam stub (what the call site asks for) nor the fake Gemini
// client (what Gemini receives) can see the params that exist only on the Claude
// side — `effort`, `thinking`, `allowTruncation`, the renamed `schema`.
//
// `flipTasks` lifts models.FLIP_BLOCKED for the duration even though `research`
// is not in it today: a helper that silently could not reach a blocked key is
// how the next group's test would go green over a gate it never exercised.
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

// ── 1. the key ──────────────────────────────────────────────────────────────

test('group 3 is dispatch-ready for `research`, and only for `research`', () => {
  assert.ok(models.DISPATCH_READY.has('research'),
    'its one call site was migrated in this PR, so it must be eligible');
  assert.ok(!models.FLIP_BLOCKED.has('research'),
    'nothing measured against the live provider blocks this key — 0 truncations in 141 calls ' +
    'through the real call site. If that changes, the entry goes in FLIP_BLOCKED with its number, ' +
    'and this assertion is what tells you to write one.');

  // The `ocr` half of the group is DEFERRED to its own decision PR, and this is
  // the machine-readable half of that statement: no `ocr` task key exists, so
  // nothing can route it and nothing can flip it. ADR-0006 §9 item 5 carries the
  // reason (free text, not structured output; Files API; no wrapper equivalent).
  assert.ok(!Object.prototype.hasOwnProperty.call(models.TASKS, 'ocr'),
    'group 3 was split: adding an `ocr` key is the ocr PR\'s job, not this one\'s');
  assert.ok(!models.DISPATCH_READY.has('ocr'));

  // Still not migrated, each for its own reason. `compare` matters most: it
  // shares knowledge/preview.js with an already-migrated key, so the file holds
  // one seam call and one direct Gemini call on purpose.
  for (const t of ['compare', 'discovery', 'marketWatch', 'brief']) {
    assert.ok(!models.DISPATCH_READY.has(t),
      `${t}'s call site still speaks to the Gemini SDK — adding it would 404 every call`);
  }
});

// ── 2. what the call site asks the seam for ────────────────────────────────

test('research.analyze goes through the seam as the `research` task', async () => {
  dbRows = researchDb();
  await withSeam(ok(ANSWER), async (calls) => {
    await research.reanalyze(TENANT, COMPANY);

    assert.strictEqual(calls.length, 1, 'analyze() is the ONE model call in this file');
    const c = calls[0];
    assert.strictEqual(c.task, 'research');
    assert.strictEqual(c.site, 'research.analyze',
      'the cost-telemetry label is unchanged, so usage_costs history stays one series');
    // The output budget and determinism setting the Gemini call site had. On
    // Claude maxTokens covers thinking too, but thinking is off, so it holds —
    // and it was measured at this call site before shipping (0 truncations in
    // 141 live claude-sonnet-5 calls, peak 2,406 of 2,600).
    assert.strictEqual(c.maxTokens, 2600);
    assert.strictEqual(c.temperature, 0.3);
    // Without tenantId the usage_costs row lands with tenant_id NULL and the
    // per-tenant rollup §6's margin table depends on silently loses the call.
    assert.strictEqual(c.tenantId, TENANT);
    // Claude-only knobs, which Gemini parity structurally cannot see. Left to
    // the seam defaults deliberately: `effort` is the value the flip gate's
    // smoke-check argument compares against, and `allowTruncation` unset is what
    // makes a truncated answer THROW instead of being stored as a synthesis.
    assert.strictEqual(c.effort, undefined,
      'this call site takes the seam default; passing one here would decouple it from that argument');
    assert.strictEqual(c.allowTruncation, undefined,
      'a truncated dossier synthesis must throw, not be parsed — half an opportunity list would be ' +
      'persisted as a research synthesis AND re-ingested as a retrievable KB document');
    // Identity, not shape: `responseSchema` keeps Gemini's spelling so
    // liveSchemaCoverage.test.js's scan for the literal token still finds it.
    assert.strictEqual(c.responseSchema, research.ANALYSIS_SCHEMA);
  });
});

// ── 3. what GEMINI receives, which must not have moved ─────────────────────

test('[GEMINI-PARITY] research.analyze still sends Gemini exactly what it did before', async () => {
  // `research` gets no anthropicTier, so nothing about its Gemini resolution
  // changed — and Gemini serves 100% of this traffic today. A cutover PR that
  // changes this request is changing live behaviour under cover of a provider
  // swap, and a per-file diff cannot show it, because the request is now
  // assembled in aiCall.js from arguments spread across two other files.
  //
  // Driven through the REAL seam so what is compared is the object handed to
  // @google/genai, not the arguments on the way in.
  geminiCalls.length = 0;
  geminiImpl = () => ({ text: JSON.stringify(ANSWER), usageMetadata: { totalTokenCount: 7 } });
  dbRows = researchDb();
  // try/finally, because geminiImpl is module state shared with every test
  // below: an assertion failure here would otherwise leave the next test driving
  // this test's fake responses, and the failure it reported would be the wrong one.
  try {
    await research.reanalyze(TENANT, COMPANY);

    assert.strictEqual(geminiCalls.length, 1,
      `expected one generateContent for the one call site, got ${geminiCalls.length}`);
    const req = geminiCalls[0];
    // The model the deleted require-time constant would have held, resolved now.
    assert.strictEqual(req.model, models.modelFor('research'),
      'the Gemini branch must still get the `research` task\'s Gemini model');
    assert.match(req.model, /^gemini-/, 'the Gemini branch must never be handed a Claude id');
    assert.deepStrictEqual(req.config, {
      maxOutputTokens: 2600,
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: research.ANALYSIS_SCHEMA,
    }, 'research.analyze changed what Gemini receives');
    assert.strictEqual(req.contents.length, 1);
    assert.strictEqual(req.contents[0].role, 'user');
    // The prompt is assembled by the call site, not the seam: dossier in, and
    // the schema-bearing instruction with it.
    assert.ok(req.contents[0].parts[0].text.includes('RESEARCH DOSSIER — Acme'));
  } finally { geminiImpl = () => ({ text: '{}', usageMetadata: null }); }
});

test('the model is resolved PER CALL, not frozen when the module was required', async () => {
  // research.js captured it at require time (`const MODEL =
  // modelFor('research')`), which is the personas.js hazard of ADR-0006 §9 item
  // 4 and the same freeze group 2 removed from keypoints.js and assessment.js.
  // This module was required at the top of this file, long before the override
  // below existed — so if the constant were still there, this env var could not
  // reach the wire. A test that read a constant instead would pass either way.
  const saved = process.env.GEMINI_RESEARCH_MODEL;
  geminiCalls.length = 0;
  geminiImpl = () => ({ text: JSON.stringify(ANSWER), usageMetadata: null });
  dbRows = researchDb();
  try {
    process.env.GEMINI_RESEARCH_MODEL = 'gemini-resolved-at-call-time';
    await research.reanalyze(TENANT, COMPANY);
    assert.strictEqual(geminiCalls[0].model, 'gemini-resolved-at-call-time');
  } finally {
    if (saved === undefined) delete process.env.GEMINI_RESEARCH_MODEL;
    else process.env.GEMINI_RESEARCH_MODEL = saved;
    geminiImpl = () => ({ text: '{}', usageMetadata: null });
  }
});

// ── 4. the retry budget: one policy, two contracts ─────────────────────────

test('the synchronous reanalyze route retries a transient failure 3 times, deliberately', async () => {
  // §9 item 5: the seam does not retry, so every forLabel() binding is a
  // caller's decision — and moving this call site onto the seam made the wrapper
  // a live choice again rather than a property of the code it replaced. It was
  // KEPT on the default policy, and the number is pinned here because "we
  // decided 3 is fine on a synchronous route" is exactly the kind of claim
  // ADR-0006 has twice found living only in a comment.
  //
  // The arithmetic it rests on, measured 2026-08-28: gemini-2.5-flash answers
  // this call site in max 6.0s (n=10), so 3 attempts plus the worst backoff the
  // 30s cap allows is ~78s against nginx's 180s proxy_read_timeout.
  dbRows = researchDb();
  let attempts = 0;
  await withSeam(async () => { attempts += 1; throw new Error('503 UNAVAILABLE'); }, async () => {
    const err = await research.reanalyze(TENANT, COMPANY).then(() => null, (e) => e);
    assert.ok(err, 'a persistent transient must surface, not be swallowed into an empty synthesis');
  });
  assert.strictEqual(attempts, aiRetry.DEFAULT_TRIES,
    'research keeps its aiRetry wrapper on the default policy — and the route it has to fit is ' +
    'the synchronous one');
  assert.strictEqual(aiRetry.DEFAULT_TRIES, 3, 'if this stops being 3 the 180s arithmetic changes');
});

test('one transient then success costs the reanalyze route one extra attempt, not the run', async () => {
  // The wrapper is worth having, not just present: the retried call succeeds and
  // the rep gets their synthesis. On the fire-and-forget route the same retry is
  // what stops a transient 503 spending a PRE-CHARGED research unit on a FAILED row.
  dbRows = researchDb();
  let attempts = 0;
  await withSeam(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('503 UNAVAILABLE');   // classify() → transient
    return { parsed: ANSWER, text: JSON.stringify(ANSWER), usage: null, model: 'gemini-2.5-flash', provider: 'gemini' };
  }, async () => {
    const out = await research.reanalyze(TENANT, COMPANY);
    assert.ok(out !== undefined, 'the retried call must actually produce a result');
  });
  assert.strictEqual(attempts, 2);
});

test('after a flip the wrapper does NOT multiply the Anthropic timeout by three', async () => {
  // THE LOAD-BEARING HALF OF THE 180s ARGUMENT. 3 x ANTHROPIC_TIMEOUT_MS (120s)
  // plus backoff is 366s, well past nginx's window — the shape §9 item 4 found
  // on proposals.js. It does not happen, because classify()'s Anthropic branch
  // is `transient: !perDay && !sdkRetried && status === 429`: a truncated or
  // malformed answer carries no 429, so the app layer takes one attempt.
  //
  // Asserted with the two failures this call site can actually produce on
  // Claude, both driven through the REAL seam so the stamping is real — the
  // "errors built by hand" shape ADR-0006 §9 item 5 names as the reason
  // aiRetry.test.js could not fail.
  dbRows = researchDb();

  // (a) a truncated answer — what a 2600-token budget would produce on a dossier
  //     richer than any measured. anthropic.generate throws 502/truncated.
  let upstream = 0;
  let err = await withAnthropic({
    tasks: ['research'],
    impl: () => {
      upstream += 1;
      const e = new Error('Claude hit the 2600-token output budget and the answer is incomplete.');
      e.status = 502; e.truncated = true; e.provider = 'anthropic'; e.sdkRetried = false;
      throw e;
    },
  }, async () => research.reanalyze(TENANT, COMPANY).then(() => null, (x) => x));
  assert.ok(err, 'a truncated synthesis must surface');
  assert.strictEqual(upstream, 1,
    'one attempt — three would be 366s of wall clock on a route nginx cuts at 180s');
  assert.strictEqual(aiRetry.classify(err).transient, false,
    'if this ever becomes true, the 180s bound at this call site stops holding and the retry ' +
    'budget has to be re-argued before a flip');

  // (b) a malformed answer — the mode measured on `battlecard` (2 of 80). The
  //     seam stamps the SyntaxError itself, which is what keeps it out of the
  //     Gemini message-scraper.
  upstream = 0;
  err = await withAnthropic({
    tasks: ['research'],
    impl: () => { upstream += 1; return { text: '{"summary":"x","opportunities":[},]}', usage: null, stopReason: 'end_turn', model: 'claude-sonnet-5' }; },
  }, async () => research.reanalyze(TENANT, COMPANY).then(() => null, (x) => x));
  assert.ok(err instanceof SyntaxError, 'the seam surfaces the parse failure itself');
  assert.strictEqual(err.provider, 'anthropic',
    'unstamped, this would fall into the Gemini branch and be message-scraped');
  assert.strictEqual(upstream, 1);
});

// ── 5. what the CLAUDE branch actually receives ────────────────────────────

test('a real flip sends claude-sonnet-5 the seam defaults — effort "medium", thinking off', async () => {
  // The whole live path for this key: env var → resolve → aiCall's anthropic
  // branch → the wrapper. `effort` is load-bearing far beyond determinism — the
  // flip gate's argument in models.js and ADR-0006 §9 item 5 is that PRODUCTION
  // sends 'medium' while test/live/smoke.js sends 'low', which is why a green
  // smoke run does not clear a flip.
  dbRows = researchDb();
  await withAnthropic({
    tasks: ['research'],
    impl: () => ({ text: JSON.stringify(ANSWER), usage: null, stopReason: 'end_turn', model: 'claude-sonnet-5' }),
  }, async (sent) => {
    await research.reanalyze(TENANT, COMPANY);
    assert.strictEqual(sent.length, 1, 'one upstream generation, not a retry storm');
    const p = sent[0];
    assert.strictEqual(p.model, 'claude-sonnet-5',
      '`research` is tier flash, which is Sonnet 5 on Claude — no anthropicTier override needed');
    assert.strictEqual(p.effort, 'medium',
      'the seam default, and the value the flip gate\'s smoke-check argument compares against');
    assert.strictEqual(p.thinking, false,
      'thinkingBudget:0 maps to thinking:false here, not to disabled adaptive thinking');
    assert.strictEqual(p.maxTokens, 2600,
      'the budget the n=141 truncation measurement was taken at — change it and that number expires');
    assert.ok(!p.allowTruncation, 'a truncated synthesis must throw rather than be stored');
    // Sent, and dropped by the wrapper on this model with a warning. Passing it
    // is what keeps Gemini's determinism setting live.
    assert.strictEqual(p.temperature, 0.3);
    assert.strictEqual(p.site, 'research.analyze');
    assert.strictEqual(p.tenantId, TENANT);
    // Gemini's spelling on the way in, Claude's on the way out.
    assert.strictEqual(p.schema, research.ANALYSIS_SCHEMA);
  });
});

// ── 6. what lands in stored payloads ───────────────────────────────────────

test('prospect_research.models names the model that SERVED the call, not a constant', async () => {
  // It was a require-time constant, so after a flip every row would have been
  // stamped with the model of whichever provider the process booted against —
  // and both writers (run() and reanalyze()) used the same one. Nothing in web/
  // reads this column; it is diagnostic. That is what makes re-pointing it safe
  // for rows already stored, and it is also why nothing else would catch it
  // being wrong.
  dbRows = researchDb();
  dbWrites.length = 0;
  await withSeam(ok(ANSWER, 'claude-sonnet-5', 'anthropic'), async () => {
    await research.reanalyze(TENANT, COMPANY);
  });
  const write = dbWrites.find((w) => w.sql.includes('prospect_research') && w.sql.includes('models'));
  assert.ok(write, 'reanalyze must persist the run');
  // Picked by SHAPE, not by substring: the `opportunities` payload in the same
  // statement also contains the token "analysis" (it is a field on every
  // opportunity), so a substring match reads the wrong parameter and reports
  // `undefined` for a stamp that is present.
  const stamped = write.params
    .filter((p) => typeof p === 'string' && p.startsWith('{'))
    .map((p) => { try { return JSON.parse(p); } catch { return null; } })
    .find((o) => o && Object.prototype.hasOwnProperty.call(o, 'hadPortfolio'));
  assert.ok(stamped, 'the models column must carry the analysis stamp');
  assert.strictEqual(stamped.analysis, 'claude-sonnet-5',
    'the stamp is the serving model handed back by the seam, not modelFor() at boot');
  assert.strictEqual(stamped.reanalyzed, true);
});
