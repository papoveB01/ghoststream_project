// The provider seam for grounded context (ADR-0006 §9 item 4).
//
// What this file is defending, in order of how much damage each would do:
//
//   1. A Claude model id reaching Google's caches API. personas.js resolves
//      modelFor('personas') and arena.js hands it straight to
//      gemini.caches.create(); the ADR names this as the specific thing item 4
//      must fix. The seam must dispatch on provider, and the Gemini client must
//      refuse the id even if something bypasses the seam.
//   2. Paying twice for a cached prefix. On Gemini a 'cached' record's body
//      lives server-side and must NOT be re-sent inline; an 'inline' one must.
//      Getting that backwards costs money in the direction the ADR's margin
//      table cannot absorb, and nothing about the response would look wrong.
//   3. temperature reaching Claude. It is a 400 on Opus 5, and arena.js's 0.85
//      is the one setting with no substitute (ADR-0006 §7) — so it has to be
//      dropped loudly, not passed through and not dropped in silence.
//   4. The prefix losing its cache_control breakpoint, which is the entire
//      point of the Claude branch and fails silently (full price, HTTP 200).
//
// Everything is stubbed: no network, no Redis, no Postgres.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

function stubModule(rel, exportsObj) {
  const full = require.resolve(path.join(SRC, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
  return exportsObj;
}

// costs → db needs Postgres. Telemetry itself is covered by costsTelemetry.test.js.
const recorded = { gemini: [], claude: [] };
stubModule('costs.js', {
  recordGemini: (...a) => { recorded.gemini.push(a); return Promise.resolve(); },
  recordClaude: (...a) => { recorded.claude.push(a); return Promise.resolve(); },
});

// gemini.js eager-connects ioredis at require time.
stubModule('redis.js', {
  on: () => {}, get: async () => null, set: async () => 'OK',
  del: async () => 0, mget: async () => [], quit: async () => {}, disconnect: () => {},
});

// Fake Anthropic SDK — records what the wrapper puts on the wire.
const sentClaude = [];
function FakeAnthropic() {
  this.messages = {
    create: async (params) => {
      sentClaude.push(params);
      return {
        content: [{ type: 'text', text: 'claude says' }],
        stop_reason: 'end_turn',
        model: params.model,
        usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 2400 },
      };
    },
    stream: (params) => {
      sentClaude.push(params);
      return { finalMessage: async () => ({
        content: [{ type: 'text', text: 'streamed' }], stop_reason: 'end_turn',
        model: params.model, usage: { input_tokens: 1, output_tokens: 1 },
      }) };
    },
  };
}
class FakeAPIError extends Error {}
FakeAnthropic.APIError = FakeAPIError;
for (const k of ['RateLimitError', 'AuthenticationError', 'PermissionDeniedError',
  'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError']) {
  FakeAnthropic[k] = class extends FakeAPIError {};
}
const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [path.join(__dirname, '..')] });
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

// Fake Google SDK, same idea. gemini.js constructs it lazily inside getClient().
const sentGemini = [];
const cachesCreated = [];
function FakeGoogleGenAI() {
  this.caches = {
    create: async (args) => { cachesCreated.push(args); return { name: 'cachedContents/xyz', displayName: args.config.displayName }; },
    delete: async () => ({}),
  };
  this.models = {
    generateContent: async (args) => {
      sentGemini.push(args);
      return {
        text: 'gemini says',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
        candidates: [{ finishReason: 'STOP' }],
      };
    },
  };
}
const genaiPath = require.resolve('@google/genai', { paths: [path.join(__dirname, '..')] });
require.cache[genaiPath] = {
  id: genaiPath, filename: genaiPath, loaded: true,
  exports: { GoogleGenAI: FakeGoogleGenAI },
};
process.env.GEMINI_API_KEY = 'gm-test';

const models = require(path.join(SRC, 'models.js'));
const gemini = require(path.join(SRC, 'gemini.js'));
const aiContext = require(path.join(SRC, 'aiContext.js'));

const PREFIX = [
  { role: 'user', text: 'You are Sara Chen, CFO.' },
  { role: 'assistant', text: 'Understood. I am in character.' },
];

