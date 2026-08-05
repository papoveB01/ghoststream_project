# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

GhostStream (the repo/internal name) ships **DealScope** (dealscope.io) — a self-serve
B2B sales-intelligence platform: prospect discovery, competitor battlecards, AI-joined
sales calls ("engagements"), Arena roleplay, and agentic Market Watch, sold as one
bundle. Monorepo, three deployable services plus infra, orchestrated by
`docker-compose.yml`.

## Repo map

| Path | What it is |
| --- | --- |
| `api/` | Node 22 / Express, CommonJS. The whole product backend + REST API — **almost all logic lives here**. `src/index.js` mounts every router; `src/knowledge/`, `src/missions/`, `src/crm/` are the only sub-packages. |
| `api/db/migrations/` | Numbered SQL, applied in lexical order on api boot. |
| `capture/` | Python/FastAPI (`uvicorn src.main`): meeting capture / recording / streaming, R2 (S3-compatible) uploads. |
| `web/` | Static frontend, no build step: `admin/` (the SPA), plus `arena/`, `onboarding/`, `portal/`, `join/`, the landing page and legal pages. |
| `proxy/` | nginx; serves `web/` and reverse-proxies `/api/ → api:3000`, `/capture/ → capture:8000`, and webhook paths. |
| `mcp/` | Separate Node package: an MCP server exposing GhostStream tools (scaffolding; see `docs/rfcs/0001-lili-integration.md`). |
| `docs/` | ADRs (`adr/`, authoritative for cross-module decisions), RFCs, assessments, ops notes. |
| `ops/`, `deploy.sh` | Backup script and the per-environment deploy entrypoint. |
| infra | `db` = Postgres 16 + pgvector; `redis` = sessions, rate-limit state, ephemeral job state. |

`web/` and `proxy/` are **live bind-mounts** — edits apply on refresh, no rebuild.
`api/` is **baked into the image** — changes need `./deploy.sh` (or a compose rebuild).

## Rules

Detailed guidance lives in `rules/` (not `.claude/`, which is gitignored and would not
travel with the repo). **Read the relevant file before you start work in that area** —
these are lazily loaded on purpose, so don't work from the summaries below.

| File | Read it when |
| --- | --- |
| `rules/commands.md` | Running tests, migrations, or the api locally; anything touching CI. |
| `rules/architecture.md` | Touching `api/src/` — the request pipeline, multi-tenancy, knowledge base, engagements, or the cross-cutting modules. |
| `rules/billing-entitlements.md` | **Any** change to plans, caps, features, usage metering, credits, gating, or Stripe. The most load-bearing subsystem in the repo. |
| `rules/frontend.md` | Editing anything under `web/` — the admin SPA, landing page, or the other static apps. |
| `rules/code-review.md` | Reviewing code or triaging findings — the Critical/High/Medium/Low rubric and what blocks a merge. |
| `rules/deploy-environments.md` | Deploying, or reasoning about which environment a checkout is. |
| `rules/conventions.md` | Writing code, commits, PRs, migrations, or ADRs — i.e. essentially always before you commit. |

## How work gets built

The four passes below are not a formality bolted onto finished code — they are
how the work is produced. Writing the code is one step of five, and **the author
is never the reviewer of record**:

1. **Decompose before writing.** Size the change against the review that will
   have to absorb it. If a per-file pass would need more than ~10 spokes, the PR
   is too big — split it *first*, and make each half independently coherent: its
   own tests must pass on their own, and it must leave the tree deployable if
   the other half never lands.
2. **Implement.** One reviewable concern per PR (`rules/conventions.md`).
3. **Per-file spokes → 4. cross-integration → 5. confidence verification →
   verdict** — exactly as in "Reviewing a PR" below, run as part of delivering
   the work, not deferred to merge day.

Three rules that separate a real review from a ritual:

- **Spokes never edit.** They report; the implementer fixes. A reviewer who
  fixes what they find stops looking for the next thing.
- **A fix is a claim until it is re-verified.** Re-run the suite and quote the
  numbers *after* fixing. If a fix repairs a guard, re-run the bypass that
  defeated it and confirm it now fails.
- **Never report your own work as verified.** "I ran the tests" is not pass 3;
  pass 3 is someone else proving the claims, including against the live
  dependency the harness cannot reach.

