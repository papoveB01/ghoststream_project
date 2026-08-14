// The one-shot structured-call seam (ADR-0006 §9 item 5, PR A).
//
// What matters here is not that it "works" — it is that the two provider
// branches stay honest about the four things they do NOT share, because each of
// those is a silent failure if it drifts:
//
//   - temperature reaching Claude is a hard 400, and temperature silently
//     vanishing is a determinism change nobody sees for weeks;
//   - thinking defaulting on would eat the answer's token budget;
//   - cost recorded in both this module and anthropic.generate would double
//     count the meter ADR-0006 §6's margin floor is built on;
//   - an unknown option silently dropped is how maxOutputTokens or abortSignal
//     disappears in a mechanical port.
//
// Both SDKs are stubbed by replacing the exported functions on the module
// objects aiCall already holds, so nothing here touches the network.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

// gemini.js is stubbed in require.cache BEFORE aiCall pulls it in, and that is
// load-bearing rather than tidiness: gemini.js requires redis.js, which
// constructs an ioredis client at MODULE LOAD. With no Redis reachable (the
// test container runs --no-deps) the client retries for ever, the event loop
// never drains, and `node --test` hangs instead of failing. Any future test
// that touches gemini.js needs this same treatment.
const geminiPath = require.resolve(path.join(SRC, 'gemini.js'));
const geminiStub = { getClient: () => { throw new Error('gemini stub not installed'); } };
require.cache[geminiPath] = {
  id: geminiPath, filename: geminiPath, loaded: true, children: [], paths: [],
  exports: geminiStub,
};

const aiCall = require(path.join(SRC, 'aiCall.js'));
const models = require(path.join(SRC, 'models.js'));
const gemini = geminiStub;
const anthropic = require(path.join(SRC, 'anthropic.js'));
const costs = require(path.join(SRC, 'costs.js'));
const aiRetry = require(path.join(SRC, 'aiRetry.js'));

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
};

// Swap in stubs, run fn, always restore — including DISPATCH_READY, which is a
// live exported Set that other test files in this process would inherit.
//
// ANTHROPIC_API_KEY IS SET HERE, and that is a correctness fix, not tidiness.
// models.providerFor() refuses to dispatch to a provider whose key is missing
// (the fail-closed guard), so every anthropic-branch assertion in this file
// silently became a Gemini assertion in any environment without a key. The dev
// container has one via compose `env_file`; CI does not — ci.yml sets only
// REDIS_HOST / JWT_SECRET / ENCRYPTION_KEY / NODE_ENV — so the suite was green
// locally and red on the runner. The key belongs in the harness rather than in
// ci.yml because the two fail-closed tests at the bottom of this file MANAGE IT
// EXPLICITLY: one asserts the fallback with the key deleted, and an ambient CI
// key would not change that, but the next test written the same way could only
// be written if the harness — not the environment — owns the default.
async function withStubs({ provider = 'gemini', task = 'relevance' }, fn) {
  const real = {
    getClient: gemini.getClient,
    generate: anthropic.generate,
    recordGemini: costs.recordGemini,
    recordClaude: costs.recordClaude,
    env: process.env[models.providerEnvName(task)],
    key: process.env.ANTHROPIC_API_KEY,
    wasReady: models.DISPATCH_READY.has(task),
  };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const seen = { gemini: [], anthropic: [], recordedGemini: [], recordedClaude: [] };

  gemini.getClient = () => ({
    models: {
      generateContent: async (params) => {
        seen.gemini.push(params);
        return { text: '{"ok":true}', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } };
      },
    },
  });
  anthropic.generate = async (params) => {
    seen.anthropic.push(params);
    // The real one records internally; mirror that so a double-count is visible.
    costs.recordClaude(params.tenantId, params.site, params.model, { input_tokens: 10, output_tokens: 3 });
    return { text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 3 }, stopReason: 'end_turn', model: params.model };
  };
  costs.recordGemini = (...a) => { seen.recordedGemini.push(a); return Promise.resolve(); };
  costs.recordClaude = (...a) => { seen.recordedClaude.push(a); return Promise.resolve(); };

  if (provider === 'anthropic') {
    process.env[models.providerEnvName(task)] = 'anthropic';
    models.DISPATCH_READY.add(task);
  } else {
    delete process.env[models.providerEnvName(task)];
  }

  try {
    return await fn(seen);
  } finally {
    gemini.getClient = real.getClient;
    anthropic.generate = real.generate;
    costs.recordGemini = real.recordGemini;
    costs.recordClaude = real.recordClaude;
    if (real.env === undefined) delete process.env[models.providerEnvName(task)];
    else process.env[models.providerEnvName(task)] = real.env;
    if (real.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = real.key;
    if (!real.wasReady) models.DISPATCH_READY.delete(task);
  }
}

