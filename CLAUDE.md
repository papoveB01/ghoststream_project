# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GhostStream (the repo/internal name) ships **DealScope** (dealscope.io) — a self-serve B2B sales-intelligence platform: prospect discovery, competitor battlecards, AI-joined sales calls ("engagements"), Arena roleplay, and agentic Market Watch, sold as one bundle. Monorepo with three deployable services plus supporting infra, orchestrated by `docker-compose.yml`.

## Services (all in one compose project)

- **`api/`** — Node/Express, the whole product backend + REST API. Almost all logic lives here.
- **`capture/`** — Python/FastAPI (`uvicorn src.main`): meeting capture / recording / streaming, R2 (S3-compatible) uploads.
- **`proxy/`** — nginx; serves the static `web/admin/` SPA and reverse-proxies `/api/ → api:3000`, `/capture/ → capture:8000`, and webhook paths. `web/` and `proxy/` are **live bind-mounts** (edits apply without a rebuild).
- **`db`** — Postgres 16 + pgvector. **`redis`** — sessions, rate-limit state, ephemeral job state.
- **`mcp/`** — separate Node package: an MCP server exposing GhostStream tools (scaffolding; see `docs/rfcs/0001-lili-integration.md`).

## Rule modules

Detailed guidance is split into imported modules (kept in `docs/claude/` because `.claude/` is gitignored and would not travel with the repo):

@docs/claude/commands.md
@docs/claude/deploy-environments.md
@docs/claude/architecture.md
@docs/claude/billing-entitlements.md
@docs/claude/conventions.md
