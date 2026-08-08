// Route-contract regression test — 2026-07-29 code review.
//
// WHY THIS TEST EXISTS: three of the four CRITICAL findings in that review
// were a MISSING MIDDLEWARE on a route, not a logic bug inside a handler:
//   - GET /meetings/:id was mounted with no auth at all and returned the
//     FULL operator record (transcript, internal coaching notes, tenantId)
//     to anonymous callers.
//   - GET /admin/portals and GET /admin/meetings had auth.authMiddleware but
//     no auth.requireSuperadmin, and their handlers do an UNSCOPED global
//     Redis scan (store.listPortals / store.listMeetings) — so any signed-in
//     user of ANY tenant could read every tenant's portals/meetings.
//   - POST /meetings had auth but no gating.requireFeature/requireCapacity,
//     so it dispatched unlimited unmetered ~$1 Recall.ai bots past any plan
//     cap (billingGate only blocks an *inactive* subscription, nothing else
//     stopped an ACTIVE tenant looping this for free).
// A one-off regression test per bug would not have caught the *next* route
// that ships without its middleware. This file instead walks the ENTIRE
// mounted route table of the real Express app and checks every route against
// a declarative contract, so a newly added or edited route that drops its
// auth/gating/superadmin middleware fails HERE, by name, with the missing
// middleware called out — instead of shipping quietly.
//
// Node's built-in test runner only (node:test + node:assert) — no npm deps,
// no Postgres, no Redis needed to RUN this test. Requiring src/index.js only
// *builds* the Express app (routes + middleware wiring); it does not run
// migrations, cron or app.listen(), because index.js guards boot() behind
// `require.main === module` and does `module.exports = app`.
//
// GOTCHA verified while writing this test: requiring index.js DOES have one
// live side effect — src/redis.js constructs an ioredis client with
// lazyConnect:false, which immediately tries to connect and retries forever
// in the background when no Redis is reachable. That keeps the event loop
// alive after every assertion below has already run, so this file explicitly
// disconnects it in the `after` hook — otherwise `node --test` (and CI) would
// hang instead of exiting.

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-test-jwt-secret-at-least-32-bytes-long-xx';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-test-encryption-key-not-a-real-secret';

const app = require('../src/index.js');

// ===========================================================================
// 1. Flatten app._router.stack into { method, path, chain } rows.
// ===========================================================================
//
// Express nests routers: a top-level `app.use('/companies', auth.authMiddleware,
// companies.router)` registers THREE separate stack layers at the same mount
// path — the authMiddleware function, then the router itself — and the
// router's own stack holds its routes (each already carrying its OWN local
// middleware in `route.stack`). To know the FULL chain that actually executes
// for e.g. `GET /companies/:id` we must walk down through the mount, carrying
// every ancestor middleware with us.
//
// mountPathFromLayer() recovers the literal path string a router was mounted
// at from the compiled path-to-regexp `RegExp` Express stores on the layer
// (there is no plain-string field for it). All mounts in this app are static
// prefixes (no `:params` in the mount path itself), so this reconstruction is
// exact, not a guess — if a future mount path DOES contain params or some
// other shape this function can't parse, it throws rather than silently
// mis-attributing routes, which would make this test quietly meaningless.
function mountPathFromLayer(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return ''; // mounted at '/' (global)
  if (!layer.regexp) throw new Error('router layer with no regexp — express internals changed?');
  const src = layer.regexp.source;
  let m = src.match(/^\^\\\/(.*?)\\\/\?\(\?:\(\?=\\\/\|\$\)\)?$/);
  if (!m) m = src.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) {
    throw new Error(
      `routeContract.test.js can't parse this router mount's path from its regexp (${src}). ` +
      `Either a mount path grew a param/wildcard, or this Express version changed how it compiles ` +
      `paths. Fix mountPathFromLayer() before trusting this test's results again.`
    );
  }
  return '/' + m[1].replace(/\\\//g, '/');
}

