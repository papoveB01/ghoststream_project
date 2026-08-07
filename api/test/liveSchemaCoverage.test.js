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
//
// `responseJsonSchema` is matched too. @google/genai accepts it as an
// alternative to `responseSchema`, and `\bresponseSchema\b` does not match
// inside it — so a call site written that way was invisible to BOTH this
// pattern and the mention-count guard below, which is the one combination that
// fails silently in both directions at once.
const SITE_RE = /response(?:Json)?Schema\s*:\s*/g;
const MENTION_RE = /\bresponse(?:Json)?Schema\b/g;

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

// Set comparison alone proves "every call-site TEXT is registered", not "every
// call site is registered". A SECOND `responseSchema: buildProspectsSchema(ourIds)`
// added to discovery.js matches the existing row and ships uncovered — the
// same class of hole as the bare `SCHEMA` name, just needing a duplicated
// expression instead of a generic one. Counting closes it: each distinct key
// must have at least as many non-variant registry rows as source occurrences.
test('[TEXTUAL] a repeated call-site expression needs its own registry row', () => {
  const sourceCount = new Map();
  for (const e of callSitesInSource()) sourceCount.set(key(e), (sourceCount.get(key(e)) || 0) + 1);

  // `variantOf` rows exercise a different SHAPE of an already-counted call site
  // (a builder with empty tenant data), so they must not pay for a new one.
  const registryCount = new Map();
  for (const e of ENTRIES) {
    if (e.variantOf) continue;
    registryCount.set(key(e), (registryCount.get(key(e)) || 0) + 1);
  }

  const short = [];
  for (const [k, n] of sourceCount) {
    const have = registryCount.get(k) || 0;
    if (have < n) short.push(`${k} — ${n} call site(s) in src/, ${have} registry row(s)`);
  }
  assert.deepStrictEqual(
    short, [],
    'two call sites sharing one registry row means only one of them is ever sent to a provider.\n' +
    'Give the new one its own row (and, if it is the same call site with different tenant data,\n' +
    'mark it `variantOf`):\n  ' + short.join('\n  ')
  );
});