test('the Gemini branch sends the config the migrated call sites already sent', async () => {
  await withStubs({ provider: 'gemini' }, async (seen) => {
    const r = await aiCall.generateStructured({
      task: 'relevance', prompt: 'p', responseSchema: SCHEMA,
      maxTokens: 400, temperature: 0.1, tenantId: 't1', site: 'kb.relevanceDoc',
    });
    assert.strictEqual(seen.gemini.length, 1);
    const { config, contents, model } = seen.gemini[0];
    assert.strictEqual(model, 'gemini-2.5-flash-lite');
    assert.deepStrictEqual(contents, [{ role: 'user', parts: [{ text: 'p' }] }]);
    assert.strictEqual(config.temperature, 0.1, 'Gemini keeps its determinism setting');
    assert.strictEqual(config.maxOutputTokens, 400);
    assert.deepStrictEqual(config.thinkingConfig, { thinkingBudget: 0 }, 'thinking stays OFF by default');
    assert.strictEqual(config.responseMimeType, 'application/json');
    assert.strictEqual(config.responseSchema, SCHEMA);
    assert.deepStrictEqual(r.parsed, { ok: true });
    assert.strictEqual(r.provider, 'gemini');
  });
});

test('the Claude branch FORWARDS temperature — the drop is per model, in the wrapper', async () => {
  // This assertion is inverted from its first version, and the inversion is the
  // fix. The seam dropped temperature for every Claude model on the premise
  // that "Claude does not accept it". Live probe, 2026-08-06, temperature 0.1:
  // claude-haiku-4-5 → 200; claude-sonnet-5 / claude-opus-5 / claude-opus-4-8 /
  // claude-opus-4-7 / claude-fable-5 → 400. Haiku 4.5 IS the LITE tier that
  // relevance, preview and companyBrief all resolve to, so the seam was
  // deleting a determinism setting on the exact tier that honours it — on a
  // judge whose confidence is compared against QUARANTINE_THRESHOLD 0.4, where
  // sampling wobble decides whether a document is quarantined.
  await withStubs({ provider: 'anthropic' }, async (seen) => {
    await aiCall.generateStructured({
      task: 'relevance', prompt: 'p', responseSchema: SCHEMA,
      maxTokens: 400, temperature: 0.1, tenantId: 't1', site: 'kb.relevanceDoc',
    });

    assert.strictEqual(seen.anthropic.length, 1);
    const sent = seen.anthropic[0];
    assert.strictEqual(sent.temperature, 0.1,
      'the wrapper decides per model; the seam must not pre-empt it for the tier that accepts it');
    assert.strictEqual(sent.model, 'claude-haiku-4-5');
    assert.strictEqual(sent.thinking, false);
    assert.strictEqual(sent.maxTokens, 400);
    assert.strictEqual(sent.schema, SCHEMA, 'schemaCompat translates at the wrapper boundary, not here');
  });
});

