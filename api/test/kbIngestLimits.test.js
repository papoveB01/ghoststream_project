// Regression test for the KB ingest chunk-count ceiling (2026-07-29 code
// review). Before this fix, service.ingest() had no chunk-count ceiling: a
// 25MB .txt file chunks into ~512-token windows regardless of encoding
// overhead, so it could yield ~13,000 chunks — each one a Gemini embed call
// PLUS a per-row INSERT, all held inside a single transaction on one open
// HTTP request. MAX_CHUNKS now rejects right after chunking (cheapest point
// to bail) and strictly BEFORE any embedding spend.
//
// These tests exercise the real ingest() pipeline (parse -> hash -> chunk ->
// [MAX_CHUNKS check] -> embed), stubbing only the network/db-facing modules
// (db, r2, embeddings, keypoints, assessment, relevance, globalCache, users)
// so it runs fully offline. embeddings.embedAll is a spy that (a) records
// whether it was called and (b) throws a distinctive sentinel error if it
// IS called, so a chunk set that clears the ceiling still can't proceed all
// the way into db/R2 work inside this test — we only need to prove the
// guard let it PAST the chunk check, not that the rest of ingest succeeds.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const FOUNDERS_TENANT_ID = '00000000-0000-0000-0000-000000000001';

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// Ceiling under test — keep it tiny so the fixture text stays tiny too.
process.env.KB_MAX_CHUNKS = '3';

const embedCalls = [];
const EMBED_SENTINEL = new Error('EMBED_SENTINEL: embedAll was reached');

stubModule('db.js', {
  query: async () => ({ rows: [] }),
  withTx: async () => { throw new Error('withTx should not be reached in these tests'); },
});
// parsers.js -> ocr.js -> ../gemini -> ./redis (the top-level ioredis client,
// eager-connecting on require). Nothing in these tests exercises OCR/Gemini,
// but requiring service.js pulls that whole chain in transitively, and a real
// redis client would spin forever retrying a connection that doesn't exist
// here. Stub it out at the source.
stubModule('redis.js', { on: () => {}, get: async () => null, set: async () => 'OK', quit: async () => {}, disconnect: () => {} });
stubModule('knowledge/r2.js', {
  isConfigured: () => false,
  buildKey: () => '',
  putObject: async () => {},
  deleteObject: async () => {},
  presignGet: async () => null,
});
stubModule('knowledge/embeddings.js', {
  embedAll: async (texts) => {
    embedCalls.push(texts);
    throw EMBED_SENTINEL;
  },
  embedQuery: async () => { throw new Error('not used in these tests'); },
  MODEL: 'test-embed-model',
  DIMENSIONS: 768,
});
stubModule('knowledge/keypoints.js', {
  kindFor: () => 'points',
  extractKeyPoints: async () => ({ kind: 'points', points: [] }),
  extractCompanyAnalysis: async () => null,
  extractProductAnalysis: async () => null,
});
stubModule('knowledge/assessment.js', {
  extractCompetitiveAssessment: async () => null,
  renderAssessmentText: () => '',
});
stubModule('knowledge/relevance.js', {
  checkDocRelevance: async () => null,
  shouldQuarantine: () => false,
});
stubModule('knowledge/globalCache.js', {
  rebuildGlobalCache: async () => {},
  getGlobalText: async () => '',
  getRow: async () => null,
  CACHE_NAME: 'kb:global',
  GLOBAL_CATEGORIES: ['ORG_INTELLIGENCE', 'BATTLECARDS'],
});
stubModule('knowledge/web.js', { isConfigured: () => false, isBraveConfigured: () => false });
stubModule('knowledge/social.js', { isConfigured: () => false });
stubModule('users.js', { FOUNDERS_TENANT_ID });

const service = require('../src/knowledge/service');

// A .txt file whose text chunks (at the default 512-token / 50-token-overlap
// settings) into more than MAX_CHUNKS=3 windows. Repeating a many-token
// sentence is a cheap way to blow past a few thousand tokens without a huge
// literal fixture.
function makeFile(paragraphCount) {
  const paragraph = 'DealScope regression fixture sentence used purely to pad the token count of this synthetic upload. '.repeat(20);
  const text = Array.from({ length: paragraphCount }, () => paragraph).join('\n\n');
  return {
    buffer: Buffer.from(text, 'utf8'),
    originalname: 'big-upload.txt',
    mimetype: 'text/plain',
  };
}

test('a document producing more chunks than MAX_CHUNKS is rejected with status 413 and embeddings is never called', async () => {
  embedCalls.length = 0;
  const file = makeFile(40); // comfortably over the 3-chunk ceiling
  await assert.rejects(
    () => service.ingest({ tenantId: FOUNDERS_TENANT_ID, file, category: 'ORG_INTELLIGENCE', title: 'Oversized doc' }),
    (err) => {
      assert.strictEqual(err.status, 413, 'must reject with 413, not fall through to embedding/db work');
      assert.match(err.message, /chunk/i);
      return true;
    }
  );
  assert.strictEqual(embedCalls.length, 0, 'reverting the guard would let this reach embeddings.embedAll — i.e. start spending on Gemini calls — before rejecting');
});

test('a document under MAX_CHUNKS is NOT rejected by the chunk-count guard', async () => {
  embedCalls.length = 0;
  const file = makeFile(1); // well under the 3-chunk ceiling
  await assert.rejects(
    () => service.ingest({ tenantId: FOUNDERS_TENANT_ID, file, category: 'ORG_INTELLIGENCE', title: 'Small doc' }),
    (err) => {
      // It must fail for an UNRELATED reason (our embeddings spy sentinel) —
      // never with the guard's 413. If the guard were miscalibrated to also
      // reject small documents, this assertion is what would catch it.
      assert.strictEqual(err, EMBED_SENTINEL, 'a small doc must reach embeddings.embedAll, not be rejected by MAX_CHUNKS');
      return true;
    }
  );
  assert.strictEqual(embedCalls.length, 1, 'the guard must let an under-ceiling document proceed to the embed step');
});
