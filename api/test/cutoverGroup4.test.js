// ADR-0006 §9 item 5, group 4 (the `compare` half): knowledge/preview.js's
// buildCompetitorComparison() on the provider seam.
//
// A sibling of cutoverGroup1/2/3.test.js rather than an extension, because what
// is specific to this group is not the swap — it is one call site, and the swap
// is four lines. What is specific is:
//
//   1. THE FILE STOPS BEING HALF-MIGRATED. knowledge/preview.js has held one
//      seam call (`preview`, group 1) beside one direct Gemini call (`compare`)
//      for three groups, and three separate comments described that arrangement
//      as deliberate. It is gone. `cutoverGroup3.test.js` asserted the negative
//      (`!DISPATCH_READY.has('compare')`) with that reasoning quoted; this file
//      asserts the positive, and that assertion moved in the same commit.
//   2. THE GEMINI REQUEST DOES NOT MOVE. `compare` gets no `anthropicTier` — it
//      needs none, tier `flash` already resolves to claude-sonnet-5 — so Gemini
//      must still receive the same model, budget, temperature, thinking config
//      and schema OBJECT it received before the seam existed. Asserted by
//      driving the REAL seam into a fake Gemini client, not by reading source.
//   3. THE MODEL IS RESOLVED PER CALL. preview.js froze it at require time
//      (`const COMPARE_MODEL = require('../models').modelFor('compare')`) — the
//      personas.js hazard of §9 item 4, and the fifth instance removed. Pinned
//      BEHAVIOURALLY: the env var is set after the module was required, and the
//      fake client is asserted to see it.
//   4. THERE IS NO RETRY, AS A DECISION. `aiRetry.POLICIES` has no `compare`
//      key, so `forLabel('compare')` THROWS — the call site cannot acquire a
//      bound by accident the way a `forLabel('research')` copy-paste would give
//      it one. The observable consequence is asserted, not just the absence:
//      a transient failure takes ONE upstream attempt and yields this file's
//      documented fail-soft `{ available:false, reason }`, not a 502.
//   5. AFTER A FLIP THE TEMPERATURE IS DROPPED, NOT 400ed. claude-sonnet-5 is in
//      anthropic.js's NO_TEMPERATURE, and this call site passes 0.3. Driven
//      through the REAL wrapper into a fake SDK so the assertion is about the
//      wire params, not about a list.
//
// The seam is exercised for real everywhere except test 2, which is about what
// the CALL SITE ASKS FOR rather than what a provider receives.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const API = path.join(__dirname, '..');
const SRC = path.join(API, 'src');

// ── module stubs, installed BEFORE anything under test is required ──────────
//
// gemini.js pulls in redis.js, which opens an ioredis client at module load and
// retries forever with no Redis reachable — `node --test` then hangs rather than
// failing. So the stub is a working fake client: `geminiCalls` is what the
// provider would have received on the wire.
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

// Postgres. gatherTenantPortfolio() reads the tenant's `products` rows and the
// text of their TENANT-scoped KB documents, and refuses to call a model at all
// unless one of the two comes back non-empty — so a stub that answered every
// SELECT with `{ rows: [] }` would make every test below pass by never reaching
// a provider.
const dbPath = require.resolve(path.join(SRC, 'db.js'));
let dbRows = () => ({ rows: [] });
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { query: async (sql, params) => dbRows(String(sql), params) },
};

// redis.js opens an ioredis client at module load, and an open handle keeps
// `node --test` alive after the last assertion — the suite passes and then
// hangs, which is worse than failing.
const redisPath = require.resolve(path.join(SRC, 'redis.js'));
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true, children: [], paths: [],
  exports: {
    getClient: () => ({ get: async () => null, set: async () => 'OK', incr: async () => 1, expire: async () => 1 }),
  },
};

// costs.js → db. Stubbed rather than left to the db stub above so the telemetry
// is READABLE: this PR DELETED preview.js's own `costs.recordGemini(...)` line,
// on the grounds that the seam records on both branches. That is a claim, and
// `recorded` is what checks it.
const costsPath = require.resolve(path.join(SRC, 'costs.js'));
const recorded = [];
require.cache[costsPath] = {
  id: costsPath, filename: costsPath, loaded: true, children: [], paths: [],
  exports: {
    recordGemini: (...a) => { recorded.push(['gemini', ...a]); return Promise.resolve(); },
    recordClaude: (...a) => { recorded.push(['claude', ...a]); return Promise.resolve(); },
  },
};