// A middleware factory (gating.requireFeature('x'), auth.requireRole('owner'),
// etc.) returns a fresh anonymous closure on every call — it has no `.name`
// and can never be identity-compared against "the same" middleware mounted
// elsewhere. What IS stable is the literal source text Function#toString()
// returns, since that's the function's source as written in gating.js/auth.js,
// not the values it closed over. Each fingerprint string below was picked by
// actually printing these factories' .toString() (see conversation) and
// choosing a substring unique to that function's body.
function tagsFor(fn) {
  if (typeof fn !== 'function') return [];
  if (fn.length === 4) return ['(error-handler)']; // (err, req, res, next) — not part of the normal chain
  const tags = [];
  if (fn.name) tags.push(fn.name);
  const src = fn.toString();
  if (src.includes('FEATURE_NOT_IN_PLAN')) tags.push('requireFeature');
  if (src.includes('req._capacity = await chargeUnit')) tags.push('requireCapacity');
  if (src.includes("req.method === 'GET' ? next() : guard(")) tags.push('requireFeatureWrite');
  if (src.includes('INSUFFICIENT_ROLE')) tags.push('requireRole');
  if (src.includes('requireRole(minRole)(req, res, next)')) tags.push('requireRoleWrite');
  return tags;
}

function buildRouteTable(rootApp) {
  const routes = [];

  // Walks one router's stack. `ancestorChain` is every middleware function
  // collected on the way down (global app.use()'d middleware + any mount-level
  // middleware of enclosing routers); `prefix` is the path assembled so far.
  function walk(stack, ancestorChain, prefix) {
    let i = 0;
    while (i < stack.length) {
      const layer = stack[i];

      if (layer.route) {
        const methods = Object.keys(layer.route.methods);
        const localChain = layer.route.stack.map((s) => s.handle);
        const routePath = layer.route.path === '/' ? '' : layer.route.path;
        const fullChain = [...ancestorChain, ...localChain];
        for (const m of methods) {
          routes.push({
            method: m.toUpperCase(),
            path: prefix + routePath,
            chain: fullChain,
            tags: fullChain.flatMap(tagsFor),
          });
        }
        i++;
        continue;
      }

      if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // A router mount can be preceded by sibling middleware layers
        // registered in the SAME app.use(path, mw1, mw2, router) call — those
        // share this layer's exact regexp (same mount path). Collect them by
        // scanning backward while the regexp source matches.
        let segStart = i;
        while (
          segStart > 0 &&
          stack[segStart - 1].regexp && layer.regexp &&
          !stack[segStart - 1].route &&
          stack[segStart - 1].name !== 'router' &&
          stack[segStart - 1].regexp.source === layer.regexp.source
        ) segStart--;
        const mountMw = stack.slice(segStart, i).map((l) => l.handle);
        const mountPath = mountPathFromLayer(layer);
        walk(layer.handle.stack, [...ancestorChain, ...mountMw], prefix + mountPath);
        i++;
        continue;
      }

      if (layer.regexp && layer.regexp.fast_slash) {
        // Global middleware (app.use(fn) with no path) — applies to every
        // route registered after it. In this app: query/expressInit parsers,
        // the JSON body parser, and gating.billingGate.
        ancestorChain = [...ancestorChain, layer.handle];
        i++;
        continue;
      }

      // A prefix-scoped middleware layer (e.g. the `auth.authMiddleware,
      // auth.requireSuperadmin,` pair in front of `platformAdmin.router`) that
      // is NOT itself a route or a router mount. It shares its regexp with a
      // router layer LATER in this same stack (every `app.use('/prefix', mw...,
      // router)` in this codebase ends in a router — verified against every
      // app.use() call site in src/index.js while writing this test), so it
      // will be picked up by that router's backward-scan above. Skip it here
      // without adding it to ancestorChain directly (adding it twice would
      // double-count it in the chain).
      i++;
    }
  }

  walk(rootApp._router.stack, [], '');
  return routes;
}

