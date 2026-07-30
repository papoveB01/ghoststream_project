// Market Watch tick fairness + the dedupe window knobs.
//
// The due-entity query used to be a flat "oldest due first, LIMIT 25" across
// every tenant, so one tenant watching many entities could occupy whole ticks
// and push everyone else's schedule back indefinitely — at 25 runs/hour
// platform-wide that starves the small tenants first. A ROW_NUMBER() partition
// caps each tenant's share of a tick.
//
// There is no Postgres in CI (rules/commands.md), so the row-level behaviour of
// that window function cannot be asserted here — it was verified directly
// against Postgres with seeded data inside a rolled-back transaction: a tenant
// with 8 due entities was capped to 3 while a tenant with 2 kept both, and the
// oldest-due ordering was preserved. What this file locks is the contract JS
// owns: that the partition is actually in the SQL, and that both bounds are
// driven by the env knobs rather than hardcoded again.

'use strict';

process.env.WATCH_TICK_LIMIT = '11';
process.env.WATCH_PER_TENANT_MAX = '3';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

let dueQuery = null;
let dueParams = null;
const dbStub = {
  async query(text, params) {
    if (text.includes('watch_enabled')) {
      dueQuery = text;
      dueParams = params;
      return { rows: [] }; // nothing due — the tick returns before doing work
    }
    return { rows: [] };
  },
};

stubModule('db', dbStub);
stubModule('watch', { runEntityScheduled: async () => ({ newCount: 0 }) });
stubModule('watchSchedule', { nextRunISO: () => '2026-08-01T00:00:00.000Z' });
stubModule('missions/brief', { generate: async () => ({}) });
stubModule('missions/dispatch', { dispatchBot: async () => ({}) });
stubModule('store', {});
stubModule('stream', {});

const scheduler = require('../src/scheduler');

test('the due query caps each tenant\'s share of a tick', async () => {
  await scheduler.watchTick();
  assert.ok(dueQuery, 'the tick queried for due entities');

  assert.match(dueQuery, /ROW_NUMBER\(\)\s*OVER\s*\(\s*PARTITION BY q\.tenant_id/,
    'entities must be ranked WITHIN each tenant — a global ORDER BY lets one tenant take the whole tick');
  assert.match(dueQuery, /WHERE r\.rn <= \$1/, 'the per-tenant rank must actually be filtered on');
  assert.match(dueQuery, /ORDER BY r\.watch_next_run_at ASC NULLS FIRST/,
    'oldest-due still wins across tenants, so a skipped entity is first in line next tick');
});

test('both bounds come from env, so throughput can be raised without a code change', async () => {
  await scheduler.watchTick();
  assert.deepStrictEqual(dueParams, [3, 11],
    'params are [WATCH_PER_TENANT_MAX, WATCH_TICK_LIMIT] as configured above');
});

test('the limits are not hardcoded anywhere in the query text', async () => {
  await scheduler.watchTick();
  assert.doesNotMatch(dueQuery, /LIMIT\s+25/, 'the old hardcoded LIMIT 25 must be gone');
  assert.match(dueQuery, /LIMIT \$2/, 'the tick limit is bound, not literal');
});
