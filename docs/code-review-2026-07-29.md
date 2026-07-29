# System code review — 2026-07-29

Full-codebase review against [`rules/code-review.md`](../rules/code-review.md), run as a
hub-and-spoke fan-out: ten read-only review agents over disjoint slices, findings
verified by the coordinator against the source before any fix was applied.

**Coverage:** `api/src/**` (all 60 modules), `api/db/`, `web/**`, `capture/src/**`,
`mcp/**`, `docker-compose.yml`, `proxy/nginx.conf`, `deploy.sh`, `ops/**`,
`.github/workflows/**`.

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| Critical | 4 | **4** | 0 |
| High | 27 | **25** | 2 (both need an ADR) |
| Medium | ~53 | 1 | ~52 |
| Low | ~38 | 2 | ~36 |

Criticals and Highs are closed except the two below, which are **deliberately deferred
because they are decisions, not defects** — fixing either changes customer-visible
behaviour and belongs in an ADR, not in a review-remediation commit:

- **Sub-tenant cap default** (`entitlements.js`) — unallocated child meters currently
  fall back to the *full* plan cap. Write-time enforcement now prevents new
  over-allocation (the sum across children can no longer exceed the parent's effective
  cap), but changing the *default* retroactively reduces existing sub-tenants'
  capacity. That is a pricing change under ADR-0004.
- **Global TEXT primary keys** on products/personas/competitors (`portfolio.js`) —
  cross-tenant slug squatting and an existence oracle are live now that the create
  routes are reachable by every tenant. The stale comment claiming otherwise has been
  corrected. The real fix is UUID PKs + composite junction keys: a storage change
  needing its own ADR and migration.

Open Mediums are tracked by this document, per the rubric's "deferrable only with a
tracking ticket" rule.

---

## Critical — all fixed (commit `6d920e1`)

### C1. `GET /meetings/:id` was completely unauthenticated
`api/src/index.js` — no auth middleware; returned the full operator record (transcript,
analysis incl. internal `knowledgeGaps`, `meta.tenantId`, raw Recall bot payload).
Directly exploitable: `GET /portals/:id` publishes `meeting.id` to anonymous share-link
holders by design, so any prospect could trade that id for the unstripped record.
**Fixed:** requires auth; `meta.tenantId` must match the caller; 404 (not 403) so a
foreign tenant cannot confirm the id exists; legacy no-tenant records fail closed.

### C2. `/admin/portals` and `/admin/meetings` returned every tenant's data
`api/src/index.js` — mounted with `authMiddleware` only, calling `store.listPortals` /
`store.listMeetings`, which are global Redis prefix scans with no tenant predicate. Any
signed-in user of any tenant, including a fresh trial signup, could read the 100 most
recent portals and meetings platform-wide. The ADR-003 deprecation note covers keeping
the routes alive, not leaving them unscoped. **Fixed:** both superadmin-only. No caller
remained in `web/`.

### C3. Founders' battlecards injected into every Pro tenant's Arena grounding
`api/src/knowledge/globalCache.js` + `api/src/arena.js` — `getGlobalText()` took no
tenant and returned a singleton assembled exclusively from the Founders tenant's
`ORG_INTELLIGENCE`/`BATTLECARDS` docs, while `arena.js` injected it into roleplay
grounding for whatever tenant owned the portal. Arena is no longer Founders-only; it is
a general Pro feature. Every Pro tenant's practice session was grounded on Founders'
competitor punchlines and escalation paths, which the model then speaks aloud.
**Fixed:** returns `''` for non-Founders callers; grounding degrades as it already does
before a cache is built. Stale comment corrected.

### C4. Unscoped `companies` join + unverified `companyId` in contacts
`api/src/contacts.js` — `LEFT JOIN companies c ON c.id = pc.company_id` had no tenant
predicate (the adjacent `personas`/`products` joins both did), and `create()` trusted a
caller-supplied `companyId` behind a tenant-blind FK. A tenant holding another tenant's
company UUID could attach a contact and read that company's name/domain back.
**Fixed:** both halves.

---

## High — fixed