const ROUTES = buildRouteTable(app);

function routeKey(method, path) { return `${method} ${path}`; }
function findRoute(method, path) {
  return ROUTES.find((r) => r.method === method && r.path === path);
}
function chainHas(route, tag) { return route.tags.includes(tag); }

// Sanity floor, not a hard pin: if this ever fails, the route walker broke
// (wrong assumption about express internals), not that the app lost 100+
// routes. Keeps a silent "ROUTES ended up empty" failure from passing.
test('sanity: the route walker actually found the app\'s routes', () => {
  assert.ok(ROUTES.length >= 200, `expected 200+ mounted routes, found ${ROUTES.length} — the router-stack walker likely broke`);
});

// ===========================================================================
// 2. The public allowlist — the review checkpoint.
// ===========================================================================
//
// Every route NOT listed here must carry auth.authMiddleware. Adding a route
// to this list IS a reviewable decision (it says out loud "this is meant to
// be reachable with no session"), which is the entire point: a route that
// forgets its auth middleware by ACCIDENT fails the test below instead of
// silently shipping, and the only way to make it pass is to come here and
// justify it.
const PUBLIC_ROUTES = [
  { method: 'GET',  path: '/health', reason: 'liveness/readiness probe' },
  { method: 'POST', path: '/_internal/meetings/:id/process', reason: 'server-to-server only (capture -> api); guarded by requireInternalAuth, a constant-time shared-secret compare — not session auth by design' },
  { method: 'GET',  path: '/portals/:id/report.docx', reason: 'consolidated report export for the public Sales Portal share link — same trust tier as GET /portals/:id' },
  { method: 'GET',  path: '/portals/:id/sow.docx', reason: 'legacy alias of the report.docx route above, kept for old links' },
  { method: 'POST', path: '/portals/:id/save-intel', reason: 'does NOT skip auth: it manually calls auth.verifyToken(auth.tokenFromRequest(req)) and 401s without a valid cookie — just doesn\'t use the shared authMiddleware, so it can\'t be detected by name' },
  { method: 'GET',  path: '/portals/:id', reason: 'two-tier Sales Portal view — the CUSTOMER tier is intentionally anonymous (share link); the handler itself upgrades to the MANAGER tier only for a session matching the portal\'s own tenant' },
  { method: 'POST', path: '/arena/start', reason: 'Arena practice is normally anonymous (share-link practice flow); uses auth.optionalAuth to attribute a session to a rep ONLY when one is logged in' },
  { method: 'POST', path: '/arena/:id/end', reason: 'same anonymous Arena roleplay flow as /arena/start' },
  { method: 'POST', path: '/arena/:id/turn', reason: 'same anonymous Arena roleplay flow as /arena/start' },
  { method: 'GET',  path: '/arena/:id', reason: 'same anonymous Arena roleplay flow as /arena/start' },
  { method: 'POST', path: '/auth/login', reason: 'the sign-in endpoint itself — cannot require a session to get one' },
  { method: 'POST', path: '/auth/verify-device', reason: 'new-device OTP step of the (still pre-session) login flow' },
  { method: 'POST', path: '/auth/resend-otp', reason: 'resend step of the (still pre-session) login flow' },
  { method: 'POST', path: '/auth/logout', reason: 'best-effort session revocation; must work even if the cookie is already invalid/missing' },
  { method: 'POST', path: '/auth/forgot-password', reason: 'password-reset request; deliberately enumeration-safe (always 200)' },
  { method: 'POST', path: '/auth/reset-password', reason: 'password-reset completion — authenticated by the single-use emailed token, not a session cookie' },
  { method: 'GET',  path: '/crm/:provider/callback', reason: 'OAuth redirect target hit by the CRM provider (no cookie); authenticated via the short-lived `state` token instead' },
  { method: 'GET',  path: '/integrations/google/callback', reason: 'OAuth redirect target; state-token authenticated (see /crm/:provider/callback above)' },
  { method: 'GET',  path: '/integrations/calendly/callback', reason: 'OAuth redirect target; state-token authenticated' },
  { method: 'GET',  path: '/integrations/microsoft/callback', reason: 'OAuth redirect target; state-token authenticated (ADR-0002 §4.2)' },
  { method: 'POST', path: '/billing/webhook', reason: 'Stripe webhook — signature-verified (billing.webhook), Stripe has no session cookie' },
  { method: 'GET',  path: '/subaccounts/invite/:token', reason: 'public sub-account self-onboard flow — the invitee has no account yet' },
  { method: 'POST', path: '/subaccounts/invite/:token/accept', reason: 'same public self-onboard flow as above' },
  { method: 'GET',  path: '/onboarding/industries', reason: 'free-trial signup flow — the caller is not a customer yet' },
  { method: 'POST', path: '/onboarding/start', reason: 'same free-trial signup flow' },
  { method: 'GET',  path: '/onboarding/:id/status', reason: 'same free-trial signup flow (progress poll)' },
  { method: 'GET',  path: '/onboarding/verify', reason: 'same free-trial signup flow (email verification link)' },
  { method: 'POST', path: '/onboarding/verify', reason: 'same free-trial signup flow (email verification submit)' },
  { method: 'POST', path: '/contact', reason: 'public website contact/demo-request form' },
  { method: 'POST', path: '/webhooks/calendly/:routeToken', reason: 'Calendly webhook, per-tenant route token; signature-verified inside handleCalendlyBooking' },
  { method: 'POST', path: '/webhooks/calendly', reason: 'legacy tokenless Calendly webhook; signature-verified the same way' },
  { method: 'POST', path: '/webhooks/inbound-email/:secret', reason: 'SendGrid Inbound Parse webhook; guarded by a secret embedded in the path (INBOUND_PARSE_SECRET), not a session' },
];

