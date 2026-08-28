// Vendor-spend telemetry (ADR-0006 phase 0).
//
// usage_costs shipped with migration 0049 and a working recorder, and then sat
// empty for two months: only 4 of ~30 model call sites ever called it, and
// nothing read the table. "What did we spend last month" was unanswerable from
// the running system — which is a bad position from which to change providers.
//
// Three properties are pinned here:
//
//  1. [TEXTUAL] every models.generateContent() call site sits in a file that
//     also records. This is the one that stops the drift recurring: adding a
//     model call without telemetry now fails the suite rather than quietly
//     widening the blind spot.
//  2. Claude's cache-token accounting. Its `input_tokens` is the UNCACHED
//     REMAINDER, and prompt tokens split across three fields billing at three
//     different rates. Porting Gemini's mapping field-for-field under-reports
//     every cached call — i.e. exactly the calls ADR-0006 §4.3 leans on.
//  3. Longest-prefix rate matching: 'gemini-2.5-flash-lite' contains
//     'gemini-2.5-flash', so a naive substring match bills lite calls at 3× and
//     the error is invisible in any single row.
//
// No Postgres: db is replaced in require.cache before costs is required, per
// the pattern in test/queryBounds.test.js and test/geminiCacheScan.test.js.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(SRC, relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const inserted = [];
let lastSelect = null;

stubModule('db', {
  async query(text, params) {
    if (/^\s*INSERT INTO usage_costs/.test(text)) {
      inserted.push({ text, params });
      return { rows: [] };
    }
    lastSelect = { text, params };
    return { rows: [] };
  },
});

const costs = require(path.join(SRC, 'costs.js'));

// Params order in record(): tenant_id, service, site, units, unit_kind, est_cost_cents, meta
const P = { TENANT: 0, SERVICE: 1, SITE: 2, UNITS: 3, KIND: 4, CENTS: 5, META: 6 };

function lastRow() {
  return inserted[inserted.length - 1];
}

// ── 1. coverage invariant ───────────────────────────────────────────────────

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Comments must not count. A reviewer defeated the first version of this guard
// twice: once with a commented-out `// costs.recordGemini(...) // TODO` next to
// a genuinely unrecorded call, and once by reformatting an existing call so the
// call-regex stopped matching while its stale recorder still did — the counts
// balanced and the suite went green with live unrecorded spend in the tree.
//
// A third defeat, found by review of the live-schema guard that copied this
// function: the original strip also fired on a `//` inside a string or a regex
// literal, deleting the rest of the line. `src/ics.js`'s
// `'-//DealScope//Meeting Invite//EN'` and `src/portfolio.js`'s `/\/\//` are
// both truncated by it today, so putting a model call on such a line hid it.
// The stripper now lives in one place, with its own tests.
const { stripComments } = require('./helpers/stripComments.js');

