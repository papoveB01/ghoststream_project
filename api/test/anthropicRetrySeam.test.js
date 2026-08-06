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

test('a refusal is stamped, so free-form provider prose is never scraped', () => {
  // refusalError never passes through translateError, so the tests above cannot
  // see it. Deleting its stamp used to leave the suite green while turning a
  // deterministic decline into three billed calls: measured against a stub
  // returning HTTP 200 / stop_reason "refusal" whose explanation contained
  // "…would leave the target service unavailable", 1 billed call became 3.
  const refusal = anthropic.refusalError({
    stop_reason: 'refusal',
    stop_details: {
      category: 'harmful_content',
      explanation: 'the request appears to seek an attack that would leave the service unavailable',
    },
  });
  assert.strictEqual(refusal.status, 422);
  assert.strictEqual(refusal.refusal, true);
  assert.strictEqual(refusal.provider, 'anthropic', 'unstamped, this gets message-scraped');
  assert.strictEqual(aiRetry.classify(refusal).transient, false);
  // The behaviour being excluded, so the assertion above is not mistaken for a
  // tautology: the same words with no stamp DO read as transient.
  assert.strictEqual(aiRetry.classify(new Error(refusal.message)).transient, true);
});

test('argument-validation throws are stamped too — they interpolate caller values', async () => {
  // Left plain at first, on the reasoning that a literal message cannot match a
  // transient regex. But these interpolate what the caller passed.
  await assert.rejects(
    () => anthropic.generate({ model: 'claude-sonnet-5', prompt: 'x', effort: '503 UNAVAILABLE' }),
    (e) => {
      assert.strictEqual(e.provider, 'anthropic');
      assert.strictEqual(aiRetry.classify(e).transient, false,
        'an unstamped validation error would buy 3 attempts at a deterministic throw');
      return true;
    }
  );
});

test('the composed deadline actually reaches the SDK — a hang has to end', async () => {
  // The guard that prevents an unbounded hang, and NOTHING asserted it: deleting
  // the signal from generate()'s opts left the suite 291/291 green while a
  // stalled stream ran past 60s with no bound at all. That is the same
  // "test that cannot fail" blind spot this whole PR exists to close.
  const saved = process.env.ANTHROPIC_TIMEOUT_MS;
  try {
    process.env.ANTHROPIC_TIMEOUT_MS = '300';
    delete require.cache[require.resolve(path.join(SRC, 'anthropic.js'))];
    const fresh = require(path.join(SRC, 'anthropic.js'));
    const client = fresh.getClient();
    const neverSettles = new Promise(() => {});
    client.messages.create = (_params, opts) => {
      // No signal means no deadline was composed — the request would hang for
      // ever. Return a promise that never settles so the watchdog below reports
      // exactly that, rather than the test passing for the wrong reason.
      if (!opts || !opts.signal) return neverSettles;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort',
          () => reject(new Anthropic.APIUserAbortError()), { once: true });
      });
    };
    const call = fresh.generate({ model: 'claude-sonnet-5', prompt: 'x', maxTokens: 100 });
    // NOT unref'd, deliberately: AbortSignal.timeout's own timer does not keep
    // the event loop alive, so with nothing else pending the process drains and
    // the deadline never fires. Harmless in the server (a request is always in
    // flight); fatal to a test that has only this promise outstanding.
    let handle;
    const watchdog = new Promise((_r, reject) => {
      handle = setTimeout(() => reject(new Error(
        'generate() did not end within 10x its budget — no deadline reached the SDK'
      )), 3000);
    });
    try {
      await assert.rejects(() => Promise.race([call, watchdog]), /cancelled or timed out/);
    } finally { clearTimeout(handle); }
  } finally {
    process.env.ANTHROPIC_TIMEOUT_MS = saved;
    delete require.cache[require.resolve(path.join(SRC, 'anthropic.js'))];
  }
});

test('a non-Error throw value cannot reach the Gemini scraper either', () => {
  const e = anthropic.translateError('a raw string 503 UNAVAILABLE');
  assert.strictEqual(e.provider, 'anthropic');
  assert.strictEqual(aiRetry.classify(e).transient, false);
});

test('ANTHROPIC_MAX_RETRIES=0 hands the retry to the app layer instead of losing it', () => {
  // The stamp is per error CLASS, so with a client told never to retry it used
  // to announce "the SDK already retried this" — and the app layer stood down
  // too. Measured: 1 upstream request, zero retries anywhere. A deployment
  // setting this to 0 silently lost 429 retry entirely.
  const saved = process.env.ANTHROPIC_MAX_RETRIES;
  try {
    process.env.ANTHROPIC_MAX_RETRIES = '0';
    delete require.cache[require.resolve(path.join(SRC, 'anthropic.js'))];
    const fresh = require(path.join(SRC, 'anthropic.js'));
    const e = fresh.translateError(apiError(429, 'rate limited', 'rate_limit_error'));
    assert.strictEqual(e.sdkRetried, false, 'a client that never retries must not claim it did');
    assert.strictEqual(aiRetry.classify(e).transient, true, 'so the app layer covers it');
  } finally {
    process.env.ANTHROPIC_MAX_RETRIES = saved;
    delete require.cache[require.resolve(path.join(SRC, 'anthropic.js'))];
  }
});

test('x-should-retry: false is an instruction the stamp has to respect', () => {
  // The SDK honours the header ahead of the status, so a 429 carrying it was
  // never retried — stamping it as retried would deny it the app-level cover.
  const err = Anthropic.APIError.generate(
    429, { error: { type: 'rate_limit_error', message: 'no' } }, 'no',
    new Headers({ 'x-should-retry': 'false' })
  );
  const e = anthropic.translateError(err);
  assert.strictEqual(e.sdkRetried, false);
  assert.strictEqual(aiRetry.classify(e).transient, true);
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
