#!/usr/bin/env node
//
// Live-schema smoke check — ADR-0006 §9 item 3, §8 phase 1.
//
// WHAT IT IS FOR. CI runs against Redis and makes no model call; ops/cd-deploy.sh
// smoke-tests /api/health, /capture/health and / — no AI path at all. So a
// schema the provider rejects ships green, deploys green, and then 502s every
// tenant on the first real request. That gap was already written up as the PR
// #40 finding (2026-07-30) and left open; this closes it for structured output,
// which is the part of the surface the provider migration actually changes.
//
// It is NOT part of `npm test` and must not become part of it: it spends money
// and needs live credentials. Run it by hand before a cutover, or on a cron.
//
//   npm run smoke:schemas                      # every schema, against Anthropic
//   npm run smoke:schemas -- --provider=both   # …and against Gemini too
//   npm run smoke:schemas -- --cluster=watch,discovery
//   npm run smoke:schemas -- --dry-run         # translate + print, call nothing
//
// HOW TO ACTUALLY RUN IT ON A DEPLOY HOST. `npm run` assumes a checkout with
// node. There is none: the host has no node binary, and the api image's runtime
// stage copies only src/ and db/, so `docker compose exec api node
// test/live/smoke.js` is MODULE_NOT_FOUND. Run it as a one-off api container
// with the checkout mounted over the image — from the repo root:
//
//   docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
//     api node test/live/smoke.js
//
// `compose run` (not `docker run --env-file .env`) is load-bearing. The api
// service's DATABASE_* and REDIS_PASSWORD are DERIVED in docker-compose.yml
// from POSTGRES_*/REDIS_PASSWORD and do not exist in .env under those names, so
// an --env-file invocation reaches the model fine but cannot reach Postgres —
// and every one of this run's own usage_costs rows is silently lost. Measured:
// zero rows written across a full 52-call run before this was corrected.
// Also in rules/commands.md.
//
// EXIT CODES — distinct so an alert can say which thing happened:
//   0  everything accepted
//   1  a schema was REJECTED — the finding this script exists to report
//   2  bad invocation, or this script itself is broken (never a rejection) —
//      including the router refusing a dispatch resolveFor() failed to lift
//   3  accepted, but a field lost its ability to be null
//   4  errors only — nothing was judged, re-run before concluding anything
//
// WHAT "ACCEPTED" MEANS HERE, precisely: the provider took the schema and
// returned JSON that parses. It is NOT a conformance proof — nothing here
// validates the response against the schema field by field. What it does check
// beyond parsing is the one divergence that is otherwise silent: a REQUIRED
// nullable field coming back non-null when the prompt asked for null. It says
// nothing about answer quality — these prompts carry no real content on
// purpose, to keep a full run to a few cents.

'use strict';

const path = require('node:path');
const SRC = path.join(__dirname, '..', '..', 'src');

const { ENTRIES, CLUSTERS } = require('./schemas.js');
const { inspect } = require(path.join(SRC, 'schemaCompat.js'));
const models = require(path.join(SRC, 'models.js'));

// ── args ────────────────────────────────────────────────────────────────────

// Every bad-argument path exits 2, never 1. Exit 1 means "a schema was
// rejected" and cron reads nothing else — so a typo that exits 1 is
// indistinguishable from the finding this whole script exists to report.
function die(msg) {
  console.error(msg);
  usage();
  process.exit(2);
}

function parseArgs(argv) {
  const out = { provider: 'anthropic', clusters: null, sites: null, dryRun: false, maxTokens: 800, verbose: false };
  const needsValue = (k, v) => { if (v === undefined || v === '') die(`--${k} needs a value`); return v; };
  // `--dry-run=false` must NOT enable dry-run. Discarding the value there is
  // how a runbook line or cron entry ends up green forever over a surface it
  // never touched — and the exit code, the only thing cron reads, says 0.
  const flag = (k, v) => {
    if (v === undefined || v === 'true' || v === '1') return true;
    die(`--${k} is a flag; pass it bare or as --${k}=true (got "${v}")`);
  };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const k = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--/, '');
    const v = eq === -1 ? undefined : arg.slice(eq + 1);
    if (k === 'provider') out.provider = needsValue(k, v);
    else if (k === 'cluster') out.clusters = needsValue(k, v).split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'site') out.sites = needsValue(k, v).split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'dry-run') out.dryRun = flag(k, v);
    else if (k === 'verbose') out.verbose = flag(k, v);
    else if (k === 'max-tokens') {
      // NaN would serialise to `max_tokens: null` and 400 every single entry —
      // reported, before this guard, as 26 schema rejections from one typo.
      const n = parseInt(needsValue(k, v), 10);
      if (!Number.isFinite(n) || n < 1) die(`--max-tokens must be a positive integer (got "${v}")`);
      out.maxTokens = n;
    } else if (k === 'help') { usage(); process.exit(0); }
    else die(`unknown option --${k}`);
  }
  if (!['anthropic', 'gemini', 'both'].includes(out.provider)) {
    die(`--provider must be anthropic | gemini | both (got "${out.provider}")`);
  }
  return out;
}

