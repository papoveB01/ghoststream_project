// The seam between anthropic.translateError and aiRetry.classify.
//
// This file exists because of a gap that CI reported as covered. aiRetry's own
// tests build Anthropic-shaped errors by hand — `Object.assign(new Error(m),
// {status, provider, sdkRetried})` — and anthropicSurface.test.js replaces the
// SDK with a fake whose constructor ignores its options. So NOTHING asserted
// that translateError actually produces the stamp classify() reads, or that the
// client is configured the way the module says it is.
//
// Measured cost of that gap (2026-08-06): deleting the stamp entirely left the
// full suite green, while in production it would have sent every Claude error
// into the Gemini message-scraping branch — 429 stops matching (no retry, the
// exact regression ADR-0006 §7 names) and 529 starts matching on the word
// "Overloaded" in the preserved provider detail (stacking, back to 9 attempts).
// Reverting the timeout fix was likewise green.
//
// So: REAL SDK exception instances, the REAL wrapper, and assertions on the
// client the wrapper actually builds. No network — nothing here calls the API.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

// Set before requiring the wrapper: it reads the budget at module load, and the
// point of the first test is which value reaches the SDK client.
process.env.ANTHROPIC_TIMEOUT_MS = '90000';
process.env.ANTHROPIC_MAX_RETRIES = '2';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-not-used';

const SRC = path.join(__dirname, '..', 'src');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = require(path.join(SRC, 'anthropic.js'));
const aiRetry = require(path.join(SRC, 'aiRetry.js'));

// APIError.generate needs a real Headers instance, not a plain object.
const apiError = (status, message, type) =>
  Anthropic.APIError.generate(status, { error: { type, message } }, message, new Headers());

// ── the client the wrapper builds ──────────────────────────────────────────

test('the SDK per-attempt timeout is the WHOLE budget, not a slice of it', () => {
  // The slice (`budget / (maxRetries + 1)`) shipped briefly and was reverted.
  // It rests on the premise that only a hang consumes an attempt, but a merely
  // slow generation is retried on the SDK's connection-error branch exactly
  // like a hung one. Measured live, claude-opus-5 @ max_tokens 3000:
  //   timeout 90s-equivalent (full budget) -> 1 upstream POST, 47.3s, HTTP 200
  //   timeout sliced to a third            -> 3 upstream POSTs, abort at 120s
  // i.e. three billed generations of one request, all recording $0.00 because
  // costs.recordClaude sits after the rethrow.
  const client = anthropic.getClient();
  assert.strictEqual(client.timeout, 90000,
    'a sliced timeout turns a slow generation into three billed failures');
  assert.strictEqual(client.maxRetries, 2);
});

test('a non-numeric ANTHROPIC_MAX_RETRIES falls back instead of NaN-ing every request', () => {
  // parseInt('none') is NaN; NaN reaching the SDK's validatePositiveInteger
  // throws "timeout must be an integer" on EVERY request — a total outage of
  // the Claude path from one typo in an env file.
  const saved = { t: process.env.ANTHROPIC_TIMEOUT_MS, r: process.env.ANTHROPIC_MAX_RETRIES };
  try {
    for (const bad of ['none', '', '-1', 'abc']) {
      process.env.ANTHROPIC_MAX_RETRIES = bad;
      delete require.cache[require.resolve(path.join(SRC, 'anthropic.js'))];
      const fresh = require(path.join(SRC, 'anthropic.js'));
      const c = fresh.getClient();
      assert.ok(Number.isFinite(c.timeout) && c.timeout > 0, `timeout finite for "${bad}"`);
      assert.ok(Number.isInteger(c.maxRetries) && c.maxRetries >= 0, `maxRetries sane for "${bad}"`);
    }
  } finally {
    process.env.ANTHROPIC_TIMEOUT_MS = saved.t;
    process.env.ANTHROPIC_MAX_RETRIES = saved.r;
    delete require.cache[require.resolve(path.join(SRC, 'anthropic.js'))];
  }
});

// ── real SDK exceptions, end to end ────────────────────────────────────────

