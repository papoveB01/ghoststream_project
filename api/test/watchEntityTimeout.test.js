// Regression test for the guard-wedge introduced when watchTick started
// awaiting its worker pool.
//
// Awaiting the pool is what makes the module-level `watchRunning` guard
// meaningful — but it also means an entity whose promise never settles holds
// that guard for the life of the process, and NOTHING in the path is
// time-bounded: gemini.js builds GoogleGenAI with no httpOptions.timeout, so a
// hung generateContent never returns. Unbounded, one stuck entity silently
// stops Market Watch for every tenant on the box until a restart — the same
// failure shape as the briefRunning incident in schedulerPhases.test.js.
//
// WATCH_ENTITY_TIMEOUT_MS bounds how long the pool WAITS (it cannot cancel the
// underlying call — the hung promise still dangles, exactly as it did under the
// old fire-and-forget loop). What matters is that the worker moves on, the pool
// resolves, and `finally` releases the guard.
//
// The timeout is driven down to 1s via env (the configured floor) so the test
// doesn't sit through the 10-minute production default.

'use strict';

process.env.WATCH_ENTITY_TIMEOUT_MS = '1000';
process.env.WATCH_CONCURRENCY = '2';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const DUE = 3;
const dbStub = {
  async query(text) {
    if (text.includes('watch_enabled')) {
      return {
        rows: Array.from({ length: DUE }, (_, i) => ({
          scope: 'PROSPECT', id: `entity-${i}`, name: `Entity ${i}`,
          watch_frequency: 'weekly', watch_day: 1, watch_timezone: 'UTC',
          watch_email_digest: false, watch_next_run_at: null,
          tenant_id: 'tenant-1', plan: 'pro', plan_version: 2,
          subscription_status: 'ACTIVE', trial_ends_at: null, current_period_end: null,
        })),
      };
    }
    return { rows: [] };
  },
};

// entity-0 hangs forever (the stuck Gemini call). The others resolve normally.
const seen = [];
const watchStub = {
  async runEntityScheduled(e) {
    seen.push(e.id);
    if (e.id === 'entity-0') return new Promise(() => {}); // never settles
    return { newCount: 0 };
  },
};

stubModule('db', dbStub);
stubModule('watch', watchStub);
stubModule('watchSchedule', { nextRunISO: () => '2026-08-01T00:00:00.000Z' });
stubModule('missions/brief', { generate: async () => ({}) });
stubModule('missions/dispatch', { dispatchBot: async () => ({}) });
stubModule('store', {});
stubModule('stream', {});

const scheduler = require('../src/scheduler');

test('a hung entity cannot wedge the watch guard: the tick still completes', async () => {
  const started = Date.now();
  // Unbounded, this await would never return and every later tick would be a
  // no-op for the life of the process.
  await scheduler.watchTick();
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 1000, `should have waited out the timeout (waited ${elapsed}ms)`);
  assert.ok(elapsed < 8000, `should not have waited far beyond it (waited ${elapsed}ms)`);
  assert.deepStrictEqual(seen.sort(), ['entity-0', 'entity-1', 'entity-2'],
    'the healthy entities still run — the timeout is per-entity, not per-pool');
});

test('the guard is released, so the NEXT tick still does work', async () => {
  seen.length = 0;
  await scheduler.watchTick();
  assert.strictEqual(seen.length, DUE,
    'a second tick after a hung entity must still query and run — this is the whole point');
});