function usage() {
  console.log(
    'usage: node test/live/smoke.js [options]\n' +
    '  --provider=anthropic|gemini|both   default anthropic\n' +
    `  --cluster=a,b                      one or more of: ${CLUSTERS.join(', ')}\n` +
    '  --site=analysis.moments,...        exact site labels\n' +
    '  --max-tokens=N                     output budget per call (default 800)\n' +
    '  --dry-run                          translate and print, call nothing\n' +
    '  --verbose                          print the translated schema and the response\n'
  );
}

// ── model resolution ────────────────────────────────────────────────────────

// Resolve through the REAL router rather than reading TIERS directly, so a task
// mis-tiered in models.js shows up here as "checked the wrong model" rather
// than passing silently. The per-task env var is the highest-precedence knob,
// so setting it beats any AI_PROVIDER_* an operator already has in .env;
// DISPATCH_READY is what the router consults before honouring it at all.
//
// EVERY ROUTER GATE HAS TO BE LIFTED HERE, NOT JUST DISPATCH_READY. `models.js`
// grew a second one — FLIP_BLOCKED — in group 2's cutover, consulted right
// after dispatch-readiness and falling back to Gemini in exactly the same way.
// With only the first lifted, this function returned `gemini-2.5-flash-lite`
// for four of the five group-2 entries and the harness posted a GEMINI model id
// to the Anthropic API: 4 × 404, `1/5 accepted, 4 errored`, exit 4, where the
// same command on `main` was 5/5 and exit 0. Nothing said "harness" — it read
// as a provider outage. That is this check disabling itself precisely for the
// tasks whose flip PR is required to run it (rules/commands.md: "the only thing
// that catches a schema the provider rejects"). Mirrors the save/lift/restore
// in test/cutoverGroup2.test.js's withAnthropic().
//
// THE WHOLE BODY IS INSIDE THE try, including the reads of the two gate
// exports. models.js:168 explicitly anticipates a key LEAVING FLIP_BLOCKED, and
// the set itself going away with the migration is the natural end state — at
// which point `models.FLIP_BLOCKED.has(...)` is a TypeError. Read outside the
// try, that throw carries no `harnessBug` tag, reports as an ordinary setup
// ERROR and exits 4, "re-run" — for a script that will fail identically forever.
// Tagging every throw from in here is right rather than over-broad: nothing in
// this function talks to a provider, so anything it throws is this file or this
// environment, and NOTHING WAS SENT is true of all of it.
function resolveFor(provider, task) {
  let envName;
  let prevEnv;
  // Initialised to "nothing to undo", not to false/false. If a throw lands
  // between here and the lift, the finally must not delete a membership this
  // call never added — which is the unconditional-restore defect one line over,
  // reached by a different route.
  let wasReady = true;
  let wasBlocked = false;
  let blockReason;
  try {
    envName = models.providerEnvName(task);
    prevEnv = process.env[envName];
    wasReady = models.DISPATCH_READY.has(task);
    wasBlocked = models.FLIP_BLOCKED.has(task);
    blockReason = models.FLIP_BLOCKED.get(task);
    process.env[envName] = provider;
    if (!wasReady) models.DISPATCH_READY.add(task);
    if (wasBlocked) models.FLIP_BLOCKED.delete(task);
    const resolved = models.resolve(task);
    // The backstop. A model that does not belong to the provider we asked for is
    // a bug in THIS FILE — the router refused the dispatch and we failed to lift
    // the refusal — and sending it produces a 404 that names the model and
    // blames the provider. Checked on the id family as well as
    // `resolved.provider`, so a stray GEMINI_*_MODEL / ANTHROPIC_*_MODEL
    // override pointing at the wrong family is caught too. providerOfModel()
    // returns null for ids it does not know, which is deliberately not a
    // failure: a newly released model or a custom endpoint id must keep working
    // without an edit here.
    //
    // WHAT IT DOES NOT COVER, and this is narrower than "a THIRD gate cannot
    // repeat the above silently", which is what it used to claim. It catches a
    // gate that changes the PROVIDER. A gate that keeps the provider and
    // downgrades the MODEL passes both checks in silence — and that shape is not
    // hypothetical: `anthropicTier` (models.js:323) already re-tiers keypoints
    // and battlecard for Claude only, so a future gate written in its image
    // would leave this run reporting a green over a model production would not
    // use. test/liveHarnessGates.test.js pins the provider half for free, on
    // every push; the model half has nothing behind it but this comment.
    const family = models.providerOfModel(resolved.model);
    if (resolved.provider !== provider || (family && family !== provider)) {
      throw new Error(
        `the router refused the dispatch — asked for ${provider}, resolved ${resolved.provider}/` +
        `${resolved.model}. NOTHING WAS SENT. This is a harness bug, not a provider or schema ` +
        'fault: smoke.js lifts DISPATCH_READY and FLIP_BLOCKED for the task under test, so a gate ' +
        'added to models.js since then has to be lifted in resolveFor() too.'
      );
    }
    return resolved;
  } catch (err) {
    err.harnessBug = true;
    throw err;
  } finally {
    if (!wasReady) models.DISPATCH_READY.delete(task);
    if (wasBlocked) models.FLIP_BLOCKED.set(task, blockReason);
    if (envName !== undefined) {
      if (prevEnv === undefined) delete process.env[envName];
      else process.env[envName] = prevEnv;
    }
  }
}

