// Regression test for CRITICAL C3 (2026-07-29 code review): getGlobalText()
// used to take no tenant argument and returned the singleton cache — built
// exclusively from the Founders tenant's ORG_INTELLIGENCE + BATTLECARDS docs —
// unconditionally. Arena (arena.js) injects this text into the roleplay
// grounding for whatever tenant owns the portal, and Arena is a general Pro
// feature, not a Founders-only one. So every Pro tenant's practice session was
// grounded on the FOUNDERS company's battlecards, escalation paths and
// competitor punchlines — a cross-tenant leak (ADR-0001).
//
// The fix scopes getGlobalText(tenantId) to refuse any caller that isn't the
// Founders tenant, short-circuiting BEFORE the db is ever queried. These tests
// pin that behavior so a future edit (e.g. "just default tenantId if missing",
// or dropping the equality check) can't silently reopen the leak.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const FOUNDERS_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CACHE_TEXT = '# DealScope Company Intelligence\n\nFOUNDERS-ONLY battlecard punchlines and escalation paths.';

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// Track every db.query call so we can assert the guard short-circuits before
// any query is issued for a non-Founders caller.
const dbCalls = [];
stubModule('db.js', {
  query: async (sql, params) => {
    dbCalls.push({ sql, params });
    return { rows: [{ content_text: CACHE_TEXT }] };
  },
});
stubModule('users.js', { FOUNDERS_TENANT_ID });
// globalCache.js also requires '../gemini' (directly) and './assessment'
// (which requires '../gemini' too). gemini.js eager-connects a real ioredis
// client via './redis' at require time — stub that out so this test never
// tries to dial a Redis host that doesn't exist here.
stubModule('redis.js', { on: () => {}, get: async () => null, set: async () => 'OK', quit: async () => {}, disconnect: () => {} });

const globalCache = require('../src/knowledge/globalCache');

test('non-Founders tenant gets \'\' and the db is never queried (the ADR-0001 leak guard)', async () => {
  dbCalls.length = 0;
  const text = await globalCache.getGlobalText(OTHER_TENANT_ID);
  assert.strictEqual(text, '', 'a non-Founders tenant must never see the Founders cache text');
  assert.strictEqual(dbCalls.length, 0, 'the guard must short-circuit before querying the db — reverting it would leak Founders content on the very first read');
});

test('missing tenantId (undefined/null) gets \'\' and the db is never queried', async () => {
  dbCalls.length = 0;
  assert.strictEqual(await globalCache.getGlobalText(undefined), '');
  assert.strictEqual(await globalCache.getGlobalText(null), '');
  assert.strictEqual(dbCalls.length, 0, 'undefined/null must not fall through to a db read either');
});

test('the Founders tenant itself still gets the cache text (guard is scoped, not a blanket kill-switch)', async () => {
  dbCalls.length = 0;
  const text = await globalCache.getGlobalText(FOUNDERS_TENANT_ID);
  assert.strictEqual(text, CACHE_TEXT);
  assert.strictEqual(dbCalls.length, 1, 'the Founders caller is the one case that SHOULD hit the db');
});
