// Live probe for the grounded-context seam (ADR-0006 §9 item 4).
//
// SPENDS MONEY. Never in `npm test`, same rule as test/live/smoke.js. A few
// cents per run.
//
// It exists because the three things this seam is for cannot be proven by any
// stub, and each fails in a way that looks like success:
//
//   1. Does a multi-turn `messages` array with an assistant turn actually get
//      accepted? A fake SDK accepts anything.
//   2. Does the breakpoint on the persona prefix actually cache? Below a
//      model's minimum the API returns HTTP 200 with
//      cache_creation_input_tokens: 0, no error and no warning field.
//   3. Does the REAL Arena persona seed clear that minimum on the tier it would
//      run on? ADR-0006 §4.3 measures it at 3,445 tokens (new-gen tokenizer),
//      i.e. above Sonnet 5's 1,024 and below Haiku 4.5's 4,096 — so the answer
//      is supposed to DIFFER by model, and that difference is the assertion.
//
// EACH MODEL CARRIES ITS OWN EXPECTATION and a mismatch exits non-zero. A first
// version of this script printed one shared verdict string with "expected on
// haiku 4.5" attached to the not-cached branch for every model, and exited 0
// unconditionally — so a Sonnet regression that stopped caching entirely, or a
// hard error, would have printed and passed. That is the same blind spot §9
// item 3 exists for: a live check that reports green over something it never
// actually proved.
//
// Exit codes match test/live/smoke.js's contract:
//   0  every model met its expectation
//   1  an expectation was not met (a real regression)
//   2  THIS SCRIPT is broken — a router gate prepareVia() fails to lift, or no
//      ANTHROPIC_API_KEY. Nothing was sent; re-running reproduces it forever
//   4  errors only — nothing was judged, re-run
//
// 2 and 4 are separated for the reason smoke.js:478-482 separates them: a
// harness bug counted as an error prints "1 model(s) errored; the rest met
// expectations", which reads as a transient, and re-running a harness bug is
// not a strategy. A failed expectation still outranks it — a bug on one model
// does not un-observe a regression seen on the other.
//
// Run from the repo root:
//   docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
//     api node test/live/contextSeam.js

'use strict';

const models = require('../../src/models');
const personas = require('../../src/personas');
const aiContext = require('../../src/aiContext');

const SEED = personas['skeptical-cfo'];

// What each model must do with the real persona prefix, per ADR-0006 §4.3's
// measured minimums. Haiku's expectation is a NEGATIVE one and is just as
// load-bearing: if it ever starts caching, the ADR's cost model for the whole
// lite tier changes and someone should be told.
const EXPECTATIONS = [
  { model: 'claude-sonnet-5', mustCache: true, why: 'seed is ~3,445 tok, above sonnet-5\'s 1,024 minimum' },
  { model: 'claude-haiku-4-5', mustCache: false, why: 'seed is ~2,577 tok, BELOW haiku-4-5\'s 4,096 minimum — must fail silently' },
];

