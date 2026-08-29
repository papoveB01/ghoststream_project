// OCR fallback for PDFs with no usable text layer.
//
// pdf-parse only extracts a PDF's *embedded* text. Scanned documents,
// "print-to-image" exports, and outlined/vector-glyph PDFs carry no text layer,
// so pdf-parse returns (near-)empty output and the ingest path rejects them
// with "extracted text too short — file may be image-only or unreadable".
//
// Gemini reads PDFs natively (it rasterizes + OCRs server-side), so we hand the
// raw PDF bytes to the model and ask for a verbatim transcription. This keeps
// the OCR path dependency-free — no Tesseract/poppler binaries in the image.
//
// Best-effort by contract: any HARD failure (no API key, oversized file, model
// error, empty result) returns null so the caller falls back to the original
// short-text result and the existing 4xx error still fires.
//
// TRUNCATION IS NOT A HARD FAILURE AND IS NOT COVERED BY THAT SENTENCE. Nothing
// below inspects finishReason, so a transcription that exhausts
// OCR_MAX_OUTPUT_TOKENS comes back as non-empty truncated text, ocrPdf returns
// it (its only test is length > 0), and the document is stored READY —
// half-transcribed and looking complete. Recorded, unfixed, and NOT this file's
// to fix in the PR that wrote this comment: docs/code-review-2026-07-29.md:163,
// "OCR silently truncated at 16K tokens and stored READY", and ADR-0006 §10.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gemini = require('../gemini');
const costs = require('../costs');
const { TIERS } = require('../models');

// Vision-capable model for transcription. Flash (not flash-lite) by default for
// OCR fidelity; override with GEMINI_OCR_MODEL.
//
// PINNED TO GEMINI BY DECISION, NOT BY OMISSION — ADR-0006 §4.8, which decided
// on 2026-08-29 that OCR stays on Gemini indefinitely, the way §4.2 keeps
// embeddings there. So this file is deliberately absent from models.TASKS:
// there is no `ocr` key, no AI_PROVIDER_OCR, no ANTHROPIC_OCR_MODEL, and
// nothing here participates in the per-task provider flip. The reasons, in
// short: the live-schema harness cannot cover free-text transcription (no
// responseSchema to post, and no fidelity probe exists); Gemini's key and SDK
// are already permanent for embeddings, so keeping this path adds no
// dependency; and this is a FALLBACK that had produced exactly ONE document in
// production as of the decision, so a port cannot repay a rewrite.
//
// ocrViaFilesApi below has no equivalent in anthropic.js — no PDF helper, no
// base64 or size handling, no upload-and-reference path. Stated that way rather
// than as "no document support": anthropic.generate's normalizeMessages accepts
// a block array and forwards it verbatim, so a hand-built document block WOULD
// reach the API. What is missing is everything around it, in this tree.
//
// The failure asymmetry is the load-bearing reason, and it holds for HARD
// failures only — see the truncation note at the top of this file. Bounded
// form: a port would add a SECOND silent-degradation mode to a path that
// already has one and has not fixed it, and the new one would be worse, because
// a systematically worse transcription is uniform, complete-looking and
// invisible to every check we have.
//
// WHAT WOULD REVERSE IT is evidence that these transcriptions are bad —
// measurable against kb_documents rows carrying metadata.ocr, truncation first —
// or Gemini changing its native PDF / Files API handling. Not a new model
// announcement.
//
// WHAT THE TESTS PIN, EXACTLY, because the honest scope is narrower than "this
// cannot drift back". cutoverGroup3.test.js asserts three things, and only the
// third fences THIS file:
//
//   1. no `ocr` key in models.TASKS, and 2. none in DISPATCH_READY — both keyed
//      on the string, so neither says anything about this module.
//   3. with the router told to prefer Claude every way it can be told, the
//      constant below AND the model actually handed to the client on a real
//      ocrPdf() call are both Gemini ids. Reading the REQUEST is the load-
//      bearing half: it catches a model resolved per call inside
//      generateFromParts — the shape §9 item 4 pushed every other task towards,
//      and so the likeliest accidental port — which an assertion on the
//      exported constant alone walks straight past. It also fails if the call
//      reaches no Gemini client at all, i.e. a swap onto another SDK.
//
// TWO gaps it does NOT close, named so nobody has to rediscover them — both
// measured green against the guard as it stands:
//
//   a. a branch keyed on an env var the test does not set
//      (`KB_OCR_PROVIDER === 'anthropic' ? …`) resolves Gemini under the test
//      and Claude in production. No executing guard can enumerate env names it
//      was never told about;
//   b. a decoy — one throwaway Gemini call left on OCR_MODEL here while the real
//      transcription goes to anthropic.generate. The guard proves a Gemini call
//      HAPPENED carrying a Gemini id, not that that call carried the PDF.
//
// (a) is the shape a careless port would take; (b) has to be built on purpose.
// The strongest fix offered for (a) — pinning the SET of process.env names this
// file reads — was considered and declined: `process.env['KB_' + 'OCR_PROVIDER']`
// defeats it, and it is the source-scrape form whose failures this migration has
// documented three times over. So: a new provider env read, or a second model
// call, appearing in this file is a REVIEWER's catch. The honest claim is that
// §4.8 cannot be reversed here QUIETLY — not that it cannot be reversed.
const OCR_MODEL = process.env.GEMINI_OCR_MODEL || TIERS.gemini.flash;

