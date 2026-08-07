#!/usr/bin/env node
//
// Live temperature-capability probe — the mechanism behind NO_TEMPERATURE in
// src/anthropic.js (ADR-0006 §9 item 5).
//
// WHY THIS EXISTS. `supportsTemperature()` is DEFAULT-ALLOW: a model id that no
// NO_TEMPERATURE prefix matches gets `temperature` on the wire. That makes the
// list wrong in two very different ways, and only one of them was observable:
//
//   OVER-broad (a model listed that in fact accepts temperature) costs
//     determinism, and the suite already catches it — adding claude-haiku-4-5
//     fails two tests, removing the seam's forwarding fails one.
//   UNDER-broad (a model missing from the list that rejects it) is a HARD 400
//     on every request the first time a task resolves to that model. Deleting
//     'claude-opus-4-7' from the list left the suite 330/330 green. The only
//     direction that takes the product down for a tenant was uncovered.
//
// The list itself is correct today — live-probed twice, 2026-08-06 — but nothing
// re-derived it, so the next model generation is a silent 400 on the first flip.
// Two guards close that, and this file is one half of both:
//
//   - test/anthropicSurface.test.js reads PROBED below and asserts that
//     supportsTemperature() agrees with it, and that every model the router can
//     resolve appears in it. Free, offline, runs in CI. That is what fails when
//     someone edits the capability list without probing, or points a tier at a
//     model nobody has classified.
//   - THIS SCRIPT re-derives PROBED against the real API. It spends money and
//     needs a live key, so — exactly like test/live/smoke.js — it is NOT part of
//     `npm test` and must not become part of it.
//
//   npm run smoke:temperature
//   npm run smoke:temperature -- --dry-run              # print what it would send
//   npm run smoke:temperature -- --models=claude-opus-4-9
//
// Run it as a one-off api container from the REPO ROOT, for the reasons
// test/live/smoke.js documents at length (no node on the deploy host; the api
// image's runtime stage ships only src/ and db/):
//
//   docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
//     api node test/live/temperature.js
//
// EXIT CODES — distinct, so an alert can say which thing happened:
//   0  every probed model agrees with supportsTemperature()
//   1  a model we SEND temperature to REJECTS it — a hard 400 in production
//   2  bad invocation, or this script itself crashed
//   3  a model we DROP it for ACCEPTS it — determinism lost, not an outage
//   4  errors only; nothing was judged, re-run before concluding anything

'use strict';

const path = require('node:path');
const SRC = path.join(__dirname, '..', '..', 'src');

// What the live API answered, per model id. `true` = HTTP 200 with
// `temperature: 0.1`; `false` = HTTP 400 "`temperature` is deprecated for this
// model." Probed 2026-08-06 on a 16-token request, twice, same result.
//
// This table is the EXPECTATION, deliberately separate from the NO_TEMPERATURE
// prefixes it is checked against: a guard that reads the same list it is
// guarding cannot notice a deletion, which is precisely the gap that shipped.
//
// claude-mythos-5 is absent on purpose. It is Project Glasswing-only and cannot
// be reached with our key, so anthropic.js carries it UNPROBED — over-dropping
// on a model we cannot call is the safe direction, and this table must not
// claim a result it does not have.
const PROBED = {
  'claude-haiku-4-5': true,
  'claude-opus-4-6': true,
  'claude-sonnet-4-6': true,
  'claude-opus-4-7': false,
  'claude-opus-4-8': false,
  'claude-sonnet-5': false,
  'claude-opus-5': false,
  'claude-fable-5': false,
};

// The models a run must cover: everything already probed, plus every default
// the router can resolve to. The second half is what makes a new tier default
// probeable by running this script rather than by remembering to add a row.
function probeTargets(extra = []) {
  const models = require(path.join(SRC, 'models.js'));
  const ids = new Set([...Object.keys(PROBED), ...Object.values(models.TIERS.anthropic), ...extra]);
  return [...ids].sort();
}

module.exports = { PROBED, probeTargets };

// ── the runner ──────────────────────────────────────────────────────────────
//
// Everything below runs only as a script. src/ is required lazily inside the
// functions, for the same reason test/live/schemas.js keeps its schemas behind
// thunks: the CI-side guard requires this file for PROBED alone and must not
// drag the Anthropic client, the pg pool or the Redis client into a process
// that has no use for them.