// Drive prepare() rather than hand-building the record, so the run exercises
// the seam's own anthropic branch and not just generate(). `personas` is not in
// DISPATCH_READY, so the task has to be opened here — which is exactly what a
// §9 item 5 cutover PR does permanently. (This used to say "DISPATCH_READY is
// empty by design", which expired the moment group 1 landed. It is one of the
// blocks models.js's "EDITING THE LINE BELOW ALSO INVALIDATES PROSE" note now
// names, so it goes stale WITH the set rather than quietly after it.)
//
// BOTH gates are lifted, not just DISPATCH_READY. `personas` is not in
// FLIP_BLOCKED today, so this is latent rather than broken — but it is the same
// omission that made test/live/smoke.js post a Gemini model id to the Anthropic
// API for four of the five group-2 entries, and the day `personas` acquires a
// measured flip blocker this file would do it too.
//
// EVERY LIFT IS CONDITIONAL, and both restores are conditional on the same flag
// — `smoke.js:161/165/201` has always been, this file was not. An unconditional
// `DISPATCH_READY.add` / `.delete` pair does not restore, it DELETES: for a task
// that is already dispatch-ready (which is what `personas` becomes at the arena
// cutover, i.e. the first run that is not latent), the first probe removes the
// membership and the second one runs against a router that has silently fallen
// back to Gemini. No live call is needed to see it — the end-of-run diagnostic
// below prints `gemini/gemini-2.5-flash` and providerFor() emits "its call site
// cannot dispatch yet" at the end of an otherwise green run.
//
// THE GATE AND ENV READS ARE INSIDE THE try TOO, not just the resolve() check —
// same correction smoke.js:139 carries, reached by the same route. models.js:168
// explicitly anticipates a key LEAVING FLIP_BLOCKED, and the set itself going
// away with the migration is the natural end state, at which point
// `models.FLIP_BLOCKED.has(...)` is a TypeError. Read outside the try that throw
// carried no `harnessBug` tag: measured with FLIP_BLOCKED removed from models.js's
// exports, this file exited 4, "Errors only — nothing judged, re-run", with
// `personas` left added to DISPATCH_READY — so the end-of-run diagnostic below
// reported a MUTATED router as the real one — where smoke.js under the identical
// mutation exits 2, "HARNESS BUG … fix the script, don't re-run". Tagging every
// throw from in here is right rather than over-broad: nothing before
// aiContext.prepare() talks to a provider, so NOTHING WAS SENT is true of all of
// it.
//
// The two flags are initialised to "nothing to undo" rather than to false/false
// for the reason smoke.js:155 gives: a throw between here and the lift must not
// make restore() delete a membership this call never added — the unconditional-
// restore defect above, reached from the other side.
function prepareVia(task, model) {
  // Cannot throw, so it is read before the try and restore() never has to guess
  // whether the read happened. The env-name read CAN throw, so `envName` guards
  // its own half of the restore, exactly as smoke.js:203 does.
  const savedModel = process.env.ANTHROPIC_PERSONAS_MODEL;
  let envName;
  let saved;
  let wasReady = true;
  let wasBlocked = false;
  let blockReason;
  const restore = () => {
    if (!wasReady) models.DISPATCH_READY.delete(task);
    if (wasBlocked) models.FLIP_BLOCKED.set(task, blockReason);
    if (envName !== undefined) {
      if (saved === undefined) delete process.env[envName]; else process.env[envName] = saved;
    }
    if (savedModel === undefined) delete process.env.ANTHROPIC_PERSONAS_MODEL;
    else process.env.ANTHROPIC_PERSONAS_MODEL = savedModel;
  };
  // CHECK BEFORE SEND, not after. The post-prepare() check below says "Nothing
  // was sent", and until this block existed that sentence was false on the
  // branch that prints it: if the router refuses, prepare() takes its GEMINI
  // leg (aiContext.js:170) into gemini.getOrCreateCache(), which writes the
  // shared registry key `gemini:cache:persona:skeptical-cfo` and calls
  // caches.create against the live API — a cachedContent resource nothing here
  // ever discards, since probe() never calls aiContext.discard.
  //
  // MEASURED, because the two review passes disagreed about it and the
  // difference is environmental, not logical: with a warm registry entry whose
  // contentHash matches (`f2b543ce…`), getOrCreateCache returns the stored
  // record and touches no network — which is the state one pass happened to run
  // in, and why it reported the mutant firing at zero cost. With that one key
  // deleted, the same call created `cachedContents/1729vf…` (displayName
  // `persona:skeptical-cfo`), which then had to be deleted by hand. So the old
  // ordering was not free, it was free ON A WARM CACHE — and a cutover runs on
  // whatever Redis it finds.
  //
  // resolve() is the same question prepare() asks, minus the side effect, so
  // asking it here makes the claim true by construction rather than by luck.
  // The gates are already lifted at this point; a refusal now means a gate this
  // function does not know about, or no ANTHROPIC_API_KEY in the environment.
  try {
    wasReady = models.DISPATCH_READY.has(task);
    if (!wasReady) models.DISPATCH_READY.add(task);
    wasBlocked = models.FLIP_BLOCKED.has(task);
    blockReason = models.FLIP_BLOCKED.get(task);
    if (wasBlocked) models.FLIP_BLOCKED.delete(task);
    envName = models.providerEnvName(task);
    saved = process.env[envName];
    process.env[envName] = 'anthropic';
    process.env.ANTHROPIC_PERSONAS_MODEL = model;

    const resolved = models.resolve(task);
    if (resolved.provider !== 'anthropic' || resolved.model !== model) {
      throw new Error(
        `the router refused the dispatch: resolve("${task}") is ` +
        `${resolved.provider}/${resolved.model}, asked for anthropic/${model}. NOTHING WAS SENT. ` +
        'prepareVia() lifts DISPATCH_READY and FLIP_BLOCKED, so a gate added to models.js since ' +
        'then has to be lifted there too — or ANTHROPIC_API_KEY is not set in this process ' +
        '(providerFor() refuses an unconfigured provider the same way it refuses a blocked one).'
      );
    }
  } catch (err) {
    // Tagged here rather than at each throw site, so a gate export that has gone
    // away is reported as the harness bug it is and not as a transient. restore()
    // is called explicitly rather than from a `finally`: the success path hands
    // restore to prepare()'s .finally() below, and a finally here would undo the
    // lift before the call it was taken out for.
    err.harnessBug = true;
    restore();
    throw err;
  }

  return aiContext.prepare({
    task,
    name: 'persona:skeptical-cfo',
    systemInstruction: SEED.systemInstruction,
    turns: SEED.turns,
  }).finally(restore);
}

