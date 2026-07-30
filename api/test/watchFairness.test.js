// Market Watch tick fairness.
//
// The due-entity query used to be "oldest due first, LIMIT 25" across every
// tenant, so a large backlog monopolised the tick until it drained. Measured at
// 200 due vs 2 due, the small tenant first ran at tick 9 — eight hours on the
// hourly cron. (Not indefinite: claimed entities are re-armed into the future
// while the waiting rows keep ageing, so they do climb the sort eventually.
// Permanent starvation needs a sustained due-rate above the 25/tick drain rate.)
// ROW_NUMBER() numbers each account's due entities by age and the outer ORDER BY
// takes rn first, interleaving them: everyone's oldest, then everyone's
// second-oldest, until the tick is full — so the small tenant runs in round one.
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
//        Under oldest-first the small tenant's entity is 51st and gets 0 rows.
//   1 tenant with 40 due, nobody else waiting
//     -> 25   (the tick is not throttled when there is no contention)
//   backlog drains: 100 due for one tenant + 31 tenants with 1 each, 40 ticks
//     -> all 100 ran, none starved, drained by tick 6; slots per tick for the
//        big tenant 1/18/25/25/25/6 as contention fell away
//   parent account with 5 sub-workspaces (6 tenant rows) x 40 due vs one solo
//   tenant x 40 due -> 13 vs 12. Partitioning on tenant_id alone gave 21 vs 4,
//   because sub-tenants are ordinary `tenants` rows and each earned its own
//   share — hence COALESCE(parent_tenant_id, tenant_id).
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

test('due entities are ranked within each BILLING ACCOUNT', async () => {
  await scheduler.watchTick();
  assert.ok(dueQuery, 'the tick queried for due entities');
  assert.match(dueQuery, /ROW_NUMBER\(\)\s*OVER\s*\(\s*PARTITION BY COALESCE\(q\.parent_tenant_id, q\.tenant_id\)/,
    'partition on the account, not the workspace — sub-tenants are ordinary tenants rows, so partitioning on tenant_id alone hands a parent one share per sub-workspace');
  assert.match(dueQuery, /t\.parent_tenant_id/,
    'parent_tenant_id must be selected on the union legs or the COALESCE silently sees NULL for everyone');
  assert.match(dueQuery, /ORDER BY q\.watch_next_run_at ASC NULLS FIRST, q\.id/,
    'within an account, oldest-due first, with a deterministic tie-break');
});

test('the tick interleaves by rank, so one account cannot monopolise it', async () => {
  await scheduler.watchTick();
  assert.match(dueQuery, /ORDER BY r\.rn ASC, r\.watch_next_run_at ASC NULLS FIRST, r\.id/,
    'rn must lead the outer sort — putting watch_next_run_at first restores the starvation bug; r.id keeps a tick reproducible when NULL next_run makes rn=1 rows tie');
  assert.match(dueQuery, /LIMIT 25/, 'the tick is still bounded');
});

test('there is no per-tenant cap: a lone tenant can still fill the tick', async () => {
  await scheduler.watchTick();
  assert.doesNotMatch(dueQuery, /\brn\s*<=/,
    'a WHERE rn <= N filter throttles unconditionally and leaves slots idle when nobody else is due');
});
