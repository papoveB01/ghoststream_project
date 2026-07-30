// Market Watch tick fairness.
//
// The due-entity query used to be "oldest due first, LIMIT 25" across every
// tenant. A tenant with a large backlog filled the whole tick and kept filling
// it, because its un-run entities stay as old as the ones just run — so a tenant
// watching two things could wait indefinitely behind a tenant watching two
// hundred. ROW_NUMBER() numbers each tenant's due entities by age and the outer
// ORDER BY takes rn first, interleaving them: everyone's oldest, then everyone's
// second-oldest, until the tick is full.
//
// Ordering, NOT a per-tenant cap. A cap throttles unconditionally — it leaves
// slots idle when nobody else is waiting and lowers a large tenant's achievable
// cadence on an otherwise quiet platform. Interleaving binds only under
// contention.
//
// No Postgres in CI (rules/commands.md), so the row-level behaviour was verified
// directly against Postgres 16 with seeded rows in rolled-back transactions:
//
//   5 tenants x 10 due entities (all older) + 1 tenant with a single NEWER entity
//     -> Big1..Big4: 5 each, Big5: 4, SmallCo: 1   (25/25 slots used)
//        Under oldest-first the small tenant's entity is 51st and never runs;
//        under the earlier per-tenant cap it measured 0.
//   1 tenant with 40 due, nobody else waiting
//     -> 25   (the tick is not throttled when there is no contention)
//
// What this file locks is the part JS owns: that the interleaving ordering is
// actually in the SQL and hasn't been reverted to a global sort.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

let dueQuery = null;
stubModule('db', {
  async query(text) {
    if (text.includes('watch_enabled')) { dueQuery = text; return { rows: [] }; }
    return { rows: [] };
  },
});
stubModule('watch', { runEntityScheduled: async () => ({ newCount: 0 }) });
stubModule('watchSchedule', { nextRunISO: () => '2026-08-01T00:00:00.000Z' });
stubModule('missions/brief', { generate: async () => ({}) });
stubModule('missions/dispatch', { dispatchBot: async () => ({}) });
stubModule('store', {});
stubModule('stream', {});

const scheduler = require('../src/scheduler');

test('due entities are ranked within each tenant', async () => {
  await scheduler.watchTick();
  assert.ok(dueQuery, 'the tick queried for due entities');
  assert.match(dueQuery, /ROW_NUMBER\(\)\s*OVER\s*\(\s*PARTITION BY q\.tenant_id/,
    'ranking must be per tenant — without the partition there is nothing to interleave');
  assert.match(dueQuery, /ORDER BY q\.watch_next_run_at ASC NULLS FIRST, q\.id/,
    'within a tenant, oldest-due first, with a deterministic tie-break');
});

test('the tick interleaves by rank, so one tenant cannot monopolise it', async () => {
  await scheduler.watchTick();
  assert.match(dueQuery, /ORDER BY r\.rn ASC, r\.watch_next_run_at ASC NULLS FIRST/,
    'rn must lead the outer sort — putting watch_next_run_at first restores the starvation bug');
});

test('there is no per-tenant cap: a lone tenant can still fill the tick', async () => {
  await scheduler.watchTick();
  assert.doesNotMatch(dueQuery, /\brn\s*<=/,
    'a WHERE rn <= N filter throttles unconditionally and leaves slots idle when nobody else is due');
});
