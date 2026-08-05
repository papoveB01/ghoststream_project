// What the Anthropic wrapper actually puts on the wire.
//
// This file exists because of a defect that CI could not have caught and a
// reviewer reading the diff would not have seen. The wrapper originally sent
// `thinking: {type:'adaptive'}` and `output_config.effort` on every request.
// Both are 4.6-and-later parameters, and claude-haiku-4-5 — our entire LITE
// tier (relevance, preview, companyBrief, callEntities, assessment) — rejects
// them with a 400:
//
//   thinking: {type:'adaptive'}   → "adaptive thinking is not supported on this model"
//   output_config: {effort:'low'} → "This model does not support the effort parameter."
//
// So the first task flipped to Claude would have 400'd for every tenant, with
// CI green and the deploy reporting success. Only a live call surfaced it.
// These tests pin the request shape per model family so it cannot regress.
//
// The SDK is replaced in require.cache before the wrapper is required, so
// nothing here touches the network.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const API = path.join(__dirname, '..');
const sent = [];

// Minimal stand-in for the SDK: records params, returns a well-formed message.
class FakeAPIError extends Error {}
function FakeAnthropic() {
  this.messages = {
    create: async (params) => {
      sent.push(params);
      return {
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
        model: params.model,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
    stream: (params) => {
      sent.push(params);
      return { finalMessage: async () => ({
        content: [{ type: 'text', text: 'streamed' }],
        stop_reason: 'end_turn', model: params.model,
        usage: { input_tokens: 1, output_tokens: 1 },
      }) };
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

// costs → db would need Postgres; the wrapper's telemetry is fire-and-forget
// and covered by costsTelemetry.test.js, so stub it out of the way.
const costsPath = require.resolve(path.join(API, 'src', 'costs.js'));
const recorded = [];
require.cache[costsPath] = {
  id: costsPath, filename: costsPath, loaded: true,
  exports: { recordClaude: (...a) => { recorded.push(a); return Promise.resolve(); } },
};

process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
const anthropic = require(path.join(API, 'src', 'anthropic.js'));

const last = () => sent[sent.length - 1];

test('the legacy surface (haiku 4.5) gets neither thinking nor effort', async () => {
  await anthropic.generate({ model: 'claude-haiku-4-5', prompt: 'x', effort: 'low' });
  const p = last();
  assert.strictEqual(p.thinking, undefined,
    'claude-haiku-4-5 rejects adaptive thinking with a 400 — sending it breaks the whole lite tier');
  assert.strictEqual(p.output_config, undefined,
    'claude-haiku-4-5 rejects the effort parameter with a 400');
  assert.strictEqual(p.model, 'claude-haiku-4-5');
  assert.strictEqual(p.max_tokens, 4096);
});

test('the legacy surface still gets structured output — that part is supported', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  await anthropic.generate({ model: 'claude-haiku-4-5', prompt: 'x', schema });
  const p = last();
  // Translated on the way out, never passed through: a Gemini-dialect schema
  // without additionalProperties is a hard 400 on every model. See
  // src/schemaCompat.js; the translation itself is covered by schemaCompat.test.js.
  assert.deepStrictEqual(p.output_config, {
    format: { type: 'json_schema', schema: { ...schema, additionalProperties: false } },
  });
  assert.strictEqual(p.thinking, undefined);
});

test('the caller\'s schema object is not mutated by the call', async () => {
  // generate() is handed a module-level constant that the Gemini path still
  // sends. If translation mutated it in place, one Anthropic call would silently
  // rewrite what every subsequent Gemini call site sends.
  // Includes a nullable ENUM deliberately: that is the only branch in
  // schemaCompat that deletes keys, so a fixture without one passes against a
  // destructive implementation.
  const schema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean', nullable: true },
      cat: { type: 'string', enum: ['A', 'B'], nullable: true },
    },
    required: ['ok'],
  };
  const before = JSON.parse(JSON.stringify(schema));
  await anthropic.generate({ model: 'claude-haiku-4-5', prompt: 'x', schema });
  assert.deepStrictEqual(schema, before);
});

test('the modern surface gets both thinking and effort when asked', async () => {
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', effort: 'high', thinking: true });
  const p = last();
  assert.deepStrictEqual(p.thinking, { type: 'adaptive' });
  assert.strictEqual(p.output_config.effort, 'high');
});

test('sonnet 4.5 is treated as legacy, sonnet 5 is not', async () => {
  await anthropic.generate({ model: 'claude-sonnet-4-5', prompt: 'x', thinking: true });
  assert.strictEqual(last().thinking, undefined);
  await anthropic.generate({ model: 'claude-sonnet-5', prompt: 'x', thinking: true });
  assert.deepStrictEqual(last().thinking, { type: 'adaptive' });
});

test('an unrecognised model defaults to the modern surface', async () => {
  // A model released after this code was written should work without an edit;
  // the exception list names the models that predate the 4.6 surface.
  await anthropic.generate({ model: 'claude-opus-9', prompt: 'x', thinking: true });
  assert.deepStrictEqual(last().thinking, { type: 'adaptive' });
});

test('thinking defaults OFF so a mechanical port preserves call-site behaviour', async () => {
  // Every Gemini call site being replaced sets thinkingBudget: 0. Defaulting on
  // would flip that AND eat the answer budget, silently shortening output.
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x' });
  assert.deepStrictEqual(last().thinking, { type: 'disabled' });
});

test('temperature is never sent — it is a 400 on opus 5', async () => {
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x' });
  const p = last();
  assert.strictEqual(p.temperature, undefined);
  assert.strictEqual(p.top_p, undefined);
  assert.strictEqual(p.top_k, undefined);
});

test('a cached system prompt becomes a block list with cache_control', async () => {
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', system: 'stable prefix', cacheSystem: true });
  assert.deepStrictEqual(last().system, [
    { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } },
  ]);
  // A plain string cannot carry cache_control, so the uncached form stays a string.
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', system: 'stable prefix' });
  assert.strictEqual(last().system, 'stable prefix');
});

// ── multi-turn (ADR-0006 §9 item 4) ─────────────────────────────────────────
//
// Arena replays its whole transcript on every turn, so a wrapper hardcoded to
// one user message could not serve arena.js at all — which is why the ADR makes
// the seam a prerequisite for the Arena cutover rather than part of it.

test('a conversation goes on the wire in order, with prompt as the one-turn sugar', async () => {
  await anthropic.generate({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'grounding' },
      { role: 'assistant', content: 'opener' },
      { role: 'user', content: 'rep reply' },
    ],
  });
  assert.deepStrictEqual(last().messages, [
    { role: 'user', content: 'grounding' },
    { role: 'assistant', content: 'opener' },
    { role: 'user', content: 'rep reply' },
  ]);
  await anthropic.generate({ model: 'claude-sonnet-5', prompt: 'just one' });
  assert.deepStrictEqual(last().messages, [{ role: 'user', content: 'just one' }]);
});

