// Free coverage for the LIVE harness's router-gate handling (ADR-0006 §9 item 3).
//
// WHY THIS FILE EXISTS. `test/live/` is deliberately outside `npm test` because
// it spends money, and CI only `node --check`s it
// (.github/workflows/ci.yml:60). So nothing in the suite asserted that
// `smoke.js`'s resolveFor() lifts every gate `models.providerFor()` consults —
// and when `models.js` grew its second gate (FLIP_BLOCKED) that omission made
// the harness resolve `gemini-2.5-flash-lite` for four of the five group-2
// entries and POST A GEMINI MODEL ID TO THE ANTHROPIC API: 4 × 404,
// "1/5 accepted, 4 errored", exit 4, where the same command on `main` was 5/5
// and exit 0. Nothing in that output said "harness"; it read as a provider
// outage.
//
// The runtime backstop smoke.js:159 now carries would have caught it — but only
// on a run, i.e. only after someone spent the money and only if they were
// looking. This is the same check, free, on every push, before a THIRD gate
// repeats it.
//
// Cheap and network-free: requiring smoke.js pulls src/models.js,
// src/schemaCompat.js and the schema registry, whose `schema` entries are thunks
// (see test/live/schemas.js's header) — no express router, no pg pool, no Redis
// client. The `require.main === module` guard in smoke.js is what makes the
// require itself safe; without it, `npm test` would start a paid 26-schema run.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const models = require('./../src/models');
const smoke = require('./live/smoke.js');

// SNAPSHOTTED AT REQUIRE TIME, before any test has had a chance to call into the
// harness. Reading the live sets inside each test looks equivalent and is not:
// the failure the second test exists to catch is resolveFor() leaving the router
// mutated, and a test that re-reads the sets afterwards compares the damage to
// itself. Measured — with resolveFor()'s restore made unconditional (the exact
// contextSeam.js defect), a version of this file that re-read the sets was still
// 2/2 green, because the first test had already emptied DISPATCH_READY and the
// second one then found "no change".
const READY_AT_LOAD = [...models.DISPATCH_READY].sort();
const BLOCKED_AT_LOAD = [...models.FLIP_BLOCKED.entries()].sort();

// The tasks the harness must be able to reach: every task the router will let a
// call site dispatch, plus every task it currently REFUSES to flip. The second
// half is the load-bearing one — a task in FLIP_BLOCKED is exactly the task
// whose flip PR has to run this harness, which is when a gate it does not lift
// disables the check precisely where it matters.
const GATED_TASKS = [...new Set([...READY_AT_LOAD, ...BLOCKED_AT_LOAD.map(([t]) => t)])].sort();

// resolveFor() consults isProviderConfigured('anthropic'), which reads the env
// on every call — an unset key is a REFUSAL, so without this the test would pass
// on a laptop with credentials and fail in CI without them, or vice versa.
// Nothing is signed or sent; the value is never used.
function withDummyKey(fn) {
  const prev = process.env.ANTHROPIC_API_KEY;
  const realWarn = console.warn;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key';
  console.warn = () => {};
  try { return fn(); } finally {
    console.warn = realWarn;
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
}

test('smoke.js resolveFor() lifts every gate the router consults', () => {
  assert.ok(GATED_TASKS.length >= 6,
    'the gated task list went empty — this test would then prove nothing');
  withDummyKey(() => {
    for (const task of GATED_TASKS) {
      const resolved = smoke.resolveFor('anthropic', task);
      assert.strictEqual(resolved.provider, 'anthropic',
        `resolveFor() asked for anthropic and got ${resolved.provider} for "${task}" — models.js has a ` +
        'gate that smoke.js does not lift, so the live check silently tests the WRONG PROVIDER for ' +
        'this task. Lift it in resolveFor() (it already lifts DISPATCH_READY and FLIP_BLOCKED).');
      // The id family as well as the provider field, for the reason smoke.js's
      // own backstop checks both: a stray ANTHROPIC_*_MODEL / GEMINI_*_MODEL
      // override pointing at the wrong family produces a 404 that names the
      // model and blames the provider. null (an id neither family claims) is
      // deliberately not a failure — a newly released model must keep working.
      assert.notStrictEqual(models.providerOfModel(resolved.model), 'gemini',
        `resolveFor('anthropic', '${task}') resolved ${resolved.model}, a Gemini id — this is what ` +
        'posting a Gemini model to the Anthropic API looks like one step before the 404.');
    }
  });
});

test('resolveFor() restores both gates it lifted', () => {
  // The sibling defect, and the one that had this exact shape in
  // test/live/contextSeam.js: an add/delete pair that is unconditional does not
  // restore, it DELETES. A harness that leaves the router mutated makes every
  // later entry in the same run resolve against a set it silently changed — and
  // the end-of-run diagnostic then reports the mutated state as the real one.
  withDummyKey(() => { for (const task of GATED_TASKS) smoke.resolveFor('anthropic', task); });
  assert.deepStrictEqual([...models.DISPATCH_READY].sort(), READY_AT_LOAD,
    'resolveFor() left DISPATCH_READY mutated (compared against the set as it was at require time, ' +
    'so damage done by the test above counts too)');
  assert.deepStrictEqual([...models.FLIP_BLOCKED.entries()].sort(), BLOCKED_AT_LOAD,
    'resolveFor() left FLIP_BLOCKED mutated — including the REASON, which is what an operator reads');
});
