// tools/kb_search.js
// ---------------------------------------------------------------------------
// First MCP tool: knowledge base search over the user's tenant.
// Wraps POST /knowledge/search → retrieval.retrieveContext().
//
// Open RFC questions still pending GhostStream-team alignment (#13):
//   Q7  Chunk projection — which fields to forward to the LLM consumer.
//   Q8  Citation format for voice consumption.
// Until those land, this tool forwards a *conservative* projection (text,
// title, date, category) and a simple "<title> • <date>" citation string.
// The unanswered detail is marked TODO(Q7|Q8) so the diff is small once the
// answers ship.
// ---------------------------------------------------------------------------

const { postJson } = require("../apiClient");

const SCHEMA = {
  name: "kb_search",
  description:
    "Search the user's GhostStream knowledge base. Returns the top-k most " +
    "relevant chunks across documents, meeting transcripts, and notes for " +
    "the user's tenant. Use this when the user asks a question likely " +
    "answered by their own organisational knowledge — meetings, projects, " +
    "decisions, internal docs, prospect intel.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language search query. Embedded with text-embedding-004 " +
          "and matched via cosine similarity over kb_chunks.",
      },
      k: {
        type: "integer",
        description: "Number of results to return. Default 8, max 50.",
        default: 8,
      },
      categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional category filter, e.g. [\"meeting_transcript\", " +
          "\"prospect_intel\"]. Omit to search everything.",
      },
    },
    required: ["query"],
  },
};

// TODO(Q7): trim/select fields once the GhostStream team finalises the
// projection. For now we forward title + date + category + a clipped text
// body, which is the minimum the LLM needs to reason. We deliberately drop
// embedding/metadata/distance to keep the tool output small.
const TEXT_CLIP = 600;

function formatCitation(chunk) {
  // TODO(Q8): replace with the agreed canonical citation form. For now,
  // "<title> • <date>" is what voice consumers can read aloud naturally.
  const title = chunk.documentTitle || "untitled";
  const date = chunk.effectiveDate
    ? new Date(chunk.effectiveDate).toISOString().slice(0, 10)
    : null;
  return date ? `${title} • ${date}` : title;
}

function shapeChunk(chunk) {
  const text = typeof chunk.text === "string" ? chunk.text : "";
  return {
    citation: formatCitation(chunk),
    category: chunk.category || null,
    text: text.length > TEXT_CLIP ? text.slice(0, TEXT_CLIP) + "…" : text,
  };
}

async function handler(args, ctx) {
  const query = args?.query;
  if (typeof query !== "string" || !query.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "kb_search requires a non-empty `query` string." }],
    };
  }

  const k = Number.isInteger(args?.k) ? Math.min(50, Math.max(1, args.k)) : 8;
  const categories = Array.isArray(args?.categories) ? args.categories : undefined;

  const res = await postJson(
    "/knowledge/search",
    { query, k, ...(categories ? { categories } : {}) },
    ctx,
  );

  if (!res.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: res.message }],
    };
  }

  const chunks = Array.isArray(res.body?.chunks) ? res.body.chunks : [];
  if (chunks.length === 0) {
    return {
      content: [{
        type: "text",
        text: `No matches for "${query}" in the user's knowledge base.`,
      }],
    };
  }

  const lines = [`Found ${chunks.length} result${chunks.length === 1 ? "" : "s"} for "${query}":`, ""];
  chunks.forEach((c, i) => {
    const shaped = shapeChunk(c);
    lines.push(`${i + 1}. [${shaped.category || "uncategorised"}] ${shaped.citation}`);
    if (shaped.text) lines.push(`   ${shaped.text}`);
    lines.push("");
  });

  return {
    content: [{ type: "text", text: lines.join("\n").trim() }],
  };
}

module.exports = { SCHEMA, handler };
