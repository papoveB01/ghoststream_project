// tools/kb_search.js
// ---------------------------------------------------------------------------
// First MCP tool: knowledge base search over the user's tenant.
// Wraps POST /knowledge/search → retrieval.retrieveContext().
//
// §11 Q7 + Q8 resolved 2026-05-19 (see docs/rfcs/0001-lili-integration.md):
//   Q7 — Projection: { id, content (≤600 chars), document: { title,
//        category, effectiveDate }, relevance: 'high' | 'medium' | 'low' }.
//        Always-excluded: embedding, tokenCount, ordinal, raw distance,
//        tier, sourceUrl, documentId.
//   Q8 — Citation: `${title}${effectiveDate ? ' from <date>' : ''}`. Raw
//        IDs never appear in voice text; they live only in the structured
//        `id` field for UI deep-linking.
// ---------------------------------------------------------------------------

const { postJson } = require("../apiClient");

const TEXT_CLIP = 600;
const RELEVANCE_HIGH_MAX = 0.30;
const RELEVANCE_MED_MAX = 0.60;

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
          "Optional category filter, e.g. [\"BATTLECARDS\", \"PRODUCT_INTEL\"]. " +
          "Omit to search everything.",
      },
    },
    required: ["query"],
  },
};

// Voice-friendly date formatter. "2026-05-12" → "May 12". Year omitted when
// the date is in the current calendar year (keeps the spoken citation tight).
function formatDateForVoice(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return sameYear
    ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
    : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// §11 Q8 — title + optional " from <date>". Raw IDs never appear in spoken
// citations; they live only in the projection's `id` field.
function formatCitation(chunk) {
  const title = chunk.documentTitle || "untitled document";
  const date = formatDateForVoice(chunk.effectiveDate);
  return date ? `${title} from ${date}` : title;
}

// §11 Q7 — bucket cosine distance into one of three labels. More LLM-
// actionable than a raw number (the model doesn't know whether 0.42 is
// "good" or "bad").
function bucketRelevance(distance) {
  if (typeof distance !== "number" || Number.isNaN(distance)) return "medium";
  if (distance < RELEVANCE_HIGH_MAX) return "high";
  if (distance < RELEVANCE_MED_MAX) return "medium";
  return "low";
}

// §11 Q7 — strict projection. Always-excluded fields: embedding, tokenCount,
// ordinal, raw distance, tier, sourceUrl, documentId.
function projectChunk(chunk) {
  const text = typeof chunk.text === "string" ? chunk.text : "";
  return {
    id: chunk.chunkId || null,
    content: text.length > TEXT_CLIP ? text.slice(0, TEXT_CLIP).trimEnd() + "…" : text,
    document: {
      title: chunk.documentTitle || null,
      category: chunk.category || null,
      effectiveDate: chunk.effectiveDate || null,
    },
    relevance: bucketRelevance(chunk.distance),
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
    { query: query.trim(), k, ...(categories ? { categories } : {}) },
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

  const projected = chunks.map(projectChunk);
  const lines = [`Found ${projected.length} result${projected.length === 1 ? "" : "s"} for "${query}":`, ""];
  projected.forEach((p, i) => {
    const citation = formatCitation(chunks[i]);
    const cat = p.document.category || "uncategorised";
    lines.push(`${i + 1}. [${cat}] ${citation} — ${p.relevance} relevance`);
    if (p.content) lines.push(`   ${p.content.replace(/\s+/g, " ").trim()}`);
    lines.push(`   source-id: ${p.id || "(unknown)"}`);
    lines.push("");
  });

  return {
    content: [{ type: "text", text: lines.join("\n").trim() }],
  };
}

module.exports = {
  SCHEMA,
  handler,
  // Exported for unit tests / self-doc:
  projectChunk,
  bucketRelevance,
  formatCitation,
  formatDateForVoice,
};
