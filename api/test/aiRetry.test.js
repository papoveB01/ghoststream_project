// The consolidated retry helper (ADR-0006 §7, §8 Phase 1).
//
// Six hand-rolled copies became one. The risk in that is entirely one-sided:
// every AI call site in the product runs on GEMINI today, so any drift in the
// Gemini branch is a live regression on the only provider actually serving
// traffic, while the Anthropic branch is still unreachable. So the first block
// below re-implements the five identical originals verbatim and asserts the new
// classifier agrees with them on a corpus of real error shapes — equivalence,
// not "looks right".
//
// The second block asserts the three deltas §7 asked for, each of which is a
// behaviour CHANGE and therefore has to be stated rather than discovered:
// 429 retries again, 503/529 stops stacking, and a per-day quota still never
// retries on either provider.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');
const aiRetry = require(path.join(SRC, 'aiRetry.js'));

// ── the five identical originals, copied verbatim from main ────────────────
// Kept as a fixture, not imported: the point is to compare against what the
// code USED to do, so this must not track edits to the new implementation.
function originalIsTransient(msg) {
  const is429 = /\b429\b|RESOURCE_EXHAUSTED/i.test(msg);
  const isDailyQuota = /per[_\s-]?day|PerDay|free_tier_requests/i.test(msg);
  return /\b(503|UNAVAILABLE|overloaded)\b|high demand|deadline[ _]?exceeded/i.test(msg)
    || (is429 && !isDailyQuota);
}
function originalBackoffMs(msg, i) {
  const m = msg.match(/retryDelay["']?\s*[:=]\s*["']?(\d+)/i);
  return m ? Math.min(parseInt(m[1], 10) * 1000 + 500, 30000) : 2000 * (i + 1);
}

// Real Gemini error shapes. The @google/genai SDK puts the upstream JSON
// straight into err.message, which is why these are strings and why the
// original helpers had to regex them.
const GEMINI_MESSAGES = [
  'got status: 503 UNAVAILABLE. {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
  'got status: 429 RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"Quota exceeded for quota metric","status":"RESOURCE_EXHAUSTED"},"retryDelay":"17"}',
  'got status: 429 RESOURCE_EXHAUSTED. {"error":{"message":"generate_content_free_tier_requests, limit: 0"}}',
  'got status: 429. {"error":{"message":"Quota exceeded for GenerateRequestsPerDayPerProjectPerModel"}}',
  'got status: 400 INVALID_ARGUMENT. {"error":{"code":400,"message":"Invalid JSON payload"}}',
  'got status: 500 INTERNAL. {"error":{"code":500,"message":"Internal error encountered."}}',
  'The service is currently experiencing high demand. Please retry.',
  'exception TypeError: Cannot read properties of undefined',
  'deadline_exceeded while awaiting headers',
  'got status: 4290 SOMETHING. {"error":{"code":4290}}',
  'the deadline for this quarter is unrelated prose',
];

test('the Gemini branch agrees with the five originals on every shape, including the two near-misses', () => {
  for (const msg of GEMINI_MESSAGES) {
    const v = aiRetry.classify(new Error(msg));
    assert.strictEqual(
      v.transient, originalIsTransient(msg),
      `transient verdict drifted for: ${msg.slice(0, 70)}`
    );
  }
  // The last two are in the corpus deliberately: `\b429\b` must NOT match 4290,
  // and `deadline[ _]?exceeded` must NOT match the word "deadline" in prose.
  // watch.js's looser copy got both of these wrong — see the delta test below.
  assert.strictEqual(aiRetry.classify(new Error(GEMINI_MESSAGES[9])).transient, false);
  assert.strictEqual(aiRetry.classify(new Error(GEMINI_MESSAGES[10])).transient, false);
});

test('the Gemini branch computes the same backoff, retryDelay included', () => {
  for (const msg of GEMINI_MESSAGES) {
    const v = aiRetry.classify(new Error(msg));
    if (v.backoffMs != null) {
      assert.strictEqual(v.backoffMs, originalBackoffMs(msg, 0),
        `backoff drifted for: ${msg.slice(0, 70)}`);
    }
  }
  // The suggested delay is the only backoff signal the Gemini path has. §7 says
  // to "drop the dead retryDelay parsers" — dead on ANTHROPIC, live here.
  const withDelay = aiRetry.classify(new Error(GEMINI_MESSAGES[1]));
  assert.strictEqual(withDelay.backoffMs, 17500);
  assert.strictEqual(aiRetry.classify(new Error('retryDelay: "9999"')).backoffMs, 30000,
    'and it stays capped at 30s');
});

test('a per-day quota is never transient, on either provider', () => {
  // Retrying burns the remaining allowance against a cap that resets tomorrow.
  // Every one of the six copies carried this carve-out.
  for (const msg of [
    'limit: 0, generate_content_free_tier_requests',
    'Quota exceeded for GenerateRequestsPerDayPerProjectPerModel',
    'quota metric per-day limit',
  ]) {
    assert.strictEqual(aiRetry.classify(new Error(msg)).transient, false, msg);
    const claude = Object.assign(new Error(msg), { provider: 'anthropic', sdkRetried: true, status: 429 });
    assert.strictEqual(aiRetry.classify(claude).transient, false,
      'a daily cap is not transient just because the status is 429');
  }
});

test('watch.js was the odd one out, and consolidating it TIGHTENS two matches', () => {
  // Five copies were byte-identical; watch.js's was looser — `429` and
  // `deadline` with no word boundaries. So consolidation is a real behaviour
  // change on a live production path (the hourly tick), in the safe direction:
  // it stops retrying two things that were never transient. Stated here rather
  // than left for someone to find in a log.
  const watchOriginal = (msg) =>
    /503|UNAVAILABLE|overloaded|high demand|deadline|429|RESOURCE_EXHAUSTED/i.test(msg)
    && !/per[_\s-]?day|PerDay|free_tier_requests/i.test(msg);

  const nowNotRetried = [
    'got status: 4290 SOMETHING. {"error":{"code":4290}}',
    'the deadline for this quarter is unrelated prose',
  ];
  for (const msg of nowNotRetried) {
    assert.strictEqual(watchOriginal(msg), true, 'watch used to treat this as transient');
    assert.strictEqual(aiRetry.classify(new Error(msg)).transient, false, 'and now does not');
  }
  // Everything watch genuinely needed still retries.
  for (const msg of ['503 UNAVAILABLE', 'model is overloaded', 'got status: 429 RESOURCE_EXHAUSTED']) {
    assert.strictEqual(aiRetry.classify(new Error(msg)).transient, true, msg);
  }
});

// ── the three deltas §7 asked for ──────────────────────────────────────────

// What anthropic.translateError actually produces, reproduced here so the test
// does not need the SDK. The stamp is the whole point: it is a structured
// signal, where the message is one we rewrote ourselves.
const claudeErr = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, provider: 'anthropic', sdkRetried: true, ...extra });