// Gemini caps a single request payload at ~20MB. Base64 inflates bytes ~33%, so
// PDFs above this go through the Files API (temp file) instead of inline data.
const INLINE_MAX_BYTES = parseInt(process.env.KB_OCR_INLINE_MAX_BYTES || String(14 * 1024 * 1024), 10);
const OCR_MAX_OUTPUT_TOKENS = parseInt(process.env.KB_OCR_MAX_OUTPUT_TOKENS || '16384', 10);
// How long to wait for the Files API to mark an upload ACTIVE before giving up.
const FILES_ACTIVE_TIMEOUT_MS = parseInt(process.env.KB_OCR_FILES_TIMEOUT_MS || '30000', 10);

const OCR_PROMPT = [
  'Transcribe ALL text from this PDF document verbatim, preserving the natural',
  'reading order. Include text from tables, headers, footers, captions, and',
  'figures. Do NOT summarize, translate, describe images, or add commentary —',
  'output only the transcribed text.',
  'Insert a single form-feed character (\\f) between the text of each page so',
  'page boundaries are preserved. If the document is genuinely blank or contains',
  'no legible text, output nothing.',
].join(' ');

// Strip a leading conversational preamble the model occasionally emits despite
// the instruction (e.g. "Here is the transcribed text:").
function stripPreamble(text) {
  return String(text || '').replace(
    /^\s*(here(?:'s| is)|sure|certainly|below is|the (?:transcribed|extracted) text)[^\n:]*:?\s*\n/i,
    ''
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateFromParts(client, parts, tenantId = null) {
  const resp = await client.models.generateContent({
    model: OCR_MODEL,
    contents: [{ role: 'user', parts }],
    config: { temperature: 0, maxOutputTokens: OCR_MAX_OUTPUT_TOKENS },
  });
  // Worth attributing per tenant despite the plumbing it costs: a scanned page
  // bills as image tokens, so one large PDF can outweigh a day of text calls.
  costs.recordGemini(tenantId, 'kb.ocr', OCR_MODEL, resp.usageMetadata);
  return stripPreamble(resp.text || '').trim();
}

async function ocrInline(client, buffer, mimeType, tenantId = null) {
  return generateFromParts(client, [
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: OCR_PROMPT },
  ], tenantId);
}

// For files too large to inline: upload via the Files API, wait until ACTIVE,
// reference it, then clean up both the temp file and the remote file.
async function ocrViaFilesApi(client, buffer, mimeType, tenantId = null) {
  const tmpPath = path.join(
    os.tmpdir(),
    `kb-ocr-${crypto.randomBytes(8).toString('hex')}.pdf`
  );
  let uploaded;
  try {
    fs.writeFileSync(tmpPath, buffer);
    uploaded = await client.files.upload({ file: tmpPath, config: { mimeType } });

    // PDFs usually become ACTIVE immediately, but poll to be safe.
    const deadline = Date.now() + FILES_ACTIVE_TIMEOUT_MS;
    let state = uploaded.state;
    while (state === 'PROCESSING' && Date.now() < deadline) {
      await sleep(1000);
      const refreshed = await client.files.get({ name: uploaded.name });
      state = refreshed.state;
    }
    if (state && state !== 'ACTIVE') {
      throw new Error(`uploaded file not ACTIVE (state=${state})`);
    }

    return await generateFromParts(client, [
      { fileData: { mimeType, fileUri: uploaded.uri } },
      { text: OCR_PROMPT },
    ], tenantId);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    if (uploaded && uploaded.name) {
      try { await client.files.delete({ name: uploaded.name }); }
      catch (err) { console.warn('[kb-ocr] remote file cleanup failed:', err.message); }
    }
  }
}

// Returns extracted text or null. NOT "null on any failure": null on the HARD
// failures only (no key, no client, empty buffer, oversized-upload trouble,
// model error, empty result). A response truncated at OCR_MAX_OUTPUT_TOKENS is
// non-empty, so it is returned as a success — see the truncation note at the
// top of this file, and ADR-0006 §10.
//
// Pages are form-feed-separated when the model honours the prompt's separator
// instruction; parsers.js derives chunk page numbers by splitting on it. The
// one production row has none at all, so treat the separator as best-effort
// rather than as part of this contract (ADR-0006 §4.8).
async function ocrPdf(buffer, { mimeType = 'application/pdf', tenantId = null } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[kb-ocr] GEMINI_API_KEY not set — skipping OCR fallback');
    return null;
  }
  if (!buffer || buffer.length === 0) return null;

  let client;
  try { client = gemini.getClient(); }
  catch (err) { console.warn('[kb-ocr] no Gemini client:', err.message); return null; }

  try {
    const text = buffer.length > INLINE_MAX_BYTES
      ? await ocrViaFilesApi(client, buffer, mimeType, tenantId)
      : await ocrInline(client, buffer, mimeType, tenantId);
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.warn('[kb-ocr] OCR fallback failed:', err.message);
    return null;
  }
}

module.exports = { ocrPdf, OCR_MODEL };
