# RFC: Lili ↔ GhostStream Integration (v1)

**Status:** Proposed — awaiting GhostStream team review
**Author:** papoveB01 (Avoa / Lili)
**Date:** 2026-05-19
**Reviewers:** GhostStream platform team
**Spans repos:** `papoveB01/ghoststream_project`, `papoveB01/avoa-project`

---

## 1. TL;DR

Lili is a Windows desktop voice assistant. We want it to act as a voice + desktop frontend to a user's GhostStream tenant — natural language → vector search over their KB → spoken answer.

This RFC proposes three coordinated changes:

1. **GhostStream API:** add long-lived API-token auth alongside the existing JWT-cookie auth, so non-browser clients can authenticate as a user against their tenant.
2. **GhostStream MCP server:** a new top-level `mcp/` module exposing GhostStream capabilities as Model Context Protocol tools. First slice = `kb_search`.
3. **Lili (avoa-project):** register the GhostStream MCP server as a preset in the Connections panel, with the API token stored in the OS keychain.

First user-visible capability: *"Hey Lili, what did we decide about X in last week's standup?"* → tenant-scoped vector search → Gemini answer → TTS.

---

## 2. Context

### 2.1 What Lili is

Lili (codename AVOA) is a local Windows desktop voice assistant:

- Wake-word listening via OpenWakeWord (variants: Hey Lili, Hey LeeLee, Hey LyLy), fully on-device.
- STT via Whisper (local).
- Agent loop runs in Electron main using `@anthropic-ai/sdk` (Claude Haiku 4.5 default) with Gemini-2.5-Flash failover on 529s.
- TTS via Edge "Read Aloud" neural voices.
- Tool execution is client-side (compliance-lean stance — user data stays on the user's machine).
- Already integrates with several MCP servers: Filesystem, GitHub, Slack, Sequential Thinking, Brave Search.
- Adding new MCP servers is a well-trodden path — see `client/src/connections/presets.js`.

### 2.2 What GhostStream is (as understood from the public repo + ADR-0001)

- Multi-tenant meeting intelligence + knowledge base.
- `api/` Node.js Express service: routes mounted at `/knowledge`, `/portfolio`, `/companies`, `/missions`, `/integrations`, etc.
- `capture/` Python service: meeting capture via Recall.ai + Skribby transcription.
- Postgres + pgvector for chunked-document retrieval, HNSW index, `text-embedding-004` (Google).
- Cloudflare R2 (object storage), Redis (cache), Gemini context cache (per-tenant).
- Per-ADR-0001: every row tagged with `tenant_id uuid NOT NULL`; RLS enabled as defence-in-depth; R2 keys prefixed `tenants/{tenantId}/…`.
- Auth today: JWT in session cookie, validated by `auth.authMiddleware` using `auth.verifyToken(auth.tokenFromRequest(req))`. **No bearer-token / API-key path exists.**

The retrieval endpoint Lili needs already exists:

```
POST /knowledge/search          (auth.authMiddleware-gated)
Body:  { query: string, k?: number, categories?: string[] }
Calls: retrieval.retrieveContext(query, { tenantId, k, categories, ... })
Returns: { chunks: [...], query: string }
```

`retrieveContext()` resolves tenant scope from `req.tenantId` (set by `authMiddleware` in `api/src/auth.js:100` — `req.tenantId = claims.tid`), so once we add a second auth path that also populates `req.tenantId`, the search route works unchanged.

### 2.3 Why an MCP server (vs. a REST integration in Lili directly)

- Lili already uses MCP for everything beyond its built-in local tools. Slack, GitHub, Filesystem, Brave Search, Sequential Thinking are all MCP. Adding GhostStream the same way means zero new shape in Lili — just another preset.
- MCP servers are spawnable from any MCP client (Claude desktop, Cursor, etc.), so this work is reusable beyond Lili.
- The contract is the MCP tool schema, not GhostStream's internal API shape — so the API can evolve without breaking clients.

---

## 3. Goals and non-goals

### 3.1 Goals (v1)

1. A user with a GhostStream tenant can mint a long-lived API token from the GhostStream web UI.
2. The user pastes that token into Lili's Connections panel; it lives in the Windows Credential Manager (keytar).
3. Saying *"Hey Lili, [question about my KB]"* triggers a `kb_search` MCP tool call → `POST /knowledge/search` → tenant-scoped retrieval → Gemini/Claude composes a spoken answer.
4. Audit trail: every API-token use is observable server-side (token id, tenant id, route, timestamp).
5. Revocation works: deleting the token in the GhostStream UI immediately blocks Lili.

### 3.2 Non-goals (v1)

- Write paths to GhostStream KB (`notes_capture`, `web_sync`, etc.) — separate RFC once `kb_search` is shipped.
- Meeting-level operations (`meeting_get`, `meeting_list`, etc.) — same.
- OAuth flow / browser-based authorization. v1 is "copy token, paste token".
- Per-tool scoped tokens (`read:knowledge` vs `write:knowledge`). v1 tokens carry the user's full identity. Scopes are a v2 concern.
- Cross-tenant Lili (one Lili install, multiple tenants). v1 = one token = one tenant per install.

---

## 4. Architecture overview

```
  ┌──────────────────────────────────────────────────────────────┐
  │              User's Windows machine (Lili host)              │
  │                                                              │
  │   ┌──────────────┐   stdio    ┌─────────────────────────┐    │
  │   │   Lili (the  │ ─────────► │  GhostStream MCP server │    │
  │   │   Electron   │   MCP      │  (Node, vendored or     │    │
  │   │   app)       │ ◄───────── │   npm in v2)            │    │
  │   └──────────────┘            └──────────┬──────────────┘    │
  │          │ keytar                        │                   │
  │          │ ghoststream_api_token          │ HTTPS            │
  │          ▼                                │ Bearer           │
  │   ┌──────────────┐                        │                  │
  │   │  Windows     │                        │                  │
  │   │  Credential  │                        │                  │
  │   │  Manager     │                        │                  │
  │   └──────────────┘                        │                  │
  └───────────────────────────────────────────┼──────────────────┘
                                              │
                                              ▼
                          ┌─────────────────────────────────────┐
                          │   GhostStream api/ (Node/Express)   │
                          │                                     │
                          │   ┌──────────────────────────────┐  │
                          │   │ auth.authMiddleware (today)  │  │
                          │   │   ├─ JWT cookie path (existing)  │
                          │   │   └─ Bearer-token path (NEW)  │ │
                          │   └──────────────┬───────────────┘  │
                          │                  │ sets req.user,   │
                          │                  │ req.tenantId     │
                          │                  ▼                  │
                          │   POST /knowledge/search → retrieveContext()  │
                          │                  │                  │
                          │                  ▼                  │
                          │       Postgres pgvector (RLS)       │
                          └─────────────────────────────────────┘
```

Three deliverables, three sections below.

---

## 5. Workstream A — GhostStream: API-token auth

**Repo:** `papoveB01/ghoststream_project`
**Owner:** GhostStream platform team
**Blocks:** Workstreams B and C — everything else waits on this.

### 5.1 Data model

New table `api_tokens`:

| Column         | Type                       | Notes                                                                 |
| -------------- | -------------------------- | --------------------------------------------------------------------- |
| `id`           | `uuid PRIMARY KEY`         | `gen_random_uuid()`                                                   |
| `tenant_id`    | `uuid NOT NULL`            | FK to `tenants`. Mandatory per ADR-0001 multi-tenant isolation.       |
| `user_id`     | `uuid NOT NULL`            | FK to `users`. Token acts on behalf of this user.                     |
| `label`        | `text NOT NULL`            | Human label, e.g. "Lili on Win desktop".                              |
| `prefix`       | `text NOT NULL UNIQUE`     | First 8 chars of the plaintext token; lets us look up by prefix without scanning all hashes. Format: `gs_pat_XXXXXXXX`. |
| `token_hash`   | `text NOT NULL`            | `bcrypt`/`argon2id` hash of the full plaintext token. We never store plaintext. |
| `created_at`   | `timestamptz NOT NULL DEFAULT now()` |                                                              |
| `expires_at`   | `timestamptz`              | Nullable = never expires. Default: now() + 90 days.                   |
| `last_used_at` | `timestamptz`              | Bumped on every successful request (best-effort, not in the hot path if costly). |
| `revoked_at`   | `timestamptz`              | Soft delete. NULL = active.                                           |

Indexes:

- `(tenant_id, user_id)` for the list endpoint.
- `(prefix)` UNIQUE for lookup.
- Optionally `(expires_at)` if we run a cleanup job.

RLS policy on `api_tokens`: same pattern as everything else — `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.

### 5.2 Token shape

Plaintext token format:

```
gs_pat_<8-char-prefix>_<32-char-secret>
        \_____________/ \_____________/
         lookup key      verified via bcrypt
```

Total length ~50 chars. The `gs_pat_` prefix makes leaked tokens grep-able. The 8-char `prefix` is used to find the row; the 32-char `secret` is hashed and compared.

### 5.3 Middleware

New file `api/src/auth-token.js` exporting `apiTokenMiddleware(req, res, next)`:

1. Read `Authorization: Bearer <token>` header.
2. If absent or malformed → `next()` (let the JWT path try).
3. Parse: split on `_`, extract `prefix`, verify the leading `gs_pat_` literal.
4. `SELECT * FROM api_tokens WHERE prefix = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
5. If no row → `401 invalid_token`.
6. `bcrypt.compare(plaintext, row.token_hash)`. If false → `401 invalid_token`.
7. Populate request context to match `authMiddleware`'s JWT-path shape exactly:
   - `req.tenantId = row.tenant_id` (flat, **not** `req.tenant.id` — see `api/src/auth.js:100`).
   - `req.user = { sub: row.user_id, tid: row.tenant_id, email, role, adm, token_id: row.id }` — JOIN `api_tokens` against `users` at lookup time so `email`, `role`, `adm` come from the live user row. **Critical:** the admin guard at `auth.js:116` reads `req.user.adm`; missing that field silently breaks bearer-token requests to admin routes.
8. Async-fire `UPDATE api_tokens SET last_used_at = now() WHERE id = $1` (don't await — best-effort).
9. `next()`.

Modify `auth.authMiddleware` so it chains: try Bearer-token first; if not present, fall back to the existing JWT-cookie path; if neither succeeds, `401`. Existing JWT-using routes keep working unchanged.

### 5.4 Token management endpoints

All gated by `authMiddleware` (so token creation requires a logged-in session — Lili can't bootstrap itself).

| Method | Path                  | Body / Returns                                                    |
| ------ | --------------------- | ----------------------------------------------------------------- |
| POST   | `/auth/tokens`        | Body: `{ label: string, expires_in_days?: number \| null }`. Returns `{ id, label, prefix, plaintext_token, expires_at, created_at }`. **`plaintext_token` is returned ONCE** and never again — same UX as GitHub PATs. |
| GET    | `/auth/tokens`        | Returns `[ { id, label, prefix, created_at, last_used_at, expires_at, revoked_at } ]` for the current tenant + user. No plaintext, no hash. |
| DELETE | `/auth/tokens/:id`    | Sets `revoked_at = now()`. Returns `204`.                         |

Rate-limit `POST /auth/tokens` to, say, 5/hour/user to discourage scripting token generation.

**Dependency note:** no rate-limiter middleware exists in `api/src/` today. Add `express-rate-limit` (Redis-backed via `rate-limit-redis` if we want multi-instance cleanliness) as a workstream-A sub-deliverable, or document that v1 ships without the limit and accept that risk explicitly.

### 5.5 Web UI changes (`web/`)

Settings page: "API tokens" section.

- Table of existing tokens (label, prefix, last used, expires, "Revoke" button).
- "Create new token" form: label, expiry select (`30d / 90d / 1y / never`).
- On create: modal shows the plaintext once with "Copy" button and a clear "you won't see this again" warning.
- Help text: "Use this token to connect Lili or other MCP clients. Treat it like a password."

### 5.6 Observability

- Log every successful Bearer auth with `{ token_id, tenant_id, user_id, route, ip }` at INFO. (Don't log the token itself, ever.)
- Metric: `api_tokens_used_total{result=ok|invalid|revoked|expired}` counter.
- Alert on >50 invalid token attempts/min from one IP — possible brute force.

**Dependency note:** the project has no metrics pipeline or alerting infrastructure today (per PR #9's CodeReviewer review, no CI is configured either). The structured INFO log is trivial to add. The counter and brute-force alert require infra that doesn't yet exist — treat them as best-effort for v1. The structured log is the durable surface; the metric and alert can land once observability becomes its own workstream.

### 5.7 Tests the GhostStream team should write

- `bcrypt.compare` verifies / rejects correctly.
- Bearer-token request hits a tenant-scoped row and sees only its own tenant's data.
- Bearer-token request that targets a wrong tenant via tampering still gets RLS-blocked.
- Revoked tokens 401.
- Expired tokens 401.
- JWT cookie path still works unchanged for the web app.

### 5.8 Open questions for the GhostStream team

1. **Hash algorithm**: bcrypt (cost ~12, ~250ms verify) vs argon2id. Bcrypt is fine for tokens given the prefix-based lookup; argon2id is slower but stronger. Preference?
2. **Token versioning**: should the format include a version byte (e.g., `gs_pat_v1_...`) so we can rotate without breaking parsing later? Recommend yes.
3. **Per-tenant token quota**: cap N active tokens per user (e.g., 10)? Prevents runaway.
4. **`last_used_at` write strategy**: hot-path update on every request, or buffer-write every N seconds? Suggest the latter via Redis to keep search latency clean.
5. **Audit log table** vs. log lines: do you want `api_token_events (token_id, kind, occurred_at, ip, route)` as its own table for queryable history, or are structured logs enough?
6. **Tenant switch**: a user can belong to multiple tenants. Should the token bind to a specific tenant at mint time (recommended) or carry the user's "default tenant"?

### 5.9 Token rotation procedure

There is no in-place refresh. A user rotating a token (suspected compromise or routine rotation) follows this order:

1. Mint a new token via Settings → API tokens (`POST /auth/tokens`).
2. Copy the plaintext.
3. In Lili → Connections → GhostStream → update the `ghoststream_api_token` secret.
4. Revoke the old token via Settings → API tokens (`DELETE /auth/tokens/:id`).

**Order matters** — revoking before swapping causes a window where Lili authenticates with a dead token and tool calls 401-out. The Settings UI should show a "Rotate" affordance that walks the user through this ordering.

---

## 6. Workstream B — GhostStream MCP server

**Repo:** `papoveB01/ghoststream_project`, new top-level `mcp/` directory.
**Owner:** GhostStream platform team (with Lili input on tool shape).
**Depends on:** Workstream A complete.

### 6.1 Layout

```
ghoststream_project/
  mcp/
    package.json         # name: "@ghoststream/mcp-server", private until shape settles
    README.md
    src/
      index.js           # entry: spawn MCP stdio server
      ghoststreamClient.js  # thin HTTP wrapper around the API
      tools/
        kb_search.js     # first tool
```

`package.json` deps:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x"
  }
}
```

No Express, no DB — this process talks to the GhostStream API over HTTPS. It is a *client* of the API.

### 6.2 Environment contract

The MCP server reads:

| Env var                  | Required | Notes                                                      |
| ------------------------ | -------- | ---------------------------------------------------------- |
| `GHOSTSTREAM_API_URL`    | yes      | e.g. `https://api.ghoststream.example` or `http://127.0.0.1:8090` for local dev. |
| `GHOSTSTREAM_API_TOKEN`  | yes      | The plaintext `gs_pat_...` token from Workstream A.        |
| `GHOSTSTREAM_TIMEOUT_MS` | no       | Default `15000`.                                           |

If either required var is missing at startup, log a clear error to stderr and exit non-zero. Lili surfaces "preset unavailable" until the user provides the secret.

### 6.3 Tool: `kb_search`

MCP tool declaration:

```jsonc
{
  "name": "kb_search",
  "description": "Search the user's GhostStream knowledge base. Returns the top-k most relevant chunks across documents, meeting transcripts, and notes for the user's tenant. Use this when the user asks a question that's likely answered by their own organizational knowledge — meetings, projects, decisions, internal docs, prospect intel.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural-language search query. Will be embedded with text-embedding-004 and matched via cosine similarity over kb_chunks."
      },
      "k": {
        "type": "integer",
        "description": "Number of results to return. Default 8, max 50.",
        "default": 8
      },
      "categories": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional category filter, e.g. [\"meeting_transcript\", \"prospect_intel\"]. Omit to search everything."
      }
    },
    "required": ["query"]
  }
}
```

Handler:

1. Validate `query` is non-empty.
2. `POST ${GHOSTSTREAM_API_URL}/knowledge/search` with body `{ query, k, categories }` and `Authorization: Bearer ${GHOSTSTREAM_API_TOKEN}`.
3. On `200`: shape the response for the LLM (don't dump raw chunks — compact text + citation):

```
Found 5 results (top similarity 0.84):

1. [meeting_transcript • 2026-05-12] "Q2 Roadmap Sync"
   …chunk text, max ~300 chars…
   citation: doc:abc123#chunk:7

2. [adr • 2026-05-14] "Multi-tenant knowledge isolation"
   …
```

4. On `401`/`403`: return `is_error: true` with `"Authentication failed — your GhostStream API token may be revoked or expired."`
5. On `429`: `"GhostStream rate limit hit; retry shortly."`
6. On `5xx` / network error: `"GhostStream API unreachable: <reason>."` — Lili's agent loop can decide whether to retry or surface to user.

### 6.4 Future tools (not in v1, listed for context)

- `meeting_list({ since?, limit? })` — recent meetings.
- `meeting_get({ id })` — full transcript + metadata.
- `notes_capture({ text, category? })` — voice → KB write path.
- `calendar_upcoming({ within_hours? })` — Nylas/Calendly proxy.
- `research_company({ company_id })` — wraps `/research/:companyId`.

Each will get its own short RFC once `kb_search` is in production.

### 6.5 Open questions for the GhostStream team

1. **Response shape**: GhostStream's chunk objects have ~14 fields. What's the right subset to send to an LLM consumer? Recommend dropping `tokenCount`, `metadata` (unless small), `embedding` (definitely), `distance` (or replace with a coarse `relevance` band).
2. **Citation format**: how do you want chunks cited so Lili can speak the source aloud? Suggest `documentTitle` + `effectiveDate` is enough for voice; raw `documentId/chunkId` is too noisy.
3. **Logging**: should the MCP server pass an `X-Client: lili/<version>` header so server-side logs can attribute calls? Recommend yes.

---

## 7. Workstream C — Lili (avoa-project)

**Repo:** `papoveB01/avoa-project`
**Owner:** Lili / Avoa team (this RFC's author).
**Depends on:** Workstream B at least scaffolded (need the MCP entry point).

### 7.1 Preset registration

Add to `client/src/connections/presets.js`:

```js
function ghoststreamPreset() {
  // During dev: spawn from the local ghoststream_project/mcp/ checkout.
  // Once published, switch to resolvePackageEntry("@ghoststream/mcp-server").
  const entry = path.join(_ctx.ghoststreamMcpPath || "", "src/index.js");
  if (!entry || !fs.existsSync(entry)) return null;
  const apiUrl = secrets.get("ghoststream_api_url") || "https://api.ghoststream.example";
  const token = secrets.get("ghoststream_api_token");
  if (!token) return null;
  return nodeChild(entry, [], {
    GHOSTSTREAM_API_URL: apiUrl,
    GHOSTSTREAM_API_TOKEN: token,
  });
}
```

Add to `PRESETS`:

```js
ghoststream: {
  label: "GhostStream",
  description: "Voice query over your GhostStream tenant's knowledge base — meetings, docs, prospect intel.",
  factory: ghoststreamPreset,
  package: "@ghoststream/mcp-server",
  secrets: [
    {
      name: "ghoststream_api_token",
      label: "GhostStream API Token",
      help: "Mint at GhostStream → Settings → API tokens. Starts with gs_pat_. Stored in Windows Credential Manager.",
    },
    {
      name: "ghoststream_api_url",
      label: "GhostStream API URL",
      help: "Defaults to the production URL. Override for local dev (e.g. http://127.0.0.1:8090).",
    },
  ],
}
```

### 7.2 Path resolution for the dev checkout

Initial implementation reads `_ctx.ghoststreamMcpPath` from env at app startup. Two options for v1:

a. `AVOA_GHOSTSTREAM_MCP_PATH` env var → user points to their local clone.
b. Just-in-time clone: Lili clones `ghoststream_project` into its app data dir on first use, runs `npm install`. More magical, more surprises.

Recommend (a) for v1.

### 7.3 No system-prompt changes needed

The agent loop's tool advertisement comes from `tools.list()`, which automatically picks up MCP-registered tools. No special-case hint in `buildSystemPrompt()`. Lili will discover `kb_search` and use it whenever the user's question looks KB-shaped.

If empirical testing shows the model under-uses the tool, we'll add a one-line hint in the system prompt: *"For questions about the user's meetings, projects, or internal knowledge, prefer kb_search before answering from priors."*

### 7.4 UX surface

- **Connections panel → MCP tab**: GhostStream appears in the preset dropdown once the user's clone path is set.
- **Add Server form**: fields for token + (optional) URL.
- **Tray menu**: unchanged for v1.
- **Voice flow**: identical to existing wake-then-ask. Latency budget: target end-to-end p50 under 3s from wake-end to first TTS token (search + Gemini stream).

### 7.5 MCP server lifecycle and failure modes

The MCP server is a child process spawned by Lili. Three failure modes need explicit Lili-side handling — none affect the GhostStream API contract:

1. **Process crash** — Lili detects the dead stdio pipe and re-spawns the server on the next tool call. Exponential backoff on repeated crashes (1s → 4s → 16s, cap at 60s). After 3 consecutive failed spawns, surface "GhostStream connection lost" in the Connections panel and disable the preset until manual retry.
2. **Hang / unresponsive** — every tool call has a hard timeout (default 15s per `GHOSTSTREAM_TIMEOUT_MS`, see §6.2). On timeout, cancel the call and return `is_error: true` with "GhostStream took too long to respond." The agent loop decides whether to retry or answer from priors.
3. **Auth failure surfacing** — `is_error: true` from §6.3 step 4 propagates to Lili's UI as: "Your GhostStream API token may be revoked or expired — re-mint at Settings → API tokens and update the secret in Connections."

### 7.6 Lili-side response cache

For the "user repeats themselves within a minute" case, Lili holds an LRU-64 in-memory cache keyed on `(query, k, categories)` with a 60s TTL on `kb_search` results. Single-user desktop app — no Redis needed. Cache is busted on app restart and on token-secret change (token-change implies tenant-change in v1).

---

## 8. End-to-end call sequence

```
User says: "Hey Lili, what did we agree about API tokens in the integration RFC?"
  │
  ├─ OpenWakeWord fires (activation > 0.5)
  ├─ Whisper transcribes utterance
  │
  ▼
Lili agent loop (Electron main, Claude Haiku 4.5)
  │
  ├─ System prompt + history + tool schemas including kb_search
  │
  ├─ Claude decides to call kb_search(query="API tokens integration RFC")
  │
  ▼
Lili invokes MCP tool → spawned ghoststream MCP server (already running on stdio)
  │
  ├─ MCP server: HTTPS POST /knowledge/search
  │    Authorization: Bearer gs_pat_v1_xxxxxxxx_yyyy…
  │    Body: { query: "API tokens integration RFC", k: 8 }
  │
  ▼
GhostStream api (Express)
  ├─ apiTokenMiddleware: parse prefix → SELECT api_tokens → bcrypt.compare
  ├─ Sets req.user, req.tenantId
  ├─ knowledge router → retrieval.retrieveContext()
  │    ├─ text-embedding-004(query) → 768-d vector
  │    ├─ pgvector cosine search over kb_chunks WHERE tenant_id = req.tenantId
  │    └─ Returns top-8 chunks with metadata
  ├─ Response JSON
  │
  ▼
MCP server: shapes chunks → compact text → returns as MCP tool result
  │
  ▼
Lili agent loop: feeds tool result back to Claude
  │
  ├─ Claude streams: "Looks like the RFC proposes long-lived bearer tokens
  │    stored in a new api_tokens table, with bcrypt-hashed secrets and an
  │    8-char prefix for lookup…"
  │
  ▼
EdgeTTS synthesizes per sentence → speaker output
  │
  ▼
User hears answer (and the orb pulses speaking-state)
```

---

## 9. Security review checklist

- [ ] Token plaintext never logged.
- [ ] Token plaintext never returned by GET endpoints (only by POST /auth/tokens once).
- [ ] Bearer-token middleware rejects malformed tokens early without DB lookup (cheap DoS surface).
- [ ] `bcrypt.compare` uses constant-time comparison internally (it does).
- [ ] RLS on `api_tokens` so a compromised token can't enumerate other tenants' tokens.
- [ ] Revoke is immediate (no cache that outlives a request) OR cache TTL is documented (<60s).
- [ ] Rate limit on `POST /auth/tokens` and on auth failures.
- [ ] CORS unchanged — API tokens are server-to-server-style, no browser CORS use case.
- [ ] Lili stores the token in Windows Credential Manager (keytar), not in any plaintext file. Already the pattern for `github_pat` / `slack_bot_token`.
- [ ] Lili never sends the token to Claude/Gemini (it lives in env passed to a subprocess; not in any agent prompt or memory).
- [ ] On Lili uninstall, document the keytar entries the user should clear.

---

## 10. Rollout plan

| Phase | Owner       | Definition of done                                                                  |
| ----- | ----------- | ----------------------------------------------------------------------------------- |
| A0    | GhostStream | RFC accepted, open questions resolved, ADR-0002 drafted (API-token auth).            |
| A1    | GhostStream | Migration + middleware + 3 endpoints + UI shipped to staging. Existing JWT auth untouched. |
| A2    | GhostStream | Token minting tested end-to-end in staging UI. Audit log entries present.            |
| B1    | GhostStream | `mcp/` scaffolded; `kb_search` tool implemented; manual `npx @modelcontextprotocol/inspector` smoke test passes against staging. |
| C1    | Avoa/Lili   | Preset registered; secret captured in keytar; spawn + handshake confirmed in dev.    |
| C2    | Avoa/Lili   | Voice test: "Hey Lili, [KB question]" returns a coherent spoken answer with at least one citation. |
| D1    | Both        | Production deploy with the same UX. Document the user setup flow in `docs/`.        |

A0–A2 must complete before B1 can be tested end-to-end. C1–C2 can begin against a stub MCP server in parallel.

---

## 11. Open questions (consolidated)

For the GhostStream team:

1. Hash algorithm (bcrypt vs argon2id)?
2. Token format versioning (`gs_pat_v1_...`)?
3. Per-user active-token cap?
4. `last_used_at` write strategy?
5. Audit log table vs structured logs?
6. Token tenant-binding at mint vs default-tenant resolution?
7. Chunk response trimming policy?
8. Citation format for voice consumption?
9. `X-Client` attribution header support?
10. **Latency budget for `/knowledge/search` — proposed:** **p50 < 400ms, p95 < 800ms** (warm cache, after embedding). Reasoning: Lili's wake-to-speech budget = STT ≈ 300ms + agent loop ≈ 500ms + TTS first-token ≈ 600ms + search ≈ 400ms ≈ 1.8s p50, leaving margin under the 3s end-to-end target. If the GhostStream team has different numbers, counter-propose — but pick something **measurable in A2 staging**, not "as fast as possible."

For the Lili team (resolved here, captured for visibility):

- Local MCP path via `AVOA_GHOSTSTREAM_MCP_PATH` env var in v1; npm package later.
- No system-prompt nudges for v1; revisit if model under-uses the tool.

---

## 12. Out of scope (explicitly)

- Mobile / browser Lili.
- Write paths to GhostStream KB.
- Meeting-level tools beyond `kb_search`.
- Tenant switching from inside Lili.
- Token scopes / fine-grained permissions.
- OAuth / device-code flow.

All deferred to future RFCs.

---

## 13. References

- ADR-0001 (Multi-tenant knowledge isolation): `ghoststream_project/docs/adr/0001-multi-tenant-knowledge-isolation.md`
- Lili compliance-lean stance: `avoa-project/docs/Compliance_Lean_Architecture_Guide.pdf`
- Lili client-tool execution protocol: `avoa-project/docs/CLIENT_TOOL_PROTOCOL_DRAFT.md`
- MCP spec: https://modelcontextprotocol.io/
- Existing Lili presets pattern: `avoa-project/client/src/connections/presets.js`
- Existing knowledge router: `ghoststream_project/api/src/knowledge/index.js`
- Existing retrieval service: `ghoststream_project/api/src/knowledge/retrieval.js`