function asAnthropic(task, fn) {
  models.DISPATCH_READY.add(task);
  const saved = process.env[models.providerEnvName(task)];
  process.env[models.providerEnvName(task)] = 'anthropic';
  const finish = () => {
    models.DISPATCH_READY.delete(task);
    if (saved === undefined) delete process.env[models.providerEnvName(task)];
    else process.env[models.providerEnvName(task)] = saved;
  };
  return Promise.resolve(fn()).finally(finish);
}

function reset() {
  sentClaude.length = 0; sentGemini.length = 0; cachesCreated.length = 0;
  recorded.gemini.length = 0; recorded.claude.length = 0;
}

// ── the routing hazard ──────────────────────────────────────────────────────

test('an anthropic task never touches the Gemini caches API', async () => {
  reset();
  await asAnthropic('personas', async () => {
    const record = await aiContext.prepare({
      task: 'personas', name: 'persona:skeptical-cfo',
      systemInstruction: 'meta rules', turns: PREFIX, geminiModel: 'gemini-2.5-pro',
    });
    assert.strictEqual(record.provider, 'anthropic');
    assert.strictEqual(record.mode, 'breakpoint');
    assert.strictEqual(record.model, 'claude-sonnet-5');
    // The whole reason this seam exists: caches.create() is a Google endpoint
    // and a Claude id posted to it is a 404 that names nothing.
    assert.strictEqual(cachesCreated.length, 0,
      'prepare() on anthropic must make no API call at all — a breakpoint is a per-request annotation');
    // geminiModel is a Gemini-branch escape hatch; it must not leak across.
    assert.ok(!/gemini/.test(record.model));
  });
});

test('the Gemini client refuses a Claude model id even when the seam is bypassed', async () => {
  // arena.js still calls gemini.getOrCreateCache directly until its own cutover
  // PR (§9 item 5), so the guard has to live in the client too, not only here.
  await assert.rejects(
    () => gemini.getOrCreateCache({
      name: 'persona:x', model: 'claude-sonnet-5', contents: ['body'],
    }),
    /is a anthropic model id/,
    'a 404 from Google names neither the provider nor the env var that caused it'
  );
  await assert.rejects(
    () => gemini.generateForRecord({
      record: { mode: 'inline', model: 'claude-opus-5', contents: [] }, message: 'hi',
    }),
    /is a anthropic model id/
  );
});

test('an unrecognised model id is allowed through, not blocked', async () => {
  reset();
  // The guard blocks a confidently-wrong id. Allow-listing would break a custom
  // endpoint id set via GEMINI_*_MODEL, or any model released after this code.
  assert.strictEqual(models.providerOfModel('some-internal-endpoint-v3'), null);
  const record = await gemini.getOrCreateCache({
    name: 'x', model: 'some-internal-endpoint-v3', contents: ['body'],
  });
  assert.strictEqual(record.mode, 'cached');
});

// ── the Gemini branch: unchanged behaviour ──────────────────────────────────

test('a cached record does not re-send its body; an inline one does', async () => {
  reset();
  const cached = await aiContext.prepare({
    task: 'personas', name: 'persona:a', systemInstruction: 'meta', turns: PREFIX,
  });
  assert.strictEqual(cached.provider, 'gemini');
  assert.strictEqual(cached.mode, 'cached');

  await aiContext.generate({ record: cached, message: 'open the call', maxOutputTokens: 400 });
  let sent = sentGemini[sentGemini.length - 1];
  assert.strictEqual(sent.contents.length, 1,
    'the prefix lives server-side on a cached record — re-sending it pays for it twice');
  assert.strictEqual(sent.config.cachedContent, 'cachedContents/xyz');
  assert.strictEqual(sent.config.systemInstruction, undefined,
    'the system instruction is part of the cached resource');

  const inline = { ...cached, mode: 'inline', systemInstruction: 'meta', cacheName: null };
  await aiContext.generate({ record: inline, message: 'open the call' });
  sent = sentGemini[sentGemini.length - 1];
  assert.strictEqual(sent.contents.length, 3, 'an inline record has to carry its own prefix');
  assert.strictEqual(sent.contents[0].parts[0].text, 'You are Sara Chen, CFO.');
  assert.strictEqual(sent.config.cachedContent, undefined);
  assert.strictEqual(sent.config.systemInstruction, 'meta');

  // An inline record that lost its neutral turns — round-tripped through
  // storage, or hand-built — must still ground. Dropping the prefix here is
  // silent: the model simply answers without its persona.
  const noTurns = { ...inline, turns: undefined, contents: aiContext.toGeminiContents(PREFIX) };
  await aiContext.generate({ record: noTurns, message: 'open the call' });
  sent = sentGemini[sentGemini.length - 1];
  assert.strictEqual(sent.contents.length, 3);
  assert.strictEqual(sent.contents[0].parts[0].text, 'You are Sara Chen, CFO.');
});

