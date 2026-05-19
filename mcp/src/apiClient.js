// apiClient.js
// ---------------------------------------------------------------------------
// Thin HTTPS wrapper around the GhostStream API. The MCP server is a client
// of the API — it doesn't talk to Postgres or R2 directly, it goes through
// /knowledge/search etc. with the user's bearer PAT.
//
// All errors are normalised into { ok: false, status, code, message } so the
// tool handler can map them to MCP error responses without re-parsing.
// ---------------------------------------------------------------------------

const PKG = require("../package.json");

const DEFAULT_TIMEOUT_MS = 15000;

// §11 Q9 (resolved 2026-05-19) — X-Client / User-Agent attribution.
// Default to this package's own name+version. Lili overrides via the
// GHOSTSTREAM_CLIENT_NAME env var (e.g. "lili-mcp/0.1.0") so server-side
// audit logs can attribute calls to the spawning client. Capped at 100
// chars per the RFC; longer is truncated.
const CLIENT_HEADER = (process.env.GHOSTSTREAM_CLIENT_NAME || `${PKG.name}/${PKG.version}`).slice(0, 100);

function classifyError(status, body) {
  if (status === 401 || status === 403) {
    return {
      code: "auth_failed",
      message:
        "GhostStream auth rejected the token. It may be revoked, expired, " +
        "or never minted. Re-mint at Settings → API tokens and update the " +
        "secret in the MCP client.",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "GhostStream rate limit hit; retry in a moment.",
    };
  }
  if (status >= 500) {
    return {
      code: "server_error",
      message: `GhostStream returned ${status}.`,
    };
  }
  if (status === 400) {
    const detail = body?.error || body?.detail || "bad request";
    return { code: "bad_request", message: `GhostStream rejected the request: ${detail}.` };
  }
  return { code: `http_${status}`, message: `Unexpected GhostStream response: ${status}.` };
}

async function postJson(path, body, { apiUrl, token, timeoutMs }) {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": CLIENT_HEADER,
        "X-Client": CLIENT_HEADER,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError" || ctrl.signal.aborted) {
      return {
        ok: false,
        status: 0,
        code: "timeout",
        message: `GhostStream took longer than ${timeoutMs || DEFAULT_TIMEOUT_MS}ms to respond.`,
      };
    }
    return {
      ok: false,
      status: 0,
      code: "network_error",
      message: `Cannot reach GhostStream API at ${apiUrl}: ${err.message}`,
    };
  }
  clearTimeout(timer);

  let parsed = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* leave parsed = null */ }
  }

  if (!res.ok) {
    return { ok: false, status: res.status, ...classifyError(res.status, parsed) };
  }
  return { ok: true, status: res.status, body: parsed };
}

module.exports = { postJson };