// Same hazard as the reads inside resolveFor(), one scope out and with a worse
// blast radius. models.js:168 anticipates a key LEAVING FLIP_BLOCKED, and the
// set going away with the migration is the natural end state — at which point
// `models.FLIP_BLOCKED.has(...)` is a TypeError. resolveFor() reads it inside a
// try for exactly that reason; the two [flip-blocked] read sites in main() sat
// outside one, where a throw escapes to main().catch and takes the WHOLE summary
// with it — every result already paid for on the run, and the HARNESS BUG block
// that would have said what happened. Measured with FLIP_BLOCKED removed from
// models.js's exports: a plain `--dry-run` run died on the FIRST row with a raw
// `TypeError: Cannot read properties of undefined (reading 'has')` and exit 2,
// no findings, no summary. It survived a review round because the call site's
// `&&` short-circuits unless the provider is anthropic.
//
// Absent set → nothing is blocked → no mark and no footnote, which is the
// truthful reading: the mark exists to say the ROUTER refuses this dispatch, and
// a router with no such set refuses nothing.
function isFlipBlocked(task) {
  try { return models.FLIP_BLOCKED.has(task); } catch { return false; }
}

// ── the calls ───────────────────────────────────────────────────────────────

// Deliberately content-free. The check is "does this schema survive the
// validator", not "is the answer good", and an empty-ish prompt keeps a full
// 26-schema run in the low cents.
const PROMPT =
  'This is a schema conformance check, not a real request. Return the smallest ' +
  'object that satisfies the required schema. Use empty strings, empty arrays, ' +
  'zeros and nulls wherever the schema allows them. Invent nothing.';

async function callAnthropic(entry, schema, maxTokens, model) {
  const anthropic = require(path.join(SRC, 'anthropic.js'));
  // Through generate(), not the SDK directly: the translation, the effort/
  // thinking gating and the refusal handling are all part of what production
  // would send, so a check that bypassed them would be checking a different
  // request. allowTruncation because hitting the budget is not a schema fault.
  const res = await anthropic.generate({
    model,
    prompt: PROMPT,
    schema,
    maxTokens,
    effort: 'low',
    thinking: false,
    allowTruncation: true,
    site: `smoke.${entry.site}`,
  });
  return { model, text: res.text, stopReason: res.stopReason };
}

async function callGemini(entry, schema, maxTokens, model) {
  const gemini = require(path.join(SRC, 'gemini.js'));
  const ai = gemini.getClient();
  const resp = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    config: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      responseSchema: schema,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return { model, text: resp.text || '', stopReason: resp.candidates?.[0]?.finishReason || null };
}

