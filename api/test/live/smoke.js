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
// Exit code is 1 if any schema was rejected, so cron can alert on it.
//
// WHAT "PASS" MEANS HERE. That the provider ACCEPTED the schema and returned
// output conforming to it. It says nothing about answer quality — these prompts
// carry no real content on purpose, to keep a full run to a few cents.

'use strict';

const path = require('node:path');
const SRC = path.join(__dirname, '..', '..', 'src');

const { ENTRIES, CLUSTERS } = require('./schemas.js');
const { inspect } = require(path.join(SRC, 'schemaCompat.js'));
const models = require(path.join(SRC, 'models.js'));

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { provider: 'anthropic', clusters: null, sites: null, dryRun: false, maxTokens: 800, verbose: false };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'provider') out.provider = v;
    else if (k === 'cluster') out.clusters = v.split(',').map((s) => s.trim());
    else if (k === 'site') out.sites = v.split(',').map((s) => s.trim());
    else if (k === 'dry-run') out.dryRun = true;
    else if (k === 'max-tokens') out.maxTokens = parseInt(v, 10);
    else if (k === 'verbose') out.verbose = true;
    else if (k === 'help') { usage(); process.exit(0); }
    else { console.error(`unknown option --${k}`); usage(); process.exit(2); }
  }
  if (!['anthropic', 'gemini', 'both'].includes(out.provider)) {
    console.error(`--provider must be anthropic | gemini | both (got "${out.provider}")`);
    process.exit(2);
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
function resolveFor(provider, task) {
  const envName = models.providerEnvName(task);
  const prevEnv = process.env[envName];
  const wasReady = models.DISPATCH_READY.has(task);
  process.env[envName] = provider;
  if (!wasReady) models.DISPATCH_READY.add(task);
  try {
    return models.resolve(task);
  } finally {
    if (!wasReady) models.DISPATCH_READY.delete(task);
    if (prevEnv === undefined) delete process.env[envName];
    else process.env[envName] = prevEnv;
  }
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

async function checkOne(entry, provider, opts) {
  let schema;
  try {
    schema = entry.schema();
  } catch (err) {
    // A registry row that cannot even build its schema is a real failure — it
    // usually means the export it names was renamed or removed.
    return { entry, provider, ok: false, model: '-', detail: `registry: ${err.message}` };
  }

  // Only meaningful for Anthropic; Gemini takes the schema as written.
  const warnings = provider === 'anthropic' ? inspect(schema).warnings : [];
  // Resolved before the call, not after, so a REJECTED schema still reports
  // which model rejected it — the first thing anyone reading a failure needs.
  const { model: planned } = resolveFor(provider, entry.task);

  if (opts.dryRun) {
    if (opts.verbose && provider === 'anthropic') {
      console.log(JSON.stringify(inspect(schema).schema, null, 2));
    }
    return { entry, provider, ok: true, model: planned, detail: 'dry-run (not sent)', warnings };
  }

  try {
    const res = provider === 'anthropic'
      ? await callAnthropic(entry, schema, opts.maxTokens, planned)
      : await callGemini(entry, schema, opts.maxTokens, planned);

    if (opts.verbose) console.log(`    ↳ ${res.text.slice(0, 400)}`);

    // Accepted. Now: did it come back as the schema promised? A truncated answer
    // is not a schema fault, so it is reported but not failed.
    let detail = 'accepted';
    if (res.stopReason === 'max_tokens' || res.stopReason === 'MAX_TOKENS') {
      detail = `accepted (truncated at ${opts.maxTokens} tokens — raise --max-tokens to check the output too)`;
    } else {
      try {
        JSON.parse(res.text);
        detail = 'accepted, output parses';
      } catch {
        detail = `accepted BUT output is not JSON: ${res.text.slice(0, 120)}`;
      }
    }
    return { entry, provider, ok: true, model: res.model, detail, warnings };
  } catch (err) {
    return { entry, provider, ok: false, model: planned, detail: err.message, warnings };
  }
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
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${entry.site.padEnd(30)} ${String(r.model).padEnd(22)} ${r.detail}`);
      for (const w of r.warnings || []) console.log(`       ! ${w}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  const warned = results.filter((r) => (r.warnings || []).length);
  console.log(`\n${results.length - failed.length}/${results.length} accepted` +
    (warned.length ? `, ${warned.length} with translation warnings` : ''));

  if (failed.length) {
    console.log('\nrejected:');
    for (const r of failed) console.log(`  ${r.provider} ${r.entry.site}: ${r.detail}`);
    console.log(
      '\nA rejection here is a task that would 502 for every tenant the moment its provider is\n' +
      'flipped. Fix the schema (or src/schemaCompat.js) before adding the task to DISPATCH_READY.'
    );
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
