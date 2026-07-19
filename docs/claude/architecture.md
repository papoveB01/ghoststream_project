# Architecture

## Request pipeline (`api/src/index.js`)
Routers are mounted with a consistent middleware chain — read a mount line to know a route's contract:
```
auth.authMiddleware  →  gating.requireFeature / requireCapacity  →  auth.requireRole(Write)  →  router
```
i.e. **authenticate (JWT) → check plan entitlement / charge usage → check in-tenant RBAC → handle**. Superadmin/platform routes add `auth.requireSuperadmin`.

## Multi-tenancy
Everything is scoped by `tenant_id`. Knowledge isolation is enforced (ADR-0001). **Sub-tenant** workspaces (`parent_tenant_id`) nest under a parent tenant and derive billing state, tier, and a masked/allocated slice of the parent's features/caps.

## Knowledge base (`api/src/knowledge/`)
pgvector-backed RAG: `parsers.js`/`ocr.js` ingest → `chunker.js` → `embeddings.js` → vector search. `discovery.js`/`apollo.js` pull prospects; `globalCache.js` shares near-zero-COGS research across tenants.

## Engagements / meetings (`api/src/missions/`, `recall.js`, `capture/`)
Scheduling an AI-joined call dispatches a **Recall.ai** bot (via `recall.js`) that joins the meeting; the `capture/` service handles the recording/stream and hands transcripts back for briefs and analysis. This is the metered "engagement" unit (~$1 COGS each — see [billing-entitlements](./billing-entitlements.md)).

## Other cross-cutting modules
- **`secretbox.js`** — at-rest encryption envelope (`enc:v1:`), keyed by `ENCRYPTION_KEY`; used for stored OAuth tokens etc.
- **`crm/`** — BYO-app OAuth connectors (Salesforce/Zoho/HubSpot) behind a common `registry.js` provider surface.
- **`gemini.js` / `models.js`** — Gemini model tiers (lite/flash/pro/content/embedding); `stream` is `live` in prod, `mock` elsewhere.
- **`auth.js` / `sessions.js` / `loginGuard.js`** — JWT auth, Redis-backed session revocation, and login lockout.