// Tolerate the formatting a prettier pass or a human would produce: any client
// variable, a newline before the options object.
//
// `embedContent` is deliberately NOT in this pattern. Verified against the live
// API on 2026-08-05: an embedContent response carries no `usageMetadata` at all
// (top-level keys are `sdkHttpResponse, embeddings`), so `recordGemini` would
// hit its `if (!usage) return` and write nothing. Widening this regex would
// force a recorder that silently records zero — a green guard over invisible
// spend, which is worse than the acknowledged gap. Embedding spend needs its
// own recorder that estimates tokens rather than reading them; tracked as a
// follow-up, and `knowledge/embeddings.js` is the one uninstrumented model
// surface until then.
const CALL_RE = /\.\s*models\s*\.\s*generateContent\s*\(\s*\{/g;
const RECORD_RE = /costs\s*\.\s*record(?:Gemini|Claude)\s*\(/g;

test('[TEXTUAL] every model call site sits in a file that records spend', () => {
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const calls = (src.match(CALL_RE) || []).length;
    if (calls === 0) continue;
    const records = (src.match(RECORD_RE) || []).length;
    if (records < calls) {
      offenders.push(`${path.relative(SRC, file)} — ${calls} call site(s), ${records} recorder(s)`);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'a model call site without a recorder is spend we cannot see — add costs.recordGemini() ' +
    'next to the call, threading tenantId in if the enclosing function lacks it:\n  ' + offenders.join('\n  ')
  );
});

// The counting guard above still cannot pair a specific call to a specific
// recorder — two recorders on one call site and none on another passes. This
// narrows that gap for the common shape: within each file, every recorder must
// name a distinct site, so the "two recorders, one call" bypass needs two
// distinct labels to go unnoticed, which is no longer an accident.
test('[TEXTUAL] no file records the same site label twice', () => {
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const seen = new Map();
    for (const m of src.matchAll(/costs\.record(?:Gemini|Claude)\([^,]+,\s*'([^']+)'/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
    for (const [label, n] of seen) {
      if (n > 1) offenders.push(`${path.relative(SRC, file)} — '${label}' recorded ${n}×`);
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n  '));
});

// A migrated call site no longer records its own spend: aiCall.generateStructured
// records for Gemini and anthropic.generate records for Claude, both keyed on the
// `site` the caller passes. So the sweep has to count BOTH spellings, or the floor
// below simply erodes as ADR-0006 §9 item 5 proceeds — one call site at a time,
// each drop individually unremarkable, until the guard is counting almost nothing
// and still passing. Group 1 alone moved four of them.
// Whitespace-tolerant, exactly like CALL_RE above — and for the same reason.
// The first version spelled this `/\.generateStructured\(\{/g`, so
// `.generateStructured( {` (a prettier pass, or a human) and a destructured
// `const { generateStructured } = require(...); generateStructured({…})` both
// escaped it. Each escape silently takes its `site:` off the floor the last
// test in this section asserts, one call site at a time, exactly as the
// migration proceeds — which is the erosion that floor exists to catch.
//
// The dot-less alternative must still skip aiCall.js's own
// `async function generateStructured({…})` — a definer, with no site to pass —
// so `function` is excluded explicitly rather than by requiring the dot.
const SEAM_CALL_RE =
  /(?:\.\s*generateStructured|(?<![.\w])(?<!function\s)generateStructured)\s*\(\s*\{/g;

// Brace-matched, not a fixed window. The 1200-char window this replaces is
// ALREADY too small for the next group: analysis.js's config key sits 1235+
// chars into its call, so the very next cutover would have reported a
// legitimately-labelled call site as unlabelled — or, with the label past the
// window, missed a genuinely missing one. Depth counting has no such ceiling,
// and an unbalanced call (truncated file, a brace inside a string) returns null
// and is reported as an offender rather than silently passing.
function callWindow(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

function seamSiteLabels(src) {
  const out = [];
  for (const m of src.matchAll(SEAM_CALL_RE)) {
    const window = callWindow(src, m.index + m[0].indexOf('('));
    // An unbalanced call is reported, never skipped: "we could not read this
    // call site" and "this call site has no label" are both failures of the
    // sweep, and silently dropping the first is how a guard starts counting
    // less than it claims to.
    if (window === null) { out.push({ unreadable: true }); continue; }
    const site = window.match(/\bsite:\s*'([^']+)'/);
    out.push(site ? site[1] : null);
  }
  return out;
}

test('[TEXTUAL] every seam call site passes an explicit site label', () => {
  // Without one, aiCall falls back to `ai.<task>` — which is not the
  // '<area>.<operation>' convention the rollup groups on, and would quietly
  // fragment a task's spend across two labels during a migration.
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    seamSiteLabels(src).forEach((label, i) => {
      if (label && label.unreadable) {
        offenders.push(`${path.relative(SRC, file)} — generateStructured #${i + 1} has unbalanced ` +
          'braces/parens, so this sweep could not read it at all');
      } else if (!label) {
        offenders.push(`${path.relative(SRC, file)} — generateStructured #${i + 1} has no site:`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n  '));
});

test('[TEXTUAL] the recorded site labels are unique and namespaced', () => {
  const labels = [];
  for (const file of walkJs(SRC)) {
    // stripComments, like every other sweep in this file. Reading raw was
    // defeat #1 from this file's own header comment, reproduced against the new
    // seam counting: two commented-out `// aiCall.generateStructured({ site:
    // 'fake' })` lines padded the floor below back to 25 while real call sites
    // went uninstrumented.
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/costs\.recordGemini\([^,]+,\s*'([^']+)'/g)) labels.push(m[1]);
    for (const label of seamSiteLabels(src)) if (typeof label === 'string') labels.push(label);
  }
  assert.ok(labels.length >= 25, `expected the full call-site sweep to be instrumented, found ${labels.length}`);
  for (const l of labels) {
    assert.match(l, /^[a-z][a-zA-Z]*\.[a-zA-Z]+$/, `site label '${l}' should read '<area>.<operation>'`);
  }
  assert.strictEqual(new Set(labels).size, labels.length,
    'two call sites sharing a label make their costs indistinguishable in the rollup');
});

test('[TEXTUAL] the number of seam call sites is pinned, so prose has something to disagree with', () => {
  // ADR-0006's migration is described in prose that COUNTS call sites —
  // anthropic.js's header, models.js's DISPATCH_READY block, the ADR's §9 item
  // 5 register, the PR bodies. Group 2 shipped with three of those disagreeing
  // with the code and with each other ("six call sites", "eleven in total"),
  // from counting the functions that had to be edited rather than the
  // generateStructured calls that resulted.
  //
  // The existing tripwire for that class — providerRouter.test.js's set-equality
  // pin — cannot catch it: it is a failure MESSAGE listing the dependent prose,
  // and a message is only ever read on a red run. Verified by rewriting
  // anthropic.js's header to claim "group 2 (nothing yet) — FOUR seam call
  // sites": the suite stayed green. A count needs a number to contradict.
  //
  // The number, not the labels, because the labels are already pinned above and
  // a task can legitimately serve several sites (`keypoints` serves three). When
  // this fails, the next cutover PR is telling you which comments to re-read.
  let sites = 0;
  for (const file of walkJs(SRC)) {
    sites += seamSiteLabels(stripComments(fs.readFileSync(file, 'utf8'))).length;
  }
  assert.strictEqual(sites, 10,
    `${sites} aiCall.generateStructured call sites in src/, pinned at 10 (group 1: relevance x2, ` +
    'preview, companyBrief; group 2: keypoints x3, assessment, battlecard; group 3: research). ' +
    'If you added or ' +
    "moved one, update this number AND the prose that quotes it: anthropic.js's header, " +
    "models.js's DISPATCH_READY / group lists, and ADR-0006 §9 item 5.");

  // …AND the number the prose actually quotes, read out of anthropic.js.
  //
  // Pinning only the code count catches a call site being added or deleted, and
  // is blind to the drift that actually happened — a comment claiming a
  // different number while the code is unchanged. Verified: rewriting this
  // sentence to "group 2 (nothing yet) — FOUR seam call sites" left the count
  // above green, because nothing in src/ had moved. Two numbers that must agree
  // is the only shape that catches both directions.
  //
  // Deliberately ONE canonical prose site rather than every place a number
  // appears: a guard that greps the whole tree for digits fails on the next
  // unrelated sentence and gets deleted. anthropic.js's header is the canonical
  // one, and its failure message names the others.
  const WORDS = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const header = fs.readFileSync(path.join(SRC, 'anthropic.js'), 'utf8');
  const quoted = header.match(/(\w+) seam call sites in total/i);
  assert.ok(quoted,
    "anthropic.js's header no longer says '<N> seam call sites in total'. That sentence is the " +
    'canonical prose copy of the count this test pins; if it was reworded, re-point this match ' +
    'at the new wording rather than deleting the check — the drift it exists to catch (a comment ' +
    'claiming a count the code contradicts) is one this repo has now paid for twice.');
  const claimed = WORDS[quoted[1].toLowerCase()] ?? Number(quoted[1]);
  assert.strictEqual(claimed, sites,
    `anthropic.js's header claims ${quoted[1]} seam call sites; src/ has ${sites}. ` +
    "Fix whichever is wrong, then check the same number in models.js's DISPATCH_READY block " +
    'and ADR-0006 §9 item 5 — those three drifted apart in group 2 and had to be repaired by hand.');
});

test('the Sonnet-5 count in prose is COMPUTED from the router, not scraped', () => {
  // A companion to the count above, and a different KIND of guard on purpose.
  // That one is [TEXTUAL] — a regex over a comment — and it is why the sentence
  // one line BELOW the number it pins was able to say "FOUR OF THE SEVEN LAND ON
  // claude-sonnet-5" and then enumerate three, while the suite stayed green.
  // Widening the regex would just move the edge; the fix is to derive the number
  // from the thing it is a claim about.
  //
  // Which matters because that sentence is the operator-facing statement of
  // "your temperature will be dropped after a flip": anthropic.js's
  // NO_TEMPERATURE is per model, so the set of migrated keys landing on Sonnet 5
  // IS the set whose determinism setting silently goes away.
  const models = require(path.join(SRC, 'models.js'));
  const sonnet = [...models.DISPATCH_READY]
    .filter((task) => {
      const t = models.TASKS[task];
      const tier = (t && t.anthropicTier) || (t && t.tier);
      return models.TIERS.anthropic[tier] === 'claude-sonnet-5';
    })
    .sort();
  assert.deepStrictEqual(sonnet, ['battlecard', 'keypoints', 'research'],
    'these are the migrated keys whose temperature is dropped after a flip');

  const header = fs.readFileSync(path.join(SRC, 'anthropic.js'), 'utf8');
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const quoted = header.match(/(\w+) OF THE (\w+) LAND ON claude-sonnet-5/i);
  assert.ok(quoted,
    "anthropic.js's header no longer says '<N> OF THE <M> LAND ON claude-sonnet-5'. Re-point this " +
    'match at the new wording rather than deleting it — the drift it catches (a count that ' +
    'contradicts the router two lines under a guarded number) has already happened once.');
  const claimed = WORDS[quoted[1].toLowerCase()] ?? Number(quoted[1]);
  const outOf = WORDS[quoted[2].toLowerCase()] ?? Number(quoted[2]);
  assert.strictEqual(claimed, sonnet.length,
    `anthropic.js's header claims ${quoted[1]} keys on claude-sonnet-5; the router resolves ${sonnet.length} (${sonnet.join(', ')})`);
  assert.strictEqual(outOf, models.DISPATCH_READY.size,
    `anthropic.js's header says "of the ${quoted[2]}"; DISPATCH_READY holds ${models.DISPATCH_READY.size}`);
});

// ── 2. Claude usage accounting ──────────────────────────────────────────────

test('recordClaude bills fresh, cache-write and cache-read input at their own rates', async () => {
  // Sonnet 5: $3/MTok in, $15/MTok out → 300 / 1500 cents per MTok.
  // 1M fresh + 1M cache-write + 1M cache-read + 1M out
  //   = 300 + (300 × 2) + (300 × 0.1) + 1500 = 2430 cents.
  // The cache-write leg uses the 1h multiplier because this fixture supplies
  // the aggregate `cache_creation_input_tokens` with no per-TTL split; see the
  // constants in costs.js for why the ambiguous case resolves to 1h.
  await costs.recordClaude('t1', 'analysis.moments', 'claude-sonnet-5', {
    input_tokens: 1e6,
    cache_creation_input_tokens: 1e6,
    cache_read_input_tokens: 1e6,
    output_tokens: 1e6,
  });
  const row = lastRow();
  assert.strictEqual(row.params[P.SERVICE], 'claude');
  assert.strictEqual(Number(row.params[P.CENTS]), 2430);
});

test('recordClaude counts cached prompt tokens in units — input_tokens is only the remainder', async () => {
  await costs.recordClaude('t1', 'analysis.moments', 'claude-sonnet-5', {
    input_tokens: 1000,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 30000,
    output_tokens: 500,
  });
  const row = lastRow();
  // The regression this guards: treating input_tokens as the whole prompt
  // reports 1500 units for a call that actually moved 33500.
  assert.strictEqual(Number(row.params[P.UNITS]), 33500);
  const meta = JSON.parse(row.params[P.META]);
  assert.strictEqual(meta.cacheRead, 30000);
  assert.strictEqual(meta.cacheWrite, 2000);
});

test('a cached call costs materially less than the same call uncached', async () => {
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', { input_tokens: 1e6, output_tokens: 0 });
  const uncached = Number(lastRow().params[P.CENTS]);
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', { cache_read_input_tokens: 1e6, output_tokens: 0 });
  const cached = Number(lastRow().params[P.CENTS]);
  assert.strictEqual(cached, uncached * 0.1,
    'cache reads bill at 0.1× input — if this drifts, the ADR-0006 §4.3 margin case is unverifiable');
});

test('an unknown model records tokens with a null cost rather than a wrong one', async () => {
  await costs.recordClaude('t1', 'a.b', 'claude-from-the-future', { input_tokens: 1000, output_tokens: 10 });
  const row = lastRow();
  assert.strictEqual(row.params[P.CENTS], null);
  assert.strictEqual(Number(row.params[P.UNITS]), 1010);
});

// ── 3. rate matching ────────────────────────────────────────────────────────

test('flash-lite bills at the lite rate, not the flash rate it is a prefix of', async () => {
  await costs.recordGemini('t1', 'kb.relevanceDoc', 'gemini-2.5-flash-lite', {
    promptTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const lite = Number(lastRow().params[P.CENTS]);
  await costs.recordGemini('t1', 'discovery.queries', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const flash = Number(lastRow().params[P.CENTS]);
  assert.strictEqual(lite, 10, 'flash-lite input is $0.10/MTok');
  assert.strictEqual(flash, 30, 'flash input is $0.30/MTok');
  assert.ok(lite < flash, 'a substring match would bill both at the flash rate');
});

test('Gemini thinking tokens count as output', async () => {
  await costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', {
    promptTokenCount: 0, candidatesTokenCount: 1e6, thoughtsTokenCount: 1e6,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 500, '2M output tokens at $2.50/MTok');
});

// ── 4. read path bounds ─────────────────────────────────────────────────────

test('rollups are bounded and clamp the day window', async () => {
  await costs.rollupByTenant({ days: 99999 });
  assert.match(lastSelect.text, /LIMIT \d+/, 'an unbounded read over usage_costs is the next queryBounds entry');
  assert.strictEqual(lastSelect.params[0], 365, 'day window clamps to a year');

  await costs.rollupBySite({ days: 'not-a-number' });
  assert.strictEqual(lastSelect.params[0], 30, 'a junk window falls back to 30 days, never to unbounded');

  await costs.rollupByTenant({ days: 7, tenantId: 't1' });
  assert.strictEqual(lastSelect.params[1], 't1');
  assert.match(lastSelect.text, /AND tenant_id = \$2/);
});

test('telemetry failures never propagate to the caller', async () => {
  const dbFull = require.resolve(path.join(SRC, 'db.js'));
  const good = require.cache[dbFull].exports.query;
  require.cache[dbFull].exports.query = async () => { throw new Error('postgres is down'); };
  try {
    await assert.doesNotReject(
      () => costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', { promptTokenCount: 1 }),
      'record() is fire-and-forget — a telemetry outage must not fail the action it observes'
    );
  } finally {
    // Restore even if the assertion throws, so a future test appended after
    // this one does not silently inherit a permanently-broken db stub.
    require.cache[dbFull].exports.query = good;
  }
});

// ── 5. the absent-usage case ────────────────────────────────────────────────

// The real-world shape CI cannot reach. A live probe on 2026-08-05 confirmed
// generateContent DOES return usageMetadata for both the plain and
// responseSchema call shapes, with thoughtsTokenCount/cachedContentTokenCount
// simply absent when unused — so the `|| 0` guards are load-bearing and correct.
// This pins the no-usage branch anyway: it is how a recorded call site can still
// produce zero rows, which is the failure mode that looks identical to "nobody
// used the product".
test('a response with no usage block records nothing rather than a zero-cost row', async () => {
  const before = inserted.length;
  await costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', undefined);
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', null);
  assert.strictEqual(inserted.length, before,
    'a missing usage block must not write a row — a $0 row is indistinguishable from a free call');
});

test('absent optional token fields are treated as zero, not NaN', async () => {
  // Exactly the live shape: no thoughtsTokenCount, no cachedContentTokenCount.
  await costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, candidatesTokenCount: 1e6,
  });
  const row = lastRow();
  assert.strictEqual(Number(row.params[P.CENTS]), 280, '1M in @ $0.30 + 1M out @ $2.50');
  assert.strictEqual(Number(row.params[P.UNITS]), 2e6);
});

test('Gemini cached prompt tokens bill at a quarter of the input rate', async () => {
  // promptTokenCount INCLUDES the cached prefix, unlike Claude's input_tokens.
  await costs.recordGemini('t1', 'arena.turn', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, cachedContentTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const allCached = Number(lastRow().params[P.CENTS]);
  await costs.recordGemini('t1', 'arena.turn', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const noneCached = Number(lastRow().params[P.CENTS]);
  assert.strictEqual(allCached, 7.5, '1M fully-cached input at 0.25 × $0.30');
  assert.strictEqual(noneCached, 30);
  assert.ok(allCached < noneCached,
    'the whole purpose of gemini.js is context caching — billing it at full rate ' +
    'reports the Arena and global-KB paths at up to 4× their real cost');
});

test('Claude 1h cache writes bill at 2x, not the 5m 1.25x', async () => {
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', {
    cache_creation: { ephemeral_1h_input_tokens: 1e6 }, output_tokens: 0,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 600, '1M @ $3.00 × 2');
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', {
    cache_creation: { ephemeral_5m_input_tokens: 1e6 }, output_tokens: 0,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 375, '1M @ $3.00 × 1.25');
  // No split present → fall back to the 1h rate, over-reporting rather than under.
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', {
    cache_creation_input_tokens: 1e6, output_tokens: 0,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 600);
});

test('rollups exclude the smoke check without hiding unlabelled rows', async () => {
  // The clause that changes what the spend view shows, and the only one in
  // these queries that was unasserted. Deleting it silently fills the coverage
  // rollup with synthetic sites; writing it without the NULL guard silently
  // drops rows recorded through the bare record().
  for (const fn of [costs.rollupByTenant, costs.rollupBySite]) {
    await fn({ days: 30 });
    assert.match(lastSelect.text, /site NOT LIKE 'smoke\.%'/,
      'the live-schema smoke check is not product usage — its rows must not enter the rollups');
    assert.match(lastSelect.text, /site IS NULL OR/,
      "NULL NOT LIKE '...' is NULL, so an unlabelled row would fail the WHERE and disappear from " +
      'the very view that exists to show what is not being recorded');
  }
});

test('rollups surface how many rows could not be priced', async () => {
  await costs.rollupByTenant({ days: 30 });
  assert.match(lastSelect.text, /FILTER \(WHERE est_cost_cents IS NULL\)/,
    'COALESCE(SUM(...),0) turns "we could not price this" into "this was free" — ' +
    'the unpriced count is what keeps the two distinguishable');
  await costs.rollupBySite({ days: 30 });
  assert.match(lastSelect.text, /FILTER \(WHERE est_cost_cents IS NULL\)/);
  assert.match(lastSelect.text, /MIN\(created_at\)/,
    'without first_seen, a coverage change reads as a cost change');
});

test('a sub-day window falls back to 30 days rather than querying nothing', async () => {
  await costs.rollupByTenant({ days: 0.5 });
  assert.strictEqual(lastSelect.params[0], 30,
    "Math.floor(0.5) is 0, and '0 days' is a zero-length window that looks like a successful empty query");
});