Why this shape: in the 2026-08-05 spend-telemetry PR the author wrote the code,
ran the suite green, and reported it verified. Three defects survived that and
were caught only by independent passes — a `[TEXTUAL]` guard the author claimed
"stops the drift recurring" was defeated twice by ordinary edits (a commented-out
recorder; a reformat that rebalanced its counts); Gemini cached prompt tokens
were billed at ~4× their real rate in the same file whose sibling function
existed specifically to avoid that error; and the obvious fix for the last gap —
instrumenting embeddings — would have recorded *nothing*, because `embedContent`
returns no usage block at all, which only a live API probe revealed.

## Reviewing a PR

Reading a diff top-to-bottom finds the wrong class of defect. The damage lives in how a
changed value is *consumed* somewhere the diff never shows. So a review is four passes,
in this order, and **no PR merges until all four have run**:

1. **Per-file passes, fanned out — one spoke per file** (or per tightly-coupled pair).
   Each reads the *whole* file plus the callers of what changed, never the diff alone,
   and is briefed with the rubric in `rules/code-review.md` plus the specific risk that
   file carries. Spokes review only — they never edit.
2. **Cross-integration pass.** One reviewer over the entire change set, looking for what
   a per-file pass structurally cannot see: a field that became nullable and its readers
   in `web/` or another module, a vocabulary that drifted between producer and consumer,
   a guard whose meaning changed for a caller that didn't change, and **data already
   stored in the old shape** — every review must state what happens to existing rows.
3. **Confidence verification.** Prove the claims instead of accepting them. Run the suite
   yourself and quote the numbers. For a regression fix, revert the fix and confirm the
   new test actually fails. For anything the harness cannot reach — a live model schema,
   a provider response — exercise it against the real dependency **before** merge; CI
   being green says nothing about it.
4. **Verdict.** `SAFE TO MERGE` / `MERGE WITH FIXES` / `DO NOT MERGE`, each finding with
   `file:line`, its concrete failure, and the fix — plus an explicit list of what was
   checked and found clean, so "no finding" is distinguishable from "never looked".

Why this shape: in PR #40 (2026-07-30) the review caught that awaiting the Market Watch
worker pool turned one hung model call into a silent, indefinite outage for every tenant
— invisible in a diff that showed only a loop becoming a worker pool — and that nothing
in CI or the CD smoke test ever exercised a Gemini response schema against the live API,
so a rejected schema would have 502'd discovery for every tenant with the deploy still
reporting green.

## Non-negotiables

These are the ones that cause unrecoverable damage, so they apply even if you haven't
opened the rule file yet:

- **Never merge on a single-pass review, and never review your own work.**
  Per-file spokes → cross-integration → confidence verification → verdict, every
  time (see "How work gets built" and "Reviewing a PR" above). The passes are
  part of building the change, not a merge-day formality. Merging to `main`
  deploys production unattended, so the review *is* the gate.

- **Never edit an applied migration** — add a new numbered one.
- **Never repoint a v1 `STRIPE_PRICE_*` at a v2 price.** Grandfathering depends on v1
  and v2 price ids staying distinct.
- **Pushing to `main` deploys production.** CI green on `main` → CD deploys staging,
  smoke-tests it, then production, unattended. Nothing else is required, so don't
  fast-forward `main` until the change is meant to be live.
- **Anything uncommitted in an environment checkout leaves the working tree on the
  next deploy.** CD snapshots it to a `<env>-live-snapshot-<utc>` branch first, so it
  is recoverable — but the staging checkout is also the dev workspace, so commit or
  stash work in progress.
- **Don't infer the environment from the folder name** — verify via the env file's
  `APP_BASE_URL` / `CONTAINER_PREFIX` and the running container prefix. (`ops/cd-deploy.sh`
  enforces this automatically; a by-hand `deploy.sh` does not.)
- **Never plain-`git checkout` a branch in an environment checkout.** CD leaves it
  detached at the deployed SHA, and the local branch ref is usually stale — since
  `web/`/`proxy/` are live bind mounts, `git checkout main` silently serves the previous
  release's frontend with no deploy and no signal. Use `git checkout -B main <deployed-sha>`
  so the pointer moves and the working tree doesn't.
- **Every plan cap must clear the ≥35% gross-margin floor** (ADR-0004 §4.3) before it
  ships.
