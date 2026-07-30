// Regression test for the Market Watch hourly burst.
//
// watchTick() claims up to 25 due entities per tick. It used to fire
// watch.runEntityScheduled(e) for every one of them WITHOUT awaiting —
// fire-and-forget — so all 25 research pipelines started within milliseconds of
// each other. Each pipeline makes ~6 search calls (internally capped at 4
// concurrent by discovery.gatherFromQueries, "bounded so we don't hammer the
// search API"), scrapes 3 pages in parallel, and makes a Gemini call. At 25 in
// flight that is ~100 concurrent searches and ~75 concurrent scrapes on the
// hour, every hour — which defeats the very per-entity cap that exists to
// prevent it, and trips provider rate limits that watch.withRetry then retries
// into, amplifying the burst.
//
// The fix runs the claimed entities through a bounded worker pool
// (WATCH_CONCURRENCY, default 4) and AWAITS it, which additionally makes the
// module-level watchRunning guard meaningful: an overrunning pass can no longer
// stack a second copy of itself.
//
// No Postgres — db is stubbed via require.cache, routing on SQL text. Every
// other scheduler.js dependency is stubbed inert. node-cron is left real but
// never armed (start() is not called), so no timer is created.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const DUE_COUNT = 25;
const EXPECTED_CONCURRENCY = 4; // scheduler.js WATCH_CONCURRENCY default

const dbCalls = { select: 0, claim: 0 };
const dbStub = {
  async query(text, params) {
    if (text.includes('watch_enabled')) {
      dbCalls.select += 1;
      return {
        rows: Array.from({ length: DUE_COUNT }, (_, i) => ({
          scope: i % 2 ? 'COMPETITOR' : 'PROSPECT',
          id: `entity-${i}`,
          name: `Entity ${i}`,
          watch_frequency: 'weekly', watch_day: 1, watch_timezone: 'UTC',
          watch_email_digest: false, watch_next_run_at: null,
          tenant_id: 'tenant-1', plan: 'pro', plan_version: 2,
          subscription_status: 'ACTIVE', trial_ends_at: null, current_period_end: null,
        })),
      };
    }
    if (text.includes('SET watch_next_run_at')) {
      dbCalls.claim += 1;
      assert.ok(params && params.length === 3, 'claim UPDATE binds (id, tenant_id, nextRun)');
      return { rows: [] };
    }
    return { rows: [] };
  },
};

// Records how many runs overlap, and settles only when released — so the test
// controls exactly when a "research pipeline" finishes.
const runs = { started: 0, live: 0, peak: 0, finished: 0, release: [] };
const watchStub = {
  async runEntityScheduled() {
    runs.started += 1;
    runs.live += 1;
    runs.peak = Math.max(runs.peak, runs.live);
    await new Promise((resolve) => runs.release.push(resolve));
    runs.live -= 1;
    runs.finished += 1;
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

// Let queued microtasks drain so every worker that CAN start has started.
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test('watchTick runs due entities through a bounded pool, not all at once', async () => {
  const tick = scheduler.watchTick();

  await settle();
  assert.strictEqual(dbCalls.select, 1, 'one due-entity query per tick');
  assert.strictEqual(dbCalls.claim, DUE_COUNT, 'every due entity is claimed up-front, before any work starts');
  assert.strictEqual(runs.started, EXPECTED_CONCURRENCY,
    `only ${EXPECTED_CONCURRENCY} entities may be in flight at once (was ${DUE_COUNT} with fire-and-forget)`);

  // Drain: each completion admits exactly one more, never more than the cap.
  while (runs.finished < DUE_COUNT) {
    const next = runs.release.shift();
    assert.ok(next, 'a queued run should always be available until all have finished');
    next();
    await settle();
    assert.ok(runs.live <= EXPECTED_CONCURRENCY,
      `concurrency must never exceed ${EXPECTED_CONCURRENCY} (saw ${runs.live})`);
  }

  await tick;
  assert.strictEqual(runs.finished, DUE_COUNT, 'every claimed entity still runs — the pool throttles, it does not drop work');
  assert.strictEqual(runs.peak, EXPECTED_CONCURRENCY, 'peak concurrency equals the cap');
});

test('watchTick awaits the pool, so an overrunning pass cannot stack a second one', async () => {
  Object.assign(runs, { started: 0, live: 0, peak: 0, finished: 0, release: [] });
  dbCalls.select = 0;

  const first = scheduler.watchTick();
  await settle();
  assert.strictEqual(runs.started, EXPECTED_CONCURRENCY, 'first tick is mid-flight');

  // Second tick fires while the first is still working (hourly cron, slow pass).
  await scheduler.watchTick();
  assert.strictEqual(dbCalls.select, 1,
    'the watchRunning guard blocks the overlapping tick — it never even queries for due entities');

  while (runs.finished < DUE_COUNT) {
    const next = runs.release.shift();
    if (!next) { await settle(); continue; }
    next();
    await settle();
  }
  await first;
});