test('assistant turns go to Gemini as role "model", and thinking stays off', async () => {
  reset();
  const record = await aiContext.prepare({ task: 'personas', name: 'persona:b', turns: PREFIX });
  await aiContext.generate({
    record,
    turns: [{ role: 'user', text: 'grounding' }, { role: 'assistant', text: 'opener' }],
    message: 'rep reply',
    temperature: 0.85,
  });
  const sent = sentGemini[sentGemini.length - 1];
  assert.deepStrictEqual(sent.contents.map((c) => c.role), ['user', 'model', 'user'],
    'Gemini spells the non-user role "model"; sending "assistant" is a 400');
  assert.strictEqual(sent.config.temperature, 0.85, 'the Gemini branch keeps temperature');
  assert.deepStrictEqual(sent.config.thinkingConfig, { thinkingBudget: 0 },
    'every call site being replaced sends thinkingBudget 0 — the seam must not flip it');
});

test('spend is recorded against the serving provider on both branches', async () => {
  reset();
  const g = await aiContext.prepare({ task: 'personas', name: 'persona:c', turns: PREFIX });
  await aiContext.generate({ record: g, message: 'x', tenantId: 't1', site: 'arena.turn' });
  assert.strictEqual(recorded.gemini.length, 1);
  assert.deepStrictEqual(recorded.gemini[0].slice(0, 2), ['t1', 'arena.turn']);
  assert.strictEqual(recorded.claude.length, 0);

  await asAnthropic('personas', async () => {
    const a = await aiContext.prepare({ task: 'personas', name: 'persona:c', turns: PREFIX });
    await aiContext.generate({ record: a, message: 'x', tenantId: 't1', site: 'arena.turn' });
  });
  assert.strictEqual(recorded.claude.length, 1);
  assert.deepStrictEqual(recorded.claude[0].slice(0, 2), ['t1', 'arena.turn']);
});

// ── the Claude branch ───────────────────────────────────────────────────────

test('the stable prefix carries exactly one cache_control breakpoint, at its end', async () => {
  reset();
  await asAnthropic('personas', async () => {
    const record = await aiContext.prepare({
      task: 'personas', name: 'persona:d', systemInstruction: 'meta rules', turns: PREFIX,
    });
    await aiContext.generate({
      record,
      turns: [{ role: 'user', text: 'grounding' }, { role: 'assistant', text: 'opener' }],
      message: 'rep reply',
    });
  });
  const sent = sentClaude[sentClaude.length - 1];
  assert.deepStrictEqual(sent.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
    'prefix, then the transcript, then the new rep turn');

  const marked = sent.messages.filter((m) =>
    Array.isArray(m.content) && m.content.some((b) => b.cache_control));
  assert.strictEqual(marked.length, 1, 'one breakpoint, not one per turn — the budget is four');
  assert.strictEqual(marked[0].content[0].text, 'Understood. I am in character.',
    'it belongs at the END of the stable prefix; anything after it changes every turn');
  // Caching is prefix-based, so the system block above the breakpoint is
  // already covered — a second breakpoint on it would be redundant.
  assert.strictEqual(typeof sent.system, 'string');
});

test('an empty prefix is a Claude-only shape — Gemini rejects it, and should', async () => {
  // caches.create() rejects empty contents, so "system instruction only" is not
  // a preparable context on Gemini. It is perfectly valid on Claude, where the
  // system block can be the whole cached prefix. Pinned so the asymmetry is a
  // known property of the seam rather than a surprise found during a cutover.
  await assert.rejects(
    () => aiContext.prepare({ task: 'personas', name: 'x', systemInstruction: 'meta', turns: [] }),
    /contents required/
  );
  await asAnthropic('personas', async () => {
    const record = await aiContext.prepare({
      task: 'personas', name: 'x', systemInstruction: 'meta', turns: [],
    });
    assert.strictEqual(record.mode, 'breakpoint');
  });
});

