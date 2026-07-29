# ADR-0005: Force real, deterministic tenant isolation at the database layer

- **Status:** Proposed
- **Date:** 2026-07-29
- **Authors:** Builder (post-review hardening pass)
- **Affects:** `api/src/db.js`, `api/db/migrations/0027_rls_policies.sql` and
  every later migration that added a tenant-scoped table
  (`0031`, `0035`, `0036`, `0038`, `0040`, `0044`, `0045`, `0049`, `0051`,
  `0052`), `api/src/platformAdmin.js`, `api/src/scheduler.js`,
  `api/src/erasure.js`, `api/db/migrate.js`, `docker-compose.yml`,
  `.env.example` / `.env.production.example`.

## 1. Context

ADR-0001 (§4.2) adopted Postgres Row-Level Security as the second of three
independent isolation layers, on top of the application's `WHERE tenant_id =
$1` filter. `0027_rls_policies.sql` (commit `c274517`, 2026-06-02) built it:
`db.js` runs two pools — `sysPool` (the schema-owning, migration-running
superuser role, `POSTGRES_USER`) and `appPool` (a restricted role,
`DATABASE_APP_USER`, granted `NOBYPASSRLS`). Normal authenticated,
non-superadmin requests are wrapped by `auth.js`'s `proceedInTenantContext` in
`db.runWithTenant(tenantId, …)`, which — only when the `RLS_ENFORCE` flag is
on — routes the request's queries to `appPool` inside a short transaction
that sets `app.tenant_id` via `SET LOCAL`. Everything else (superadmin
requests, migrations, boot, cron, erasure) runs on `sysPool`.

**What today's measurement actually shows** (checked directly against the
running `ghost-db`/`dsp-db` containers and the migration files, 2026-07-29):

- **38 tables have `relrowsecurity = true`** (`pg_class` query against the
  live schema); **zero have `relforcerowsecurity = true`** — nothing in the
  repo has ever issued `FORCE ROW LEVEL SECURITY`. This part of the commonly
  assumed gap is real.
- **`companies` is not one of the gaps** — it has had RLS enabled since
  `0027` (it's in the migration's table array, and `\d+ companies` on the
  live DB confirms `rowsecurity=t`). The C4 leak (`contacts.js`'s
  `companies` join with no tenant predicate, closed in `6d920e1`) was an
  **application-layer bug in a JOIN clause**, not a table missing RLS. It is
  still the right motivating example, for a more specific reason below.
- **Three tenant-scoped tables added *after* `0027` never got RLS at all**:
  `usage_costs` (`0049_pricing_v2.sql`), `journey_emails`
  (`0051_journey_emails.sql`), `user_prefs` (`0052_user_prefs.sql`). `0027`'s
  own header comment warned this would happen ("any NEW tenant-scoped table
  … MUST add its own `ENABLE ROW LEVEL SECURITY` … or it will be wide-open to
  the restricted role") — and it has, three times, in the five migrations
  since. A convention enforced only by a code comment does not hold.
- **`RLS_ENFORCE` ships off by default and stays off unless an env file says
  otherwise.** `docker-compose.yml` defaults it to `off`; `.env.example`
  ships `RLS_ENFORCE=off`; the original commit message describes the whole
  feature as "committed default off." Only `.env.production.example` carries
  the intent — as a comment ("RLS stays on in production") next to
  `RLS_ENFORCE=on` — with nothing in code that checks it. Right now, both
  running environments (`ghost-api` and `dsp-api`) do have `RLS_ENFORCE=on`
  set in their env files — but that is a fact about today's `.env`/`.env.production`
  files, which are gitignored, hand-maintained, and not verified anywhere. A
  fresh environment, a reset env file, or a copy-paste of `.env.example`
  reintroduces the gap with no error and no warning.
- **A wrong-password `DATABASE_APP_PASSWORD` fails closed *when
  `RLS_ENFORCE=on`*** (`db.js` `ensureAppRole()` throws), but if
  `RLS_ENFORCE` is simply left `off`, an empty `DATABASE_APP_PASSWORD` only
  logs a warning and boot continues — indistinguishable, from the logs a
  human actually reads at 3am, from every other correctly-configured `off`
  environment.
- **The `FORCE` gap is not the safety net people probably think it is,
  today.** We verified this empirically rather than take the Postgres docs
  on faith: created a throwaway table, `ENABLE`+`FORCE ROW LEVEL SECURITY`,
  a restrictive policy, then queried as both roles with no GUC set.
  `ghoststream_app` (the `appPool` role — ordinary, non-owner, no
  `BYPASSRLS`) was **already correctly filtered to zero matching rows**,
  identically with or without `FORCE` — ordinary roles were never exempt in
  the first place, so `FORCE` changes nothing for the path that actually
  serves tenant traffic today. `ghoststream_user` (the `sysPool` role) saw
  **every row regardless of `FORCE`** — because `\du` shows it holds not
  just table ownership but `SUPERUSER` and an explicit `BYPASSRLS`
  attribute, and Postgres superusers/`BYPASSRLS` roles bypass row security
  unconditionally; `FORCE ROW LEVEL SECURITY` only revokes the separate,
  narrower exemption an *ordinary* owning role gets, and has no effect on a
  superuser or `BYPASSRLS` role no matter how it's set. **Adding `FORCE` to
  every table today, by itself, protects nothing that isn't already
  protected** — it is real, correct, and still worth doing (see Decision),
  but this ADR should not be sold as closing the gap on its own.
- **The actual gap is which code paths run on `sysPool` at all**, since that
  is the one role no Postgres-level policy can constrain. Application-level
  `WHERE tenant_id = $1` remains the *only* real control on every one of
  those paths — exactly the control the 2026-07-29 review
  (`docs/code-review-2026-07-29.md`) found silently missing on a `companies`
  join (C4), unmetered on a dispatch route (H1), and un-tenant-scoped on two
  admin list endpoints (C2). C4 in particular is proof by example: the same
  bug, if it had reached a query running through `appPool` under
  enforcement, would have come back empty (RLS on `companies` would have
  filtered the foreign-tenant row out of the join) instead of leaking. It
  happened to leak here because the review doesn't say which pool the
  request ran through, and there is currently no way to *know*, from outside
  the code, whether a given route is on the enforced path or the bypass
  path — that ambiguity is the thing worth fixing, not just the `FORCE` flag.

This ADR proposes to close the *measurable* gaps (`FORCE`, coverage, fail-closed
enforcement) and to be honest that they are necessary but, on the current role
architecture, not sufficient — the harder, higher-blast-radius question of
narrowing `sysPool`'s privileges is raised but deliberately **not** decided
here (see Open questions).

## 2. Decision drivers

- **A safety net that silently doesn't hold is worse than no safety net**,
  because it changes behaviour under incident review and change approval —
  "RLS covers this" has to mean something a human can rely on without
  re-deriving the role graph.
- **No regression for legitimate cross-tenant paths.** Superadmin console,
  migrations, cron fan-out, and erasure all have to keep working; breaking
  any of them to chase a security property is not an acceptable trade at
  this company's size.
- **Fail closed, not warn-and-continue**, matching the standing convention
  this repo already applies elsewhere (`auth.js`'s `JWT_SECRET`,
  `secretbox.js`'s at-rest encryption) — RLS enforcement should not be the
  one exception.
- **Coverage has to survive the next ten migrations**, not just the ones
  already written — three misses in five migrations since `0027` is the
  evidence that a comment-only convention isn't durable.
- **CI cannot validate any of this.** `docs/claude/commands.md` is explicit:
  there is no Postgres in CI, so anything touching `db.query` can't be
  unit-tested today. Whatever is decided has to be validatable by hand on
  staging, because it cannot be validated by the automated gate.
- **Distinguish "we changed a policy" from "we changed who can ignore
  policies."** The first is cheap and mostly reversible; the second touches
  every legitimately-privileged code path at once and needs its own review.

## 3. Alternatives considered

### A — Status quo: application-level filtering + code review only

- **Pro:** zero engineering cost; no risk of breaking a legitimate
  cross-tenant path.
- **Con:** this is precisely what the 2026-07-29 review demonstrated is
  fallible — C4 shipped past normal review until a dedicated ten-agent
  fan-out audit caught it, and the one automated gate that runs on every
  push (CI) structurally cannot exercise DB-touching code at all. **Rejected**
  as the sole control; it's necessary, not sufficient.

### B — Query-level lint (extend ADR-0001's proposed `no-untenanted-kb-query`)

- **Pro:** catches the exact bug class (a forgotten/incomplete `WHERE`) at
  commit time, cheap to run, and would plausibly have flagged C4 if it had
  been generalized past `kb_*` tables.
- **Con:** only as good as the tables and SQL shapes it's taught to
  recognize — a new table, a new JOIN shape, or a raw string built outside
  the linted call sites falls outside it until someone updates the rule.
  That's the same "coverage drifts as the schema grows" failure this ADR is
  reacting to, just moved to a different layer, and it does nothing for
  in-process cron/erasure code that legitimately spans tenants. **Not
  rejected — recommended as a complement, not a substitute** (see Builder
  hand-off).

### C — Per-tenant schemas or databases

- **Pro:** physical isolation; a query bug cannot cross a tenant boundary no
  matter which role runs it.
- **Con:** ADR-0001 §3 (Options A/B) already rejected this for this
  product's scale — onboarding cost, HNSW index fragmentation, and
  migration fan-out all get worse, and nothing about the 2026-07-29 review
  changes that calculus. Re-litigating it here would be a much bigger ADR
  than "harden the RLS we already have." **Rejected, reaffirming ADR-0001.**

### D — De-privilege `sysPool`'s role outright (strip `SUPERUSER`/`BYPASSRLS`)

- **Pro:** the only change that would make `FORCE ROW LEVEL SECURITY`
  actually constrain something new — this is the one alternative that
  closes the real gap identified in §1, not just the documented one.
- **Con:** `sysPool` is simultaneously the migration runner, the boot-time
  role provisioner (`ensureAppRole`'s `ALTER ROLE`/`CREATE ROLE` need
  `CREATEROLE`/superuser), the superadmin console's backing role
  (`platformAdmin.js`), the cron fan-out role (`scheduler.js`), and the
  erasure role (`erasure.js`). Stripping its privileges breaks all five at
  once, and the failure mode of getting it wrong is "nothing boots," which
  is a worse outage than the exposure it fixes. **Not proposed as a blanket
  change in this ADR** — see Open questions for the narrower, path-by-path
  version of this that's worth its own follow-up decision.

## 4. Decision

Adopt the parts of the hardening that are unambiguously correct and
reversible now; punt the role-architecture question that would actually
close the `sysPool` bypass to a follow-up decision (§6).

1. **Add `FORCE ROW LEVEL SECURITY` to every table currently under `ENABLE
   ROW LEVEL SECURITY`** (all 38, per §1's measurement), in a new migration.
   Framed honestly per §1: this is correct hygiene and closes the
   *documented* gap (an ordinary, non-superuser owner would otherwise bypass
   policies), but verified today to be a no-op against the two roles that
   actually exist in this system. Ship it anyway — it's cheap, reversible,
   and becomes load-bearing the moment anyone changes table ownership or
   role attributes without re-deriving this analysis from scratch.
2. **Extend RLS coverage to the three orphaned tables** — `usage_costs`,
   `journey_emails`, `user_prefs` — using the same `tenant_id`-equality
   pattern as `0027` for the first two, and the indirect via-`users`-FK
   pattern already used for `trusted_devices` for `user_prefs` (it's keyed
   by `user_id`, not `tenant_id`).
3. **Make `RLS_ENFORCE` fail closed in production.** `db.js` (or `index.js`'s
   boot sequence) should refuse to serve traffic — not merely warn — when
   `NODE_ENV=production` and `RLS_ENFORCE` is not `on`. This is the change
   that actually addresses §1's real finding: today "RLS is enforced in
   prod" is true only because two `.env` files happen to say so, unverified
   by anything except a comment in an example file.
4. **Companies stays exactly as it is** — it already has RLS; no change
   needed there beyond `FORCE` (item 1). The C4 pattern (unscoped join) is
   addressed by application code + Alternative B's lint, not by this ADR.
5. **Do not change what runs on `sysPool`.** Superadmin/platform-admin
   reads, the migration runner, cron fan-out, and erasure cascades keep
   running exactly as they do today (§5 catalogs each and why). This ADR
   is scoped to policy coverage and the enforcement flag, not to the role
   graph.

## 5. Consequences

**What gets genuinely safer:**
- A future table that forgets its own RLS migration is now the *only*
  remaining coverage gap (down from three known instances); the lint from
  Alternative B, if built, would close that too.
- Production can no longer silently run with enforcement off because an env
  file reverted or a fresh checkout used the example defaults — it now
  fails loudly at boot instead.
- `FORCE` removes one theoretical bypass (an ordinary, non-superuser
  owning role) even though no such role exists today — insurance against a
  role-config mistake made without re-reading this ADR.

**What this does *not* fix, and must not be reported as fixed:**
- `sysPool` — used by every one of the four paths below — remains a full
  bypass of every policy, `FORCE` or not, because it is a Postgres
  superuser with `BYPASSRLS` explicitly granted. **Application-level
  `WHERE tenant_id = $1` is still the only real control on those four
  paths after this ADR ships.** That is an intentional, catalogued trade,
  not an oversight — but it means the C4 pattern (a forgotten predicate)
  remains fully exploitable on any of them.

**The four paths that rely on `sysPool`'s bypass, read from source, and
what this ADR requires of each:**

| # | Path | Why it needs the bypass | What changes here |
| - | --- | --- | --- |
| 1 | **Superadmin / platform-admin cross-tenant reads** (`api/src/platformAdmin.js` — every handler is a plain `db.query(...)` with no tenant context; e.g. `SELECT count(*)::int AS n FROM tenants`, per-tenant drill-down by explicit `WHERE tenant_id = $1` parameter, not a GUC) | The feature *is* cross-tenant visibility for the platform console. | Nothing. Stays on `sysPool`. Audit trail (`tenant_admin_audit`, per ADR-0001 §4.4 threat 10) is the compensating control, not RLS. |
| 2 | **The migration runner** (`api/db/migrate.js`, invoked from `index.js` before `db.ensureAppRole()`) | Runs arbitrary DDL and one-shot backfills; DDL requires the owning/superuser role by construction. | Nothing changes mechanically. A migration author adding `FORCE ROW LEVEL SECURITY` in a new migration must remember that testing "did this work" *from the migration script itself* will always show every row, because the script runs on the same superuser it's trying to restrict — verification has to run as `ghoststream_app` explicitly, not "the migration applied without error." |
| 3 | **Erasure cascades** (`api/src/erasure.js`) — reads/deletes one tenant's Postgres rows via plain `db` calls (no `runWithTenant`), relying on `ON DELETE CASCADE` FKs | Currently a `sysPool` operation by default, not by necessity — it only ever targets **one** tenant at a time, unlike the other three. | Not changed by this ADR. It is the one path that looks like it *could* move onto `appPool`/`runWithTenant(tenantId)` and become an ordinary RLS-checked operation instead of a trusted bypass — flagged as an open question (§6), not decided, because cascade-delete behaviour under `USING`-only policies (Postgres does not apply `WITH CHECK` to `DELETE`) needs to be proven on staging before relying on it for a destructive, compliance-relevant operation. |
| 4 | **Cross-tenant background cron** (`api/src/scheduler.js` — `watchTick` and related sweeps iterate due rows across every tenant per timer tick; the review's Medium list separately notes `watchTick` "fires up to 25 concurrent research pipelines uncapped") | Fundamentally a fan-out across tenants in one process; there is no single tenant context to scope it to. | Nothing changes here either. Same caution as #1: if any of this code is ever reused from a request-handling path (e.g. a debug/admin endpoint that calls into scheduler internals), that handler would silently inherit the bypass — worth a code-comment warning at minimum, tracked as a Medium-severity note rather than blocking this ADR. |

**The nastier failure mode — silent empty results instead of an error:**

A missing or wrong policy on the `appPool` path doesn't crash; it returns
zero rows. That reads to a rep as "my dashboard is empty" or "no companies
show up," not as a 500 — the review's Medium list already flags
`/dashboard/setup` swallowing every exception as a related pattern, and this
adds another way to get a quiet-empty state. Detecting it requires:
- A **canary check**, run against `appPool` (not `sysPool` — see the
  migration-runner note above), that seeds/reads one known row per policy
  family and asserts exactly one row comes back; alert on 0 (over-blocking)
  or >1 (under-blocking / cross-tenant leak). This cannot be a CI unit test
  (no Postgres in CI); it has to run on staging, either as a one-shot
  pre-promotion script or a scheduled job.
- Treating any tenant-facing "unexpectedly empty" bug report as an RLS
  suspect, not just an application bug, once `RLS_ENFORCE` is fail-closed —
  worth a line in the on-call runbook.

**Residual risk explicitly accepted:** the four `sysPool` paths above remain
a full bypass; a bug in any of their own `WHERE tenant_id` clauses is not
caught by anything this ADR proposes. This is the same residual risk
ADR-0001 §5 already accepted for the migration role — this ADR extends the
same acceptance to platform-admin, cron, and erasure, explicitly, rather
than leaving it implicit.

## 6. Staged rollout (staging first, rollback at every stage)

Each stage is independently shippable and independently reversible; do not
skip ahead to production until the prior stage has soaked and the canary
(added in Stage 0) is quiet.

**Stage 0 — observability before any enforcement change (staging).**
Build and run the canary check described in §5 against the *current* state
(coverage gaps and all), so its baseline is known before anything moves.
Purely additive; no rollback needed.

**Stage 1 — close the coverage gap (staging → soak → production).**
New migration: `ENABLE ROW LEVEL SECURITY` (no `FORCE` yet) on `usage_costs`,
`journey_emails`, `user_prefs`. Validate with the Stage 0 canary plus a
manual two-tenant smoke test (seed two tenants, confirm each sees only its
own rows through `appPool`, confirm `sysPool` still sees both — expected,
per §5). **Rollback:** `ALTER TABLE … DISABLE ROW LEVEL SECURITY` per table;
instant, no data change.

**Stage 2 — prove the `FORCE` mechanics on one low-traffic table (staging
only).** Add `FORCE ROW LEVEL SECURITY` to a single canary table first
(e.g. `subtenant_invites` or `trusted_devices` — low write volume, not on
the hot path) before touching all 38. Confirm `sysPool` behaviour is
unchanged (expected: yes, per §1's empirical test) and `appPool` behaviour
is unchanged (expected: yes, it was never exempt). The point of this stage
is purely to rehearse the migration-and-rollback mechanics on one table
before it's irreversible-in-spirit across the whole schema. **Rollback:**
`ALTER TABLE … NO FORCE ROW LEVEL SECURITY` on that one table.

**Stage 3 — `FORCE` across all 38+3 tables (staging → soak).** If Stage 2
was a true no-op, this should be too — that's the expected, desired
outcome. If it is *not* a no-op (an error or a behavior change surfaces
anywhere), stop and audit before proceeding: it means some code path
depends on owner-bypass semantics that weren't accounted for in §5's
catalog, and that needs to be found before it reaches production, not
patched around. Soak at least one full release cycle, per the cadence
ADR-0001 §4.5 already used for RLS. **Rollback:** `NO FORCE ROW LEVEL
SECURITY`, per table, applied via a follow-up migration (never edit the
applied one, per `docs/claude/conventions.md`).

**Stage 4 — fail-closed `RLS_ENFORCE` check (staging → soak → production).**
Ship the boot-time check from Decision item 3. Validate on staging by
deliberately unsetting `RLS_ENFORCE` in a throwaway env and confirming the
API refuses to serve traffic with a clear error, before trusting it in
production. **Rollback:** revert the check; the flag itself is untouched
and the system returns to today's warn-and-continue behaviour.

**Stage 5 — promote to production.** Standard hub-and-spoke promotion
(`docs/claude/conventions.md`): merge `origin/main` into the branch,
re-validate, fast-forward `main`, human go + green CI + a prod-checkout
snapshot branch, `./deploy.sh production`, smoke-test. Stages 1–4 should
each have already soaked on staging individually — this stage does not
bundle them into one big-bang deploy.

**Not part of this rollout, deliberately:** any change to what runs on
`sysPool` (§3 Alternative D, §6 Open questions). That is a separate,
larger decision this ADR does not make.

## 7. Open questions

- **Is shipping `FORCE ROW LEVEL SECURITY` now, knowing it's a no-op against
  both roles that exist today, the right call — or should it wait and ship
  together with a role-architecture change so it isn't reported as "tenant
  isolation hardened" while the actual `sysPool` bypass is untouched?** This
  ADR's authors lean toward "ship now, document honestly" (insurance is
  still insurance), but it's a judgment call a human should make
  explicitly, not inherit from a migration diff.
- **Should `sysPool`'s runtime role be split** into a migration-only
  superuser (used solely at boot/migration time) and a narrower
  "cross-tenant reader" role for `platformAdmin.js`/`scheduler.js` that
  carries `BYPASSRLS` but not `SUPERUSER`/`CREATEROLE`/`CREATEDB`/
  `REPLICATION` — all of which `ghoststream_user` currently also holds and
  none of which the console or cron need? This is Alternative D, scoped
  narrower; it's the change that would make `FORCE` matter, but it touches
  every legitimately-privileged path at once and deserves its own ADR and
  its own staged rollout.
- **Should `erasure.js` move onto `runWithTenant(tenantId)`/`appPool`?** It's
  the one bypass path that targets a single tenant, so it's the cheapest of
  the four to convert — but cascade-delete behaviour under `USING`-only
  policies needs to be proven on staging (with a disposable tenant) before
  it's trusted for a GDPR/CCPA-relevant deletion path.
- **What does production do when `RLS_ENFORCE` is found off at boot** — hard
  refuse to start (simple, but a misconfigured env var becomes a full
  outage) or start but return 503 on `/api/*` while still answering
  `/health` (degrades visibly instead of paging on a health check)? This is
  an on-call/runbook decision, not a technical one.
- **Who owns the Stage 0 canary** — a scheduled job (`scheduler.js`, which
  already runs cron) or a separate ops script invoked from `deploy.sh`
  before/after each promotion? Affects whether it's an `api/src` change or
  an `ops/` change.
- **`ghoststream_user` also holds `CREATEDB`/`CREATEROLE`/`REPLICATION`**,
  attributes with no relationship to RLS at all. Worth a separate, smaller
  SOC 2 hardening item (narrow the role to what boot/migrations actually
  use) independent of anything in this ADR — flagged here so it isn't lost.

## 8. Builder hand-off

### PR 1 — RLS coverage gap (Decision item 2)
- New migration (next number after `0053_contact_location.sql`) —
  `ENABLE ROW LEVEL SECURITY` + tenant-equality policy on `usage_costs` and
  `journey_emails` (direct `tenant_id` column, `usage_costs.tenant_id` is
  nullable — mirror `audit_log`'s `WITH CHECK (tenant_id IS NULL OR …)`
  pattern from `0027`, not a bare equality, or legitimate tenant-less rows
  become uninsertable under `appPool`); indirect via-`users`-FK policy on
  `user_prefs`, mirroring `trusted_devices`'s pattern in `0027`.

### PR 2 — FORCE ROW LEVEL SECURITY (Decision item 1, staged per §6)
- New migration: `ALTER TABLE … FORCE ROW LEVEL SECURITY` for every table
  touched by `0027`, `0031`, `0035`, `0036`, `0038`, `0040`, `0044`, `0045`,
  and PR 1 above. One `DO $$ … FOREACH … $$` block per table group, mirroring
  `0027`'s own style.

### PR 3 — fail-closed RLS_ENFORCE (Decision item 3)
- `api/src/db.js` and/or `api/src/index.js` boot sequence — refuse to
  proceed past `ensureAppRole()`/`db.ping()` when `NODE_ENV=production` and
  `RLS_ENFORCE` is not `on`. Update the comment block at the top of `db.js`
  (currently describes off-by-default as the whole feature) to describe the
  new fail-closed contract.
- `.env.example` — add the same "must be `on` in production" comment
  `.env.production.example` already carries, so the two files stop
  disagreeing silently.

### PR 4 — canary check (§5, §6 Stage 0)
- New script (location TBD per the Open Questions ownership call — likely
  `api/scripts/rls-canary.js` if scheduler-owned, or an `ops/` script if
  deploy-owned) — seeds/reads a known row per RLS-covered table family
  through `appPool` under a known tenant, asserts row count is exactly 1,
  alerts otherwise. Not a CI job (no Postgres in CI); runs on staging
  on-demand and/or on a schedule.

### Not in scope for any PR above (tracked as Open questions only)
- Any change to `platformAdmin.js`, `scheduler.js`, `erasure.js`, or
  `api/db/migrate.js`'s access pattern — these keep using `sysPool` exactly
  as they do today.
- Any change to `ghoststream_user`'s role attributes (`SUPERUSER`,
  `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION`).
