// Regression test for a finding from the 2026-07-29 code review in
// api/src/missions/dispatch.js, dispatchBot().
//
// Defect: idempotency used to be pure check-then-act — read
// mission.recall_bot_id, then act on what was read — with nothing claiming
// the row in between. A rep clicking "send bot now" at the same moment the
// per-minute cron tick fired both read recall_bot_id = NULL and both went on
// to call recall.createBot: two ~$1 Recall.ai bots joined the customer's
// meeting for one engagement.
//
// The fix claims the row FIRST with a single atomic conditional UPDATE
// (claimForDispatch, sentinel value 'dispatching') before ever calling
// Recall; a caller that loses the race gets `raced: true` back and never
// touches Recall. If dispatch fails after a successful claim, clearClaim()
// resets the sentinel back to NULL so a later retry (including the next
// cron tick) isn't permanently locked out.
//
// Node's built-in test runner only (node:test + node:assert) — no Postgres,
// no Redis. Every collaborator dispatch.js touches is stubbed; `db` and
// `recall` push into a single shared `calls` log so call ORDER can be
// asserted, not just call presence.

'use strict';

const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.RECALL_AI_API_KEY = process.env.RECALL_AI_API_KEY || 'test-recall-key';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.test.local';

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// Shared call log, in call order, across every stubbed collaborator —
// {fn, ...}. Reset before each test.
let calls = [];

// The one "row" the claim/clear queries mutate. Kept separate from
// `missionFixture.recall_bot_id` (which is what service.get() hands back)
// exactly like the real system has two read paths onto the same underlying
// scheduled_meetings row.
let row;
// Whether the next claimForDispatch UPDATE should "win" (rowCount 1) or
// lose the race (rowCount 0) — set per test.
let claimShouldSucceed;
// Whether recall.createBot() should throw on the next call.
let recallShouldThrow;

let missionFixture;

