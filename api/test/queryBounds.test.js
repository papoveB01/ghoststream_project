// Regression tests for three unbounded-read fixes from the 2026-07-29 review:
//
//  1. api/src/dashboard.js (Overview) — the "latest research per company" query
//     and the "top prospects" company-name lookup both used to be unbounded
//     over the WHOLE tenant (every researched company; every company row just
//     to label <=6 names). After a CRM import of 50k+ prospects, that OOM'd
//     the api process on every Overview load. Fixed: the research query now
//     carries LIMIT 500 (most-recent-first via an outer wrapper, since a plain
//     LIMIT can't sit on the DISTINCT ON query directly), and the name lookup
//     is restricted to the handful of candidate ids via `id = ANY($2)`.
//
//  2. api/src/store.js buildCallsList() — used `redis.keys('portal:*')` +
//     `redis.keys('meeting:*')` (blocking, whole-keyspace) then MGET+parsed
//     EVERY blob (meeting blobs carry full transcripts) before filtering to
//     one tenant's single page. Fixed: `scanStream` with per-batch projection
//     so full payloads are never all resident at once.
//
//  3. api/src/portfolio.js GET /competitors/threats (Market Map) — cross-
//     joined kb_chunks x companies with an unindexable per-row substring
//     predicate, unbounded, synchronously on every page load. Fixed: bounded
//     on both sides via CTEs (LIMIT on both the companies and chunks sides)
//     and cached per-tenant in Redis (~1h TTL).
//
// Node's built-in test runner only (node:test + node:assert) — no Postgres,
// no Redis, no npm deps beyond what's already installed. Every module that
// would otherwise touch a real Postgres pool or construct a real ioredis
// client (which keeps the event loop alive and hangs `node --test`) is
// replaced in require.cache BEFORE the module under test is required, per
// the pattern already used by test/contactsScoping.test.js,
// test/billingLifecycle.test.js and test/geminiCacheScan.test.js.
//
// Each section requires its module under test exactly once (real modules
// close over whatever fake happens to be in require.cache at THEIR require
// time), then mutates the fakes' internal state (a plain Map + a recorded-
// calls array) between tests via beforeEach — same approach as the existing
// suite, not a fresh require() per test.

'use strict';

const path = require('node:path');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// Pulls the actual handler function off an express Router's stack, same as
// test/billingLifecycle.test.js / test/subaccountCaps.test.js — exercises the
// real route logic without booting the app or touching a real socket.
function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

// ===========================================================================
// 1. api/src/dashboard.js — Overview
// ===========================================================================

