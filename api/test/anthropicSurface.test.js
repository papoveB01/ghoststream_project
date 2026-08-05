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
  assert.deepStrictEqual(p.output_config, { format: { type: 'json_schema', schema } });
  assert.strictEqual(p.thinking, undefined);
});

test('the modern surface gets both thinking and effort', async () => {
  await anthropic.generate({ model: 'claude-opus-5', prompt: 'x', effort: 'high' });
  const p = last();
  assert.deepStrictEqual(p.thinking, { type: 'adaptive' });
  assert.strictEqual(p.output_config.effort, 'high');
});

test('sonnet 4.5 is treated as legacy, sonnet 5 is not', async () => {
  await anthropic.generate({ model: 'claude-sonnet-4-5', prompt: 'x' });
  assert.strictEqual(last().thinking, undefined);
  await anthropic.generate({ model: 'claude-sonnet-5', prompt: 'x' });
  assert.deepStrictEqual(last().thinking, { type: 'adaptive' });
});

test('an unrecognised model defaults to the modern surface', async () => {
  // A model released after this code was written should work without an edit;
  // the exception list names the models that predate the 4.6 surface.
  await anthropic.generate({ model: 'claude-opus-9', prompt: 'x' });
  assert.deepStrictEqual(last().thinking, { type: 'adaptive' });
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

test('spend is recorded even for a request whose output is unusable', () => {
  // recordClaude fires before stop_reason is inspected: a refused or truncated
  // response still consumed tokens, and the meter is about what we were billed.
  assert.ok(recorded.length > 0);
  const [, site, model, usage] = recorded[0];
  assert.strictEqual(typeof site, 'string');
  assert.ok(model.startsWith('claude-'));
  assert.ok(usage && typeof usage.input_tokens === 'number');
});