test('PUBLIC_ROUTES has no stale entries (every listed route still exists)', () => {
  const known = new Set(ROUTES.map((r) => routeKey(r.method, r.path)));
  const stale = PUBLIC_ROUTES.filter((r) => !known.has(routeKey(r.method, r.path)));
  assert.deepStrictEqual(
    stale.map((r) => routeKey(r.method, r.path)),
    [],
    'PUBLIC_ROUTES lists routes that no longer exist in the app (renamed/removed) — fix or delete these allowlist entries so the list stays trustworthy'
  );
});

test('every route NOT in PUBLIC_ROUTES requires auth.authMiddleware', () => {
  const publicSet = new Set(PUBLIC_ROUTES.map((r) => routeKey(r.method, r.path)));
  const offenders = ROUTES
    .filter((r) => !publicSet.has(routeKey(r.method, r.path)))
    .filter((r) => !chainHas(r, 'authMiddleware'))
    .map((r) => routeKey(r.method, r.path));

  assert.deepStrictEqual(offenders, [], [
    '',
    'These routes have NO auth.authMiddleware anywhere in their middleware chain,',
    'which means an anonymous caller with no session can hit them — the exact bug',
    'class behind GET /meetings/:id leaking full call transcripts in the',
    '2026-07-29 review.',
    '',
    'If one of these is genuinely meant to be public (health check, OAuth',
    'callback, signature-verified webhook, ...), add it to PUBLIC_ROUTES above',
    'with a one-line reason. If it is NOT meant to be public, the route lost its',
    'auth.authMiddleware — put it back.',
    '',
    `Offending routes:\n  ${offenders.join('\n  ')}`,
  ].join('\n'));
});