// ── run ─────────────────────────────────────────────────────────────────────

function selected(opts) {
  let list = ENTRIES;
  if (opts.clusters) list = list.filter((e) => opts.clusters.includes(e.cluster));
  if (opts.sites) list = list.filter((e) => opts.sites.includes(e.site));
  return list;
}

// THE distinction this script turns on. "Rejected" must mean the provider read
// our schema and refused it — that is the finding, and it is what the exit code
// and the 502 banner are for. Everything else that can throw here (a 429 across
// 26 sequential calls on one key, a timeout, a safety REFUSAL — which
// anthropic.js documents as a live path for exactly the battlecard and
// competitor-discovery surface — or a module that would not even load) says
// nothing about the schema.
//
// Conflating them is not cosmetic: a gate that reports transients as rejections
// gets muted, and then a real rejection ships green. That is the failure this
// file exists to close.
//
// The classifier is deliberately narrow: only a 4xx that names the schema, or
// the grammar-size ceiling, counts. Anything ambiguous is an ERROR — the safe
// direction, since an ERROR still fails the run loudly, just without claiming
// the schema is at fault.
// `response_?schema` covers both spellings: the Anthropic path and our own code
// say `responseSchema`, but the Gemini API names the field `response_schema` in
// its 400 body ("Unknown name \"patternProperties\" at
// 'generation_config.response_schema'"). With only the camelCase form, a REAL
// Gemini schema rejection classified as an ERROR and exited 4 — "nothing was
// judged, re-run" — for a run that had in fact judged it and found it invalid.
const SCHEMA_REJECT_RE = /output_config\.format|response_?schema|compiled grammar|invalid schema|invalid json ?schema|does not match declared type|additionalProperties|unknown name/i;

function classify(err) {
  const msg = String((err && err.message) || err);
  if (err && err.refusal) return 'ERROR';            // a 422 refusal is not a schema fault
  if (err && err.truncated) return 'ERROR';          // budget, not shape
  const looks400 = (err && err.status === 400) || /\b400\b|INVALID_ARGUMENT/.test(msg);
  if (looks400 && SCHEMA_REJECT_RE.test(msg)) return 'REJECTED';
  return 'ERROR';
}

// The half that acceptance cannot prove. schemaCompat's hazard #2 is a nullable
// field the validator silently ignores: the response is well-formed JSON, the
// call succeeds, and the model has simply lost the ability to say "there wasn't
// one" — so it invents one instead. The prompt asks explicitly for null
// wherever the schema allows it, so a REQUIRED nullable field coming back
// non-null is the signal.
//
// Reported as DEGRADED, never as REJECTED: the model is entitled to return a
// value, so this is evidence to go and look, not proof of a defect.
// Descends through `items` as well as `properties`. Without the array leg this
// saw 3 of the 8 required-nullable fields in the registry and missed 5 —
// including BOTH of the nullable enums in discovery.competitorProducts and the
// one in companies.productFit, which are two of the three schemas schemaCompat
// names as the reason it exists. The check that proves the conversion held
// could not look where the conversion mattered most.
function nullableLeaves(schema, path = '', out = []) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return out;
  for (const [name, sub] of Object.entries(schema.properties || {})) {
    if (!sub || typeof sub !== 'object') continue;
    const here = path ? `${path}.${name}` : name;
    if (sub.nullable === true && (schema.required || []).includes(name)) out.push(here);
    if (sub.properties) nullableLeaves(sub, here, out);
    if (sub.items) nullableLeaves(sub.items, `${here}[]`, out);
  }
  return out;
}

// Resolves a path emitted above, fanning out at each `[]` segment: an array
// element that kept its null is not evidence, but any element that lost it is.
function valuesAt(parsed, path) {
  let nodes = [parsed];
  for (const seg of path.split('.')) {
    const key = seg.endsWith('[]') ? seg.slice(0, -2) : seg;
    const next = [];
    for (const n of nodes) {
      if (n == null || typeof n !== 'object') continue;
      const v = n[key];
      if (seg.endsWith('[]')) { if (Array.isArray(v)) next.push(...v); }
      else next.push(v);
    }
    nodes = next;
  }
  return nodes;
}

function nonNullRequiredNullables(schema, parsed) {
  const offenders = [];
  for (const p of nullableLeaves(schema)) {
    const values = valuesAt(parsed, p);
    // An empty array yields nothing to judge — silence, not a pass.
    if (values.length && values.every((v) => v !== null && v !== undefined)) offenders.push(p);
  }
  return offenders;
}