test('with no prefix turns the system block is the breakpoint instead', async () => {
  reset();
  await asAnthropic('personas', async () => {
    const record = await aiContext.prepare({
      task: 'personas', name: 'persona:e', systemInstruction: 'the only stable part', turns: [],
    });
    await aiContext.generate({ record, message: 'hello' });
  });
  const sent = sentClaude[sentClaude.length - 1];
  assert.deepStrictEqual(sent.system, [
    { type: 'text', text: 'the only stable part', cache_control: { type: 'ephemeral' } },
  ], 'there is nowhere else to put it');
});

test('temperature is dropped for Claude, and says so once', async () => {
  reset();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    await asAnthropic('personas', async () => {
      const record = await aiContext.prepare({ task: 'personas', name: 'persona:f', turns: PREFIX });
      await aiContext.generate({ record, message: 'x', temperature: 0.85, site: 'arena.turn' });
    });
  } finally { console.warn = realWarn; }
  const sent = sentClaude[sentClaude.length - 1];
  assert.strictEqual(sent.temperature, undefined, 'temperature is a 400 on Opus 5');
  assert.ok(warnings.some((w) => w.includes('temperature 0.85 dropped')),
    'arena.js sets 0.85 for persona variety and there is no substitute — dropping it silently ' +
    'would surface later as "the personas got blander" with nothing to point at');
});

test('an unsupported-parameter regression would fail loudly, not vanish', async () => {
  // The wrapper rejects unknown keys. This pins that the seam never hands it a
  // Gemini spelling — the failure mode being a call site's only time bound
  // quietly disappearing during a mechanical port.
  reset();
  await asAnthropic('personas', async () => {
    const record = await aiContext.prepare({ task: 'personas', name: 'persona:g', turns: PREFIX });
    await aiContext.generate({
      record, message: 'x', maxOutputTokens: 500, signal: AbortSignal.timeout(5000),
    });
  });
  const sent = sentClaude[sentClaude.length - 1];
  assert.strictEqual(sent.max_tokens, 500, 'maxOutputTokens → max_tokens');
});

test('an inline record with EMPTY turns falls back to its contents, not to nothing', async () => {
  // `[]` is truthy, so a truthiness test here would take the turns branch,
  // produce [], and drop the persona — the exact failure the fallback exists to
  // prevent, wearing the costume of the fix for it. Found by review, not by CI.
  reset();
  const record = {
    provider: 'gemini', mode: 'inline', model: 'gemini-2.5-flash',
    systemInstruction: 'meta', turns: [],
    contents: aiContext.toGeminiContents(PREFIX),
  };
  await aiContext.generate({ record, message: 'hello' });
  const sent = sentGemini[sentGemini.length - 1];
  assert.strictEqual(sent.contents.length, 3);
  assert.strictEqual(sent.contents[0].parts[0].text, 'You are Sara Chen, CFO.',
    'an empty turns array must not be read as "this record has a prefix, and it is nothing"');
});

test('an unknown option throws instead of being dropped in silence', async () => {
  // The seam INVERTS the spellings relative to anthropic.generate, so a call
  // site ported from there brings `maxTokens` and one ported from a Gemini
  // config brings `abortSignal`. Dropping either silently costs that call site
  // its output budget or its only wall-clock bound, and nothing would notice.
  const record = await aiContext.prepare({ task: 'personas', name: 'x', turns: PREFIX });
  await assert.rejects(
    () => aiContext.generate({ record, message: 'x', maxTokens: 4000 }),
    /unknown option\(s\) maxTokens/
  );
  await assert.rejects(
    () => aiContext.generate({ record, message: 'x', abortSignal: AbortSignal.timeout(1000) }),
    /abortSignal/
  );
});