stubModule('db.js', {
  query: async (sql, params) => {
    const s = norm(sql);
    calls.push({ fn: 'db.query', sql: s, params });

    if (s.includes("SET recall_bot_id = 'dispatching'") && s.includes('RETURNING id')) {
      // claimForDispatch()
      if (claimShouldSucceed) {
        row.recall_bot_id = 'dispatching';
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (s.includes('SET recall_bot_id = NULL') && s.includes("AND recall_bot_id = 'dispatching'")) {
      // clearClaim() — guarded the same way the real SQL guards it.
      if (row.recall_bot_id === 'dispatching') {
        row.recall_bot_id = null;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }
    throw new Error(`missionDispatch.test.js: unstubbed db query: ${s}`);
  },
});

stubModule('recall.js', {
  createBot: async (opts) => {
    calls.push({ fn: 'recall.createBot', opts });
    if (recallShouldThrow) {
      const e = new Error('recall rejected the bot');
      throw e;
    }
    return { id: 'bot-123', status_changes: [{ code: 'joining_call' }] };
  },
});

stubModule('costs.js', {
  recordRecallDispatch: (...args) => { calls.push({ fn: 'costs.recordRecallDispatch', args }); },
});

stubModule('store.js', {
  createMeeting: async (data) => {
    calls.push({ fn: 'store.createMeeting', data });
    return { id: 'meeting-1', meta: data.meta };
  },
  updateMeeting: async (id, patch) => {
    calls.push({ fn: 'store.updateMeeting', id, patch });
    return { id, ...patch };
  },
});

stubModule('missions/service.js', {
  get: async (tenantId, id) => {
    calls.push({ fn: 'service.get', tenantId, id });
    return missionFixture;
  },
  setRecallBotId: async (tenantId, id, botId) => {
    calls.push({ fn: 'service.setRecallBotId', tenantId, id, botId });
    missionFixture.recall_bot_id = botId;
  },
});

stubModule('integrations.js', {
  resolveMeetingUrl: async (u) => u,
});

stubModule('recordingSettings.js', {
  get: async () => ({ videoEnabled: true }),
  noticeMessageFor: () => 'This meeting is being recorded.',
});

const { dispatchBot } = require('../src/missions/dispatch');

beforeEach(() => {
  calls = [];
  row = { recall_bot_id: null };
  claimShouldSucceed = true;
  recallShouldThrow = false;
  missionFixture = {
    id: 'mission-1',
    tenant_id: 'tenant-1',
    recall_bot_id: null,
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    company_id: 'company-1',
  };
});

// (a) ORDER matters. Reverting the fix to plain check-then-act would still
// call both db.query (to read, not claim) and recall.createBot, so a test
// that only checked "both happened" would not catch a regression — it must
// check that the CLAIM update is issued before createBot is ever reached.
test('dispatchBot claims the row (atomic UPDATE) before ever calling recall.createBot', async () => {
  const result = await dispatchBot('tenant-1', 'mission-1', {});
  assert.strictEqual(result.alreadyDispatched, false);
  assert.strictEqual(result.botId, 'bot-123');

  const claimIndex = calls.findIndex((c) => c.fn === 'db.query' && c.sql.includes("SET recall_bot_id = 'dispatching'"));
  const createBotIndex = calls.findIndex((c) => c.fn === 'recall.createBot');
  assert.notStrictEqual(claimIndex, -1, 'expected a claim UPDATE to have run');
  assert.notStrictEqual(createBotIndex, -1, 'expected recall.createBot to have run');
  assert.ok(claimIndex < createBotIndex, `claim (index ${claimIndex}) must happen before createBot (index ${createBotIndex})`);
});

// (b) Lost race: claimForDispatch returns 0 rows (another caller — the cron,
// another click — already claimed it). Reverting the fix (check-then-act,
// no claim at all) would let this call reach recall.createBot regardless —
// this assertion is exactly what would have caught the double-bot bug.
test('dispatchBot never calls recall.createBot when the claim is lost, and reports already-dispatched', async () => {
  claimShouldSucceed = false;
  const result = await dispatchBot('tenant-1', 'mission-1', {});
  assert.strictEqual(result.alreadyDispatched, true);
  assert.strictEqual(result.raced, true);

  const createBotCalls = calls.filter((c) => c.fn === 'recall.createBot');
  assert.strictEqual(createBotCalls.length, 0, 'createBot must never be called after losing the claim race');
});

// (c) Claim succeeds, then something downstream throws (Recall itself
// rejects the bot). The sentinel must be cleared back to NULL so a later
// retry (a re-click, or the next cron tick) can still claim and dispatch —
// otherwise a mission that failed once would be stuck under the
// 'dispatching' sentinel forever.
test('dispatchBot clears the dispatching sentinel on failure so a later retry can run', async () => {
  recallShouldThrow = true;
  await assert.rejects(dispatchBot('tenant-1', 'mission-1', {}), (err) => {
    assert.strictEqual(err.code, 'RECALL_DISPATCH_FAILED');
    return true;
  });

  // Sentinel released: the row is back to NULL, not stuck at 'dispatching'.
  assert.strictEqual(row.recall_bot_id, null);
  const clearCalls = calls.filter((c) => c.fn === 'db.query' && c.sql.includes('SET recall_bot_id = NULL'));
  assert.strictEqual(clearCalls.length, 1, 'expected clearClaim to have run exactly once');

  // Retry proves it in practice: a second dispatch call, now that recall
  // stops throwing, must be able to claim and succeed rather than being
  // told it's already/still dispatching.
  recallShouldThrow = false;
  const retryCalls = calls.length;
  const retryResult = await dispatchBot('tenant-1', 'mission-1', {});
  assert.strictEqual(retryResult.alreadyDispatched, false);
  assert.strictEqual(retryResult.botId, 'bot-123');
  const createBotCallsAfterRetry = calls.slice(retryCalls).filter((c) => c.fn === 'recall.createBot');
  assert.strictEqual(createBotCallsAfterRetry.length, 1, 'the retry should be the one and only successful createBot call');
});