test('[LIVE-PINNED] the wrapper keeps temperature on the LITE tier and drops it above, loudly', async () => {
  // The real anthropic.generate, not the stub — this is the behaviour the seam
  // now delegates to, and the model split it turns on. Pinned against the live
  // probe in NO_TEMPERATURE's comment; both calls stop at the missing key,
  // which is one line past every decision under test.
  const saved = process.env.ANTHROPIC_API_KEY;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    delete process.env.ANTHROPIC_API_KEY;
    for (const model of ['claude-haiku-4-5', 'claude-opus-5']) {
      await assert.rejects(
        () => anthropic.generate({
          model, prompt: 'p', maxTokens: 64, thinking: false, temperature: 0.1, site: 'kb.relevanceDoc',
        }),
        /ANTHROPIC_API_KEY is not set/,
        `${model}: temperature must not be rejected as an unknown option`
      );
    }
  } finally {
    console.warn = realWarn;
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
  assert.ok(warnings.some((w) => /claude-opus-5/.test(w) && /temperature/.test(w)),
    'dropping a determinism setting on a model that 400s on it must be visible, and name the model');
  assert.ok(!warnings.some((w) => /claude-haiku-4-5/.test(w)),
    'the LITE tier accepts temperature — warning there would train the reader to ignore the line');
});

test('cost is recorded exactly once per call, on whichever provider ran', async () => {
  // Recording in both this module and anthropic.generate would double the meter
  // ADR-0006 §6's margin floor is derived from.
  await withStubs({ provider: 'gemini' }, async (seen) => {
    await aiCall.generateStructured({ task: 'relevance', prompt: 'p', responseSchema: SCHEMA, tenantId: 't1', site: 'kb.relevanceDoc' });
    assert.strictEqual(seen.recordedGemini.length, 1);
    assert.strictEqual(seen.recordedClaude.length, 0);
    assert.deepStrictEqual(seen.recordedGemini[0].slice(0, 3), ['t1', 'kb.relevanceDoc', 'gemini-2.5-flash-lite']);
  });
  await withStubs({ provider: 'anthropic' }, async (seen) => {
    await aiCall.generateStructured({ task: 'relevance', prompt: 'p', responseSchema: SCHEMA, tenantId: 't1', site: 'kb.relevanceDoc' });
    assert.strictEqual(seen.recordedGemini.length, 0, 'the Gemini recorder must not fire on a Claude call');
    assert.strictEqual(seen.recordedClaude.length, 1, 'and generate() records its own');
  });
});

test('an unknown option throws instead of vanishing', async () => {
  await withStubs({ provider: 'gemini' }, async () => {
    await assert.rejects(
      () => aiCall.generateStructured({ task: 'relevance', prompt: 'p', maxOutputTokens: 400 }),
      /unknown option\(s\) maxOutputTokens/
    );
    await assert.rejects(
      () => aiCall.generateStructured({ task: 'relevance', prompt: 'p', abortSignal: {} }),
      /unknown option\(s\) abortSignal/
    );
  });
});

// ── every error this module raises is attributable ─────────────────────────
//
// An unstamped error reaches aiRetry.classify() with no `provider` and is
// classified by SCRAPING ITS MESSAGE against Gemini's transient patterns. Two
// things fall out of that, and both were live here: a Claude-side failure got
// logged as a Gemini one by relevance.js's fail-open warning, and a message
// that happens to contain 503/UNAVAILABLE/overloaded got retried three times.
// The parse error's message is the dangerous one — it quotes the model's own
// output.

// Chosen, not invented: V8's parse message quotes the first TEN characters of
// the input, so this one comes back as `Unexpected token 'o', "overloaded"...`
// and matches GEMINI_TRANSIENT_RE's `\boverloaded\b`. (A leading `503 …` does
// NOT reproduce — a leading digit parses far enough that V8 reports a position
// instead of quoting the text — so the ten-character window is the whole
// exposure, and it is wide enough to hit.)
const badJson = 'overloaded — the model returned prose instead of JSON';

test('an unparseable Claude answer is attributed to Claude, and not retried', async () => {
  await withStubs({ provider: 'anthropic' }, async () => {
    anthropic.generate = async () => ({ text: badJson, usage: null, stopReason: 'end_turn', model: 'claude-haiku-4-5' });
    const err = await aiCall.generateStructured({
      task: 'relevance', prompt: 'p', responseSchema: SCHEMA, site: 'kb.relevanceDoc',
    }).then(() => null, (e) => e);
    assert.ok(err instanceof SyntaxError, 'the parse failure itself still surfaces');
    assert.strictEqual(err.provider, 'anthropic');
    assert.strictEqual(err.sdkRetried, false, 'nothing retried this — the parse is after the response');
    assert.strictEqual(aiRetry.classify(err).transient, false,
      'the model opening with the word "overloaded" must not buy three more attempts');
    assert.strictEqual(aiRetry.classify(Object.assign(new Error(err.message), {})).transient, true,
      'sanity: the same message WITHOUT the stamp is scraped as transient — that is the leak');
  });
});