async function probe(model) {
  const record = await prepareVia('personas', model);
  // A cheap second belt. prepareVia() has already proven the router resolves
  // the way we asked BEFORE anything was sent; this catches the narrower case
  // of prepare() returning a record that disagrees with its own resolve().
  if (record.provider !== 'anthropic' || record.model !== model) {
    const err = new Error(
      `prepare() returned ${record.provider}/${record.model}, expected anthropic/${model}, ` +
      'even though resolve() agreed with us a moment earlier. That is aiContext.prepare() disagreeing ' +
      'with the router, not a gate this file failed to lift.'
    );
    err.harnessBug = true;
    throw err;
  }

  // Turn 1: multi-turn conversation on top of the cached prefix.
  const first = await aiContext.generate({
    record,
    turns: [{ role: 'user', text: 'The rep opens: "Thanks for the time, Sara."' }],
    maxOutputTokens: 120,
    allowTruncation: true,
    site: 'live.contextSeam',
  });

  // Turn 2: same prefix, longer transcript — this is the shape arena.takeTurn
  // produces, and the one that should READ the cache rather than write it.
  const second = await aiContext.generate({
    record,
    turns: [
      { role: 'user', text: 'The rep opens: "Thanks for the time, Sara."' },
      { role: 'assistant', text: first.text },
    ],
    message: 'Payback is under nine months at your ACV.',
    maxOutputTokens: 120,
    allowTruncation: true,
    site: 'live.contextSeam',
  });

  return { first, second };
}