// ===========================================================================
// 3. /admin/* superadmin scoping.
// ===========================================================================
//
// store.listPortals()/store.listMeetings() (the handlers behind /admin/portals
// and /admin/meetings) are unscoped global Redis prefix scans — there is no
// tenant_id predicate anywhere in them. The ONLY thing that made them
// single-tenant-safe was auth.requireSuperadmin sitting in front. A route
// under /admin/* is safe WITHOUT requireSuperadmin only if its own handler
// scopes the query to req.tenantId (or explicitly branches superadmin vs.
// non-superadmin) — each such route is named below with the exact call that
// does the scoping, so "safe without requireSuperadmin" is never just assumed.
const TENANT_SCOPED_ADMIN_ROUTES = [
  { method: 'GET', path: '/admin/sessions', reason: 'arenaHistory.listForTenant(req.tenantId, ...) — Arena practice history, hard-scoped' },
  { method: 'GET', path: '/admin/sessions/:id', reason: 'arenaHistory.getOne(req.tenantId, ...) — hard-scoped' },
  { method: 'GET', path: '/admin/calls', reason: 'store.buildCallsList({ tenant: isSuperadmin ? (req.query.tenant||null) : req.tenantId, ... }) — non-superadmin is hard-scoped in the handler itself' },
];

// Pre-existing gaps found WHILE BUILDING this test (2026-07-29 follow-up), out
// of scope to fix here (this file may not touch api/src/). Both call the exact
// same kind of unscoped global scan that made /admin/portals and
// /admin/meetings Critical, but currently carry only auth.authMiddleware:
//   - GET /admin/overview  -> store.getCounts() (global redis.keys() scan
//     across ALL tenants' portals/sessions/meetings) + gemini.listCachedRecords()
//   - GET /admin/caches    -> gemini.listCachedRecords() again, unscoped —
//     this is a DUPLICATE of GET /gemini/caches, which IS superadmin-gated;
//     this second copy of the same data is not.
// Reported to the reviewer rather than silently allowlisted as "fine" (that
// would defeat the point of this test) or force-failed. Anything listed here
// must also carry its own named assertion below stating the fix expected, so
// a tolerated hole can never be silent.
// Empty, and it should stay that way. Both original entries (/admin/overview,
// /admin/caches) were fixed the same day this test surfaced them — see the
// now-live assertions below. An entry here means a known cross-tenant hole is
// being tolerated, so adding one should be a deliberate, argued decision.
const ADMIN_KNOWN_GAPS = [];

test('every /admin/* route is superadmin-only or explicitly tenant-scoped by its handler', () => {
  const scopedSet = new Set(TENANT_SCOPED_ADMIN_ROUTES.map((r) => routeKey(r.method, r.path)));
  const gapSet = new Set(ADMIN_KNOWN_GAPS.map((r) => routeKey(r.method, r.path)));
  const offenders = ROUTES
    .filter((r) => r.path.startsWith('/admin/'))
    .filter((r) => !chainHas(r, 'requireSuperadmin'))
    .filter((r) => !scopedSet.has(routeKey(r.method, r.path)))
    .filter((r) => !gapSet.has(routeKey(r.method, r.path))) // tracked separately below, see ADMIN_KNOWN_GAPS
    .map((r) => routeKey(r.method, r.path));

  assert.deepStrictEqual(offenders, [], [
    '',
    'These /admin/* routes have no auth.requireSuperadmin AND are not in',
    'TENANT_SCOPED_ADMIN_ROUTES — i.e. nothing stops a signed-in user of ANY',
    'tenant from reading every OTHER tenant\'s data through them. This is',
    'exactly the /admin/portals + /admin/meetings Critical from the',
    '2026-07-29 review.',
    '',
    'Either add auth.requireSuperadmin to the route, or — if the handler',
    'already scopes its query to req.tenantId — add it to',
    'TENANT_SCOPED_ADMIN_ROUTES above naming the exact scoping call.',
    '',
    `Offending routes:\n  ${offenders.join('\n  ')}`,
  ].join('\n'));
});