test('429 retries again — the coverage a cutover silently dropped', () => {
  const e = claudeErr(429, 'AI quota exhausted — retry shortly.');
  // The regression this fixes, demonstrated: the original regexes saw the
  // TRANSLATED message, which contains neither "429" nor "RESOURCE_EXHAUSTED".
  assert.strictEqual(originalIsTransient(e.message), false,
    'the old helpers stopped matching the one transient they were written for');
  assert.strictEqual(aiRetry.classify(e).transient, true,
    'classify reads err.status, so it matches again');
});

test('503/529 no longer stack on top of the SDK\'s own retries', () => {
  for (const [status, msg] of [[502, 'AI provider error (529): Overloaded'], [502, 'AI provider error (503): Service unavailable']]) {
    const e = claudeErr(status, msg);
    // The old regexes DID match these — via the word "Overloaded" surviving in
    // the preserved provider detail — giving up to 9 attempts on exactly the
    // statuses Anthropic uses for overload.
    assert.strictEqual(originalIsTransient(e.message), /overloaded|503/i.test(e.message));
    assert.strictEqual(aiRetry.classify(e).transient, false,
      'the SDK already retried these; the app layer must stand down');
  }
});

test('a local timeout is not retried, and is not reported as a provider fault', () => {
  const e = claudeErr(504, 'AI request cancelled or timed out locally.', { aborted: true });
  assert.strictEqual(aiRetry.classify(e).transient, false,
    'our own deadline fired — another attempt just spends it again');
});

test('the sdkRetried stamp is what distinguishes the two branches, not the message', () => {
  // Same status, same text; only the stamp differs. A Gemini-side 503 must
  // still retry, because the @google/genai SDK does not retry at all — deleting
  // that would be a live regression on the provider everything runs on today.
  const msg = 'got status: 503 UNAVAILABLE. The model is overloaded.';
  assert.strictEqual(aiRetry.classify(new Error(msg)).transient, true, 'gemini: app layer retries');
  assert.strictEqual(aiRetry.classify(claudeErr(502, msg)).transient, false, 'anthropic: it already did');
});

// ── the loop ───────────────────────────────────────────────────────────────

test('withRetry retries transients up to `tries` total attempts, then rethrows the last error', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; throw new Error('got status: 503 UNAVAILABLE overloaded. retryDelay: "0"'); };
  await assert.rejects(() => aiRetry.withRetry(fn, { tries: 3, label: 'test' }), /503/);
  assert.strictEqual(calls, 3, '`tries` is total attempts, not extra ones — what all six copies meant');
});

test('a non-transient failure is not retried at all', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; throw new Error('got status: 400 INVALID_ARGUMENT'); };
  await assert.rejects(() => aiRetry.withRetry(fn, { tries: 3, label: 'test' }));
  assert.strictEqual(calls, 1);
});

test('a success on a later attempt returns normally', async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls < 2) throw new Error('got status: 503 UNAVAILABLE overloaded. retryDelay: "0"');
    return 'ok';
  };
  assert.strictEqual(await aiRetry.withRetry(fn, { tries: 3, label: 'test' }), 'ok');
  assert.strictEqual(calls, 2);
});

test('watch keeps its tighter backoff cap instead of being harmonised to 30s', async () => {
  // The hourly tick fans out over a worker pool; a 30s sleep per entity would
  // stall the whole scan. watch.js capped at 8s where the others capped at 30s,
  // and consolidation must not quietly take that away.
  const waits = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };
  try {
    await assert.rejects(() => aiRetry.withRetry(
      async () => { throw new Error('got status: 503 UNAVAILABLE overloaded. retryDelay: "600"'); },
      { tries: 2, label: 'watch', maxBackoffMs: 8000 }
    ));
    assert.deepStrictEqual(waits, [8000], 'a 600s suggested delay must clamp to watch\'s 8s, not 30s');
  } finally { global.setTimeout = realSetTimeout; }
});