| # | Area | Finding |
| --- | --- | --- |
| H1 | `index.js` | `POST /meetings` dispatched a ~$1 Recall bot with no `requireFeature`/`requireCapacity`/metering — unlimited free bots for any ACTIVE tenant. Now gated and metered like `/missions`, with `refundCapacity` on both failure paths. |
| H2 | `web/admin/admin.js` | Market Watch finding source link built with `escapeHtml` only — scraped `javascript:` URL executes in the authenticated admin origin on click. Now `safeHref`. |
| H3 | `web/admin/admin.js` | KB intel-card title link, same defect, same fix. |
| H4 | `web/portal/portal.js` | KB source-drawer link, same defect; `portal.js` had no `safeHref` at all. Helper ported and applied. |
| H5 | `scheduler.js` | `watchTick` omitted `t.plan_version`, so every cron watch run evaluated v2 tenants against the **v1** catalog (v1 Pro 500 vs v2 Pro 250) — double the paid allowance. |
| H6 | `journeyEmails.js` | No per-tenant try/catch: one SendGrid rejection aborted the whole loop, so every tenant ordered after it silently never received day2/day7, forever. |
| H7 | `gemini.js` | `redis.keys()` on the shared Redis that also holds sessions and rate-limit state — blocks the single-threaded server on every cache invalidation. Now `scanStream`. |
| H8 | `capture/src/main.py` | Recall webhook `_verify_svix_signature` returned success when the signing secret was unset, and compose defaults it empty — a missing env var leaves `/webhooks/recall` fully unauthenticated and replayable. Now fails closed outside dev. |
| H9 | `proxy/nginx.conf` | `location ~ ^/api/_internal` is case-sensitive but Express routes case-insensitively — `/api/_Internal/...` reached internal endpoints from the public internet. Now `~*`. |

## High — fixed in the second remediation pass (`hub-and-spoke`, Sonnet spokes)

Applied by eight fix spokes over disjoint file sets, each finding verified by the
coordinator before and after. All 34 tests pass.

**Billing / money** — checkout now 409s instead of creating a second subscription
(silent double-billing); `customer.subscription.deleted` verifies the subscription id
before downgrading, so a stale cancel can no longer drop a paying tenant to Free;
sub-tenant invite validates fully *before* touching Stripe and resyncs the quantity on
a late failure; expired PENDING invites no longer occupy a billed slot forever;
`dispatch-bot?force=1` now charges an engagement unit (with refund on failure or a
lost race) instead of spawning unlimited free $1 bots; `dispatchBot` claims the row
atomically via a `dispatching` sentinel before calling Recall, so a rep clicking "send
bot now" as the cron fires can no longer put two bots in a customer's meeting.

**Auth / security** — password-reset rate limiting keys on `devices.clientIp(req)`
instead of the client-controlled leftmost `X-Forwarded-For`; the device OTP is no
longer logged or returned in the login response, and fails closed in production;
`bootstrapFoundersAdmin` scopes both its lookup and its UPDATE to the Founders tenant,
so `ADMIN_EMAIL` pointed at a customer address can no longer grant them cross-tenant
superadmin.

**Performance / availability** — dashboard bounds both unbounded reads (company names
now fetched only for the ~6 candidates, research capped at 500 most-recent);
`/admin/calls` replaces blocking `KEYS` with `scanStream` and projects each blob as it
is parsed so full transcripts are never retained; Market Map threat scoring is cached
per tenant for an hour and its cross-join bounded on both sides; ingest rejects
documents over `KB_MAX_CHUNKS` (default 1000) with a 413 before spending on
embeddings; brief generation has a `generateContent` timeout and the scheduler's brief
and bot-dispatch phases now run under independent guards, so a hung LLM call can no
longer wedge bot dispatch platform-wide; `_archive_video` streams to R2 via
`upload_fileobj` instead of buffering a multi-GB recording into RAM; public signup
rate-limits per IP and per target email *before* bcrypt, closing the mail-relay and
CPU-sink vector.

**Behaviour changes worth knowing about**
- Market Map refreshes at most hourly per tenant (was live), and on tenants past 400
  prospects / 3000 intel chunks the overlap factor considers only the most recent of
  each.
- Dashboard signal aggregates derive from the 500 most-recently-researched companies;
  identical output for any tenant below that, which is every tenant today.
- Upgrading plan via the Pro card now returns 409 directing the user to the billing
  portal, rather than silently creating a second subscription.

## Medium (~53) — tracked, not fixed

Grouped by file. Each is a real defect; none blocks the primary user flow.

- **`auth.js`/`sessions.js`/`secretbox.js`** — PATs survive "sign out everywhere" and
  tenant suspension; `secretbox` silently stores plaintext when `ENCRYPTION_KEY` is
  missing (warn only, unlike `auth.js` which fails closed); weak `JWT_SECRET` warned
  but not rejected; `passwordReset.consumeToken` is a GET-then-DEL race despite being
  documented atomic; `X-Device-FP` lets the client choose its own device identity;
  OTP resend resets the attempt counter (25 guesses/15min).
- **`billing.js`/`credits.js`/`gating.js`** — `credits.tryConsume` `SKIP LOCKED`
  spuriously 402s when the balance is one grant; `subscription.updated` applies an
  out-of-order event snapshot; `/billing/confirm` accepts a session with no
  `tenantId` metadata; invite accept is non-atomic (double-accept → two child
  tenants); `sendPlanActivatedEmail` throws `ReferenceError: per` so the
  plan-activation email is **never** sent.
