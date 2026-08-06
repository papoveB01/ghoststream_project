// The consolidated retry helper (ADR-0006 §7, §8 Phase 1).
//
// Six hand-rolled copies became one. The risk in that is entirely one-sided:
// every AI call site in the product runs on GEMINI today, so any drift in the
// Gemini branch is a live regression on the only provider actually serving
// traffic, while the Anthropic branch is still unreachable. So the first block
// below re-implements the originals verbatim and asserts the new classifier
// agrees with them on a corpus of error shapes — equivalence, not "looks right".
//
// MIND THE COUNTS — the first version of this file got them wrong and the error
// hid a real regression. FIVE copies shared the classifier; only FOUR shared the
// backoff. `proposals.js` had the four's transient predicate but no retryDelay
// parser, so it never slept longer than 4s, and `watch.js` differed in both. The
// `originalBackoffMs` fixture below is the FOUR knowledge modules' backoff and
// nothing else; the two odd copies get their own delta tests.
//
// The second block asserts the deltas §7 asked for, each of which is a behaviour
// CHANGE and therefore has to be stated rather than discovered: 429 is
// recognised again, nothing the SDK already retried is retried a second time,
// and a per-day quota still never retries on either provider.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');
const aiRetry = require(path.join(SRC, 'aiRetry.js'));

// ── the originals, copied verbatim from main ───────────────────────────────
// Kept as a fixture, not imported: the point is to compare against what the
// code USED to do, so this must not track edits to the new implementation.
// `originalIsTransient` is shared by five copies; `originalBackoffMs` by four.
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
    // With sdkRetried false the 429 arm is otherwise open, so this is the case
    // that isolates the carve-out on the Anthropic branch. Without it, dropping
    // `!perDay` there left the suite green.
    const unretried = Object.assign(new Error(msg), { provider: 'anthropic', sdkRetried: false, status: 429 });
    assert.strictEqual(aiRetry.classify(unretried).perDay, true);
    assert.strictEqual(aiRetry.classify(unretried).transient, false,
      'a daily cap must not be retried even where the app layer would otherwise cover the 429');
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

test('429 is recognised again — but by the SDK, not by stacking a second set of attempts', () => {
  const e = claudeErr(429, 'AI quota exhausted — retry shortly.');
  // The regression §7 named, demonstrated: the original regexes saw the
  // TRANSLATED message, which contains neither "429" nor "RESOURCE_EXHAUSTED".
  assert.strictEqual(originalIsTransient(e.message), false,
    'the old helpers stopped matching the one transient they were written for');
  // classify now recognises it structurally...
  assert.strictEqual(aiRetry.classify(e).status, 429, 'classify reads err.status');
  // ...and then declines to retry it, because the SDK already did, honouring
  // retry-after. The first version of this branch retried anyway: measured
  // against an always-429 stub that was 9 upstream requests for one logical
  // call (3 SDK attempts x 3 app tries), and with `retry-after: 60` the SDK's
  // inter-retry sleep takes no abort signal, so the composed deadline could not
  // cut it short — ~366s. That is the stacking §7 exists to remove.
  assert.strictEqual(aiRetry.classify(e).transient, false,
    'the SDK retried this one already; the app layer must not go again');
});