test('every translated SDK error carries the stamp classify() branches on', () => {
  const raw = [
    apiError(429, 'rate limited', 'rate_limit_error'),
    apiError(529, 'Overloaded'),
    apiError(401, 'bad key'),
    apiError(400, 'bad param'),
    new Anthropic.APIUserAbortError(),
    new Anthropic.APIConnectionTimeoutError({ message: 'timed out' }),
    new Anthropic.APIConnectionError({ message: 'refused' }),
    new Anthropic.AnthropicError('timeout must be an integer'),
  ];
  for (const err of raw) {
    const e = anthropic.translateError(err);
    assert.strictEqual(e.provider, 'anthropic', `${err.constructor.name} lost its provider stamp`);
    assert.strictEqual(typeof e.sdkRetried, 'boolean', `${err.constructor.name} lost sdkRetried`);
    assert.strictEqual(aiRetry.classify(e).sdkRetried, e.sdkRetried);
  }
});

test('sdkRetried tells the truth about what the SDK actually retried', () => {
  // The SDK retries 408/409/429/5xx and connection failures. It does NOT retry
  // 401/403/other 4xx, and an abort WE raised never entered its retry path.
  // Blanket-true would deny an app-level retry to errors that never had one.
  const cases = [
    [apiError(429, 'rate limited', 'rate_limit_error'), true],
    [apiError(529, 'Overloaded'), true],
    [apiError(500, 'boom'), true],
    [new Anthropic.APIConnectionTimeoutError({ message: 't' }), true],
    [new Anthropic.APIConnectionError({ message: 'r' }), true],
    [apiError(401, 'bad key'), false],
    [apiError(403, 'forbidden'), false],
    [apiError(400, 'bad param'), false],
    [new Anthropic.APIUserAbortError(), false],
    [new Anthropic.AnthropicError('timeout must be an integer'), false],
  ];
  for (const [err, expected] of cases) {
    assert.strictEqual(anthropic.translateError(err).sdkRetried, expected,
      `${err.constructor.name}${err.status ? ` ${err.status}` : ''}`);
  }
});

test('nothing the SDK already retried is retried again — the 9-attempt stack, closed', () => {
  // 529 first, because it is the one the old Gemini-shaped regexes matched via
  // the word "Overloaded" surviving in the preserved provider detail.
  for (const status of [429, 500, 502, 503, 529]) {
    const e = anthropic.translateError(apiError(status, status === 429 ? 'rate limited' : 'Overloaded',
      status === 429 ? 'rate_limit_error' : undefined));
    assert.strictEqual(aiRetry.classify(e).transient, false,
      `${status} must not be retried on top of the SDK's own attempts`);
  }
});

test('an Anthropic error never reaches the Gemini message-scraper', () => {
  // The failure this prevents: a refusal explanation is free-form provider
  // prose. "…would leave the service unavailable" hits \bUNAVAILABLE\b in
  // GEMINI_TRANSIENT_RE, so an unstamped refusal is retried three times and
  // billed three times for a deterministic decline.
  const refusalish = new Anthropic.AnthropicError(
    'the request appears to seek instructions for an attack that would leave the service unavailable'
  );
  const e = anthropic.translateError(refusalish);
  assert.strictEqual(e.provider, 'anthropic');
  assert.strictEqual(aiRetry.classify(e).transient, false,
    'stamped, so the Gemini regexes never see it');

  // Same string with no stamp is what the Gemini branch would have made of it —
  // this is the behaviour being excluded, not an accepted one.
  assert.strictEqual(aiRetry.classify(new Error(refusalish.message)).transient, true);
});

test('the per-day carve-out survives translation on the Anthropic path', () => {
  // The 429 branch used to discard the provider detail, which made the carve-out
  // permanently dead here: classify matches on the message, and the message no
  // longer said which quota was exhausted. A daily cap would then be retried
  // against an allowance that resets tomorrow.
  const e = anthropic.translateError(
    apiError(429, 'This organization has exceeded its limit of 1000 requests per day', 'rate_limit_error')
  );
  assert.match(e.message, /per day/, 'the detail the carve-out matches on must survive');
  const v = aiRetry.classify(e);
  assert.strictEqual(v.perDay, true);
  assert.strictEqual(v.transient, false);
});