test('consecutive same-role turns are merged rather than sent as-is', async () => {
  // Defensive, not a claim about what the API accepts: the seam concatenates a
  // stable prefix with a live transcript, and whether that join lands
  // user-on-user depends on how a given persona seed happens to end. Merging
  // makes that a non-event instead of a 400 that only some personas trigger.
  await anthropic.generate({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'prefix tail' },
      { role: 'user', content: 'grounding' },
      { role: 'assistant', content: 'a' },
    ],
  });
  assert.deepStrictEqual(last().messages, [
    { role: 'user', content: 'prefix tail\n\ngrounding' },
    { role: 'assistant', content: 'a' },
  ]);
});

test('merging preserves a cache_control block instead of flattening it to text', async () => {
  // The breakpoint is the entire value of the Claude branch, and losing it
  // fails silently: HTTP 200, full price, nothing in the response to look at.
  await anthropic.generate({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'persona', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'grounding' },
    ],
  });
  const [m] = last().messages;
  assert.strictEqual(m.content.length, 2);
  assert.deepStrictEqual(m.content[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(m.content[1].text, 'grounding');
});

test('an invalid conversation is rejected here, not by the API', async () => {
  const bad = (messages) => anthropic.generate({ model: 'claude-sonnet-5', messages });
  await assert.rejects(() => bad([{ role: 'model', content: 'x' }]), /role must be "user" or "assistant"/,
    'Gemini\'s "model" role is the spelling a mechanical port would carry over');
  await assert.rejects(() => bad([{ role: 'system', content: 'x' }]), /role must be/);
  await assert.rejects(() => bad([{ role: 'assistant', content: 'x' }]), /first message must be from the user/);
  await assert.rejects(() => bad([]), /non-empty array/);
  await assert.rejects(() => bad([{ role: 'user', content: 42 }]), /string or a block array/);
  await assert.rejects(() => bad([{ role: 'user', content: '' }]), /no content/);
});