test('every variantOf points at a real sibling row', () => {
  const sites = new Set(ENTRIES.map((e) => e.site));
  const dangling = ENTRIES.filter((e) => e.variantOf && !sites.has(e.variantOf));
  assert.deepStrictEqual(dangling.map((e) => `${e.site} → ${e.variantOf}`), [],
    'a variant whose base row is gone is silently excused from the count above');
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

// Files that FORWARD a caller's schema instead of defining one of their own.
//
// aiCall.js is the one-shot provider seam (ADR-0006 §9 item 5). It names its
// parameter `responseSchema` deliberately — so that migrated call sites keep
// the token this guard scans for — and then mentions it several more times
// destructuring and forwarding it. Those mentions are not call sites and can
// never have a registry row: the schema is whatever the caller passed, and the
// registry is keyed on a literal expression.
//
// This is an exemption from the MENTION-COUNT test only. The seam's callers are
// still scanned normally, which is the whole point of keeping the parameter
// name — a schema is registered where it is DEFINED, not where it is relayed.
const SCHEMA_FORWARDERS = new Set(['aiCall.js']);

test('the forwarder exemption list stays exactly what it claims to be', () => {
  // An exemption list is a hole in a guard. This makes growing it a visible,
  // deliberate diff rather than the quiet way a file stops being checked —
  // which is how a [TEXTUAL] guard in this repo has been defeated twice.
  assert.deepStrictEqual([...SCHEMA_FORWARDERS].sort(), ['aiCall.js']);
  for (const rel of SCHEMA_FORWARDERS) {
    assert.ok(fs.existsSync(path.join(SRC, rel)), `${rel} is exempted but does not exist`);
    const src = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.ok(/responseSchema/.test(src),
      `${rel} no longer mentions responseSchema — drop it from the exemption list`);
    // A forwarder relays; it must not carry a schema literal of its own, or the
    // exemption would be hiding a genuinely unregistered call site.
    //
    // `[:=]`, not `:`. The mention-count test below exists specifically to
    // catch the DEFERRED form (`cfg.responseSchema = X`) — and this
    // self-policing check, which is the only thing standing in for it inside an
    // exempted file, tested for the colon form alone. A real schema literal
    // written `config.responseSchema = { … }` inside aiCall.js passed
    // everything: exempt from the mention count, and invisible here.
    // `responseJsonSchema` is covered for the same reason MENTION_RE covers it.
    assert.ok(!/response(?:Json)?Schema\s*[:=]\s*\{/.test(src),
      `${rel} defines an inline schema literal — that is a real call site, not a forward`);
  }
  // The exemption's cost, pinned. aiCall.js is excused from the mention count,
  // so nothing else notices a new `responseSchema` appearing in it — including
  // one that is genuinely a second forwarding path needing its own thought.
  // Counting makes every such addition a deliberate one-line diff here.
  const seam = stripComments(fs.readFileSync(path.join(SRC, 'aiCall.js'), 'utf8'));
  assert.strictEqual((seam.match(MENTION_RE) || []).length, 7,
    'the number of responseSchema mentions in aiCall.js changed. It is exempt from the ' +
    'mention-count guard, so this is the only place that notices: confirm the new mention ' +
    'forwards a caller\'s schema rather than defining one, then update this count.');
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
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (SCHEMA_FORWARDERS.has(rel)) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const mentions = (src.match(MENTION_RE) || []).length;
    const matched = (src.match(SITE_RE) || []).length;
    if (mentions !== matched) {
      offenders.push(`${rel} — ${mentions} mention(s), ${matched} matched as a call site`);
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

// The two schemas in knowledge/assessment.js go to DIFFERENT models on Claude
// (ADR-0006 §4.1): per-document scoring is `assessment`/lite, battlecard
// synthesis is `battlecard`/flash. `task` is what smoke.js resolves the model
// from, so a row keyed to the wrong one validates the schema against a model
// production never sends it to — and reports green either way. The test above
// only checks the task EXISTS, and `assessment` exists, so nothing else here
// notices the drift.
test('the two assessment schemas are keyed to their own tasks, in one cluster', () => {
  const byS = Object.fromEntries(ENTRIES.map((e) => [e.site, e]));
  // Assert the rows EXIST before reading through them. `--site=kb.battlecard`
  // is the command MEDIUM 3 of this PR's review round is run with, so a renamed
  // site label has to fail here with a sentence, not as a bare TypeError three
  // lines down.
  for (const site of ['kb.assessment', 'kb.battlecard']) {
    assert.ok(byS[site], `no registry row is labelled ${site} — the site labels are what --site= selects on`);
  }
  assert.strictEqual(byS['kb.assessment'].task, 'assessment');
  assert.strictEqual(byS['kb.battlecard'].task, 'battlecard',
    'BATTLECARD_SCHEMA would be smoke-tested against Haiku while production sends it to Sonnet');
  // ADR-0006 §9 item 5 groups keypoints + assessment + battlecard as one
  // cutover and tells the operator to run `--cluster=` for the group before
  // flipping it. Giving battlecard its own cluster would drop it out of that one
  // command — so assert the VALUE, not merely that the two rows agree: renaming
  // both to a third string would keep them equal and still miss `assessment`.
  assert.strictEqual(byS['kb.assessment'].cluster, 'assessment');
  assert.strictEqual(byS['kb.battlecard'].cluster, 'assessment',
    '--cluster=assessment must still reach both schemas');
});

test('every registered task exists in the model router', () => {
  const { TASKS } = require('../src/models.js');
  const unknown = [...new Set(ENTRIES.map((e) => e.task))].filter((t) => !TASKS[t]);
  assert.deepStrictEqual(unknown, [],
    'an unknown task silently resolves to the FLASH tier, so the smoke check would validate the ' +
    'schema against a model production never uses for it: ' + unknown.join(', '));
});