- **`index.js`/`erasure.js`** — error handler echoes internal `err.message` on 500s;
  `/admin/caches` and `/admin/overview` expose platform state to any tenant user;
  erasure misses portals whose parent meeting lacks `meta.tenantId` (GDPR residue);
  `/onboarding` and `/contact` unthrottled; `POST /gemini/roleplay/:slug` is authed but
  unmetered Gemini spend.
- **`integrations.js`/`crm/`** — Calendly refresh has no single-flight lock and its
  single-use token can be burned, permanently breaking the connection; OAuth `state` is
  not bound to the initiating browser (victim can be induced to bind their account into
  an attacker's tenant); Calendly webhook has no timestamp tolerance (replayable);
  OAuth grants + the Calendly route index live only in Redis, which this repo documents
  as ephemeral; inbound email ingests with no SPF/DKIM or sender check (KB poisoning);
  no outbound timeouts anywhere except `resolveMeetingUrl`; CRM credential decrypt
  failure swallowed to `{}`.
- **`knowledge/`** — SSRF guard misses non-dotted-quad IP literals (`http://2130706433/`);
  R2 object written before the transaction (orphans on failure); OCR silently truncated
  at 16K tokens and stored READY; scraped pages reach LLM prompts unneutralized
  (prompt injection into battlecards/scoreboards); malformed PDFs surface as 500s;
  NewsAPI fetch has no timeout.
- **`companies.js`/`contacts.js`/`portfolio.js`** — `POST /companies` passes an
  unvalidated body to INSERT (missing `name` → 500); `linkContactsToMission` ignores its
  `tenantId`; portfolio PATCH accepts null/empty `name`.
- **`watch.js`/`scheduler.js`/`proposals.js`/`missions/`** — watch claim failure
  swallowed (double-charge); scheduled watch consumes a metered unit even when the run
  fails, with no refund; retention purge only scans the 2000 most-recent meetings;
  digest email interpolates LLM/web strings into HTML unescaped; watchTick fires up to
  25 concurrent research pipelines uncapped; Founders-tenant fallback in the analysis
  pipeline is a live cross-tenant grounding path for any missing-meta meeting; proposal
  version numbering races; cancelling a mission never refunds the engagement unit.
- **`platformAdmin.js`/`onboarding.js`/`dashboard.js`/`exportDocx.js`** — contact form
  unthrottled; unescaped company name in outbound email HTML (attacker-chosen link in a
  DKIM-signed DealScope email); email addresses in application logs (erasure gap);
  Gemini calls have no timeout; `/dashboard/setup` swallows every exception; platform
  admin write routes accept non-UUID ids and unvalidated timestamps (500s);
  `POST /export/docx` blocks the event loop on a 1 MB body with no gate.
- **infra** — `ops/backup-db.sh`'s empty-dump guard is unreachable under `pipefail`, so
  truncated backups survive looking valid; capture→api handoff ignores the response
  status (a paid engagement silently produces nothing); no rate limit on `/webhooks/`
  or `/capture/`; Redis password on the container argv on a shared host; CI covers only
  `api/` — `capture/` and `mcp/` ship with no syntax gate.

## Low (~38) — optional polish

Representative, not exhaustive: modulo bias in `_randomString`; revocation cutoff uses
`<` not `<=`; `credits.restore` can inflate a grant; `billingGate` allowlist uses bare
prefix matching; `trialDaysFor` can never return a trial (dead plumbing);
`usage.summary` is lifetime-blind so the superadmin console shows 0 for free tenants;
stale model comment in `retrieval.js`; research dedupe query lacks a tenant predicate;
non-transactional unpin/regenerate pairs in `portfolio.js`; `foundation.snapshot()`
runs 5 sequential queries; `watch.js` hardcodes the year `'2026'` (silent recency
degradation from 2027-01-01); orphaned `failed` meeting rows per retry;
`platformAdmin.js` header still claims READ-ONLY; `domainsRelated` treats a public
suffix as registrable; nginx `/health` sets Content-Type via `add_header` (ineffective);
MCP client reports a non-JSON 200 as "no results".

---

## Notes on method

Each spoke was told to verify against source and quote the offending line, and to
explicitly separate deliberate decisions from defects. Several correctly identified
in-repo decisions and did **not** file them (globalCache sharing tenant-neutral
research; `/portals/:id/report.docx` being public by design; the relevance quarantine;
fail-open Redis checks in `sessions.js`/`loginGuard.js`; signature-verified webhooks;
bounded CRM pagination). Two findings were filed *because* a comment asserting safety
had gone stale — C3 and open-High 18 — which is the failure mode worth watching for on
the next pass.
