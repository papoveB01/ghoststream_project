// Token-aware chunker.
//
// Targets ~KB_CHUNK_TOKENS per chunk with KB_CHUNK_OVERLAP tokens of carryover.
// We use gpt-tokenizer (cl100k_base) as a Gemini approximator — Gemini's
// tokenizer is similar enough (~10% drift) that chunk-size budgeting holds.
//
// If the parser emitted `pages` (PDF), we chunk each page independently and
// stamp page numbers into chunk metadata. Otherwise we chunk the whole text.

const tokenizer = require('gpt-tokenizer');

const DEFAULT_CHUNK_TOKENS = parseInt(process.env.KB_CHUNK_TOKENS || '512', 10);
const DEFAULT_OVERLAP = parseInt(process.env.KB_CHUNK_OVERLAP || '50', 10);

function encode(text)  { return tokenizer.encode(text); }
function decode(tokens) { return tokenizer.decode(tokens); }
function tokenCount(text) { return encode(text).length; }

// Slide a (size, overlap) window across `tokens` and decode each window back
// into text. Yields { text, tokenCount } per chunk.
function* tokenWindows(tokens, size, overlap) {
  if (tokens.length === 0) return;
  const stride = Math.max(size - overlap, 1);
  let i = 0;
  while (i < tokens.length) {
    const slice = tokens.slice(i, i + size);
    const text = decode(slice).trim();
    if (text.length > 0) {
      yield { text, tokenCount: slice.length };
    }
    if (i + size >= tokens.length) break;
    i += stride;
  }
}

// `parsed` = { text, pages?, sourceType }
// Returns [{ text, tokenCount, metadata: { page? } }, ...]
function chunk(parsed, {
  chunkTokens = DEFAULT_CHUNK_TOKENS,
  overlap = DEFAULT_OVERLAP,
} = {}) {
  if (overlap >= chunkTokens) {
    throw new Error(`overlap (${overlap}) must be smaller than chunk size (${chunkTokens})`);
  }

  const out = [];

  if (parsed.pages && parsed.pages.length > 0) {
    // Per-page chunking preserves citations like "see page 14 of the pricing
    // PDF" — the analysis prompt can echo the page number when flagging a
    // mismatch.
    for (const page of parsed.pages) {
      const tokens = encode(page.text);
      for (const w of tokenWindows(tokens, chunkTokens, overlap)) {
        out.push({
          text: w.text,
          tokenCount: w.tokenCount,
          metadata: { page: page.page },
        });
      }
    }
  } else {
    const tokens = encode(parsed.text);
    for (const w of tokenWindows(tokens, chunkTokens, overlap)) {
      out.push({
        text: w.text,
        tokenCount: w.tokenCount,
        metadata: {},
      });
    }
  }

  return out;
}

module.exports = { chunk, tokenCount, DEFAULT_CHUNK_TOKENS, DEFAULT_OVERLAP };