test('a fifth cache_control breakpoint is refused before the request is sent', async () => {
  // The API's answer is a hard 400 ("A maximum of 4 blocks with cache_control
  // may be provided. Found 5."), not a silent drop — so budgeting breakpoints
  // is a validation constraint, and the message should name the budget.
  const block = (t) => [{ type: 'text', text: t, cache_control: { type: 'ephemeral' } }];
  const four = {
    model: 'claude-sonnet-5',
    system: block('sys'),
    messages: [
      { role: 'user', content: block('a') },
      { role: 'assistant', content: block('b') },
      { role: 'user', content: block('c') },
    ],
  };
  await anthropic.generate(four);
  assert.strictEqual(last().messages.length, 3, 'four is the limit, and four is allowed');

  await assert.rejects(
    () => anthropic.generate({
      ...four,
      messages: [...four.messages, { role: 'assistant', content: block('d') }, { role: 'user', content: 'x' }],
    }),
    /5 cache_control breakpoints, max is 4/
  );
});

test('a prefix that asked to cache and cached nothing is reported', async () => {
  // The silent failure this exists for: under a model's minimum cacheable
  // prefix (512 / 1,024 / 4,096 tokens, and NOT in tier order — Haiku's is the
  // largest) the call returns 200 with cache_creation_input_tokens: 0 and no
  // warning field. The Arena persona seed sits above Opus's and Sonnet's
  // minimum and below Haiku's, so this is a live path, not a theoretical one.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    await anthropic.generate({
      model: 'claude-haiku-4-5', prompt: 'x', site: 'test.silentmiss',
      system: 'short prefix', cacheSystem: true,
    });
    // Second identical call: the warning must not repeat in a per-turn loop.
    await anthropic.generate({
      model: 'claude-haiku-4-5', prompt: 'x', site: 'test.silentmiss',
      system: 'short prefix', cacheSystem: true,
    });
  } finally { console.warn = realWarn; }
  const hits = warnings.filter((w) => w.includes('nothing was cached'));
  assert.strictEqual(hits.length, 1, 'warn once per model+site, not once per call');
  assert.match(hits[0], /minimum cacheable size/);
});

test('no warning when a request never asked to cache anything', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    await anthropic.generate({ model: 'claude-sonnet-5', prompt: 'x', system: 'plain' });
  } finally { console.warn = realWarn; }
  assert.strictEqual(warnings.filter((w) => w.includes('nothing was cached')).length, 0);
});

test('a large max_tokens streams rather than risking an HTTP timeout', async () => {
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', maxTokens: 64000 });
  assert.strictEqual(last().max_tokens, 64000);
  // The stream path returns the reassembled message.
  const r = await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', maxTokens: 64000 });
  assert.strictEqual(r.text, 'streamed');
});

test('a refusal throws instead of returning an empty answer', async () => {
  const real = require.cache[sdkPath].exports;
  require.cache[sdkPath].exports = function Refusing() {
    this.messages = { create: async () => ({
      content: [], stop_reason: 'refusal',
      stop_details: { category: 'cyber', explanation: 'declined' },
      usage: { input_tokens: 5, output_tokens: 0 },
    }) };
  };
  Object.assign(require.cache[sdkPath].exports, real);
  delete require.cache[require.resolve(path.join(API, 'src', 'anthropic.js'))];
  const fresh = require(path.join(API, 'src', 'anthropic.js'));
  try {
    await assert.rejects(
      () => fresh.generate({ model: 'claude-opus-5', prompt: 'x' }),
      (e) => e.refusal === true && e.status === 422 && /cyber/.test(e.message),
      'a refusal is HTTP 200 with empty content — returning "" would look like a real answer'
    );
  } finally {
    require.cache[sdkPath].exports = real;
    delete require.cache[require.resolve(path.join(API, 'src', 'anthropic.js'))];
  }
});

test('thinking:false is sent as the disabled config, spelled exactly', async () => {
  // The literal matters: 'disable' or 'off' is a 400. Nothing captured this
  // shape before — providerRouter's thinking:false test unsets the API key, so
  // it never reaches param construction.
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', thinking: false, effort: 'high' });
  assert.deepStrictEqual(last().thinking, { type: 'disabled' });
});

test('effort is clamped down, not rejected, on models without xhigh', async () => {
  await anthropic.generate({ model: 'claude-opus-4-6', prompt: 'x', effort: 'xhigh' });
  assert.strictEqual(last().output_config.effort, 'high', 'opus-4-6 400s on xhigh');
  // thinking:true is required here, not incidental: Opus 5 rejects disabled
  // thinking above effort 'high', and thinking now defaults off.
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', effort: 'xhigh', thinking: true });
  assert.strictEqual(last().output_config.effort, 'xhigh', 'opus-5 supports it');
});

test('the disabled-thinking effort cap is opus-5-only, not global', async () => {
  // Sonnet 5 accepts disabled thinking at any effort (live-verified). A global
  // rule would reject it — and now that thinking defaults off, would reject
  // every xhigh/max request on the default path.
  await anthropic.generate({ model: 'claude-sonnet-5', prompt: 'x', effort: 'max' });
  assert.strictEqual(last().output_config.effort, 'max');
  await assert.rejects(
    () => anthropic.generate({ model: 'claude-opus-5', prompt: 'x', effort: 'max' }),
    /effort <= high/
  );
});