test('an unparseable Gemini answer is attributed to Gemini', async () => {
  await withStubs({ provider: 'gemini' }, async () => {
    gemini.getClient = () => ({
      models: { generateContent: async () => ({ text: badJson, usageMetadata: {} }) },
    });
    const err = await aiCall.generateStructured({
      task: 'relevance', prompt: 'p', responseSchema: SCHEMA, site: 'kb.relevanceDoc',
    }).then(() => null, (e) => e);
    assert.strictEqual(err.provider, 'gemini',
      'a log line naming the wrong provider is worse than one naming none');
    // Gemini's classification is deliberately unchanged: its branch scrapes
    // whether or not the error is stamped, and every task runs here today.
    assert.strictEqual(aiRetry.classify(err).transient, true);
  });
});

test('the seam\'s own validation throws are stamped, and are never transient', async () => {
  // 'aiCall', not a vendor: no provider has been resolved when these fire. The
  // retry side matters because the unknown-option message interpolates the
  // caller's key names, so a mechanical port could put a Gemini transient token
  // straight into a message about a caller bug.
  const cases = [
    { task: 'relevance', prompt: 'p', deadlineExceeded: 1 },
    { prompt: 'p' },
    { task: 'relevance' },
  ];
  for (const args of cases) {
    const err = await aiCall.generateStructured(args).then(() => null, (e) => e);
    assert.strictEqual(err.provider, 'aiCall', `${JSON.stringify(args)} left an unstamped error`);
    assert.strictEqual(err.sdkRetried, false);
    assert.strictEqual(aiRetry.classify(err).transient, false,
      `${JSON.stringify(args)} is a deterministic caller bug — retrying it is three throws, not one`);
  }
});