test('GET /admin/overview requires superadmin (unscoped global counts + cache list)', () => {
  const r = findRoute('GET', '/admin/overview');
  assert.ok(r, 'GET /admin/overview route not found — did it move?');
  assert.ok(chainHas(r, 'requireSuperadmin'), 'GET /admin/overview still has no requireSuperadmin guarding its unscoped store.getCounts()/gemini.listCachedRecords() calls');
});

test('GET /admin/caches requires superadmin (unscoped duplicate of GET /gemini/caches)', () => {
  const r = findRoute('GET', '/admin/caches');
  assert.ok(r, 'GET /admin/caches route not found — did it move?');
  assert.ok(chainHas(r, 'requireSuperadmin'), 'GET /admin/caches still has no requireSuperadmin guarding its unscoped gemini.listCachedRecords() call');
});

// Explicit, named assertions for the two Critical routes themselves — belt and
// suspenders on top of the blanket /admin/* rule above, so a reader who never
// gets past this section still sees the exact regression being pinned down.
test('CRITICAL FIX: GET /admin/portals requires auth.requireSuperadmin (store.listPortals is an unscoped global Redis scan)', () => {
  const r = findRoute('GET', '/admin/portals');
  assert.ok(r, 'GET /admin/portals route not found — did it move or get removed (see ADR-003 Phase 3 deprecation note)?');
  assert.ok(chainHas(r, 'authMiddleware'), 'GET /admin/portals lost auth.authMiddleware');
  assert.ok(chainHas(r, 'requireSuperadmin'), 'GET /admin/portals lost auth.requireSuperadmin — its handler (store.listPortals) has no tenant_id filter, so without this ANY signed-in user of ANY tenant reads every tenant\'s portals (moments, email drafts, reports, grounding)');
});

test('CRITICAL FIX: GET /admin/meetings requires auth.requireSuperadmin (store.listMeetings is an unscoped global Redis scan)', () => {
  const r = findRoute('GET', '/admin/meetings');
  assert.ok(r, 'GET /admin/meetings route not found — did it move or get removed (see ADR-003 Phase 3 deprecation note)?');
  assert.ok(chainHas(r, 'authMiddleware'), 'GET /admin/meetings lost auth.authMiddleware');
  assert.ok(chainHas(r, 'requireSuperadmin'), 'GET /admin/meetings lost auth.requireSuperadmin — its handler (store.listMeetings) has no tenant_id filter, so without this ANY signed-in user of ANY tenant reads every tenant\'s FULL meeting records, including transcripts');
});

// ===========================================================================
// 4. Engagement gating — POST /meetings and POST /missions both dispatch a
//    real Recall.ai bot at ~$1 COGS. auth.authMiddleware alone only proves
//    "this caller has a session" — it says nothing about plan entitlement or
//    the monthly engagement cap. Both must carry gating.requireFeature AND
//    gating.requireCapacity, or an ACTIVE tenant on any plan (even Free trial)
//    could loop the endpoint past its cap for free — billingGate only blocks
//    an *inactive* subscription, nothing else was stopping this.
// ===========================================================================

test('CRITICAL FIX: POST /meetings carries engagement feature + capacity gating', () => {
  const r = findRoute('POST', '/meetings');
  assert.ok(r, 'POST /meetings route not found — did it move?');
  assert.ok(chainHas(r, 'authMiddleware'), 'POST /meetings lost auth.authMiddleware');
  assert.ok(chainHas(r, 'requireFeature'), 'POST /meetings lost gating.requireFeature(plans.FEATURES.ENGAGEMENTS) — a tenant whose plan doesn\'t include engagements could still dispatch a Recall.ai bot');
  assert.ok(chainHas(r, 'requireCapacity'), 'POST /meetings lost gating.requireCapacity(plans.FEATURES.ENGAGEMENTS) — this is the actual meter charge; without it an ACTIVE tenant can dispatch unlimited unmetered ~$1 Recall.ai bots past its plan\'s engagement cap');
});

