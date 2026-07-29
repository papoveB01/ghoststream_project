// Regression test for the 2026-07-29 fix to api/src/scheduler.js: brief
// generation and Recall.ai bot dispatch used to run serially under ONE
// shared `running` flag (briefs first, one mission at a time). A single
// hung Gemini call inside brief generation left that flag set forever, so
// NO briefs and — critically — NO bot dispatch ran for ANY tenant until the
// process was restarted. Bot dispatch is the phase with a paid engagement
// unit (~$1 Recall.ai bot) and a hard 5-minute dispatch window attached, so
// starving it behind a stuck brief call is an availability bug with a real
// cost/deadline attached, not just a cosmetic delay.
//
// The fix splits this into two INDEPENDENT guards (`briefRunning`,
// `botRunning`), each private to its own phase function (runBriefPhase /
// runBotPhase). Neither of those two functions — nor tick() itself, which
// fires both concurrently via Promise.allSettled — is exported by
// scheduler.js (module.exports = { start, tick, watchTick, purgeTick,
// findDueMissions, findMissionsDueForBot }). So this test drives both
// phases through the one reachable entry point, tick(), and distinguishes
// them by which stub (brief.generate vs dispatch.dispatchBot) gets called.
//
// Because tick() awaits Promise.allSettled([runBriefPhase(), runBotPhase()]),
// and this test needs the brief phase to hang FOREVER (simulating the
// original hung-Gemini-call trigger), tick()'s own returned promise never
// resolves either — so the test never `await`s tick() directly. It only
// awaits a promise that resolves when the bot-dispatch stub runs. A bare,
// never-resolving Promise (no timer/socket) doesn't keep Node's event loop
// alive, so the process still exits cleanly at the end of the run — the
// "stuck" state lives only in scheduler.js's own module-level flags, which
// die with the process.
//
// No Postgres/Redis available — every dependency scheduler.js requires
// (db, missions/brief, missions/dispatch, watch, watchSchedule, store,
// stream) is stubbed via require.cache. node-cron is left real: it's only
// ever invoked via schedule() inside start(), which this test never calls,
// so no timer is created.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// --- db stub: routes on SQL text. findDueMissions() (brief phase) selects
// status = 'PENDING'; findMissionsDueForBot() (bot phase) selects on
// recall_bot_id IS NULL. Each returns exactly one due row so every tick
// gives both phases real work to do. ------------------------------------
const dbCalls = { brief: 0, bot: 0 };
const dbStub = {
  async query(text) {
    if (text.includes('recall_bot_id IS NULL')) {
      dbCalls.bot += 1;
      return {
        rows: [{ id: 'mission-bot-1', tenant_id: 'tenant-1', scheduled_at: new Date().toISOString(), meeting_url: 'https://meet.google.com/abc-defg-hij' }],
      };
    }
    if (text.includes('FROM scheduled_meetings') && text.includes("status = 'PENDING'")) {
      dbCalls.brief += 1;
      return {
        rows: [{ id: 'mission-brief-1', tenant_id: 'tenant-1', scheduled_at: new Date().toISOString() }],
      };
    }
    return { rows: [] };
  },
};

// --- brief/dispatch stubs are mutable so each test can rig its own
// behavior; the module objects themselves are what's registered in
// require.cache, so mutating their methods between tests is safe. --------
const briefStub = { generate: async () => ({ briefId: 'unused', chunkCount: 0 }) };
const dispatchStub = { dispatchBot: async () => ({ botId: 'unused' }) };

stubModule('db', dbStub);
stubModule('missions/brief', briefStub);
stubModule('missions/dispatch', dispatchStub);
// Required at module scope by scheduler.js but not touched by tick()'s two
// phases — stub as inert objects so require() resolves without pulling in
// real db/redis/Recall/Cloudflare Stream connections.
stubModule('watch', {});
stubModule('watchSchedule', {});
stubModule('store', {});
stubModule('stream', {});

// Re-require scheduler.js fresh (its own module-level briefRunning/botRunning
// flags reset to false) so tests don't leak overlap state into each other.
function freshScheduler() {
  const p = require.resolve('../src/scheduler');
  delete require.cache[p];
  return require('../src/scheduler');
}

test('bot dispatch phase completes even while the brief phase is permanently hung (independent guards)', async () => {
  let briefCallCount = 0;
  briefStub.generate = () => {
    briefCallCount += 1;
    return new Promise(() => {}); // never resolves/rejects — simulates a hung Gemini call
  };

  let resolveDispatch;
  const dispatched = new Promise((resolve) => { resolveDispatch = resolve; });
  dispatchStub.dispatchBot = async (tenantId, missionId) => {
    resolveDispatch({ tenantId, missionId });
    return { alreadyDispatched: false, botId: 'bot-99' };
  };

  const scheduler = freshScheduler();

  // Fire-and-forget: tick() calls both phases concurrently. Its own returned
  // promise never settles (the brief phase inside it hangs forever), so we
  // deliberately do not await it.
  scheduler.tick();

  const call = await dispatched; // must resolve promptly if the guards are independent

  assert.strictEqual(call.missionId, 'mission-bot-1', 'the bot-dispatch phase must have run against the due mission');
  assert.strictEqual(briefCallCount, 1, 'sanity check: the brief phase was indeed started (and is now stuck)');
});

test('each phase still guards against an overlapping run of ITSELF', async () => {
  let briefCallCount = 0;
  briefStub.generate = () => {
    briefCallCount += 1;
    return new Promise(() => {}); // hangs forever, same as above
  };

  let dispatchCallCount = 0;
  let resolveDispatch;
  const dispatched = new Promise((resolve) => { resolveDispatch = resolve; });
  dispatchStub.dispatchBot = async (tenantId, missionId) => {
    dispatchCallCount += 1;
    resolveDispatch();
    return { alreadyDispatched: false, botId: `bot-${dispatchCallCount}` };
  };

  const scheduler = freshScheduler();

  // Two ticks fired back-to-back, synchronously, before either has a chance
  // to await anything: runBriefPhase()/runBotPhase() each set their own
  // `xRunning = true` synchronously before their first `await`, so the
  // SECOND tick's calls into both phases must see the flag already set and
  // return immediately without doing any work.
  scheduler.tick();
  scheduler.tick();

  await dispatched;
  // Let any remaining microtasks (e.g. a wrongly-unguarded second dispatch)
  // flush before asserting the final counts.
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(briefCallCount, 1, 'a second overlapping tick must not start a second brief-phase run while one is already in flight');
  assert.strictEqual(dispatchCallCount, 1, 'a second overlapping tick must not start a second bot-dispatch-phase run while one is already in flight');
});
