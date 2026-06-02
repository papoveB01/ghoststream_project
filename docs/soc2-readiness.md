# SOC 2 Type 2 — Readiness Status & Remaining Work

**Last updated:** 2026-06-02
**Scope:** Security (CC1–CC9) + Availability (A1) + Confidentiality (C1) Trust Services Criteria.
**Status legend:** ✅ done & live · 🟡 partial / in progress · 🔴 not started · ⛔ blocked (external)

> This is a living document. As items below are completed, tick the boxes and update
> the "Last updated" date. It is the reference for the remaining SOC 2 work.

---

## 1. Verdict

**Not yet attestable**, but the gap has changed shape. The **technical/system posture is strong** —
essentially all of the original audit's P0/P1 *system* findings are closed and running in production.
What remains is largely **operational + organizational** (governance, monitoring, vendor management)
and the **observation period** — the parts a code change can't satisfy.

Practical framing: the system would **largely pass a Type 1 (design) review**; **Type 2** additionally
requires those controls **operating effectively over 3–12 months**, evidenced to a licensed CPA firm.

> SOC 2 compliance is an attestation issued by an auditor, not a state of the codebase. The work below
> gets the *system* ready; the *attestation* requires a compliance program + auditor engagement.

---

## 2. Implemented this engagement (audit findings → closed)

| Finding | Sev | Status | Where |
|---|---|---|---|
| 3rd-party OAuth/API tokens plaintext at rest | P0 | ✅ | `api/src/secretbox.js` (AES-256-GCM); wired into `microsoft.js`, `integrations.js`, `crm/index.js`. Live MS token re-encrypted. |
| No security audit logging | P0 | ✅ | `api/src/audit.js` + migration `0026_audit_log`; events on login/logout/OTP/device/password/token/erasure |
| No automated DB backups | P0 | 🟡 | `ops/backup-db.sh` + cron `30 2 * * *` (daily 02:30 UTC). **Off-site + encryption still TODO.** |
| No login brute-force protection | P1 | ✅ | `api/src/loginGuard.js` (per-account cap 8 / per-IP 30, 15-min window) |
| No server-side session revocation | P1 | ✅ | `api/src/sessions.js` (jti denylist + per-user valid-after); logout/password-change/sign-out-everywhere |
| In-tenant RBAC unenforced | P1 | ✅ | `auth.requireRole/requireRoleWrite`; owner/manager/rep enforced on billing/CRM/tokens/catalog-deletes |
| Unauthenticated mutating routes | P1 | ✅ | `/gemini/caches*` now superadmin-gated (`/arena/*` intentionally public) |
| No security response headers | P1 | ✅ | `proxy/nginx.conf` (HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy, server_tokens off) |
| No dependency lockfile / scanning | P1 | ✅ | `api/package-lock.json` + `.github/dependabot.yml` |
| No right-to-erasure / data deletion | P1 | ✅ | `api/src/erasure.js` + `DELETE /admin/tenants/:id` (Postgres cascade + Redis + R2 + Stream) |
| App-layer-only tenant isolation (no DB backstop) | P2 | ✅ | **Postgres RLS** — migration `0027`, two-pool/GUC in `api/src/db.js`, **enforced** (`RLS_ENFORCE=on`) |
| Known cross-tenant persona leak | P2 | ✅ | `api/src/contacts.js` (tenant-scoped lookup + JOIN) |
| JWT algorithm not pinned | P2 | ✅ | `auth.js` pins HS256 + boot warning on weak `JWT_SECRET` |
| No MFA | — | ✅ | New-device email OTP (`api/src/devices.js`, migration `0025_trusted_devices`) |
| No CI / no tests | P0 (CC8) | ⛔ | `.github/workflows/ci.yml` + `api/test/*` (13 tests, green locally) — **blocked: GitHub Actions billing lock** |

---

## 3. Readiness by Trust Services Criteria

| Area | State | Notes |
|---|---|---|
| **CC6 Logical access** | 🟢 | Auth, MFA, RBAC, hashed PATs, session revocation, RLS, encryption-at-rest, headers |
| **CC7 Ops / vuln / monitoring** | 🟡 | Audit logging ✅, dependency scanning ✅; **monitoring/alerting/error-tracking missing** |
| **CC8 Change management** | 🟡 | CI + tests authored ✅; not executing (billing); **Git remote divergent from prod** |
| **A1 Availability** | 🟡 | Backups scheduled ✅; **no off-site/encryption, no HA/replication** (single node) |
| **C1 Confidentiality** | 🟢 | Encryption at rest + edge TLS, tenant isolation, erasure |
| **CC1–CC5 Governance/risk/org** | 🔴 | Policies, risk assessment, org/roles, vendor mgmt — **not started; the bulk of Type 2** |
| **CC9 Vendor/risk** | 🟡 | Subprocessor/DPA pages exist but **incomplete**; no executed vendor reviews |

---

## 4. Remaining work

