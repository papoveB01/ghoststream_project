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

test('[TEXTUAL] every model call site sits in a file that records spend', () => {
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const calls = (src.match(/models\.generateContent\(\{/g) || []).length;
    if (calls === 0) continue;
    const records = (src.match(/costs\.recordGemini\(/g) || []).length;
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

test('[TEXTUAL] the recorded site labels are unique and namespaced', () => {
  const labels = [];
  for (const file of walkJs(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/costs\.recordGemini\([^,]+,\s*'([^']+)'/g)) labels.push(m[1]);
  }
  assert.ok(labels.length >= 25, `expected the full call-site sweep to be instrumented, found ${labels.length}`);
  for (const l of labels) {
    assert.match(l, /^[a-z][a-zA-Z]*\.[a-zA-Z]+$/, `site label '${l}' should read '<area>.<operation>'`);
  }
  assert.strictEqual(new Set(labels).size, labels.length,
    'two call sites sharing a label make their costs indistinguishable in the rollup');
});

// ── 2. Claude usage accounting ──────────────────────────────────────────────

test('recordClaude bills fresh, cache-write and cache-read input at their own rates', async () => {
  // Sonnet 5: $3/MTok in, $15/MTok out → 300 / 1500 cents per MTok.
  // 1M fresh + 1M cache-write + 1M cache-read + 1M out
  //   = 300 + (300 × 1.25) + (300 × 0.1) + 1500 = 2205 cents.
  await costs.recordClaude('t1', 'analysis.moments', 'claude-sonnet-5', {
    input_tokens: 1e6,
    cache_creation_input_tokens: 1e6,
    cache_read_input_tokens: 1e6,
    output_tokens: 1e6,
  });
  const row = lastRow();
  assert.strictEqual(row.params[P.SERVICE], 'claude');
  assert.strictEqual(Number(row.params[P.CENTS]), 2205);
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
  await assert.doesNotReject(
    () => costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', { promptTokenCount: 1 }),
    'record() is fire-and-forget — a telemetry outage must not fail the action it observes'
  );
  require.cache[dbFull].exports.query = good;
});