async function checkOne(entry, provider, opts) {
  // The whole body is guarded, not just the call: `entry.schema()`, `inspect()`
  // and `resolveFor()` sit before it, and a throw from any of them used to
  // escape to main().catch — losing the summary AND every result already paid
  // for on this run.
  let schema;
  let planned = '-';
  let warnings = [];
  try {
    schema = entry.schema();
    // A thunk that returns undefined does NOT throw — and it is reachable: 13
    // rows read a named export, and nothing ties that export name to the call
    // site (the coverage guard pairs the call site's TEXT). Drop an export and
    // every layer stays green: anthropic.js sends no output_config at all when
    // schema is falsy, so the call succeeds UNCONSTRAINED and reports `ok`.
    // Exactly the green-over-unobserved-surface failure this script exists to
    // eliminate, reintroduced one level up.
    if (!schema || typeof schema !== 'object') {
      throw new Error(`schema thunk returned ${schema === undefined ? 'undefined' : typeof schema} — is the export still there?`);
    }
    // Only meaningful for Anthropic; Gemini takes the schema as written.
    warnings = provider === 'anthropic' ? inspect(schema).warnings : [];
    // Resolved before the call, not after, so a rejected schema still reports
    // which model rejected it — the first thing anyone reading a failure needs.
    planned = resolveFor(provider, entry.task).model;
  } catch (err) {
    // Usually a renamed/removed export, or a module that will not load (a
    // missing JWT_SECRET takes out every router-bearing module at once). Not a
    // schema rejection — nothing was sent. `harnessBug` is carried through so
    // the summary can separate "this script is broken" from "the provider or
    // the environment misbehaved"; they need different readers.
    return {
      entry, provider, status: 'ERROR', model: planned, warnings,
      detail: `setup: ${err.message}`, harnessBug: Boolean(err.harnessBug),
    };
  }

  if (opts.dryRun) {
    if (opts.verbose && provider === 'anthropic') {
      console.log(JSON.stringify(inspect(schema).schema, null, 2));
    }
    return { entry, provider, status: 'OK', model: planned, detail: 'dry-run (not sent)', warnings };
  }

  try {
    const res = provider === 'anthropic'
      ? await callAnthropic(entry, schema, opts.maxTokens, planned)
      : await callGemini(entry, schema, opts.maxTokens, planned);

    if (opts.verbose) console.log(`    ↳ ${res.text.slice(0, 400)}`);

    // Accepted. A truncated answer is a budget problem, not a schema fault, so
    // it is reported without failing.
    if (res.stopReason === 'max_tokens' || res.stopReason === 'MAX_TOKENS') {
      return {
        entry, provider, status: 'OK', model: res.model, warnings,
        detail: `accepted (truncated at ${opts.maxTokens} tokens — raise --max-tokens to check the output too)`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return {
        entry, provider, status: 'OK', model: res.model, warnings,
        detail: `accepted BUT output is not JSON: ${res.text.slice(0, 120)}`,
      };
    }
    const lost = nonNullRequiredNullables(schema, parsed);
    if (lost.length) {
      return {
        entry, provider, status: 'DEGRADED', model: res.model, warnings,
        detail: `accepted, but required nullable field(s) came back non-null despite being asked for null: ${lost.join(', ')}`,
      };
    }
    return { entry, provider, status: 'OK', model: res.model, detail: 'accepted, output parses', warnings };
  } catch (err) {
    return { entry, provider, status: classify(err), model: planned, detail: err.message, warnings };
  }
}

// The registry loads modules that open a Redis client at require time, so the
// event loop cannot drain on its own — the first version simply called
// process.exit(), which also discards anything still buffered in stdout. Under
// cron (`| mail`), `docker logs` or `tee`, stdout is a pipe, and the block that
// gets truncated is the one at the very end: the findings the alert exists to
// carry. Tear down explicitly, flush, and keep a hard stop as the backstop.
async function shutdown() {
  // costs.record* is fire-and-forget by contract (a telemetry outage must not
  // fail the action it observes), so its INSERT is still in flight when the
  // last call returns. Without this pause the smoke run's own spend is simply
  // never recorded — measured: zero rows after a full 52-call run.
  await new Promise((r) => setTimeout(r, 1500));
  try { require(path.join(SRC, 'redis.js')).disconnect(); } catch { /* may not be loaded */ }
  await new Promise((r) => process.stdout.write('', r));
  // Anything else still holding the loop open would hang an unattended run.
  const bail = setTimeout(() => process.exit(process.exitCode || 0), 5000);
  bail.unref();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const providers = opts.provider === 'both' ? ['anthropic', 'gemini'] : [opts.provider];
  const list = selected(opts);

  if (!list.length) {
    console.error('nothing selected — check --cluster / --site');
    process.exit(2);
  }
  for (const p of providers) {
    const key = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
    if (!opts.dryRun && !process.env[key]) {
      console.error(`${key} is not set — cannot check ${p}`);
      process.exit(2);
    }
  }
  // Not an API credential, but the registry loads router-bearing modules and
  // src/auth.js THROWS at require time when NODE_ENV=production and this is
  // unset — which is the api Dockerfile's own default, i.e. the mode a cutover
  // run is most likely to be in. Without this check that surfaces as six
  // "setup:" errors instead of one sentence.
  if (!process.env.JWT_SECRET) {
    console.error(
      'JWT_SECRET is not set — the registry loads modules that refuse to initialise without it.\n' +
      'Any value works here; nothing is signed. Run with --env-file, or export a throwaway value.'
    );
    process.exit(2);
  }

  console.log(
    `live-schema smoke: ${list.length} schema(s) × ${providers.join(' + ')}` +
    `${opts.dryRun ? '  [DRY RUN]' : ''}\n`
  );

  const results = [];
  for (const provider of providers) {
    let lastCluster = null;
    for (const entry of list) {
      if (entry.cluster !== lastCluster) {
        console.log(`  ── ${entry.cluster} ${'─'.repeat(Math.max(0, 40 - entry.cluster.length))} [${provider}]`);
        lastCluster = entry.cluster;
      }
      // Sequential on purpose: a burst of 26 parallel calls is the fastest way
      // to turn a schema check into a rate-limit check.
      const r = await checkOne(entry, provider, opts);
      results.push(r);
      // A harness-bug row has status ERROR but must not PRINT as one. The
      // summary already separates the two; the BODY did not, so the observed
      // failure was four lines reading `ERROR kb.battlecard … setup: the router
      // refused the dispatch`, and anyone grepping the log rather than reading
      // the last block still counted four provider errors. That is the exact
      // misreading, still available one screen up from where it was fixed.
      const tag = r.harnessBug
        ? 'HARNESS!'
        : { OK: 'ok      ', DEGRADED: 'DEGRADED', REJECTED: 'REJECTED', ERROR: 'ERROR   ' }[r.status];
      // MARK THE ROWS PRODUCTION REFUSES TO SEND. `resolveFor()` lifts
      // FLIP_BLOCKED for the duration of the call — that is the whole point, it
      // is how a blocked task's schema gets checked at all — so an `ok` here is
      // a true statement about a dispatch the router will NOT make today. On the
      // group-2 cluster 4 of the 5 rows are keypoints/battlecard, and "5/5
      // accepted" over them is the sentence a flip PR is most likely to quote as
      // readiness. The mark makes that impossible to do by accident.
      const flipBlocked = provider === 'anthropic' && isFlipBlocked(entry.task);
      console.log(
        `  ${tag} ${entry.site.padEnd(34)} ${String(r.model).padEnd(22)}` +
        `${flipBlocked ? ' [flip-blocked]' : ''} ${r.detail}`
      );
      for (const w of r.warnings || []) console.log(`         ! ${w}`);
    }
  }

  const by = (s) => results.filter((r) => r.status === s);
  const rejected = by('REJECTED');
  const degraded = by('DEGRADED');
  const warned = results.filter((r) => (r.warnings || []).length);
  const bugs = results.filter((r) => r.harnessBug);
  // A harness bug is reported in its own block below and NOT also as an error.
  // Listing it twice is how "4 errored" gets read as four flaky provider calls
  // — which is exactly the misreading that let the FLIP_BLOCKED regression sit.
  const errored = by('ERROR').filter((r) => !r.harnessBug);
  const flipBlockedRows = results.filter(
    (r) => r.provider === 'anthropic' && isFlipBlocked(r.entry.task));

  console.log(
    `\n${by('OK').length}/${results.length} accepted` +
    (degraded.length ? `, ${degraded.length} degraded` : '') +
    (rejected.length ? `, ${rejected.length} REJECTED` : '') +
    (errored.length ? `, ${errored.length} errored` : '') +
    (bugs.length ? `, ${bugs.length} HARNESS BUG` : '') +
    (warned.length ? `, ${warned.length} with translation warnings` : '')
  );

  // The footnote that keeps the number above from being quoted as readiness.
  // ADR-0006 §9 item 5 makes the argument at length; the one-liner is here
  // because the count is what gets pasted into a PR body.
  if (flipBlockedRows.length) {
    console.log(
      `\n${flipBlockedRows.length} of those row(s) are [flip-blocked]: the provider accepted the schema and ` +
      'production still\nrefuses to route the task there (models.FLIP_BLOCKED). This run measures SCHEMA ' +
      'ACCEPTANCE\nat one sample, effort=low and max_tokens=' + `${opts.maxTokens}` +
      '; it is not evidence about the real request\nshape, and it is not flip readiness.'
    );
  }

  if (bugs.length) {
    console.log('\nHARNESS BUG — this script, not the provider and not the schema. Nothing was sent:');
    for (const r of bugs) console.log(`  ${r.provider} ${r.entry.site}: ${r.detail}`);
    console.log(
      '\nThese entries were never judged and this run says nothing about them. Fix\n' +
      'test/live/smoke.js and re-run before flipping anything.'
    );
  }

  if (rejected.length) {
    console.log('\nREJECTED — the provider read the schema and refused it:');
    for (const r of rejected) console.log(`  ${r.provider} ${r.entry.site}: ${r.detail}`);
    console.log(
      '\nThis is a task that would 502 for every tenant the moment its provider is flipped.\n' +
      'Fix the schema (or src/schemaCompat.js) before adding the task to DISPATCH_READY.'
    );
  }
  if (degraded.length || warned.length) {
    console.log('\nDEGRADED — accepted, but a field lost its ability to be null:');
    for (const r of degraded) console.log(`  ${r.provider} ${r.entry.site}: ${r.detail}`);
    for (const r of warned) console.log(`  ${r.provider} ${r.entry.site}: ${(r.warnings || []).join('; ')}`);
    console.log(
      '\nThis half is silent in production: the call succeeds, the JSON is well-formed, and the\n' +
      'model fabricates a value where it should have said "there wasn\'t one".'
    );
  }
  if (errored.length) {
    console.log('\nerrors (NOT schema rejections — nothing here says the schema is wrong):');
    for (const r of errored) console.log(`  ${r.provider} ${r.entry.site}: ${r.detail}`);
    console.log('\nRe-run these before drawing any conclusion; the schema was never judged.');
  }

  // Distinct codes so a cron alert can say which of the three happened rather
  // than treating a rate-limit blip as "the schema is broken".
  //   1 = a schema was rejected      2 = bad invocation / this script is broken
  //   3 = degraded semantics only    4 = errors only, nothing judged
  //
  // A rejection still outranks a harness bug. The bug means those entries were
  // never judged; it does not un-observe a refusal that WAS observed on another
  // entry, and 1 is the only code that pages anyone. The HARNESS BUG block above
  // prints either way.
  if (rejected.length) return 1;
  if (bugs.length) return 2;
  if (degraded.length || warned.length) return 3;
  if (errored.length) return 4;
  return 0;
}

// Only when RUN, not when required. test/liveHarnessGates.test.js requires this
// file to exercise resolveFor() for free, in CI, with no network — and without
// this guard that require would start a paid 26-schema run inside `npm test`.
if (require.main === module) {
  main()
    .then(async (code) => {
      process.exitCode = code;
      await shutdown();
    })
    .catch(async (err) => {
      console.error(err);
      // 2, not 1. An unexpected throw out here is this script failing, not a
      // schema being rejected — and 1 is the code that pages someone about a
      // rejection.
      process.exitCode = 2;
      await shutdown();
    });
}

// resolveFor is the only export, and it is exported for ONE reason: nothing in
// `npm test` could reach it, so the gate-lifting defect that made this harness
// post a Gemini model id to the Anthropic API was catchable only by spending
// money. test/live/ is outside `npm test` and CI merely `node --check`s it
// (.github/workflows/ci.yml:60), so the runtime backstop above is the last line
// of defence and it fires only after the run has already been paid for.
module.exports = { resolveFor };
