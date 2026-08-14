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
const { ENTRIES } = require('./live/schemas.js');

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

// THE TASKS THE HARNESS MUST BE ABLE TO REACH, and the third source here is the
// one that makes this test cover what smoke.js actually does. The two router
// sets between them name 6 tasks; a run resolves EVERY entry in the schema
// registry, which is 15 distinct tasks. Built from the two sets alone, this test
// left 9 of them — callAnalysis, callEntities, compare, content, discovery,
// marketWatch, personas, proposal, research — with no coverage at all, so a
// THIRD gate landing on any of those was silent here.
//
// Measured, with a hypothetical third Set gate added to providerFor() in
// FLIP_BLOCKED's shape: a gate on `assessment` (in both router sets) was 0/2,
// caught; the same gate on `discovery` (registry only) was 2/2, green. A
// --provider=both run would then have posted a Gemini id to the Anthropic API
// for that cluster, 404, exit 4, and read as a provider outage — this file's
// whole reason for existing, with CI green over it. `personas` is on that
// uncovered list and is the next cutover.
//
// FLIP_BLOCKED is still called out separately even though its keys are a subset
// of DISPATCH_READY today, because it is the load-bearing half: a task in
// FLIP_BLOCKED is exactly the task whose flip PR has to run this harness, which
// is when a gate it does not lift disables the check precisely where it matters.
const GATED_TASKS = [...new Set([
  ...READY_AT_LOAD,
  ...BLOCKED_AT_LOAD.map(([t]) => t),
  ...ENTRIES.map((e) => e.task),
])].sort();

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
  // A FLOOR, NOT A COUNT, and deliberately placed at 10 rather than at today's
  // 15. Its job is to prove the loop below is not vacuous, and specifically that
  // the REGISTRY half is contributing: the two router sets alone supply 6, so
  // any value above 6 fails if `ENTRIES` stops being reachable (a renamed
  // export "fixed" with `|| []`, a registry that stops carrying `task`). Pinned
  // at 15 it would instead fail on an ordinary registry edit, with a message
  // that says "went empty" and is false — and set membership for the two router
  // sets is already pinned by set equality in test/providerRouter.test.js,
  // which is where a change to them is supposed to be argued.
  assert.ok(GATED_TASKS.length >= 10,
    `only ${GATED_TASKS.length} gated task(s) — the schema registry is no longer contributing to this ` +
    'list (the two router sets alone give 6), so this test now proves far less than it reads as proving');
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
