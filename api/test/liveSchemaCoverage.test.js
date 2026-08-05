// Coverage guard for the live-schema smoke check (ADR-0006 §9 item 3).
//
// The smoke check is only worth its runtime if it covers every schema the
// product actually sends. Nothing about `test/live/schemas.js` forces that on
// its own: add a `responseSchema:` to src/, forget the registry, and the smoke
// run still reports all-green over a schema it never tried. That is the same
// shape as the telemetry blind spot ADR-0006 phase 0 existed to close — a green
// signal over an unobserved surface — so it gets the same treatment.
//
// Free, DB-free, no network: this reads source text and the registry's METADATA
// only. The registry's `schema` thunks are never called here, so requiring it
// does not pull express routers, the pg pool or the Redis client into CI.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');
const { ENTRIES } = require('./live/schemas.js');
// Shared with costsTelemetry.test.js, and quote/regex-aware — a naive stripper
// deletes the rest of any line containing `'-//DealScope//…'` or `/\/\//`,
// taking a call site on that line with it. See test/stripComments.test.js.
const { stripComments } = require('./helpers/stripComments.js');

// .mjs/.cjs are included even though src/ is CommonJS today: a guard that only
// looks at .js silently stops covering the first file written in another
// extension, and nothing about that failure is visible.
const JS_EXT = /\.(js|mjs|cjs)$/;

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (JS_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

// Read the expression after `responseSchema:` up to the value's end. A plain
// `/[^,]+/` is wrong here — `buildCompetitorsSchema(ourIds, incumbentNames)`
// contains the delimiter, and truncating it would silently produce a registry
// key that can never match.
function readExpr(src, from) {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ',' || c === '}' || c === '\n')) break;
    i++;
  }
  return src.slice(from, i).trim();
}

// `\s*` before the colon as well as after: `responseSchema : X` is valid JS and
// was invisible to the first version of this pattern.
const SITE_RE = /responseSchema\s*:\s*/g;

function callSitesInSource() {
  const found = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const m of src.matchAll(SITE_RE)) {
      found.push({ file: rel, expr: readExpr(src, m.index + m[0].length) });
    }
  }
  return found;
}

// Whitespace-normalised so that reformatting a registered call site across
// lines — an ordinary prettier or manual edit — does not fail the guard and ask
// the reader to register a key containing newlines.
const key = (e) => `${e.file}::${e.expr.replace(/\s+/g, ' ').trim()}`;

test('[TEXTUAL] every responseSchema in src/ is registered for the live smoke check', () => {
  const inSource = callSitesInSource();
  const registered = new Set(ENTRIES.map(key));
  const missing = inSource.filter((e) => !registered.has(key(e)));

  assert.deepStrictEqual(
    missing.map(key), [],
    'these schemas reach a provider in production but no live check ever validates them.\n' +
    'Anthropic rejects the Gemini dialect outright (missing additionalProperties is a 400), so an\n' +
    'unregistered schema is a task that 400s for every tenant on its first request after a provider\n' +
    'flip — with CI and the CD smoke test both green. Add a row to test/live/schemas.js:\n  ' +
    missing.map(key).join('\n  ')
  );
});

test('[TEXTUAL] the registry has no rows that no longer exist in src/', () => {
  const inSource = new Set(callSitesInSource().map(key));
  const stale = ENTRIES.map(key).filter((k) => !inSource.has(k));
  assert.deepStrictEqual(
    stale, [],
    'a registry row pointing at a schema that no longer exists spends money proving nothing, ' +
    'and pads the coverage count so a genuinely missing row is harder to notice:\n  ' + stale.join('\n  ')
  );
});

// The two tests above enumerate SPELLINGS of a call site, so they can only
// catch the spellings someone thought of. This one is structural: every
// surviving mention of the token must be one the pattern matched. It is what
// catches the forms enumeration misses — ES6 shorthand `{ …, responseSchema }`
// and a deferred `cfg.responseSchema = X` — by construction rather than by
// guesswork.
test('[TEXTUAL] no responseSchema mention escapes the call-site pattern', () => {
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const mentions = (src.match(/\bresponseSchema\b/g) || []).length;
    const matched = (src.match(SITE_RE) || []).length;
    if (mentions !== matched) {
      offenders.push(`${path.relative(SRC, file).split(path.sep).join('/')} — ${mentions} mention(s), ${matched} matched as a call site`);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'a mention of responseSchema that is not a `responseSchema: <expr>` call site is either a new\n' +
    'spelling this guard cannot see (shorthand, a later assignment) or prose that belongs in a\n' +
    'comment. Either way the coverage count above is no longer trustworthy:\n  ' + offenders.join('\n  ')
  );
});

test('no registry expr is a bare generic name', () => {
  // `file::expr` is the identity of a call site. When expr is a name as generic
  // as `SCHEMA` — this repo's idiomatic local for "the schema for this call" —
  // ANY later `responseSchema: SCHEMA` in the same file matches an
  // already-registered row, and ships uncovered. Two of these existed in the
  // first version of this PR.
  const generic = new Set(['SCHEMA', 'schema', 'Schema', 'CONFIG', 'config']);
  const bad = ENTRIES.filter((e) => generic.has(e.expr));
  assert.deepStrictEqual(
    bad.map((e) => `${e.file}::${e.expr}`), [],
    'rename the local at the call site to a distinct name (e.g. KEYPOINTS_SCHEMA) and update expr'
  );
});

test('the registry rows are individually addressable', () => {
  const sites = ENTRIES.map((e) => e.site);
  assert.strictEqual(new Set(sites).size, sites.length,
    'two rows sharing a site label cannot be told apart in the smoke output or filtered separately');
  for (const e of ENTRIES) {
    assert.ok(e.cluster, `${e.site}: needs a cluster (ADR-0006 §8 phase 1 checks per cluster)`);
    assert.ok(e.task, `${e.site}: needs the models.js task key, or the check cannot resolve which model to send it to`);
    assert.strictEqual(typeof e.schema, 'function',
      `${e.site}: schema must be a thunk — see the header of test/live/schemas.js`);
  }
});

test('every registered task exists in the model router', () => {
  const { TASKS } = require('../src/models.js');
  const unknown = [...new Set(ENTRIES.map((e) => e.task))].filter((t) => !TASKS[t]);
  assert.deepStrictEqual(unknown, [],
    'an unknown task silently resolves to the FLASH tier, so the smoke check would validate the ' +
    'schema against a model production never uses for it: ' + unknown.join(', '));
});
