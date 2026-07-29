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

## Non-negotiables

These are the ones that cause unrecoverable damage, so they apply even if you haven't
opened the rule file yet:

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
