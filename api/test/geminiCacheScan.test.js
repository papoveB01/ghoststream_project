// Regression test for the 2026-07-29 fix to api/src/gemini.js
// (listCachedRecords / invalidate): both used to call redis.keys(pattern) to
// find registry / skip-flag entries. KEYS walks the ENTIRE keyspace
// regardless of pattern and blocks the single-threaded Redis server while it
// does — and this is the same Redis that holds sessions, login-guard
// counters and device-OTP challenges, so every cache invalidation stalled
// auth and rate-limit lookups platform-wide. The fix (scanKeys(), backed by
// redis.scanStream) never blocks: it walks the keyspace in small cursor
// batches.
//
// This test asserts two things per function:
//   1. redis.keys() is never called (it throws if it is, so any regression
//      to KEYS fails loudly instead of just "still passing, coincidentally").
//   2. redis.scanStream() IS used, and — the realistic way a "SCAN" fix
//      regresses — its results are correctly assembled across MULTIPLE
//      cursor batches, not just the first one. A cursor bug that resolves
//      early (e.g. on the first 'data' event instead of accumulating until
//      'end') would silently drop later batches.
//
// No Postgres/Redis available — redis is faked entirely in-memory via
// require.cache before gemini.js loads. gemini.js's other import, the real
// @google/genai SDK, is left un-stubbed: it does no eager network/connection
// work at require time (verified: constructing GoogleGenAI happens lazily
// inside getClient(), which neither function under test reaches on the code
// paths exercised here).

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// --- fake Redis --------------------------------------------------------
// - keys(): throws. If either function under test still calls it, the test
//   fails immediately with a clear message instead of silently "working".
// - scanStream(): returns an EventEmitter that emits 'data' with the
//   configured batches (plural!) for the given match pattern, one batch per
//   tick, then 'end'. This exercises real multi-batch cursor accumulation
//   rather than a single round-trip.
// - get/mget/del operate over a plain in-memory Map, like the other fakes in
//   this suite.
function makeFakeRedis({ scanBatches = {} } = {}) {
  const store = new Map();
  const calls = { keys: 0, scanStream: [], get: [], mget: [], del: [] };
  return {
    store,
    calls,
    keys() {
      calls.keys += 1;
      throw new Error(
        'redis.keys() must never be called from gemini.js — it blocks the single-threaded ' +
        'server for every caller (sessions, login-guard, device OTP) while it scans the ' +
        'entire keyspace. Use scanStream() instead.'
      );
    },
    scanStream({ match }) {
      calls.scanStream.push(match);
      const em = new EventEmitter();
      const batches = (scanBatches[match] || []).map((b) => b.slice());
      setImmediate(function emitNext() {
        if (batches.length === 0) { em.emit('end'); return; }
        em.emit('data', batches.shift());
        setImmediate(emitNext);
      });
      return em;
    },
    async get(key) {
      calls.get.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async mget(keys) {
      calls.mget.push(keys.slice());
      return keys.map((k) => (store.has(k) ? store.get(k) : null));
    },
    async del(...keys) {
      const flat = keys.flat();
      calls.del.push(flat);
      let n = 0;
      for (const k of flat) { if (store.delete(k)) n += 1; }
      return n;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
  };
}

test('listCachedRecords() uses scanStream (never keys()) and assembles results across MULTIPLE scan batches', async () => {
  const fakeRedis = makeFakeRedis({
    scanBatches: {
      'gemini:cache:*': [
        ['gemini:cache:persona-a', 'gemini:cache:persona-b'], // batch 1
        ['gemini:cache:persona-c'],                            // batch 2 — dropped by a cursor bug
      ],
    },
  });
  fakeRedis.store.set('gemini:cache:persona-a', JSON.stringify({ mode: 'cached', name: 'persona-a', cacheName: 'cachedContents/aaa' }));
  fakeRedis.store.set('gemini:cache:persona-b', JSON.stringify({ mode: 'cached', name: 'persona-b', cacheName: 'cachedContents/bbb' }));
  fakeRedis.store.set('gemini:cache:persona-c', JSON.stringify({ mode: 'inline', name: 'persona-c', reason: 'too small' }));

  stubModule('redis', fakeRedis);
  delete require.cache[require.resolve('../src/gemini')];
  const gemini = require('../src/gemini');

  const records = await gemini.listCachedRecords();

  assert.strictEqual(fakeRedis.calls.keys, 0, 'listCachedRecords() must never call redis.keys()');
  assert.ok(fakeRedis.calls.scanStream.includes('gemini:cache:*'), 'listCachedRecords() must scan with the registry prefix pattern');

  const names = records.map((r) => r.name).sort();
  assert.deepStrictEqual(
    names,
    ['persona-a', 'persona-b', 'persona-c'],
    'all three records must be present — persona-c only arrives in the SECOND scan batch, so a cursor ' +
    'bug that resolves after the first \'data\' event instead of accumulating until \'end\' would drop it'
  );
});

test('invalidate() uses scanStream (never keys()) and deletes skip-flag keys collected across MULTIPLE scan batches', async () => {
  const fakeRedis = makeFakeRedis({
    scanBatches: {
      'gemini:cache-skip:persona-x:*': [
        ['gemini:cache-skip:persona-x:hash1'], // batch 1
        ['gemini:cache-skip:persona-x:hash2'], // batch 2 — dropped by a cursor bug
      ],
    },
  });
  fakeRedis.store.set('gemini:cache:persona-x', JSON.stringify({ mode: 'inline', name: 'persona-x', reason: 'RESOURCE_EXHAUSTED' }));
  fakeRedis.store.set('gemini:cache-skip:persona-x:hash1', 'RESOURCE_EXHAUSTED');
  fakeRedis.store.set('gemini:cache-skip:persona-x:hash2', 'RESOURCE_EXHAUSTED');

  stubModule('redis', fakeRedis);
  delete require.cache[require.resolve('../src/gemini')];
  const gemini = require('../src/gemini');

  const result = await gemini.invalidate('persona-x');

  assert.strictEqual(result, true, 'invalidate() should report success for a name that had a registry entry');
  assert.strictEqual(fakeRedis.calls.keys, 0, 'invalidate() must never call redis.keys()');
  assert.ok(fakeRedis.calls.scanStream.includes('gemini:cache-skip:persona-x:*'), 'invalidate() must scan for skip-flag keys using the name-scoped pattern');

  const delCallWithBoth = fakeRedis.calls.del.find(
    (batch) => batch.includes('gemini:cache-skip:persona-x:hash1') && batch.includes('gemini:cache-skip:persona-x:hash2')
  );
  assert.ok(
    delCallWithBoth,
    'both skip-flag keys (one from each scan batch) must be passed to redis.del() together — if only ' +
    'hash1 shows up, the scan is dropping the second batch'
  );
  assert.strictEqual(fakeRedis.store.has('gemini:cache:persona-x'), false, 'the registry key itself must be deleted');
});