function die(msg) {
  console.error(msg);
  console.error('usage: node test/live/temperature.js [--models=a,b] [--dry-run]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { models: [], dryRun: false };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const k = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--/, '');
    const v = eq === -1 ? undefined : arg.slice(eq + 1);
    if (k === 'models') {
      if (!v) die('--models needs a value');
      out.models = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (k === 'dry-run') {
      // `--dry-run=false` must not enable it — see the same guard in smoke.js.
      if (v === undefined || v === 'true' || v === '1') out.dryRun = true;
      else die(`--dry-run is a flag; pass it bare (got "${v}")`);
    } else if (k === 'help') { die('help'); } else die(`unknown option --${k}`);
  }
  return out;
}

// The raw SDK client, NOT anthropic.generate(): generate() drops `temperature`
// for exactly the models this script exists to test, so probing through it
// would only prove that the list agrees with itself.
async function probe(model) {
  const anthropic = require(path.join(SRC, 'anthropic.js'));
  const client = anthropic.getClient();
  try {
    await client.messages.create({
      model,
      max_tokens: 16,
      temperature: 0.1,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    return { accepts: true };
  } catch (err) {
    const msg = String((err && err.message) || err);
    const status = err && err.status;
    // Narrow on purpose. A 400 that names `temperature` is the answer; a 404
    // (no access to the model), a 429, a 529 or a connection error says nothing
    // about the capability and must never be recorded as "rejects".
    if (status === 400 && /temperature/i.test(msg)) return { accepts: false };
    return { error: `${status || '?'} ${msg}` };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = probeTargets(opts.models);

  if (opts.dryRun) {
    console.log(`would probe ${targets.length} model(s) with a 16-token request at temperature 0.1:`);
    for (const m of targets) {
      const known = m in PROBED ? (PROBED[m] ? 'accepts' : 'rejects') : 'UNPROBED';
      console.log(`  ${m.padEnd(22)} recorded: ${known}`);
    }
    return 0;
  }

  const anthropic = require(path.join(SRC, 'anthropic.js'));
  if (!anthropic.isConfigured()) die('ANTHROPIC_API_KEY is not set — this script needs a live key');

  const rows = [];
  for (const model of targets) {
    const r = await probe(model);
    rows.push({ model, ...r });
    const verdict = r.error ? `ERROR ${r.error}` : (r.accepts ? 'accepts' : 'rejects');
    console.log(`${model.padEnd(22)} ${verdict}`);
  }

  // Three separate ways to be wrong, reported separately because the fix
  // differs: send-a-400 is an outage, drop-on-a-capable-model is a quality
  // regression, and an unprobed model is a coin flip waiting for a flip.
  const judged = rows.filter((r) => !r.error);
  const dangerous = [];
  const safe = [];
  for (const r of judged) {
    const weSend = anthropic.supportsTemperature(r.model);
    if (weSend && !r.accepts) dangerous.push(r.model);
    if (!weSend && r.accepts) safe.push(r.model);
  }
  const drifted = judged.filter((r) => r.model in PROBED && PROBED[r.model] !== r.accepts);
  const unrecorded = judged.filter((r) => !(r.model in PROBED));

  console.log('');
  if (drifted.length) {
    console.log('PROBED is out of date — update the table in this file:');
    for (const r of drifted) console.log(`  ${r.model}: recorded ${PROBED[r.model]}, live says ${r.accepts}`);
  }
  if (unrecorded.length) {
    console.log('not in PROBED — add these rows so CI can check them for free:');
    for (const r of unrecorded) console.log(`  '${r.model}': ${r.accepts},`);
  }

  if (!judged.length) { console.log('nothing was judged'); return 4; }
  if (dangerous.length) {
    console.log(`SENDING temperature to a model that rejects it: ${dangerous.join(', ')} — ` +
      'every request to that model is a 400. Add it to NO_TEMPERATURE in src/anthropic.js.');
    return 1;
  }
  if (safe.length) {
    console.log(`DROPPING temperature on a model that accepts it: ${safe.join(', ')} — ` +
      'sampling is unpinned there. Remove it from NO_TEMPERATURE in src/anthropic.js.');
    return 3;
  }
  console.log(`all ${judged.length} judged model(s) agree with supportsTemperature()`);
  return rows.length === judged.length ? 0 : 4;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    // A crash is exit 2, never 1: exit 1 means "we send temperature to a model
    // that 400s", and that is the only thing an alert should read it as.
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
}