// The SDK itself, so the flip test drives the REAL anthropic.generate and reads
// the params that actually went out. Replacing `anthropic.generate` (the way
// cutoverGroup3.test.js does) cannot see the temperature drop at all — that
// happens INSIDE generate, which is the whole point of test 6.
const sdkSent = [];
class FakeAPIError extends Error {}
function FakeAnthropic() {
  this.messages = {
    create: async (params) => {
      sdkSent.push(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(ANSWER) }],
        stop_reason: 'end_turn',
        model: params.model,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}
FakeAnthropic.APIError = FakeAPIError;
FakeAnthropic.RateLimitError = class extends FakeAPIError {};
FakeAnthropic.AuthenticationError = class extends FakeAPIError {};
FakeAnthropic.PermissionDeniedError = class extends FakeAPIError {};
FakeAnthropic.APIConnectionError = class extends FakeAPIError {};
FakeAnthropic.APIConnectionTimeoutError = class extends FakeAPIError {};
FakeAnthropic.APIUserAbortError = class extends FakeAPIError {};
const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [API] });
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const aiCall = require(path.join(SRC, 'aiCall.js'));
const models = require(path.join(SRC, 'models.js'));
const aiRetry = require(path.join(SRC, 'aiRetry.js'));
const preview = require(path.join(SRC, 'knowledge', 'preview.js'));

const TENANT = '9f1c2d34-t';
const COMPETITOR = 'Rival Systems';
// Long enough to clear buildCompetitorComparison's `length < 60` guard.
const COMPETITOR_TEXT = `Rival Systems sells a payments orchestration platform. ${'Feature copy. '.repeat(20)}`;

// The portfolio rows gatherTenantPortfolio() reads, in the order it reads them.
// Both halves are non-empty on purpose: `hasAny` is an OR, so answering only one
// of the two would leave the other query's contribution to the prompt untested.
function portfolioDb() {
  return (sql) => {
    if (sql.includes('FROM products')) {
      return { rows: [{ name: 'Queue AI', description: 'payment queue orchestration' }] };
    }
    if (sql.includes('FROM kb_documents')) {
      return { rows: [{ title: 'Our positioning', body: 'We win on settlement speed.' }] };
    }
    return { rows: [] };
  };
}

const ANSWER = {
  competitorOverview: 'They sell orchestration.',
  dimensions: [{ dimension: 'Pricing model', ours: 'usage', theirs: 'seat', edge: 'ours', note: null }],
  similarities: ['both cloud-hosted'],
  ourStrengths: ['settlement speed'],
  theirStrengths: ['bigger ecosystem'],
  talkingPoints: ['Ask about settlement latency.'],
};

// Set env vars for the duration, restoring exactly — including deleting keys
// that were absent, which a naive save/restore turns into the string
// 'undefined'.
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