test('a 429 the SDK did NOT retry is still the app layer\'s to retry', () => {
  // The reason the branch is a condition rather than a hardcoded false: a call
  // site constructed with maxRetries: 0 gets app-level cover automatically.
  const e = claudeErr(429, 'AI quota exhausted — retry shortly.', { sdkRetried: false });
  assert.strictEqual(aiRetry.classify(e).transient, true);
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

test('the provider stamp picks the branch; sdkRetried decides within it', () => {
  // Two separate claims, and the first version of this test only proved the
  // first — its helper always set `provider` and `sdkRetried` together, so
  // deleting sdkRetried entirely left the suite green while re-opening the
  // stacking. Each is now varied with the other held constant.
  const msg = 'got status: 503 UNAVAILABLE. The model is overloaded.';

  // provider varies, everything else fixed. A Gemini-side 503 must still retry:
  // the @google/genai SDK does not retry at all, so deleting that would be a
  // live regression on the provider everything runs on today.
  assert.strictEqual(aiRetry.classify(new Error(msg)).transient, true, 'gemini: app layer retries');
  assert.strictEqual(aiRetry.classify(claudeErr(503, msg)).transient, false, 'anthropic: it already did');

  // sdkRetried varies, provider and status fixed. If this pair ever agrees, the
  // field has stopped being read and the stacking is back.
  const notRetried = aiRetry.classify(claudeErr(429, 'x', { sdkRetried: false }));
  const retried = aiRetry.classify(claudeErr(429, 'x', { sdkRetried: true }));
  assert.strictEqual(notRetried.transient, true);
  assert.strictEqual(retried.transient, false);
  assert.notStrictEqual(notRetried.transient, retried.transient,
    'sdkRetried must be load-bearing, not decoration');
});

test('translateError\'s route-facing 502 must not be read as "a 5xx, so retry"', () => {
  // translateError maps rejected credentials AND a truncated answer to 502.
  // Both are deterministic. A `status >= 500` test in the Anthropic branch —
  // which is an easy-looking generalisation — would retry each of them 3x.
  for (const e of [
    claudeErr(502, 'AI provider rejected our credentials.', { sdkRetried: false }),
    claudeErr(502, 'Claude hit the 3000-token output budget…', { sdkRetried: false, truncated: true }),
    claudeErr(422, 'Claude declined this request (harmful_content)', { sdkRetried: false, refusal: true }),
  ]) {
    assert.strictEqual(aiRetry.classify(e).transient, false, e.message);
  }
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

// Capture the sleep schedule without actually sleeping.
async function sleepsFor(message, opts) {
  const waits = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };
  try {
    await assert.rejects(() => aiRetry.withRetry(
      async () => { throw new Error(message); }, opts
    ));
  } finally { global.setTimeout = realSetTimeout; }
  return waits;
}

test('the default ladder is 2s then 4s — the backoff for every transient WITHOUT a retryDelay', async () => {
  // This is the commonest Gemini transient by far (a bare 503/UNAVAILABLE
  // carries no suggested delay), and nothing covered it: the equivalence loop
  // above skips every shape where backoffMs is null, which is 10 of the 11.
  // Changing `2000 * (i + 1)` to anything else used to leave the suite green.
  assert.deepStrictEqual(
    await sleepsFor('got status: 503 UNAVAILABLE. The model is overloaded.', { tries: 3, label: 'test' }),
    [2000, 4000]
  );
});

// The suggested-delay corpus: a per-minute 429 carrying a large retryDelay is
// exactly the shape that separates the three policies.
const BIG_DELAY = 'got status: 429 RESOURCE_EXHAUSTED. {"error":{"code":429}} retryDelay: "56"';

// Drive the helper the way a module does — through forLabel, so the assertion
// covers the POLICY each call site actually gets, not options a test supplied.
async function sleepsForLabel(label, message = BIG_DELAY) {
  const waits = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };
  try {
    await assert.rejects(() => aiRetry.forLabel(label)(async () => { throw new Error(message); }, 3));
  } finally { global.setTimeout = realSetTimeout; }
  return waits;
}

test('each call site gets the backoff bound it actually had, not the shared default', async () => {
  // The first version of this test passed `maxBackoffMs` itself and so proved
  // only that the helper honours an option — deleting the cap from proposals.js
  // left it green. Going through forLabel is the point: this now fails if the
  // POLICIES table changes.
  //
  // proposals.js was the SECOND odd copy: the four knowledge modules' classifier
  // but NO retryDelay parser, so it never slept longer than 4s. Inheriting the
  // 30s default turns a Gemini "retryDelay: 56s" into 60s of sleep on
  // POST /proposals/:companyId/generate — synchronous, metered, behind nginx's
  // 180s proxy_read_timeout, with a button that reads "~15s".
  assert.deepStrictEqual(await sleepsForLabel('proposals'), [4000, 4000]);
  // watch had no parser either; its 8s cap was unreachable and now is not.
  assert.deepStrictEqual(await sleepsForLabel('watch'), [8000, 8000]);
  // The four that genuinely did cap at 30s keep it.
  for (const label of ['research', 'relevance', 'assessment', 'discovery']) {
    assert.deepStrictEqual(await sleepsForLabel(label), [30000, 30000], label);
  }
});

test('an unregistered label throws instead of silently taking the defaults', () => {
  // A typo would otherwise be an invisible policy change — which is the exact
  // shape of the bug this table exists to prevent.
  assert.throws(() => aiRetry.forLabel('propsals'), /no policy for "propsals"/);
  assert.deepStrictEqual(
    Object.keys(aiRetry.POLICIES).sort(),
    ['assessment', 'discovery', 'proposals', 'relevance', 'research', 'watch'],
    'every retry-wrapped module has a row, and nothing else does'
  );
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