### 4a. Technical (can be done in-code)
- [ ] **Monitoring & alerting** — error tracking (e.g. Sentry), uptime check, basic metrics, on-call routing. *(Highest-value remaining technical gap — CC7.)*
- [ ] **Off-site, encrypted backups** — restic/rclone (or `aws s3 cp`) from `ops/backup-db.sh` to R2/S3; verify a test restore; document RPO/RTO. *(A1)*
- [ ] **PAT least-privilege** — token scopes / read-only PATs; disallow non-expiring tokens (`api/src/auth-tokens.js`). *(CC6.3)*
- [ ] **DOM-XSS pass** — audit the ~186 `innerHTML` sinks in `web/admin/*`; rely less on the permissive CSP. *(CC6.8)*
- [ ] **Password policy** — unify min length (signup 8 vs change 12) to ≥12 + breach check; **rotate the 8-char `ADMIN_PASSWORD`**. *(CC6.1)*
- [ ] **Subprocessor list** — add Stripe, Nylas, NewsAPI, Phyllo to `web/subprocessors/`; name the hosting/DB provider. *(CC9)*
- [ ] **Internal transport** — document the api↔db↔redis docker-bridge as a trusted single-host boundary (or enable PG TLS). *(CC6.1)*
- [ ] **Availability/HA** (stretch) — Postgres standby/replication, Redis persistence/HA; remove single points of failure. *(A1)*
- [ ] Tighten CI `npm audit` from advisory → blocking once aging deps (multer 1.x, pdf-parse) are addressed. *(CC7.1)*

### 4b. Operational (owner: operator)
- [ ] ⛔ **Resolve GitHub Actions billing lock** so CI executes (Settings → Billing). *(CC8.1)*
- [ ] **Reconcile the Git remote with production** — review/merge the 7 feature branches to `main`; make the repo the source of truth (today `main` is ~16 migrations behind the live host). *(CC8.1 — auditor will ask "what's the source of truth for prod?")*
- [ ] Establish a branch-protection + PR-review policy (segregation of duties). *(CC8.1)*
- [ ] Document the deploy runbook (image rebuild, migration safety, rollback). *(CC8.1)*

### 4c. Organizational — the real Type 2 blocker (owner: operator + auditor; not code)
- [ ] Information Security Policy set (access control, data classification, encryption, incident response, change management, vendor mgmt, BCP/DR, acceptable use).
- [ ] Risk assessment + risk register (annual).
- [ ] Access reviews (periodic; who has prod/DB/cloud access).
- [ ] Employee onboarding/offboarding + background checks + security-awareness training.
- [ ] Incident-response plan **+ a tabletop test** with evidence.
- [ ] Vendor/subprocessor risk reviews + **signed DPAs** (Google/Gemini, Recall.ai, SendGrid, Stripe, HubSpot, Microsoft, Calendly, Nylas, Firecrawl, Apollo, Cloudflare, …).
- [ ] Choose a **compliance platform** (Vanta / Drata / Secureframe) to collect evidence + monitor controls.
- [ ] Engage a **licensed CPA firm**; pick the **observation window** (3–12 months) → Type 2 report.

---

## 5. Reference

### Deployment / source-of-truth state
- **Live stack:** 27 migrations applied, `RLS_ENFORCE=on`, backup cron active. All work is deployed to the running host.
- **Branches pushed to `origin` (papoveB01/ghoststream_project), none merged to `main`:**
  `feat/device-otp-verification`, `feat/soc2-hardening-batch-1`, `feat/soc2-hardening-batch-2`,
  `feat/soc2-hardening-batch-3-rbac`, `feat/soc2-ci-and-tests`, `feat/soc2-tenant-erasure`, `feat/soc2-rls`.
- **Caveat:** the GitHub remote diverged from production before this work; `main` is far behind the live code.

### Key controls → files
- Auth/MFA/sessions/RBAC: `api/src/auth.js`, `api/src/devices.js`, `api/src/sessions.js`, `api/src/loginGuard.js`
- Encryption at rest: `api/src/secretbox.js` (env `ENCRYPTION_KEY`)
- Tenant isolation (RLS): `api/src/db.js` (two pools + AsyncLocalStorage GUC), migration `0027_rls_policies.sql`
  (env `RLS_ENFORCE`, restricted role `DATABASE_APP_USER`/`DATABASE_APP_PASSWORD`)
- Audit log: `api/src/audit.js`, migration `0026_audit_log`, read via `GET /admin/audit`
- Erasure: `api/src/erasure.js`, `DELETE /admin/tenants/:id` (`?dryRun=1` to preview)
- Backups: `ops/backup-db.sh` (cron `30 2 * * *`, logs `backups/backup.log`)
- CI: `.github/workflows/ci.yml`, tests `api/test/*.test.js` (`npm test`), `.github/dependabot.yml`

### Verification commands (quick)
- Tests: `cd api && npm test` (Node built-in runner; needs Redis).
- RLS isolation (out-of-band): connect as `ghoststream_app`, `set_config('app.tenant_id', …)`, confirm per-tenant rows.
- Erasure preview: `DELETE /admin/tenants/:id?dryRun=1` (superadmin).
- Rollback RLS: set `RLS_ENFORCE=off` + restart api.

### Rollout notes
- Backend changes need `docker compose up -d --build api` (baked image). `web/` is a live nginx bind mount.
- `proxy/nginx.conf` is a single-file bind mount → editing needs `docker compose up -d --force-recreate proxy`.
- `RLS_ENFORCE` lives in `.env` (gitignored); committed default is `off` (`${RLS_ENFORCE:-off}`), so fresh deploys are safe until the flag is set.

---

## 6. Recommended sequence
1. Engage a compliance platform + auditor → scopes the org program (4c) and starts the observation clock.
2. Fix GitHub billing + reconcile the remote (4b) → unblocks CI and the change-management evidence trail.
3. Add monitoring (Sentry + uptime) (4a) → the most impactful remaining technical control.
4. Off-site encrypted backups + the smaller hardening items (4a).
