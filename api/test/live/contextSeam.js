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
//   4  errors only — nothing was judged, re-run
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
function prepareVia(task, model) {
  models.DISPATCH_READY.add(task);
  const wasBlocked = models.FLIP_BLOCKED.has(task);
  const blockReason = models.FLIP_BLOCKED.get(task);
  models.FLIP_BLOCKED.delete(task);
  const envName = models.providerEnvName(task);
  const saved = process.env[envName];
  process.env[envName] = 'anthropic';
  const savedModel = process.env.ANTHROPIC_PERSONAS_MODEL;
  process.env.ANTHROPIC_PERSONAS_MODEL = model;
  const restore = () => {
    models.DISPATCH_READY.delete(task);
    if (wasBlocked) models.FLIP_BLOCKED.set(task, blockReason);
    if (saved === undefined) delete process.env[envName]; else process.env[envName] = saved;
    if (savedModel === undefined) delete process.env.ANTHROPIC_PERSONAS_MODEL;
    else process.env.ANTHROPIC_PERSONAS_MODEL = savedModel;
  };
  return aiContext.prepare({
    task,
    name: 'persona:skeptical-cfo',
    systemInstruction: SEED.systemInstruction,
    turns: SEED.turns,
  }).finally(restore);
}

async function probe(model) {
  const record = await prepareVia('personas', model);
  // A mismatch here is a bug in THIS FILE, not in the seam: the router refused
  // the dispatch and prepareVia() failed to lift the refusal. Say so, rather
  // than leaving the next reader to conclude aiContext.prepare() is broken.
  if (record.provider !== 'anthropic' || record.model !== model) {
    throw new Error(
      `HARNESS BUG — prepare() returned ${record.provider}/${record.model}, expected anthropic/${model}. ` +
      'The router refused the dispatch; prepareVia() lifts DISPATCH_READY and FLIP_BLOCKED, so a gate ' +
      'added to models.js since then has to be lifted there too. Nothing was sent.'
    );
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
      console.log('  ERROR:', err.message);
      results.push({ ...exp, error: err.message });
    }
  }

  console.log('\n── verdict ──');
  let failed = 0;
  let errored = 0;
  for (const r of results) {
    if (r.error) {
      errored += 1;
      console.log(`  ✗ ${r.model}: ERROR — ${r.error}`);
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

  if (failed > 0) { console.log(`\n${failed} expectation(s) not met.`); process.exit(1); }
  if (errored === results.length) { console.log('\nErrors only — nothing judged, re-run.'); process.exit(4); }
  if (errored > 0) { console.log(`\n${errored} model(s) errored; the rest met expectations.`); process.exit(4); }
  process.exit(0);
})();
