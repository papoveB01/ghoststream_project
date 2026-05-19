# @ghoststream/mcp-server

Model Context Protocol server exposing GhostStream tools to MCP-aware clients
(e.g. Lili, Claude desktop, Cursor).

See `docs/rfcs/0001-lili-integration.md` for the full design and §6 for the
MCP-server-specific contract.

## Status

`v0.1.0` — scaffolding. `kb_search` implemented, talks to
`POST /knowledge/search` with a bearer PAT. RFC questions Q7 (chunk
projection) and Q8 (citation format) are still open; the tool currently
forwards a conservative projection and a `<title> • <date>` citation, both
marked `TODO(Q7|Q8)` for a tight follow-up diff.

## Running

```bash
# from this directory
npm install
GHOSTSTREAM_API_URL=https://api.ghoststream.example \
GHOSTSTREAM_API_TOKEN=gs_pat_v1_xxxxxxxx_yyyy... \
npm start
```

The process speaks MCP over stdio — it's meant to be spawned by an MCP
client, not run interactively. For manual smoke testing:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

with the env vars above set in the inspector's launch config.

## Configuration

| Env var                  | Required | Notes                                      |
| ------------------------ | -------- | ------------------------------------------ |
| `GHOSTSTREAM_API_URL`    | yes      | API base URL, e.g. `https://api.ghoststream.example`. |
| `GHOSTSTREAM_API_TOKEN`  | yes      | `gs_pat_v1_<8>_<32>` bearer PAT minted at Settings → API tokens. |
| `GHOSTSTREAM_TIMEOUT_MS` | no       | Per-call timeout. Default `15000`.         |

Missing required vars → the process writes a clear error to stderr and
exits non-zero, so the MCP client surfaces "preset unavailable" rather than
connecting to a broken server.

## Tools

### `kb_search({ query, k?, categories? })`

Wraps `POST /knowledge/search`. Returns the top-k most relevant chunks for
the bearer's tenant.

- `query` — natural-language search string (required)
- `k` — number of results, default 8, clamped to `[1, 50]`
- `categories` — optional category filter array

Error mapping:

| Server status | Tool result                                            |
| ------------- | ------------------------------------------------------ |
| `401` / `403` | "auth_failed" — token likely revoked/expired           |
| `429`         | "rate_limited"                                         |
| `5xx`         | "server_error"                                         |
| timeout       | "timeout" with the configured `GHOSTSTREAM_TIMEOUT_MS` |
| network       | "network_error" with the underlying message            |

## Repository layout

```
mcp/
  package.json
  README.md
  src/
    index.js          # stdio entry point + tool dispatch
    apiClient.js      # HTTPS wrapper, Bearer auth, error classification
    tools/
      kb_search.js    # first MCP tool
```

Add new tools by creating a file under `src/tools/` exporting
`{ SCHEMA, handler }` and registering it in the `tools` array in `index.js`.

## Future tools (per RFC §6.4)

- `meeting_list({ since?, limit? })`
- `meeting_get({ id })`
- `notes_capture({ text, category? })`
- `calendar_upcoming({ within_hours? })`
- `research_company({ company_id })`

Each gets its own short follow-up RFC once `kb_search` is in production.
