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
//      is supposed to differ by model, and that is the claim being checked.
//
// Run from the repo root:
//   docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
//     api node test/live/contextSeam.js

'use strict';

const models = require('../../src/models');
const personas = require('../../src/personas');
const aiContext = require('../../src/aiContext');

const SEED = personas['skeptical-cfo'];

async function probe(model) {
  const record = {
    provider: 'anthropic',
    mode: 'breakpoint',
    name: 'persona:skeptical-cfo',
    model,
    systemInstruction: SEED.systemInstruction,
    turns: SEED.turns,
  };

  // Turn 1: multi-turn conversation on top of the cached prefix.
  const first = await aiContext.generate({
    record,
    turns: [{ role: 'user', text: 'The rep opens: "Thanks for the time, Sara."' }],
    maxOutputTokens: 120,
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
    site: 'live.contextSeam',
  });

  return { first, second };
}

(async () => {
  const results = [];
  for (const model of ['claude-sonnet-5', 'claude-haiku-4-5']) {
    process.stdout.write(`\n── ${model} ──\n`);
    try {
      const { first, second } = await probe(model);
      const u1 = first.usage || {};
      const u2 = second.usage || {};
      console.log('  multi-turn accepted :', first.text ? 'yes' : 'NO — empty answer');
      console.log('  turn 1 usage        :', JSON.stringify({
        input: u1.input_tokens, cache_write: u1.cache_creation_input_tokens,
        cache_read: u1.cache_read_input_tokens, output: u1.output_tokens,
      }));
      console.log('  turn 2 usage        :', JSON.stringify({
        input: u2.input_tokens, cache_write: u2.cache_creation_input_tokens,
        cache_read: u2.cache_read_input_tokens, output: u2.output_tokens,
      }));
      console.log('  in character        :', first.text.slice(0, 90).replace(/\n/g, ' '));
      results.push({
        model,
        cached: (u1.cache_creation_input_tokens || 0) > 0,
        readBack: (u2.cache_read_input_tokens || 0) > 0,
        ok: Boolean(first.text && second.text),
      });
    } catch (err) {
      console.log('  ERROR:', err.message);
      results.push({ model, error: err.message });
    }
  }

  console.log('\n── verdict ──');
  for (const r of results) {
    if (r.error) { console.log(`  ${r.model}: ERROR ${r.error}`); continue; }
    console.log(
      `  ${r.model}: multi-turn ${r.ok ? 'OK' : 'FAILED'}, ` +
      `prefix ${r.cached ? 'CACHED' : 'NOT cached (silent — expected on haiku 4.5)'}, ` +
      `read back ${r.readBack ? 'yes' : 'no'}`
    );
  }
  console.log(`\n  (router state: personas resolves to ${JSON.stringify(models.resolve('personas'))})`);
  process.exit(0);
})();