// ── the seam→wrapper parameter contract ────────────────────────────────────
//
// Every other test in this file stubs anthropic.generate, so the OBJECT the
// seam builds is never checked against the function that receives it. Two
// ordinary mutations of that object literal pass the whole suite and break
// production on the first flip: renaming `site:` to `siteLabel:`, and
// forwarding a stray `responseMimeType` alongside the schema. Both throw
// `anthropic.generate: unknown option(s) …` against the real wrapper — and on
// `relevance` that is not an outage but the silent quarantine bypass this PR
// exists around, because checkDocRelevance catches everything and
// shouldQuarantine(null) is false.
test('the object the seam builds is accepted by the REAL anthropic.generate', async () => {
  // Capture what the seam actually sends, then replay it verbatim. Capturing
  // beats hand-writing the expected shape: a hand-written copy is a second
  // place to forget the rename.
  let sent;
  await withStubs({ provider: 'anthropic' }, async (seen) => {
    await aiCall.generateStructured({
      task: 'relevance', prompt: 'p', system: 's', responseSchema: SCHEMA,
      maxTokens: 400, temperature: 0.1, tenantId: 't1', site: 'kb.relevanceDoc',
    });
    sent = seen.anthropic[0];
  });

  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    // No key, so the call stops at getClient() — which is PAST the
    // unknown-option guard, past model/prompt validation, past the effort
    // interlock and past schema translation. Reaching that specific error is
    // the assertion: any renamed or added forwarded key fails first, as
    // `unknown option(s) …`, and any key the wrapper validates differently
    // fails with its own message.
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(
      () => anthropic.generate(sent),
      /ANTHROPIC_API_KEY is not set/,
      'the seam is passing anthropic.generate something it does not accept — compare the ' +
      'object literal in aiCall.generateStructured against generate()\'s destructuring'
    );
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

// ── the parse is a verdict gate, not just a JSON.parse ─────────────────────

test('valid JSON that is not an object is rejected, stamped, rather than returned', async () => {
  // Fail-CLOSED where the file's whole design is fail-OPEN. Every schema here
  // describes an object; `[]`, `5`, `"hi"` and `true` all parse. Returned as
  // `parsed`, each one gives relevance `{isOnTopic: false, confidence: 0}` —
  // because `undefined === true` is false and `Number(undefined) || 0` is 0 —
  // which QUARANTINES A LEGITIMATE DOCUMENT with nothing logged at all. `null`
  // threw an unstamped TypeError instead, logged as `failed on unknown`, which
  // sends triage after a missing stamp that is not missing.
  for (const body of ['[]', '5', '"hi"', 'true', 'null']) {
    await withStubs({ provider: 'anthropic' }, async () => {
      anthropic.generate = async () => ({ text: body, usage: null, stopReason: 'end_turn', model: 'claude-haiku-4-5' });
      const err = await aiCall.generateStructured({
        task: 'relevance', prompt: 'p', responseSchema: SCHEMA, site: 'kb.relevanceDoc',
      }).then((r) => new Error(`${body} was accepted as a verdict: ${JSON.stringify(r.parsed)}`), (e) => e);
      assert.match(err.message, /not an object/, `${body} must be rejected`);
      assert.strictEqual(err.provider, 'anthropic', `${body} left an unattributed error`);
      assert.strictEqual(aiRetry.classify(err).transient, false,
        `${body} is a deterministic bad answer — retrying it is three throws, not one`);
    });
  }
});

test('a real object still parses', async () => {
  await withStubs({ provider: 'anthropic' }, async () => {
    const r = await aiCall.generateStructured({
      task: 'relevance', prompt: 'p', responseSchema: SCHEMA, site: 'kb.relevanceDoc',
    });
    assert.deepStrictEqual(r.parsed, { ok: true }, 'the guard must not be a blanket no');
  });
});

test('a missing GEMINI_API_KEY leaves a stamped error, not an unattributed one', async () => {
  // providerFor() only key-checks NON-DEFAULT providers, so a process with no
  // GEMINI_API_KEY resolves to gemini and dies inside getClient() — whose error
  // this module used to let past unstamped, straight into classify()'s
  // message-scraping branch. That falsifies the invariant stated in this file's
  // own header, and the message is provider prose we do not control.
  await withStubs({ provider: 'gemini' }, async () => {
    gemini.getClient = () => { throw new Error('GEMINI_API_KEY is not set'); };
    const err = await aiCall.generateStructured({
      task: 'relevance', prompt: 'p', responseSchema: SCHEMA, site: 'kb.relevanceDoc',
    }).then(() => null, (e) => e);
    assert.strictEqual(err.provider, 'gemini');
    assert.strictEqual(err.sdkRetried, false);
  });
});

test('stamp() never downgrades an error another module already attributed', () => {
  // Called directly, because no path through generateStructured reaches this
  // branch today — an error from anthropic.generate propagates without passing
  // through stamp() at all. That is exactly what makes the guard worth pinning:
  // the day someone wraps that call (to add a label, a timeout, a metric) every
  // Anthropic error starts flowing through here, and an unconditional
  // `err.sdkRetried = false` silently resets the one field classify() uses to
  // stop the app layer stacking a second set of retries. Measured cost of that
  // stacking: 3 SDK attempts × 3 app tries = 9 upstream requests for one call.
  const already = Object.assign(new Error('AI quota exhausted — retry shortly.'), {
    provider: 'anthropic', sdkRetried: true, status: 429,
  });
  assert.strictEqual(aiCall.stamp(already, 'aiCall'), already);
  assert.strictEqual(already.provider, 'anthropic', 'the vendor that raised it still owns it');
  assert.strictEqual(already.sdkRetried, true, 'the SDK really did retry this — do not claim otherwise');
  assert.strictEqual(aiRetry.classify(already).transient, false, 'so the app layer stands down');

  // And an unattributed error still gets this module's stamp.
  const fresh = aiCall.stamp(new Error('boom'), 'aiCall');
  assert.strictEqual(fresh.provider, 'aiCall');
  assert.strictEqual(fresh.sdkRetried, false);
});

test('an unknown effort is rejected at the seam, on BOTH providers', async () => {
  // Gemini ignores `effort` entirely, so a typo there is a no-op until someone
  // flips the task to Claude — which is the worst possible moment to find it.
  for (const provider of ['gemini', 'anthropic']) {
    await withStubs({ provider }, async () => {
      const err = await aiCall.generateStructured({
        task: 'relevance', prompt: 'p', effort: 'xhgih', site: 'kb.relevanceDoc',
      }).then(() => null, (e) => e);
      assert.match(err.message, /unknown effort "xhgih"/, `${provider} accepted a typo'd effort`);
      assert.strictEqual(err.provider, 'aiCall');
    });
  }
  // Same vocabulary as the wrapper's, not a second copy that can drift.
  assert.ok(anthropic.EFFORTS.has('xhigh') && anthropic.EFFORTS.has('max'));
});

test('generateStructured() with no argument throws a stamped seam error', async () => {
  // Destructuring `undefined` is an unstamped TypeError, which reaches
  // classify() with no provider and is routed by scraping a V8 message.
  const err = await aiCall.generateStructured().then(() => null, (e) => e);
  assert.strictEqual(err.provider, 'aiCall');
  assert.match(err.message, /task required/);
});

test('membership in DISPATCH_READY is eligibility, not a flip', () => {
  // Groups 1 and 2 are migrated and eligible, but with no AI_PROVIDER_* set every
  // task — ready or not — still resolves to Gemini. Eligibility and activation are
  // separate on purpose: merging the code must not move traffic, so the flip is
  // an env change an operator makes deliberately and can reverse.
  assert.deepStrictEqual([...models.DISPATCH_READY].sort(),
    ['assessment', 'battlecard', 'companyBrief', 'keypoints', 'preview', 'relevance'],
    'a task joins this set in the same PR that migrates its call site');
  for (const task of Object.keys(models.TASKS)) {
    assert.strictEqual(models.resolve(task).provider, 'gemini', task);
  }
});

// ── the fail-closed guard ──────────────────────────────────────────────────

test('an unconfigured provider falls back to Gemini instead of dispatching', () => {
  // The scenario: a task is migrated and in DISPATCH_READY, an operator sets
  // AI_PROVIDER_RELEVANCE=anthropic, and the environment has no key. Every
  // getClient() then throws — which for relevance is not an outage but a SILENT
  // quarantine bypass, because checkDocRelevance catches everything and
  // shouldQuarantine(null) is false. Falling back is the only safe answer.
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    env: process.env.AI_PROVIDER_RELEVANCE,
    wasReady: models.DISPATCH_READY.has('relevance'),
  };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_PROVIDER_RELEVANCE = 'anthropic';
    models.DISPATCH_READY.add('relevance');
    assert.strictEqual(models.isProviderConfigured('anthropic'), false);
    const r = models.resolve('relevance');
    assert.strictEqual(r.provider, 'gemini', 'must not dispatch to a provider with no credentials');
    assert.strictEqual(r.model, 'gemini-2.5-flash-lite', 'and the model must match the provider it fell back to');
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.env === undefined) delete process.env.AI_PROVIDER_RELEVANCE;
    else process.env.AI_PROVIDER_RELEVANCE = saved.env;
    if (!saved.wasReady) models.DISPATCH_READY.delete('relevance');
  }
});

test('a configured provider on a ready task does dispatch — the guard is not a blanket no', () => {
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    env: process.env.AI_PROVIDER_RELEVANCE,
    wasReady: models.DISPATCH_READY.has('relevance'),
  };
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_PROVIDER_RELEVANCE = 'anthropic';
    models.DISPATCH_READY.add('relevance');
    const r = models.resolve('relevance');
    assert.strictEqual(r.provider, 'anthropic');
    assert.strictEqual(r.model, 'claude-haiku-4-5');
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.env === undefined) delete process.env.AI_PROVIDER_RELEVANCE;
    else process.env.AI_PROVIDER_RELEVANCE = saved.env;
    if (!saved.wasReady) models.DISPATCH_READY.delete('relevance');
  }
});