test('POST /missions carries the same engagement feature + capacity gating (it dispatches the same kind of bot)', () => {
  const r = findRoute('POST', '/missions');
  assert.ok(r, 'POST /missions route not found — did it move?');
  assert.ok(chainHas(r, 'authMiddleware'), 'POST /missions lost auth.authMiddleware');
  assert.ok(chainHas(r, 'requireFeature'), 'POST /missions lost gating.requireFeature(...) — see the identical POST /meetings gap in the 2026-07-29 review');
  assert.ok(chainHas(r, 'requireCapacity'), 'POST /missions lost gating.requireCapacity(...) — see the identical POST /meetings gap in the 2026-07-29 review');
});

// ===========================================================================
// 5. GET /meetings/:id — the route that was actually exploitable: fully
//    unauthenticated, returning transcript + internal knowledgeGaps coaching
//    notes + meta.tenantId + the raw Recall bot payload to ANY caller.
// ===========================================================================

test('CRITICAL FIX: GET /meetings/:id requires auth.authMiddleware', () => {
  const r = findRoute('GET', '/meetings/:id');
  assert.ok(r, 'GET /meetings/:id route not found — did it move?');
  assert.ok(chainHas(r, 'authMiddleware'), 'GET /meetings/:id has no auth.authMiddleware again — this is the exact route that leaked full call transcripts (incl. internal knowledgeGaps coaching notes) to anonymous callers in the 2026-07-29 review; see the comment above this route in src/index.js for the two-tier trust model it depends on (the stripped public shape belongs on GET /portals/:id, not here)');
});

// ===========================================================================
// 6. POST /first-loop — the route that reads a KB that is not the caller's.
//    Its handler passes userModel.FOUNDERS_TENANT_ID to analysis.runPipeline
//    regardless of who called, and the caller's own `req.body.transcript`
//    decides the entities that become the pgvector query. So with only
//    authMiddleware in front, any self-serve trial tenant could steer
//    retrieval into the Founders KB and read the result back out of the
//    verbatim `pipeline` in the response — grounding.citations[] carries
//    documentTitle / sourceUrl / category, and moments.knowledgeGaps[]
//    .contradiction restates the retrieved chunk bodies in prose.
//    Nothing in web/ or mcp/ calls it; it is a demo endpoint (ADR-0001 §7
//    PR 4 says so in as many words), so like the /gemini/caches* siblings it
//    is superadmin-only. Postgres RLS also blocks the read, but only when
//    RLS_ENFORCE=on — db.js defaults it to off, so RLS is defence in depth
//    here, not the control.
// ===========================================================================

test('CRITICAL FIX: POST /first-loop requires auth.requireSuperadmin (its handler reads the FOUNDERS tenant KB, not the caller\'s)', () => {
  const r = findRoute('POST', '/first-loop');
  assert.ok(r, 'POST /first-loop route not found — did it move or get removed?');
  assert.ok(chainHas(r, 'authMiddleware'), 'POST /first-loop lost auth.authMiddleware');
  assert.ok(chainHas(r, 'requireSuperadmin'), 'POST /first-loop lost auth.requireSuperadmin — its handler hard-codes tenantId: userModel.FOUNDERS_TENANT_ID into analysis.runPipeline while the caller controls req.body.transcript (and therefore the retrieval query), so without this ANY signed-in tenant can read the Founders knowledge base out of the response\'s grounding.citations[] and moments.knowledgeGaps[].contradiction — a break of ADR-0001 §4.2. It also drives three unmetered model stages plus a Cloudflare Stream ingest+clip per call, billed to Founders.');
});

// ---------------------------------------------------------------------------
// Cleanup: disconnect the ioredis client index.js's module graph opened (see
// the file-level comment above) so `node --test` can exit instead of hanging
// on a background reconnect loop with nothing to connect to.
// ---------------------------------------------------------------------------
after(() => {
  try { require('../src/redis.js').disconnect(); } catch { /* best-effort */ }
});