describe('dashboard.js — Overview unbounded reads (fix 1)', () => {
  // dashboard.js requires db/tenants/entitlements/usage/plans/credits directly
  // at module load. tenants.js/entitlements.js/usage.js/credits.js all touch
  // `db` for real data the '/' route doesn't need (and none of them touch
  // Redis), so stubbing them directly — rather than letting them run for real
  // against a fake db — keeps this section self-contained and focused on the
  // two queries under test. plans.js/credits.js aren't referenced at all by
  // the '/' handler (only by '/setup'), so they're stubbed as inert objects.
  stubModule('plans.js', {});
  stubModule('credits.js', {});
  stubModule('usage.js', { summary: async () => ({}) });
  stubModule('tenants.js', {
    get: async (id) => ({ id, name: 'Acme', subscription_status: 'ACTIVE', trial_ends_at: null }),
  });
  stubModule('entitlements.js', {
    resolveEntitlementsFor: async () => ({
      planVersion: 2,
      lifetimeMeters: [],
      lifetimeCaps: false,
      caps: { research: 1000, engagements: 50, arena: 500, market_monitoring: 500 },
    }),
    toJson: () => ({
      planName: 'Pro',
      caps: { research: 1000, engagements: 50, arena: 500, market_monitoring: 500 },
    }),
  });

  // A CRM-import-sized universe: 5000 companies the tenant owns. Only ~9 of
  // them ever appear in "research" rows (the ones with a filed opportunity) —
  // the fix's whole point is that the name-lookup query must only ever ask
  // for those ~9, never the other ~4991.
  const COMPANY_COUNT = 5000;
  const companiesUniverse = new Map();
  for (let i = 0; i < COMPANY_COUNT; i++) {
    companiesUniverse.set(`co-${i}`, `Company ${i}`);
  }
  const HEAT_COMPANY_IDS = ['co-10', 'co-25', 'co-777', 'co-1200', 'co-1999', 'co-2500', 'co-3001', 'co-4321', 'co-4999'];

  let calls;          // every db.query({text, params}) issued by the handler
  let researchRows;   // fixture fed back for the prospect_research/oppR query
  let namesLookupCalls; // just the calls matched as the company-name lookup (fix target #2)

  beforeEach(() => {
    calls = [];
    namesLookupCalls = [];
    researchRows = HEAT_COMPANY_IDS.map((id, i) => ({
      company_id: id,
      company_name: companiesUniverse.get(id),
      opportunities: [{ title: `Deal ${i}`, strength: 'strong', analysis: 'why-now', products: [], pinned: false }],
      created_at: new Date(2026, 6, 1 + i).toISOString(),
    }));
  });

  stubModule('db.js', {
    query: async (text, params) => {
      const s = norm(text);
      calls.push({ text: s, params });

      // ---- fix target #1: the "latest per company" research query ---------
      if (s.includes('prospect_research') && s.includes('DISTINCT ON')) {
        return { rows: researchRows };
      }

      // ---- fix target #2: the bounded "top prospects" name lookup ----------
      // Matches BOTH the fixed shape (`... AND id = ANY($2)`, params.length 2)
      // and a hypothetical reverted shape (`SELECT id, name FROM companies
      // WHERE tenant_id = $1`, params.length 1) — the reverted shape throws,
      // so a regression fails the test immediately instead of quietly passing.
      if (s.includes('FROM companies') && /select\s+id,\s*name/i.test(s)) {
        namesLookupCalls.push({ text: s, params });
        const idList = params[1];
        if (!Array.isArray(idList)) {
          throw new Error(
            'REGRESSION: dashboard requested company names WITHOUT a bounded id list — this ' +
            'would load the ENTIRE companies table (5000 rows in this fixture; 50k+ after a real ' +
            `CRM import) just to label a handful of "top prospects". SQL: ${s}`
          );
        }
        const rows = idList.filter((id) => companiesUniverse.has(id)).map((id) => ({ id, name: companiesUniverse.get(id) }));
        return { rows };
      }

      // ---- everything else: harmless fixed-shape aggregate/list queries ----
      if (s.includes('new_week')) return { rows: [{ total: COMPANY_COUNT, new_week: 12 }] };                 // prospectsR
      if (s.includes('FROM products') && s.includes('count(*)')) return { rows: [{ n: 4 }] };                 // prodR
      if (s.includes('FROM personas') && s.includes('count(*)')) return { rows: [{ n: 2 }] };                 // persR
      if (s.includes('FROM competitors WHERE tenant_id = $1')) return { rows: [{ n: 3 }] };                   // compR
      if (s.includes('kb_document_competitors')) return { rows: [{ n: 1 }] };                                 // compIntelR
      if (s.includes("FROM kb_documents WHERE tenant_id = $1 AND scope")) return { rows: [{ n: 5 }] };        // intelR
      if (s.includes('FROM scheduled_meetings') && s.includes("now() + interval '7 days'")) return { rows: [{ n: 2 }] }; // engCountR
      if (s.includes('SELECT positioning, objectives FROM tenant_profiles')) return { rows: [{ positioning: 'x', objectives: 'y' }] }; // profR
      if (s.includes('FROM scheduled_meetings sm') && s.includes('LEFT JOIN companies c')) return { rows: [] }; // engR
      if (s.includes('FROM crm_connections')) return { rows: [] };                                            // crmR
      if (s.includes('FROM scheduled_meetings') && s.includes('GROUP BY company_id')) return { rows: [] };    // upcR
      if (s.includes('FROM watch_findings') && s.includes('GROUP BY subject_id')) return { rows: [] };        // freshR
      if (s.includes('research_done')) return { rows: [{ research_done: 1, contacts: 1, meetings_ever: 1, watched: 0, new_alerts: 0 }] }; // setupR
      if (s.includes('FROM prospect_contacts') && s.includes('GROUP BY company_id')) return { rows: [] };     // contactsByCoR
      if (s.includes('generate_series')) return { rows: [] };                                                 // trendR
      if (s.includes('FROM companies') && s.includes('watch_enabled')) return { rows: [] };                   // watchedRows

      throw new Error(`queryBounds.test.js (dashboard section): unstubbed query: ${s}`);
    },
  });

  const dashboard = require('../src/dashboard');
  const handler = getRouteHandler(dashboard.router, 'get', '/');

  test('[TEXTUAL] research query carries LIMIT 500, most-recent-first', async () => {
    const req = { tenantId: 'tenant-crm-import' };
    const res = makeRes();
    let nextErr;
    await handler(req, res, (err) => { nextErr = err; });
    assert.strictEqual(nextErr, undefined, `handler errored: ${nextErr && nextErr.stack}`);

    const oppCall = calls.find((c) => c.text.includes('prospect_research') && c.text.includes('DISTINCT ON'));
    assert.ok(oppCall, 'expected the prospect_research/DISTINCT ON query to have been issued');
    assert.match(oppCall.text, /LIMIT 500/, 'reverting the fix removes this LIMIT — the query would again load one row per EVERY researched company');
    assert.match(oppCall.text, /ORDER BY created_at DESC/, 'the LIMIT must sit on a most-recent-first ordering, not an arbitrary 500 rows');
  });

  test('[BEHAVIORAL] top-prospects name lookup is restricted to the candidate ids, never the whole table', async () => {
    const req = { tenantId: 'tenant-crm-import' };
    const res = makeRes();
    let nextErr;
    await handler(req, res, (err) => { nextErr = err; });
    assert.strictEqual(nextErr, undefined, `handler errored: ${nextErr && nextErr.stack}`);

    assert.strictEqual(namesLookupCalls.length, 1, 'expected exactly one company-name lookup query');
    const [, idList] = namesLookupCalls[0].params;
    assert.ok(Array.isArray(idList), 'the name lookup must be parameterised by an id array');
    assert.strictEqual(idList.length, HEAT_COMPANY_IDS.length, 'must request exactly the companies that have research/heat, not the full universe');
    assert.deepStrictEqual([...idList].sort(), [...HEAT_COMPANY_IDS].sort());
    assert.ok(
      idList.length < COMPANY_COUNT,
      `sanity: ${idList.length} requested ids must be far fewer than the ${COMPANY_COUNT}-row tenant`
    );

    // Also confirm the fix didn't just move the boundedness into JS after an
    // unbounded fetch: no query in the whole handler run ever selected
    // `FROM companies` without either a `count(*)` aggregate or an id list.
    const suspicious = calls.filter((c) =>
      c.text.includes('FROM companies') &&
      !c.text.includes('count(*)') &&
      !(c.params && Array.isArray(c.params[1]))
    );
    // The one legitimate exception is the "watched companies" lookup
    // (`SELECT id FROM companies WHERE tenant_id = $1 AND watch_enabled`),
    // which is a different, pre-existing, always-tiny query not part of this
    // fix — filter it out explicitly rather than broadening the check above.
    const reallySuspicious = suspicious.filter((c) => !c.text.includes('watch_enabled'));
    assert.strictEqual(reallySuspicious.length, 0, `unexpected unbounded companies query: ${JSON.stringify(reallySuspicious)}`);
  });
});