test('thinking and effort are independent axes', async () => {
  // claude-opus-4-5 is the case a single boolean cannot express: it accepts
  // effort and rejects adaptive thinking.
  await anthropic.generate({ model: 'claude-opus-4-5', prompt: 'x', effort: 'high' });
  const p = last();
  assert.strictEqual(p.thinking, undefined, 'opus-4-5 rejects adaptive thinking');
  assert.strictEqual(p.output_config.effort, 'high', 'but it does support effort');
});

test('unknown options throw rather than vanishing', async () => {
  // A mechanical port from a Gemini call site keeps these spellings; silently
  // dropping abortSignal removes that call site's only time bound.
  await assert.rejects(
    () => anthropic.generate({ model: 'claude-opus-5', prompt: 'x', abortSignal: AbortSignal.timeout(1000) }),
    /unknown option\(s\) abortSignal/
  );
  await assert.rejects(
    () => anthropic.generate({ model: 'claude-opus-5', prompt: 'x', maxOutputTokens: 2048 }),
    /maxOutputTokens/
  );
  await assert.rejects(
    () => anthropic.generate({ model: 'claude-opus-5', prompt: 'x', temperature: 0.3 }),
    /unknown option/
  );
});

test('a truncated answer throws instead of being returned as complete', async () => {
  const real = require.cache[sdkPath].exports;
  const Truncating = function () {
    this.messages = { create: async () => ({
      content: [{ type: 'text', text: 'half an ans' }],
      stop_reason: 'max_tokens', model: 'claude-opus-5',
      usage: { input_tokens: 5, output_tokens: 2048 },
    }) };
  };
  Object.assign(Truncating, real);
  require.cache[sdkPath].exports = Truncating;
  const wrapperPath = require.resolve(path.join(API, 'src', 'anthropic.js'));
  delete require.cache[wrapperPath];
  const fresh = require(wrapperPath);
  try {
    await assert.rejects(
      () => fresh.generate({ model: 'claude-opus-5', prompt: 'x', maxTokens: 2048 }),
      (e) => e.truncated === true && e.status === 502,
      'a partial answer that looks complete is the most dangerous success there is'
    );
    // …unless the caller opts in.
    const ok = await fresh.generate({ model: 'claude-opus-5', prompt: 'x', maxTokens: 2048, allowTruncation: true });
    assert.strictEqual(ok.text, 'half an ans');
    assert.strictEqual(ok.stopReason, 'max_tokens');
  } finally {
    require.cache[sdkPath].exports = real;
    delete require.cache[wrapperPath];
  }
});

test('translateError maps each SDK class to the right status', () => {
  const cases = [
    ['RateLimitError', 429], ['AuthenticationError', 502], ['PermissionDeniedError', 502],
    ['APIConnectionTimeoutError', 504], ['APIConnectionError', 502], ['APIUserAbortError', 504],
  ];
  for (const [cls, status] of cases) {
    const e = anthropic.translateError(new FakeAnthropic[cls]('boom'));
    assert.strictEqual(e.status, status, `${cls} should map to ${status}`);
  }
  // A local abort must not be reported as a provider outage.
  assert.strictEqual(anthropic.translateError(new FakeAnthropic.APIUserAbortError('x')).aborted, true);
});

test('spend is recorded for the refused request specifically, not just some earlier one', async () => {
  const before = recorded.length;
  const real = require.cache[sdkPath].exports;
  const Refusing = function () {
    this.messages = { create: async () => ({
      content: [], stop_reason: 'refusal',
      stop_details: { category: 'cyber', explanation: 'declined' },
      model: 'claude-opus-5', usage: { input_tokens: 77, output_tokens: 0 },
    }) };
  };
  Object.assign(Refusing, real);
  require.cache[sdkPath].exports = Refusing;
  const wrapperPath = require.resolve(path.join(API, 'src', 'anthropic.js'));
  delete require.cache[wrapperPath];
  const fresh = require(wrapperPath);
  try {
    await assert.rejects(() => fresh.generate({ model: 'claude-opus-5', prompt: 'x', site: 'test.refusal' }));
    const added = recorded.slice(before);
    assert.strictEqual(added.length, 1, 'the refused call still cost tokens and must be recorded');
    assert.strictEqual(added[0][1], 'test.refusal');
    assert.strictEqual(added[0][3].input_tokens, 77,
      'moving recordClaude after the refusal throw would lose this row');
  } finally {
    require.cache[sdkPath].exports = real;
    delete require.cache[wrapperPath];
  }
});