// Lift models.FLIP_BLOCKED for the duration. `compare` IS in it — the live
// measurement in ADR-0006 §9 item 5 group 4 put it there — so without this every
// "after a flip" assertion below would silently be testing the Gemini branch:
// providerFor() refuses a blocked key exactly the way it refuses an unmigrated
// one. Conditional restore, not an unconditional add/delete pair, for the reason
// test/live/contextSeam.js gives: on a key that is NOT blocked, an unconditional
// `set`/`delete` does not restore, it INVENTS an entry and then deletes it.
async function withFlipUnblocked(tasks, fn) {
  const saved = tasks.filter((t) => models.FLIP_BLOCKED.has(t)).map((t) => [t, models.FLIP_BLOCKED.get(t)]);
  for (const t of tasks) models.FLIP_BLOCKED.delete(t);
  try { return await fn(); } finally {
    for (const [t, reason] of saved) models.FLIP_BLOCKED.set(t, reason);
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

const run = () => preview.buildCompetitorComparison(TENANT, COMPETITOR_TEXT, COMPETITOR);

// ── 1. the key ──────────────────────────────────────────────────────────────

test('group 4 PR A is dispatch-ready for `compare`, and only for `compare`', () => {
  assert.ok(models.DISPATCH_READY.has('compare'),
    'buildCompetitorComparison was migrated onto aiCall.generateStructured in this PR, so the key ' +
    'must be eligible. Membership and migration ship together — that rule is on DISPATCH_READY ' +
    'itself, and this is the assertion that makes it more than a comment.');
  // …AND IT IS BLOCKED, which is the other half and is not the same claim.
  // DISPATCH_READY says the call site can dispatch; FLIP_BLOCKED says a live
  // measurement found the result would be worse than what we have. Both were
  // decided in this PR, from opposite evidence: the code was read for the first,
  // and the REAL call site was driven against the live API for the second.
  //
  // The number and its deletion criterion live in models.js, deliberately not
  // here — two copies of a measurement is how one of them goes stale, and the
  // one an operator hits at run time is the one that must be right. What this
  // assertion is for is the reverse direction: deleting the entry with no new
  // evidence recorded next to it is the same failure as adding a task to
  // DISPATCH_READY whose call site was never migrated. It looks like progress.
  //
  // DO NOT CLEAR IT BY RAISING maxTokens. The budget is provider-agnostic at
  // this call site, so raising it changes what GEMINI receives and breaks the
  // [GEMINI-PARITY] property below — the same rule models.js states for
  // `keypoints`, for the same reason, on the same defect.
  assert.ok(models.FLIP_BLOCKED.has('compare'),
    'the live probe against the REAL call site found BOTH group-2 defects here at once — ' +
    'stop_reason max_tokens against the 1800-token budget, and unparseable JSON. See ' +
    'models.FLIP_BLOCKED for the rates, the method and what would have to be true to delete it.');

  // `content` is the OTHER half of what §9 item 5 calls group 4, and it is
  // deliberately absent. The item names the group by three FILE names —
  // "enrichment + contacts + companies" — and behind them is ONE key over FOUR
  // call sites, the fourth being analysis.js, a file §9 schedules for the LAST
  // group. One key over four sites has to land in one PR (the
  // `assessment`/`battlecard` argument), so the group splits: `compare` here,
  // `content` in PR B.
  const reasons = {
    content: 'group 4 PR B — one key over four call sites (enrichment.js, contacts.js, ' +
             'companies.js, analysis.js), which must migrate together',
    discovery: 'a later group',
    marketWatch: 'a later group',
    brief: 'a later group',
    personas: 'depends on §9 item 4 and ships with the arena cutover',
    callAnalysis: 'the last group',
    callEntities: 'a later group',
    proposal: 'the last group — it carries the §4.7 schema reshape',
  };
  for (const [t, why] of Object.entries(reasons)) {
    assert.ok(!models.DISPATCH_READY.has(t),
      `${t}'s call site still speaks to the Gemini SDK — adding it would 404 every call (${why})`);
  }
});

// ── 2. what the call site asks the seam for ────────────────────────────────

test('buildCompetitorComparison goes through the seam as the `compare` task', async () => {
  dbRows = portfolioDb();
  await withSeam(async () => ({ parsed: ANSWER, text: JSON.stringify(ANSWER), usage: null, model: 'gemini-2.5-flash', provider: 'gemini' }), async (calls) => {
    const out = await run();
    assert.strictEqual(out.available, true, 'the happy path must still produce a comparison');

    assert.strictEqual(calls.length, 1, 'this is the ONE model call in buildCompetitorComparison');
    const c = calls[0];
    assert.strictEqual(c.task, 'compare');
    assert.strictEqual(c.site, 'kb.compare',
      'the cost-telemetry label is UNCHANGED, so this call site\'s usage_costs history stays one ' +
      'series across the cutover. Renaming it silently forks §6\'s per-task margin table.');
    // The output budget and determinism setting the Gemini call site had.
    assert.strictEqual(c.maxTokens, 1800);
    assert.strictEqual(c.temperature, 0.3);
    // Without tenantId the usage_costs row lands with tenant_id NULL and the
    // per-tenant rollup §6's margin table depends on silently loses the call.
    assert.strictEqual(c.tenantId, TENANT);
    // Claude-only knobs, which Gemini parity structurally cannot see. Left to
    // the seam defaults deliberately: `effort` is the value the flip gate's
    // smoke-check argument compares against, and `allowTruncation` unset is what
    // makes a truncated answer THROW rather than be parsed into a half-built
    // battlecard the rep cannot tell from a complete one.
    assert.strictEqual(c.effort, undefined,
      'this call site takes the seam default; passing one here would decouple it from that argument');
    assert.strictEqual(c.allowTruncation, undefined,
      'a truncated comparison must throw into the fail-soft path, not be rendered as a real one');
    // Identity, not shape: `responseSchema` keeps GEMINI's spelling so
    // liveSchemaCoverage.test.js's scan of src/ for the literal token still
    // finds this schema, and schemaCompat translates it inside
    // anthropic.generate rather than at the call site (§4.6).
    assert.strictEqual(c.responseSchema, preview.COMPARISON_SCHEMA);
  });
});

// ── 3. what GEMINI receives, which must not have moved ─────────────────────

test('[GEMINI-PARITY] buildCompetitorComparison still sends Gemini exactly what it did before', async () => {
  // Gemini serves 100% of this traffic today. A cutover PR that changes this
  // request is changing live behaviour under cover of a provider swap, and a
  // per-file diff cannot show it, because the request is now assembled in
  // aiCall.js from arguments spread across two other files.
  //
  // Driven through the REAL seam so what is compared is the object handed to
  // @google/genai, not the arguments on the way in.
  dbRows = portfolioDb();
  geminiCalls.length = 0;
  recorded.length = 0;
  geminiImpl = () => ({ text: JSON.stringify(ANSWER), usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } });
  try {
    const out = await run();
    assert.strictEqual(out.available, true);
    assert.strictEqual(geminiCalls.length, 1);
    const req = geminiCalls[0];

    // A LITERAL, not a re-derivation of the function that produced it —
    // `models.resolve('compare').model` here would be a tautology that two
    // different re-tierings walk through green (group 3's confidence pass found
    // exactly that). `compare` is tier `flash` on Gemini, and re-tiering it or
    // repointing the flash tier is a live change to 100% of this traffic.
    //
    // The residual: TIERS.gemini.flash is `process.env.GEMINI_MODEL ||
    // 'gemini-2.5-flash'`, captured at models.js require time, so a deployment
    // that overrides GEMINI_MODEL reds this. That is the safe direction and the
    // same exposure the group-2 and group-3 pins already carry.
    assert.strictEqual(req.model, 'gemini-2.5-flash',
      '`compare` is tier flash on Gemini and must resolve to exactly the model it did before this ' +
      'PR — re-tiering it, or repointing the flash tier, is a live change to 100% of this traffic ' +
      'and is what this literal exists to catch');
    assert.match(req.model, /^gemini-/, 'the Gemini branch must never be handed a Claude id');

    assert.deepStrictEqual(req.config, {
      maxOutputTokens: 1800,
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: preview.COMPARISON_SCHEMA,
    }, 'buildCompetitorComparison changed what Gemini receives');
    // deepStrictEqual compares schemas STRUCTURALLY, so a defensive copy passes
    // it. Identity is the property that matters: liveSchemaCoverage.test.js and
    // the live smoke registry are keyed on the exported object, and a copy would
    // leave the harness covering a schema nothing sends.
    assert.strictEqual(req.config.responseSchema, preview.COMPARISON_SCHEMA,
      'the schema must be the exported COMPARISON_SCHEMA object itself, not a copy of it');

    assert.strictEqual(req.contents.length, 1);
    assert.strictEqual(req.contents[0].role, 'user');
    const text = req.contents[0].parts[0].text;
    // The prompt is assembled by the call site, not the seam — both halves of
    // the portfolio and the competitor body, under the headings the model is
    // instructed to read.
    assert.ok(text.includes('===OUR COMPANY PORTFOLIO==='));
    assert.ok(text.includes('Queue AI'), 'the products query feeds the prompt');
    assert.ok(text.includes('We win on settlement speed.'), 'the Basis-doc query feeds the prompt');
    assert.ok(text.includes(`===COMPETITOR (${COMPETITOR})===`));

    // This PR deleted preview.js's own costs.recordGemini() line. The seam has
    // to have taken it over, under the same label and the same tenant, or the
    // deletion silently stopped metering a paid call.
    const gem = recorded.filter((r) => r[0] === 'gemini');
    assert.strictEqual(gem.length, 1, 'the seam records Gemini usage exactly once — not zero, not twice');
    assert.strictEqual(gem[0][1], TENANT);
    assert.strictEqual(gem[0][2], 'kb.compare');
    assert.strictEqual(gem[0][3], 'gemini-2.5-flash');
  } finally { geminiImpl = () => ({ text: '{}', usageMetadata: null }); }
});

test('the model is resolved PER CALL, not frozen when the module was required', async () => {
  // preview.js captured it at require time (`const COMPARE_MODEL =
  // require('../models').modelFor('compare')`), which is the personas.js hazard
  // of ADR-0006 §9 item 4 and the same freeze groups 2 and 3 removed three times
  // before this one. This module was required at the top of this file, long
  // before the override below existed — so if the constant were still there,
  // this env var could not reach the wire. A test that read a constant instead
  // would pass either way.
  dbRows = portfolioDb();
  geminiCalls.length = 0;
  geminiImpl = () => ({ text: JSON.stringify(ANSWER), usageMetadata: null });
  await withEnv({ GEMINI_COMPARE_MODEL: 'gemini-resolved-at-call-time' }, async () => {
    await run();
    assert.strictEqual(geminiCalls[0].model, 'gemini-resolved-at-call-time',
      'the per-task override set AFTER require time must reach the wire');
  });
  geminiImpl = () => ({ text: '{}', usageMetadata: null });
});

// ── 4. the flip ────────────────────────────────────────────────────────────

test('a real flip sends claude-sonnet-5 the seam defaults and DROPS the temperature', async () => {
  // The whole path: preview.js → aiCall's anthropic branch → the real
  // anthropic.generate → the SDK. Only the SDK is fake, because the property
  // under test — temperature 0.3 being dropped rather than 400ing — happens
  // INSIDE generate(), where a stubbed `anthropic.generate` cannot see it.
  //
  // claude-sonnet-5 is in NO_TEMPERATURE ("`temperature` is deprecated for this
  // model", live-probed 2026-08-06). This call site passes 0.3 and always has.
  // If the drop stopped happening, EVERY comparison after a flip would be a hard
  // 400 — and because this path fails soft, the only symptom would be the "you
  // can still ingest this as a battlecard" sentence appearing forever.
  dbRows = portfolioDb();
  sdkSent.length = 0;
  recorded.length = 0;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  try {
    await withFlipUnblocked(['compare'], () =>
      withEnv({ AI_PROVIDER_COMPARE: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
        const out = await run();
        assert.strictEqual(out.available, true, 'a flip must still produce a comparison');
      }));
  } finally { console.warn = realWarn; }

  assert.strictEqual(sdkSent.length, 1, 'the anthropic branch was not reached at all');
  const p = sdkSent[0];
  assert.strictEqual(p.model, 'claude-sonnet-5',
    '`compare` is tier flash, which resolves to claude-sonnet-5 on Claude with NO anthropicTier ' +
    'override — the point being that this group has ZERO Haiku exposure, so the `assessment` ' +
    'hazard (one key rounding a hard call site down to Haiku) cannot arise here');
  assert.strictEqual(p.max_tokens, 1800, 'the output budget is provider-agnostic at this call site');
  assert.deepStrictEqual(p.output_config.effort, 'medium',
    'the seam default, unchanged — this is the value the smoke check\'s effort argument compares against');
  assert.deepStrictEqual(p.thinking, { type: 'disabled' },
    'thinkingBudget:0 maps to thinking:false here, which generate() sends as disabled — not to ' +
    'adaptive thinking, which would spend part of the 1800-token budget on reasoning tokens');
  assert.ok(p.output_config.format, 'structured output must survive the translation');

  assert.strictEqual(p.temperature, undefined,
    'claude-sonnet-5 400s on temperature; anthropic.js must DROP it rather than pass it through');
  assert.ok(warnings.some((w) => w.includes('kb.compare') && w.includes('temperature 0.3')),
    'the drop must be LOUD — a determinism setting disappearing silently is the change nobody ' +
    `sees for three weeks and then reports as "the model got flakier". Warnings seen: ${JSON.stringify(warnings)}`);

  const claude = recorded.filter((r) => r[0] === 'claude');
  assert.strictEqual(claude.length, 1, 'Claude usage is recorded inside generate(), exactly once');
  assert.strictEqual(claude[0][2], 'kb.compare', 'under the SAME label as the Gemini branch');
});

test('AI_PROVIDER_COMPARE=anthropic with no key FAILS CLOSED to Gemini, loudly', async () => {
  // providerFor() key-checks non-default providers. Without this, an operator
  // following the runbook and forgetting the key would post a Claude model id to
  // the Gemini SDK — a 404 on every comparison, arriving as this file's
  // fail-soft sentence rather than as an error anyone would investigate.
  dbRows = portfolioDb();
  geminiCalls.length = 0;
  sdkSent.length = 0;
  geminiImpl = () => ({ text: JSON.stringify(ANSWER), usageMetadata: null });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  try {
    // FLIP_BLOCKED is lifted here too, and that is load-bearing rather than
    // tidy: providerFor() checks the block BEFORE the key, so with `compare`
    // blocked this test would go green on the WRONG refusal — the router would
    // fall back for the measured-defect reason and never reach the key gate at
    // all. The assertion would still pass, and the guard would cover nothing.
    await withFlipUnblocked(['compare'], () =>
      withEnv({ AI_PROVIDER_COMPARE: 'anthropic', ANTHROPIC_API_KEY: undefined }, async () => {
        const out = await run();
        assert.strictEqual(out.available, true, 'the fallback must still produce a comparison');
      }));
  } finally { console.warn = realWarn; geminiImpl = () => ({ text: '{}', usageMetadata: null }); }
  assert.strictEqual(sdkSent.length, 0, 'nothing may reach the Anthropic SDK without a key');
  assert.strictEqual(geminiCalls.length, 1, 'the call must fall back to Gemini, not fail');
  assert.match(geminiCalls[0].model, /^gemini-/, 'and it must carry a GEMINI model id');
  assert.ok(warnings.some((w) => /ANTHROPIC_API_KEY|anthropic/i.test(w)),
    `the fallback must warn — silently serving Gemini while the env says anthropic is how a flip ` +
    `is believed to have happened. Warnings seen: ${JSON.stringify(warnings)}`);
});

// ── 5. the retry budget: no retry, as a decision ───────────────────────────

test('there is no `compare` retry policy, and asking for one THROWS', () => {
  // The absence is the decision, and this is what keeps it from being read as an
  // oversight by the next person to copy a `forLabel('research')` line into this
  // file. aiRetry refuses an unknown label rather than falling through to the
  // defaults, precisely so a call site cannot inherit a bound it never had.
  assert.ok(!Object.prototype.hasOwnProperty.call(aiRetry.POLICIES, 'compare'),
    'kb.compare is deliberately unretried: it is SYNCHRONOUS behind POST /api/knowledge/preview ' +
    'and the dryRun branch of the web-scrape route, it sits BEHIND a Firecrawl scrape in the same ' +
    'request, and it already fails soft. Three attempts with backoff would spend up to 3x an ' +
    '1800-token generation to salvage a block whose absence is already a graceful message. ' +
    'Adding a policy here is a decision to re-argue in ADR-0006 §9 item 5, not a gap to close.');
  assert.throws(() => aiRetry.forLabel('compare'), /no policy for "compare"/,
    'and the refusal is what makes the absence load-bearing rather than merely true');
});

test('a transient failure takes ONE upstream attempt and fails soft, not 502', () => {
  // Counted AT THE WIRE, not at the seam. A retry loop added inside the seam's
  // Gemini branch would be 3 metered 1800-token generations for one logical
  // call — double the spend and triple the wall clock on a page a rep is
  // watching — and a seam-level counter reports 1 and stays green.
  dbRows = portfolioDb();
  geminiCalls.length = 0;
  geminiImpl = () => { throw new Error('503 UNAVAILABLE'); };
  const realWarn = console.warn;
  console.warn = () => {};
  return run().then((out) => {
    console.warn = realWarn;
    assert.strictEqual(geminiCalls.length, 1,
      'ONE upstream generation. `503 UNAVAILABLE` is exactly what aiRetry classifies transient on ' +
      'the Gemini branch, so this is the message that would prove a wrapper had appeared.');
    assert.strictEqual(out.available, false,
      'the documented fail-soft contract: the preview card renders a sentence and the upload still ' +
      'works. A throw here would 502 the whole preview, losing the summary and the stats too.');
    assert.match(out.reason, /Comparison generation failed/,
      'and the reason is the rep-facing one, not a provider message');
  }, (err) => { console.warn = realWarn; throw err; });
});