// ===========================================================================
// 2. api/src/store.js — buildCallsList (GET /admin/calls)
// ===========================================================================

describe('store.js — buildCallsList unbounded KEYS scan (fix 2)', () => {
  // store.js's only dependency (besides `crypto`) is `./redis`, and it binds
  // `const redis = require('./redis')` once at module load — so this fake is
  // a single long-lived object whose Map is cleared/reseeded per test, not a
  // fresh require() per test.
  const redisStore = new Map();
  const redisCalls = { keys: 0, scanStream: [], mget: 0 };

  function scanStream({ match, count }) {
    redisCalls.scanStream.push(match);
    const prefix = String(match || '').replace(/\*$/, '');
    const batchSize = count || 10;
    const allKeys = [...redisStore.keys()].filter((k) => k.startsWith(prefix));
    const batches = [];
    for (let i = 0; i < allKeys.length; i += batchSize) batches.push(allKeys.slice(i, i + batchSize));

    const em = new EventEmitter();
    let destroyed = false;
    function emitNext() {
      if (destroyed) return;
      if (batches.length === 0) { em.emit('end'); return; }
      em.emit('data', batches.shift());
    }
    em.pause = () => {};
    em.resume = () => { setImmediate(emitNext); };
    em.destroy = () => { destroyed = true; };
    setImmediate(emitNext);
    return em;
  }

  stubModule('redis', {
    async keys() {
      redisCalls.keys += 1;
      throw new Error(
        'redis.keys() must never be called from store.js buildCallsList — it blocks the whole ' +
        'single-threaded Redis server while it walks the entire keyspace, and the blobs it would ' +
        'load (meeting records) carry full transcripts. Use scanStream() instead.'
      );
    },
    scanStream,
    async mget(keys) {
      redisCalls.mget += 1;
      return keys.map((k) => (redisStore.has(k) ? redisStore.get(k) : null));
    },
  });

  const store = require('../src/store');

  const TENANT_A_COUNT = 250; // > one scanStream batch (count:100) on both prefixes

  beforeEach(() => {
    redisStore.clear();
    redisCalls.keys = 0;
    redisCalls.scanStream = [];
    redisCalls.mget = 0;

    for (let i = 0; i < TENANT_A_COUNT; i++) {
      const id = `m_${String(i).padStart(4, '0')}`;
      redisStore.set(`meeting:${id}`, JSON.stringify({
        id,
        source: 'recall',
        status: 'done',
        meta: { tenantId: 'tenant-A' },
        createdAt: new Date(2026, 6, 1, 0, 0, i).toISOString(),
        // Realistic-sized payload — what the old KEYS+MGET-everything path
        // used to hold fully in memory for the whole keyspace at once.
        transcript: { durationSeconds: 900, text: 'lorem ipsum '.repeat(200) },
        analysis: { summary: 'x'.repeat(2000) },
      }));
      redisStore.set(`portal:p_${String(i).padStart(4, '0')}`, JSON.stringify({
        id: `p_${String(i).padStart(4, '0')}`,
        meetingId: id,
        title: `Call ${i}`,
        participants: [],
        moments: {},
      }));
    }
    // A little tenant-B noise so tenant-scoping isn't accidentally papering
    // over a completeness bug (e.g. total including someone else's rows).
    for (let i = 0; i < 3; i++) {
      redisStore.set(`meeting:mb_${i}`, JSON.stringify({
        id: `mb_${i}`, source: 'recall', status: 'done', meta: { tenantId: 'tenant-B' },
        createdAt: new Date(2025, 0, 1).toISOString(),
      }));
    }
  });

  test('[BEHAVIORAL] never calls redis.keys(); uses scanStream on both prefixes', async () => {
    await store.buildCallsList({ tenant: 'tenant-A', limit: 200 });
    assert.strictEqual(redisCalls.keys, 0, 'buildCallsList must never call redis.keys()');
    assert.ok(redisCalls.scanStream.includes('meeting:*'), 'must scanStream the meeting: prefix');
    assert.ok(redisCalls.scanStream.includes('portal:*'), 'must scanStream the portal: prefix');
  });

  test('[BEHAVIORAL] assembles ALL calls correctly across MULTIPLE scan batches (none dropped)', async () => {
    // count:100 (hardcoded in store.js's _scanProjected) over 250 tenant-A
    // meeting keys means 3 scan batches (100/100/50) for meetings, and the
    // same for the 250 matching portal keys. A cursor bug that resolves on
    // the first 'data' event instead of accumulating until 'end' would drop
    // the 2nd/3rd batches — this would look like "some calls missing" (and,
    // since portals are scanned the same way, "some ready calls showing as
    // failed/orphaned") in production.
    const page1 = await store.buildCallsList({ tenant: 'tenant-A', limit: 200 });
    assert.strictEqual(page1.pageInfo.total, TENANT_A_COUNT, 'facets/total must reflect all 250 tenant-A calls, not just the first scan batch');
    assert.strictEqual(page1.calls.length, 200);
    assert.ok(page1.pageInfo.hasMore);

    const page2 = await store.buildCallsList({ tenant: 'tenant-A', limit: 200, cursor: page1.pageInfo.cursor });
    assert.strictEqual(page2.pageInfo.total, TENANT_A_COUNT);
    assert.strictEqual(page2.calls.length, 50);
    assert.strictEqual(page2.pageInfo.hasMore, false);

    const allIds = new Set([...page1.calls, ...page2.calls].map((c) => c.id));
    assert.strictEqual(allIds.size, TENANT_A_COUNT, 'no duplicates and no gaps across the two pages');
    for (let i = 0; i < TENANT_A_COUNT; i++) {
      assert.ok(allIds.has(`m_${String(i).padStart(4, '0')}`), `m_${i} missing — a later scan batch was dropped`);
    }
    assert.ok(![...allIds].some((id) => id.startsWith('mb_')), 'tenant-B rows must not leak into tenant-A results');

    // Every tenant-A meeting has status 'done' + a matching portal → bucket
    // 'ready'. If the PORTAL scan (not just the meeting scan) dropped a
    // batch, some of these would show as bucket 'failed' (done, no portal
    // found) instead, and this facet count would come in under 250.
    assert.strictEqual(page1.facets.status.ready, TENANT_A_COUNT, 'portal-scan batches must all be joined in, or done-calls misreport as failed/orphaned');
  });
});

