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

// knowledge/web.js — Firecrawl. Stubbed so the FIRE-AND-FORGET route can be
// driven end to end without a network call: `run()` refuses outright unless
// isConfigured() is true, and then needs gatherSources to produce at least one
// source or it throws "no public sources found" before ever reaching the model.
const webPath = require.resolve(path.join(SRC, 'knowledge', 'web.js'));
require.cache[webPath] = {
  id: webPath, filename: webPath, loaded: true, children: [], paths: [],
  exports: {
    isConfigured: () => true,
    isBraveConfigured: () => false,
    mapSite: async () => [],
    // null markdown → the source is recorded snippet-only, which is enough for
    // buildDossier and keeps this stub from having to invent page text.
    scrapeMarkdown: async () => null,
    search: async () => [{ url: 'https://acme.test/news', title: 'Acme raises', description: 'a signal', publishedTime: null }],
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

// The real SDK, for its real exception classes: `translateError` branches on
// `instanceof Anthropic.RateLimitError`, so a hand-built error would take the
// catch-all and prove nothing about the 429 path.
const Anthropic = require('@anthropic-ai/sdk');

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

// The rows start() → run() reads, in the order it reads them. Deliberately NOT
// researchDb(): start() short-circuits and returns an existing RUNNING row if
// one comes back, so a stub that answers every prospect_research SELECT with a
// row would make this test pass by never running anything.
function runDb() {
  return (sql) => {
    if (sql.includes('FROM companies')) return { rows: [{ id: COMPANY, name: 'Acme', domain: null }] };
    if (sql.includes("status = 'RUNNING'")) return { rows: [] };                 // no run in flight
    if (sql.includes('INSERT INTO prospect_research')) return { rows: [{ id: 'r1' }] };
    if (sql.includes('SELECT opportunities')) return { rows: [] };               // no pins
    return { rows: [] };
  };
}

// Resolve when a recorded write matches — the fire-and-forget route's only
// observable, since start() returns before run() has done anything.
function onWrite(predicate, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const w = dbWrites.find(predicate);
      if (w) return resolve(w);
      if (Date.now() - t0 > 20000) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const ANSWER = {
  summary: 'Acme is scaling.',
  opportunities: [
    { title: 'Capacity — Volume surge', analysis: 'They are scaling fast.', products: ['Queue AI'], strength: 'strong', sources: [1] },
  ],
};

// Re-require anthropic.js under a different ANTHROPIC_MAX_RETRIES and hand the
// FRESH module to `fn`, then put the original back.
//
// It has to be a re-require: SDK_RETRIES_AT_ALL is a module-level const read at
// load time, so setting the env var afterwards changes nothing. Same technique
// anthropicRetrySeam.test.js already uses for the same constant.
//
// The cache entry is SAVED and RESTORED rather than just deleted: aiCall.js
// holds a reference to the original module object, and every other test in this
// file drives that one. Leaving a second instance in the cache would make
// `withAnthropic`'s stub land on a module nothing calls.
async function withFreshAnthropic(maxRetries, fn) {
  const p = require.resolve(path.join(SRC, 'anthropic.js'));
  const savedMod = require.cache[p];
  const savedEnv = process.env.ANTHROPIC_MAX_RETRIES;
  try {
    if (maxRetries === undefined) delete process.env.ANTHROPIC_MAX_RETRIES;
    else process.env.ANTHROPIC_MAX_RETRIES = maxRetries;
    delete require.cache[p];
    return await fn(require(p));
  } finally {
    delete require.cache[p];
    require.cache[p] = savedMod;
    if (savedEnv === undefined) delete process.env.ANTHROPIC_MAX_RETRIES;
    else process.env.ANTHROPIC_MAX_RETRIES = savedEnv;
  }
}

// Set env vars for the duration, restoring exactly — including deleting keys
// that were absent, which a naive save/restore turns into `'undefined'`.
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

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

  // These two assertions ENCODE A DECISION, not a pause. The `ocr` half of the
  // group was split off and then decided on 2026-08-29: OCR stays on Gemini
  // indefinitely — ADR-0006 §4.8, the same STANDING form §4.2 uses for
  // embeddings, though not the same kind of permanence (§4.2's is structural,
  // §4.8's is contingent on evidence it names). So the absence of the key is the machine-readable half of that
  // decision: no `ocr` task key exists, nothing can route it, nothing can flip
  // it. Adding one is what REVERSING §4.8 looks like in code, and §4.8 names
  // what would justify that (evidence the Gemini transcriptions are bad, or
  // Gemini changing its PDF/Files API handling) — a red line here means someone
  // is doing that, deliberately or otherwise. Both were re-proved able to fail
  // when §4.8 landed: adding an `ocr` key to models.TASKS reds the first, and
  // adding `ocr` to DISPATCH_READY reds the second.
  assert.ok(!Object.prototype.hasOwnProperty.call(models.TASKS, 'ocr'),
    'ADR-0006 §4.8 decided OCR stays on Gemini indefinitely — an `ocr` key is the reversal of a ' +
    'standing decision, not the next step of this migration. Read §4.8 before you add one.');
  assert.ok(!models.DISPATCH_READY.has('ocr'),
    'same decision, second half: ADR-0006 §4.8 keeps `ocr` out of the router entirely, so it can ' +
    'never become dispatch-eligible. If you are here from a red run, §4.8 is what you are changing.');

  // Still not migrated, each for its own reason. `compare` IS NO LONGER ONE OF
  // THEM: this loop used to carry it, with a comment saying knowledge/preview.js
  // deliberately held one seam call and one direct Gemini call because its two
  // keys sat in different groups. Group 4 (PR A) migrated it, so that sentence
  // and this assertion both stopped being true in the same commit — which is
  // why this list is edited here rather than being left to fail as a surprise
  // in someone else's PR. cutoverGroup4.test.js now asserts the positive.
  for (const t of ['discovery', 'marketWatch', 'brief']) {
    assert.ok(!models.DISPATCH_READY.has(t),
      `${t}'s call site still speaks to the Gemini SDK — adding it would 404 every call`);
  }
});

// The two assertions above are keyed on the STRING `ocr`, and that is a narrower
// fence than §4.8 needs. They say nothing about knowledge/ocr.js itself, which
// can be moved to Claude without either of them noticing — three ways, all three
// green at 405/405 before this test existed:
//
//   1. re-point its constant at a key that IS dispatch-ready:
//      `OCR_MODEL = process.env.GEMINI_OCR_MODEL || require('../models').modelFor('research')`
//      After that, OCR follows AI_PROVIDER_RESEARCH — the exact variable group
//      3's runbook tells an operator to set. No `ocr` string appears anywhere.
//   2. give it its own AI_PROVIDER_OCR / ANTHROPIC_OCR_MODEL branch, without a
//      TASKS entry — or one keyed on any other env var, which is the same shape.
//   3. resolve PER CALL: leave the exported OCR_MODEL constant alone and pick
//      the model inside generateFromParts. Every request then goes out on a
//      Claude id while the constant still reads `gemini-2.5-flash`.
//
// SHAPE 3 IS THE ONE TO WORRY ABOUT, and the first version of this test missed
// it while claiming otherwise. ADR-0006 §9 item 4 deliberately moved every OTHER
// task off require-time resolution, so per-call is the idiom a future OCR port
// would reach for first. A guard that reads the constant is looking at the one
// place such a port would leave untouched.
//
// So this pins the property §4.8 actually decided — THE MODEL THIS FILE SENDS IS
// A GEMINI ONE — at BOTH points, with the router told to prefer Claude in every
// way it can be told:
//
//   - the exported constant, on a fresh require. Cheap, and its failure names
//     the resolved id.
//   - THE MODEL THAT REACHES THE WIRE, by running ocrPdf() against the fake
//     client at the top of this file and reading the `model` it was handed.
//     Indifferent to WHERE the id came from — constant, per-call, router,
//     override — so it covers shapes 1-3 alike. It also fails if the request
//     reaches no Gemini client at all, which is the only way to notice a port
//     onto another SDK. That assertion is load-bearing rather than decorative:
//     weaken it to the id check alone and a full Anthropic-SDK port is GREEN,
//     one test-insertion away — at this block's current position the port
//     happens to throw a TypeError on an empty geminiCalls, but move the block
//     after the research tests and the array is already populated, so the
//     weakened guard reads someone else's call and passes.
//
//     Pinning the count to `before + 1` is what makes reading
//     `geminiCalls[length - 1]` sound: it proves the entry IS the call ocrPdf
//     made, so the assertion does not depend on where this block sits.
//
// WHAT IT STILL DOES NOT COVER, stated rather than implied, because the first
// version of this comment claimed to cover "any env var it does not name" and
// that is false. TWO shapes survive it, both measured, both green:
//
//   a. A per-call branch keyed on an env var this test does not SET —
//      `model: process.env.KB_OCR_PROVIDER === 'anthropic' ? 'claude-opus-5' : OCR_MODEL`
//      resolves Gemini here and Claude in production: 13/13.
//   b. A DECOY: leave one throwaway Gemini call on OCR_MODEL in
//      generateFromParts and send the real transcription to anthropic.generate.
//      The count is still exactly `before + 1` and the id on it is still a
//      `gemini-` one: 13/13. The guard proves a Gemini call HAPPENED carrying a
//      Gemini id; it does not prove that call carried the PDF.
//
// (a) is the accidental shape and (b) is a deliberate one, which is why neither
// changes the decision to stop here. No executing guard can close (a): the space
// of env names is unbounded and a test can only set names it knows. The
// strongest counter-proposal — deepStrictEqual over the SET of process.env reads
// in this one file, which is bounded and reds only on a visible diff — was
// considered and declined: `process.env['KB_' + 'OCR_PROVIDER']` walks through
// it, and it is the source-text-scrape form this repo has now watched rot
// through three generations of prose guard. Closing (b) means asserting the
// request carried the document, which is more test logic than the risk earns.
//
// What closes both is a reviewer seeing a new env read, or a second model call,
// appear in a file whose entire subject is that it does neither — a diff a human
// looks at. Hence: this decision cannot be reversed QUIETLY. Not that it cannot
// be reversed.
//
// Both assert the PROVIDER FAMILY, not a literal id, so a legitimate
// GEMINI_MODEL / GEMINI_OCR_MODEL override does not red them — a Gemini id is a
// Gemini id, and pinning `gemini-2.5-flash` here would carry the same
// deployment-env residual the [GEMINI-PARITY] pin below documents, for no gain.
//
// They ask models.providerOfModel() rather than matching /^gemini-/, because
// that is what "provider family" MEANS in this codebase and an anchored prefix
// is not it: providerOfModel uses includes('gemini') on purpose, since ids can
// be prefixed. A deployment setting GEMINI_MODEL=models/gemini-2.5-flash — an
// env this test does NOT clear, unlike GEMINI_OCR_MODEL — would red an anchored
// match on a completely correct configuration. Asking the router is strictly
// better on both sides: it reds on the same ports and greens on the same
// legitimate overrides the router itself accepts.
test('OCR sends a GEMINI model even with the router told to prefer Claude (ADR-0006 §4.8)', async () => {
  const ocrPath = require.resolve(path.join(SRC, 'knowledge', 'ocr.js'));
  const KEYS = [
    'AI_PROVIDER', 'AI_PROVIDER_OCR', 'AI_PROVIDER_RESEARCH',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_OCR_MODEL', 'GEMINI_OCR_MODEL', 'GEMINI_API_KEY',
  ];
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  // Lift FLIP_BLOCKED for the duration, the way withAnthropic() above does and
  // for the same reason. Without this, "the router told to prefer Claude every
  // way it can be told" is false for any blocked key: providerFor() falls back
  // to Gemini for `battlecard` and `keypoints` regardless of AI_PROVIDER, so
  // re-pointing OCR_MODEL at modelFor('battlecard') — reversal shape 1, with a
  // blocked key — resolves a Gemini id and passes GREEN. That is latent only
  // because those two keys happen to be blocked today; FLIP_BLOCKED is
  // temporary by design (models.js), and the day a key leaves it, OCR would
  // silently follow it onto Claude with this test still green.
  const savedBlocks = new Map(models.FLIP_BLOCKED);
  // Everything an operator could set that ought NOT to move this file.
  process.env.AI_PROVIDER = 'anthropic';
  process.env.AI_PROVIDER_OCR = 'anthropic';
  process.env.AI_PROVIDER_RESEARCH = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key';
  process.env.ANTHROPIC_OCR_MODEL = 'claude-opus-5';
  // ocrPdf returns null immediately without this, and a guard that never
  // reaches the client would pass on a file that had been ported outright.
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  // Cleared so the assertion is about what the file RESOLVES, not about an
  // override happening to be a Gemini id.
  delete process.env.GEMINI_OCR_MODEL;
  models.FLIP_BLOCKED.clear();
  delete require.cache[ocrPath];
  try {
    const ocr = require(ocrPath);
    assert.strictEqual(models.providerOfModel(ocr.OCR_MODEL), 'gemini',
      `knowledge/ocr.js resolved "${ocr.OCR_MODEL}" with AI_PROVIDER=anthropic. ADR-0006 §4.8 ` +
      'decided OCR stays on Gemini indefinitely: this file must not take its model from the task ' +
      'router, from another task\'s key, or from an ANTHROPIC_* override. Reversing that decision ' +
      'means amending §4.8, not making this assertion pass.');

    // …and the same property where it actually bites. Small buffer on purpose:
    // above INLINE_MAX_BYTES this would take the Files API branch, which the
    // fake client has no `files` for, and a thrown-and-swallowed error would
    // make this assertion vacuous rather than red.
    const before = geminiCalls.length;
    await ocr.ocrPdf(Buffer.from('%PDF-1.4 stand-in for a scanned page'), { tenantId: null });
    assert.strictEqual(geminiCalls.length, before + 1,
      'ocrPdf reached no client at all, so the wire assertion below would prove nothing. If OCR ' +
      'was moved to another SDK, that is the finding — this fake client is the GEMINI one.');
    assert.strictEqual(models.providerOfModel(geminiCalls[geminiCalls.length - 1].model), 'gemini',
      `knowledge/ocr.js sent "${geminiCalls[geminiCalls.length - 1].model}" to the model client ` +
      'with AI_PROVIDER=anthropic. This assertion reads the REQUEST, not the exported constant, ' +
      'so it also covers a model resolved per call inside generateFromParts — the shape ADR-0006 ' +
      '§9 item 4 pushed every other task towards, and therefore the likeliest way OCR gets ported ' +
      'by accident. §4.8 is what a real port has to amend.');

    // Deliberately NOT re-asserting `!('ocr' in models.TASKS)` here. The first
    // test in this file already does, models.TASKS is a static object literal
    // that nothing writes to, and models.js is not re-required in this block —
    // so a copy here could not fail for a reason the earlier one would miss. It
    // read as "no key appeared while it resolved"; nothing in this block can
    // make one appear.
  } finally {
    delete require.cache[ocrPath];
    models.FLIP_BLOCKED.clear();
    for (const [t, reason] of savedBlocks) models.FLIP_BLOCKED.set(t, reason);
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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
    // GEMINI_RESEARCH_MODEL cleared for the duration: it is a per-task override
    // read on every resolve, so an ambient one in a developer's or CI's env
    // would silently redefine what "unchanged" means. Cleared, an override makes
    // this a false RED (someone re-reads the pin) rather than a false GREEN.
    await withEnv({ GEMINI_RESEARCH_MODEL: undefined }, () => research.reanalyze(TENANT, COMPANY));

    assert.strictEqual(geminiCalls.length, 1,
      `expected one generateContent for the one call site, got ${geminiCalls.length}`);
    const req = geminiCalls[0];
    // A LITERAL, not `models.modelFor('research')`. Comparing the wire value
    // against a live re-derivation of the function that produced it is a
    // tautology: any change that moves both together is invisible. Two
    // mutations proved it — re-tiering `research` flash→lite (with
    // anthropicTier preserving the Claude side) and repointing models.js's
    // FLASH constant — each moves 100% of today's real traffic and each left
    // this file green. Every other field here is pinned by a literal; this one
    // was the odd one out, on the single property the whole staged cutover
    // rests on. Same shape providerRouter.test.js already uses for `keypoints`
    // and `battlecard`.
    //
    // The residual: TIERS.gemini.flash is `process.env.GEMINI_MODEL ||
    // 'gemini-2.5-flash'`, captured at models.js require time, so a deployment
    // that overrides GEMINI_MODEL reds this. That is the safe direction and the
    // same exposure the two group-2 pins already carry.
    assert.strictEqual(req.model, 'gemini-2.5-flash',
      '`research` is tier flash on Gemini and must resolve to exactly the model it did before ' +
      'this PR — re-tiering it, or repointing the flash tier, is a live change to 100% of this ' +
      'traffic and is what this literal exists to catch');
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
  // 30s cap allows is ~78s against nginx's 180s proxy_read_timeout. That is the
  // GEMINI bound; the Claude one is conditional and is tested separately below.
  //
  // COUNTED AT THE WIRE, NOT AT THE SEAM. An earlier version of this test stubbed
  // aiCall.generateStructured and counted invocations of it, which assumes the
  // thing it should assert: that one seam call is one upstream generation. A
  // retry loop added inside the seam's Gemini branch makes it 3 × 2 = SIX
  // metered generations for one logical call — double the spend and double the
  // wall clock the 78s figure is computed from — and a seam-level counter
  // reports 3 and stays green. So the real seam runs, the fake @google/genai
  // client throws, and `geminiCalls` is what actually went to the provider.
  // (Test 7 already does this on the Claude side; this is the missing half.)
  geminiCalls.length = 0;
  geminiImpl = () => { throw new Error('503 UNAVAILABLE'); };
  dbRows = researchDb();
  try {
    const err = await research.reanalyze(TENANT, COMPANY).then(() => null, (e) => e);
    assert.ok(err, 'a persistent transient must surface, not be swallowed into an empty synthesis');
  } finally { geminiImpl = () => ({ text: '{}', usageMetadata: null }); }
  assert.strictEqual(geminiCalls.length, aiRetry.DEFAULT_TRIES,
    `research keeps its aiRetry wrapper on the default policy, and each attempt must be exactly ` +
    `one upstream generation — got ${geminiCalls.length} for ${aiRetry.DEFAULT_TRIES} attempts`);
  assert.strictEqual(aiRetry.DEFAULT_TRIES, 3, 'if this stops being 3 the 180s arithmetic changes');
});

test('one transient then success costs the reanalyze route one extra attempt, not the run', async () => {
  // The wrapper is worth having, not just present: the retried call succeeds and
  // the rep gets their synthesis. On the fire-and-forget route the same retry is
  // what stops a transient 503 spending a PRE-CHARGED research unit on a FAILED row.
  //
  // Also counted at the wire, for the reason above.
  geminiCalls.length = 0;
  dbRows = researchDb();
  let n = 0;
  geminiImpl = () => {
    n += 1;
    if (n === 1) throw new Error('503 UNAVAILABLE');   // classify() → transient
    return { text: JSON.stringify(ANSWER), usageMetadata: null };
  };
  try {
    const out = await research.reanalyze(TENANT, COMPANY);
    assert.ok(out !== undefined, 'the retried call must actually produce a result');
  } finally { geminiImpl = () => ({ text: '{}', usageMetadata: null }); }
  assert.strictEqual(geminiCalls.length, 2,
    'one retry, one upstream generation each — not one seam call that fans out');
});

test('after a flip a truncated or malformed answer takes ONE attempt, unconditionally', async () => {
  // HALF OF THE 180s ARGUMENT, and the unconditional half. 3 ×
  // ANTHROPIC_TIMEOUT_MS (120s) plus backoff is 366s, well past nginx's window —
  // the shape §9 item 4 found on proposals.js. It does not happen for these two,
  // because classify()'s Anthropic branch is `transient: !perDay && !sdkRetried
  // && status === 429` and neither carries a 429.
  //
  // THE OTHER HALF IS CONDITIONAL AND IS THE NEXT TEST. A 429 *is* transient
  // here whenever the SDK did not retry it, so "the wrapper is effectively one
  // attempt after a flip" is true only under a precondition. This test used to
  // be named as though it covered that, while exercising only the two errors
  // that structurally cannot reach the transient branch.
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

test('a 429 IS retried here whenever the SDK did not — ANTHROPIC_MAX_RETRIES >= 1 is a flip precondition', async () => {
  // THE CONDITIONAL HALF OF THE 180s ARGUMENT, and the one status this branch
  // actually treats as transient. Nothing exercised it: the test above uses the
  // two errors that carry no 429, so the claim "effectively one attempt after a
  // flip" rested on an untested precondition.
  //
  // The stamp is produced by the REAL translateError from a REAL SDK
  // RateLimitError at each setting — not built by hand, which is the shape
  // ADR-0006 §9 item 5 names as the reason aiRetry.test.js could not fail. Only
  // the transport is faked.
  //
  //   ANTHROPIC_MAX_RETRIES unset (default 2) → the SDK retried, stamp true,
  //     app layer stands down: 1 attempt. This is the assumed case.
  //   ANTHROPIC_MAX_RETRIES=0 → a permitted value that anthropic.js's own
  //     DEFAULT_TIMEOUT_MS note RECOMMENDS for user-facing routes. The stamp is
  //     honestly false, so the retry moves up a layer: 3 attempts, i.e. 3 ×
  //     ANTHROPIC_TIMEOUT_MS on a route nginx cuts at 180s.
  //   `x-should-retry: false` at DEFAULT settings → sdkRetriesStatus subtracts
  //     exactly this from the SDK's retryable set, correctly. So aiRetry's "the
  //     SDK's retryable set is a superset of ours" is false for this one case,
  //     and it reaches the app layer transient: 3 attempts.
  dbRows = researchDb();

  const rateLimit = (headers) => Anthropic.APIError.generate(
    429,
    { error: { type: 'rate_limit_error', message: 'rate limit exceeded' } },
    'rate limit exceeded',
    headers,
  );

  async function attemptsFor({ maxRetries, headers }) {
    const stamped = await withFreshAnthropic(maxRetries, (fresh) => fresh.translateError(rateLimit(headers)));
    assert.strictEqual(stamped.status, 429, 'a real RateLimitError must translate to 429');
    assert.strictEqual(stamped.provider, 'anthropic');
    let upstream = 0;
    await withAnthropic({
      tasks: ['research'],
      impl: () => { upstream += 1; throw stamped; },
    }, async () => research.reanalyze(TENANT, COMPANY).then(() => null, (x) => x));
    return { upstream, stamped };
  }

  const dflt = await attemptsFor({ maxRetries: undefined, headers: new Headers() });
  assert.strictEqual(dflt.stamped.sdkRetried, true, 'at the default the client really did retry');
  assert.strictEqual(dflt.upstream, 1,
    'the app layer stands down when the client already retried — this is the ONLY configuration ' +
    'in which the flip-safety argument for the synchronous route holds');

  const zero = await attemptsFor({ maxRetries: '0', headers: new Headers() });
  assert.strictEqual(zero.stamped.sdkRetried, false,
    'a client told never to retry must not claim it did');
  assert.strictEqual(zero.upstream, aiRetry.DEFAULT_TRIES,
    'at ANTHROPIC_MAX_RETRIES=0 the retry moves up to this wrapper — 3 x ANTHROPIC_TIMEOUT_MS ' +
    'on a synchronous route behind a 180s proxy_read_timeout. That is why >= 1 is a documented ' +
    'flip precondition in .env.example and in research.js, and why it is asserted here');

  const noRetryHeader = await attemptsFor({
    maxRetries: undefined,
    headers: new Headers({ 'x-should-retry': 'false' }),
  });
  assert.strictEqual(noRetryHeader.stamped.sdkRetried, false);
  assert.strictEqual(noRetryHeader.upstream, aiRetry.DEFAULT_TRIES,
    'x-should-retry:false reaches the app layer unretried even at default settings, so the ' +
    '"superset" premise has an exception and the synchronous bound has a second door');
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
  // and both writers (run() and reanalyze()) used the same one.
  //
  // `web/` DOES read this column — web/admin/admin.js's research panel does
  // `r.models && r.models.hadPortfolio === false` to render the "no product
  // portfolio on file" hint. It reads a SIBLING of the key that changed, and the
  // whole object is still written with the same key set, which is what makes
  // re-pointing `analysis` safe for rows already stored. It is NOT safe to
  // narrow this write to the changed key, and an earlier version of this comment
  // said "nothing in web/ reads this column" — sitting directly above the only
  // test covering the write, that reads as licence to do exactly that. So
  // `hadPortfolio` is asserted below rather than merely used as a locator.
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
  // The sibling key web/admin/admin.js:9725 renders on. It is `!!context`, and
  // tenantContextText returns '' against this file's empty db — so `false` here
  // is the value that makes the "no product portfolio on file" hint appear.
  // Pinned so a later narrowing of this write cannot drop it silently.
  assert.strictEqual(stamped.hadPortfolio, false,
    'the research panel reads models.hadPortfolio — narrowing this write to the model stamp ' +
    'would delete a rendered field with nothing to notice');
});

// ── 7. the OTHER route: fire-and-forget, metered, and previously untested ──

test('run() — the metered background route — takes its stamp from the seam too', async () => {
  // NOTHING IN THE SUITE EXECUTED run() BEFORE THIS. Only reanalyze() was
  // driven, so reverting run()'s stamp to a require-time modelFor('research')
  // constant — the exact regression this PR exists to remove — stayed green.
  // It is also the route the retry decision is mostly argued FROM: the research
  // unit is pre-charged on admission, so an un-retried transient spends it.
  //
  // Driven through start(), not by exporting run(): start()'s in-flight check
  // and its INSERT are on the path, and the whole point is that this is the
  // route nothing exercised.
  dbRows = runDb();
  dbWrites.length = 0;
  await withEnv({ APOLLO_API_KEY: undefined, NEWSAPI_KEY: undefined }, async () => {
    await withSeam(ok(ANSWER, 'claude-sonnet-5', 'anthropic'), async (calls) => {
      const row = await research.start(TENANT, COMPANY);
      assert.strictEqual(row.id, 'r1', 'start() returns the freshly inserted RUNNING row');
      const write = await onWrite((w) => w.sql.includes("status = 'DONE'"), 'the DONE write');

      assert.strictEqual(calls.length, 1, 'one model call on the background route as well');
      assert.strictEqual(calls[0].task, 'research');
      assert.strictEqual(calls[0].site, 'research.analyze');
      assert.strictEqual(calls[0].tenantId, TENANT);

      const stamped = write.params
        .filter((p) => typeof p === 'string' && p.startsWith('{'))
        .map((p) => { try { return JSON.parse(p); } catch { return null; } })
        .find((o) => o && Object.prototype.hasOwnProperty.call(o, 'hadPortfolio'));
      assert.ok(stamped, 'run() must persist the models stamp');
      assert.strictEqual(stamped.analysis, 'claude-sonnet-5',
        'run() takes the serving model from the seam, not modelFor() at boot — this is the ' +
        'assertion that was missing entirely');
      assert.strictEqual(stamped.reanalyzed, undefined, 'the background route is not a re-analyze');
      assert.strictEqual(stamped.hadPortfolio, false);
    });
  });
});

test('run() retries a persistent transient DEFAULT_TRIES times, then writes FAILED', async () => {
  // The other half of the "one policy, two contracts" claim. The failure here is
  // silent to the rep — no socket is open — so the only evidence is the FAILED
  // row, and the pre-charged unit is gone either way. That is precisely why the
  // wrapper is worth its 3 attempts on this route.
  dbRows = runDb();
  dbWrites.length = 0;
  let attempts = 0;
  await withEnv({ APOLLO_API_KEY: undefined, NEWSAPI_KEY: undefined }, async () => {
    await withSeam(async () => { attempts += 1; throw new Error('503 UNAVAILABLE'); }, async () => {
      await research.start(TENANT, COMPANY);
      const write = await onWrite((w) => w.sql.includes("status = 'FAILED'"), 'the FAILED write');
      assert.ok(String(write.params[0]).includes('503'),
        'the FAILED row carries the provider message the rep will be shown');
    });
  });
  assert.strictEqual(attempts, aiRetry.DEFAULT_TRIES,
    'the background route gets the same budget as the synchronous one — deliberately, and this ' +
    'is the route where backoff is free');
});