(async () => {
  const results = [];

  for (const exp of EXPECTATIONS) {
    process.stdout.write(`\n── ${exp.model} ──\n`);
    try {
      const { first, second } = await probe(exp.model);
      const u1 = first.usage || {};
      const u2 = second.usage || {};
      // "Did caching engage?" is write OR read, never write alone. Re-running
      // this script within the 5-minute TTL means turn 1 READS a prefix an
      // earlier run wrote, so cache_creation is 0 on a perfectly healthy run.
      // Asserting on the write alone makes the check pass or fail on how
      // recently it was last run — which is how a probe ends up proving the
      // opposite of what it claims. Caught by inverting the expectations and
      // watching the sonnet row pass the inverted test.
      const engaged = (u1.cache_creation_input_tokens || 0) > 0
        || (u1.cache_read_input_tokens || 0) > 0;
      const wrote = (u1.cache_creation_input_tokens || 0) > 0;
      const readBack = (u2.cache_read_input_tokens || 0) > 0;
      const answered = Boolean(first.text && second.text);

      console.log('  turn 1 usage :', JSON.stringify({
        input: u1.input_tokens, cache_write: u1.cache_creation_input_tokens,
        cache_read: u1.cache_read_input_tokens, output: u1.output_tokens,
      }));
      console.log('  turn 2 usage :', JSON.stringify({
        input: u2.input_tokens, cache_write: u2.cache_creation_input_tokens,
        cache_read: u2.cache_read_input_tokens, output: u2.output_tokens,
      }));
      console.log('  in character :', first.text.slice(0, 90).replace(/\n/g, ' '));

      // A model that must cache must also read it back on the next turn —
      // writing once and missing every subsequent turn is the expensive
      // failure, and it is invisible from turn 1 alone. A model that must NOT
      // cache must show both counters at zero on both turns.
      const met = answered
        && engaged === exp.mustCache
        && readBack === exp.mustCache;
      results.push({ ...exp, met, answered, engaged, wrote, readBack });
    } catch (err) {
      // `harnessBug` rides along so the summary can separate "this script is
      // broken" from "the provider or the environment misbehaved". They need
      // different readers and different exit codes.
      console.log(`  ${err.harnessBug ? 'HARNESS BUG' : 'ERROR'}:`, err.message);
      results.push({ ...exp, error: err.message, harnessBug: Boolean(err.harnessBug) });
    }
  }

  console.log('\n── verdict ──');
  let failed = 0;
  let errored = 0;
  const bugs = results.filter((r) => r.harnessBug);
  for (const r of results) {
    if (r.error) {
      // A harness bug is reported in its own block below and NOT also as an
      // error, for the reason smoke.js:478-482 gives: listed twice, it prints
      // as "1 model(s) errored; the rest met expectations" and gets re-run.
      if (!r.harnessBug) errored += 1;
      console.log(`  ✗ ${r.model}: ${r.harnessBug ? 'HARNESS BUG' : 'ERROR'} — ${r.error}`);
      continue;
    }
    if (r.met) {
      console.log(
        `  ✓ ${r.model}: multi-turn OK, prefix ${r.engaged ? 'CACHED' : 'not cached'}` +
        `${r.engaged ? ` (${r.wrote ? 'written this run' : 'already warm'}) and read back on turn 2` : ''}` +
        ` — as expected (${r.why})`
      );
    } else {
      failed += 1;
      console.log(
        `  ✗ ${r.model}: EXPECTED ${r.mustCache ? 'to cache' : 'NOT to cache'} (${r.why}) — ` +
        `got answered=${r.answered} engaged=${r.engaged} wrote=${r.wrote} readBack=${r.readBack}`
      );
    }
  }

  console.log(`\n  (router state after the run: personas resolves to ${JSON.stringify(models.resolve('personas'))})`);

  if (bugs.length) {
    console.log('\nHARNESS BUG — this script, not the seam and not the provider. Nothing was sent:');
    for (const r of bugs) console.log(`  ${r.model}: ${r.error}`);
    console.log(
      '\nThese models were never judged and this run says nothing about them. Fix\n' +
      'test/live/contextSeam.js and re-run — re-running as-is reproduces it forever.'
    );
  }

  // A failed expectation still outranks a harness bug: the bug means those
  // models were never judged, it does not un-observe a regression that WAS
  // observed on another one, and 1 is the code that pages someone.
  if (failed > 0) { console.log(`\n${failed} expectation(s) not met.`); process.exit(1); }
  if (bugs.length) { process.exit(2); }
  if (errored === results.length) { console.log('\nErrors only — nothing judged, re-run.'); process.exit(4); }
  if (errored > 0) { console.log(`\n${errored} model(s) errored; the rest met expectations.`); process.exit(4); }
  process.exit(0);
})();