// ===========================================================================
// 3. api/src/portfolio.js — GET /competitors/threats (Market Map)
// ===========================================================================

describe('portfolio.js — GET /competitors/threats unbounded cross-join (fix 3)', () => {
  // portfolio.js requires a long list of modules at the top of the file,
  // several of which (auth -> sessions, gating -> auth, knowledge/* ->
  // gemini) transitively construct a real ioredis client or Postgres pool at
  // require time. None of them are touched by the threats route itself
  // (nor is auth.requireRole/gating.requireFeature/requireCapacity's return
  // value ever invoked here — they only need to exist as middleware
  // factories because portfolio.js calls them at module load to WIRE other
  // routes), so they're stubbed as inert objects.
  stubModule('auth.js', {
    requireRole: () => (req, res, next) => next(),
  });
  stubModule('gating.js', {
    requireFeature: () => (req, res, next) => next(),
    requireCapacity: () => (req, res, next) => next(),
    refundCapacity: async () => {},
  });
  stubModule('watchSchedule.js', {});
  stubModule('knowledge/assessment.js', {});
  stubModule('knowledge/web.js', {});
  stubModule('knowledge/service.js', {});
  stubModule('knowledge/relevance.js', {});
  stubModule('knowledge/discovery.js', {});
  stubModule('knowledge/keypoints.js', {});
  stubModule('companyBrief.js', {});
  stubModule('foundation.js', {});

  const redisStore = new Map();
  const redisCalls = { get: 0, set: 0 };
  stubModule('redis', {
    async get(key) { redisCalls.get += 1; return redisStore.has(key) ? redisStore.get(key) : null; },
    async set(key, value) { redisCalls.set += 1; redisStore.set(key, value); return 'OK'; },
  });

  let dbCalls;
  stubModule('db.js', {
    query: async (text, params) => {
      const s = norm(text);
      dbCalls.push({ text: s, params });

      if (s.includes('FROM competitor_products') && s.includes('GROUP BY competitor_id')) {
        return { rows: [{ competitor_id: 'comp-1', n: 2 }] }; // pins
      }
      if (s.includes('kb_chunks') && s.includes('Competing-threat level')) {
        return { rows: [{ competitor_id: 'comp-1', lvl: 4 }] }; // bc
      }
      // ---- fix target: the bounded overlap CTE (both sides capped) ---------
      if (s.includes('bounded_co') && s.includes('bounded_ch')) {
        return { rows: [{ competitor_id: 'comp-1', n: 3, names: ['Foo LLC', 'Bar Co'] }] }; // overlap
      }
      if (s.includes('FROM watch_findings')) {
        return { rows: [{ competitor_id: 'comp-1', w: 6 }] }; // watch
      }
      if (s.includes('FROM competitors WHERE tenant_id = $1')) {
        return { rows: [{ id: 'comp-1', name: 'Acme Rival' }, { id: 'comp-2', name: 'Beta Rival' }] }; // comps
      }
      if (s.includes('FROM products WHERE tenant_id = $1')) {
        return { rows: [{ n: 4 }] }; // prodTotal
      }
      if (s.includes('FROM companies WHERE tenant_id = $1')) {
        return { rows: [{ n: 1234 }] }; // prospectN
      }

      throw new Error(`queryBounds.test.js (portfolio section): unstubbed query: ${s}`);
    },
  });

  const portfolio = require('../src/portfolio');
  const handler = getRouteHandler(portfolio.router, 'get', '/competitors/threats');

  beforeEach(() => {
    dbCalls = [];
    redisStore.clear();
    redisCalls.get = 0;
    redisCalls.set = 0;
  });

  test('[TEXTUAL] overlap query is bounded on both sides (companies x chunks)', async () => {
    const req = { tenantId: 'tenant-heavy' };
    const res = makeRes();
    let nextErr;
    await handler(req, res, (err) => { nextErr = err; });
    assert.strictEqual(nextErr, undefined, `handler errored: ${nextErr && nextErr.stack}`);

    const overlapCall = dbCalls.find((c) => c.text.includes('bounded_co') && c.text.includes('bounded_ch'));
    assert.ok(overlapCall, 'expected the bounded overlap CTE query to have been issued');
    const limits = [...overlapCall.text.matchAll(/LIMIT (\d+)/g)].map((m) => Number(m[1]));
    assert.strictEqual(limits.length, 2, 'expected exactly two LIMIT clauses (one per CTE) — reverting the fix collapses back to an unbounded cross-join');
    // Locks today's OVERLAP_COMPANIES_CAP/OVERLAP_CHUNKS_CAP constants (see
    // portfolio.js) — a deliberate resize should update this test too; the
    // regression this guards is the LIMIT disappearing or ballooning back
    // toward "unbounded", not a legitimate tuning of the cap.
    assert.deepStrictEqual(limits.sort((a, b) => a - b), [400, 3000]);
  });

  test('[BEHAVIORAL] a second request within the TTL is served from the Redis cache, without re-running the queries', async () => {
    const req1 = { tenantId: 'tenant-heavy' };
    const res1 = makeRes();
    let err1;
    await handler(req1, res1, (e) => { err1 = e; });
    assert.strictEqual(err1, undefined, `first call errored: ${err1 && err1.stack}`);
    assert.ok(res1.body && res1.body.threats, 'expected a threats payload on the first (uncached) call');

    const firstCallCount = dbCalls.length;
    assert.ok(firstCallCount > 0, 'sanity: the first call must have actually queried the db');
    assert.strictEqual(redisCalls.set, 1, 'the computed payload must be written to the Redis cache exactly once');

    const req2 = { tenantId: 'tenant-heavy' };
    const res2 = makeRes();
    let err2;
    await handler(req2, res2, (e) => { err2 = e; });
    assert.strictEqual(err2, undefined, `second call errored: ${err2 && err2.stack}`);

    assert.strictEqual(dbCalls.length, firstCallCount, 'a second request within the TTL must NOT re-run any of the threat-scoring queries');
    assert.strictEqual(redisCalls.set, 1, 'a cache hit must not re-write the cache');
    assert.deepStrictEqual(res2.body, res1.body, 'the cached response must match the originally computed payload');
  });
});