test('allowTruncation reaches the Claude branch, where a full budget throws', async () => {
  // Gemini returns partial text with finishReason MAX_TOKENS; Claude throws a
  // 502 unless told otherwise. arena.js runs at 400–600 output tokens with a
  // persona told to answer in "two to four sentences", so the flip turns a
  // truncated reply into a dead practice session unless this is forwarded.
  reset();
  const real = require.cache[sdkPath].exports;
  const Truncating = function () {
    this.messages = { create: async () => ({
      content: [{ type: 'text', text: 'half an ans' }], stop_reason: 'max_tokens',
      model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 600 },
    }) };
  };
  Object.assign(Truncating, real);
  require.cache[sdkPath].exports = Truncating;
  const wrapperPath = require.resolve(path.join(SRC, 'anthropic.js'));
  const seamPath = require.resolve(path.join(SRC, 'aiContext.js'));
  delete require.cache[wrapperPath];
  delete require.cache[seamPath];
  const freshSeam = require(seamPath);
  try {
    await asAnthropic('personas', async () => {
      const record = await freshSeam.prepare({ task: 'personas', name: 'x', turns: PREFIX });
      await assert.rejects(
        () => freshSeam.generate({ record, message: 'x', maxOutputTokens: 600 }),
        (e) => e.truncated === true
      );
      const ok = await freshSeam.generate({
        record, message: 'x', maxOutputTokens: 600, allowTruncation: true,
      });
      assert.strictEqual(ok.text, 'half an ans', 'the opt-in must actually reach the wrapper');
    });
  } finally {
    require.cache[sdkPath].exports = real;
    delete require.cache[wrapperPath];
    delete require.cache[seamPath];
  }
});

test('one prepared record can be generated from twice without accumulating breakpoints', async () => {
  // arena.js re-prepares per turn, but a future refactor memoizing the prefix on
  // the record would double the breakpoint each call and eventually 400 at five.
  reset();
  await asAnthropic('personas', async () => {
    const record = await aiContext.prepare({ task: 'personas', name: 'x', turns: PREFIX });
    await aiContext.generate({ record, message: 'turn one' });
    await aiContext.generate({ record, message: 'turn two' });
  });
  for (const sent of sentClaude) {
    const marks = sent.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.cache_control);
    assert.strictEqual(marks.length, 1, 'one breakpoint per call, every call');
  }
  // …and the record's own neutral turns are untouched, still plain strings.
  assert.deepStrictEqual(PREFIX.map((t) => typeof t.text), ['string', 'string']);
});

// ── discard ─────────────────────────────────────────────────────────────────

test('discard deletes on Gemini and is an honest no-op on Claude', async () => {
  reset();
  const record = await aiContext.prepare({ task: 'personas', name: 'kb:global', turns: PREFIX });
  assert.strictEqual(record.mode, 'cached');
  // The Gemini path goes through the registry, which the redis stub keeps empty
  // — invalidate() reports false for a name it has no entry for. What matters
  // here is that it reached the client at all.
  assert.strictEqual(typeof await aiContext.discard({ task: 'personas', name: 'kb:global' }), 'boolean');

  await asAnthropic('personas', async () => {
    assert.strictEqual(await aiContext.discard({ task: 'personas', name: 'kb:global' }), false,
      'nothing was invalidated because nothing exists — a breakpoint has no server resource');

    // …but a caller holding a STORED Gemini pointer must still be able to
    // delete it after its task has flipped. Resolving from the task alone would
    // no-op here, and globalCache then nulls cache_name — orphaning a live
    // cachedContent with nothing left that can name it.
    const invalidated = [];
    const realInvalidate = gemini.invalidate;
    gemini.invalidate = async (n) => { invalidated.push(n); return true; };
    try {
      assert.strictEqual(
        await aiContext.discard({ task: 'personas', name: 'kb:global', provider: 'gemini' }), true);
      assert.deepStrictEqual(invalidated, ['kb:global']);
    } finally { gemini.invalidate = realInvalidate; }
  });
});

// ── input validation ────────────────────────────────────────────────────────

test('the neutral turn shape is enforced at the seam, not at the provider', async () => {
  await assert.rejects(
    () => aiContext.prepare({ task: 'personas', name: 'x', turns: [{ role: 'model', text: 'hi' }] }),
    /must be "user" or "assistant"/,
    'accepting Gemini\'s "model" here would send an invalid role to Claude two layers down'
  );
  await assert.rejects(
    () => aiContext.prepare({ task: 'personas', name: 'x', turns: [{ role: 'user', text: null }] }),
    /text string/
  );
  await assert.rejects(() => aiContext.prepare({ name: 'x', turns: [] }), /task required/);
  await assert.rejects(() => aiContext.prepare({ task: 'personas', turns: [] }), /name required/);
});

test('generate refuses an empty conversation', async () => {
  const record = await aiContext.prepare({ task: 'personas', name: 'x', turns: PREFIX });
  await assert.rejects(() => aiContext.generate({ record }), /turns or message required/);
  await assert.rejects(() => aiContext.generate({ message: 'x' }), /record required/);
});
