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
// dependency; and this is a FALLBACK whose production volume is too small to
// repay a rewrite. The volume is a database observation, so it is NOT restated
// here where nothing can keep it true — §4.8 carries the number, dated, scoped
// to an environment, and with the row id.
//
// ocrViaFilesApi below has no equivalent in anthropic.js — no PDF helper, no
// base64 or size handling, no upload-and-reference path. Stated that way rather
// than as "no document support": anthropic.generate's normalizeMessages accepts
// a block array and passes the blocks through UNINSPECTED — untouched in the
// common case, and re-wrapped into a fresh array (same block objects) when it
// merges two same-role messages. Either way it never reads a block's type or
// contents, so a hand-built document block WOULD reach the API. What is missing
// is everything around it, in this tree.
//
// Bounded the same way §4.8 bounds it: ocrViaFilesApi has never EXECUTED in
// either environment, so "no equivalent" is an argument about a rewrite nobody
// has needed yet, not about a path in use.
//
// The failure asymmetry is the load-bearing reason, and it holds for HARD
// failures only — see the truncation note at the top of this file. Bounded
// form: a port would add a SECOND silent-degradation mode to a path that
// already has one and has not fixed it, and the new one would be worse, because
// a systematically worse transcription is uniform, complete-looking and
// invisible to every check we have.
//
// WHAT WOULD REVERSE IT is evidence that these transcriptions are bad — or
// Gemini changing its native PDF / Files API handling. Not a new model
// announcement. kb_documents rows carrying metadata.ocr IDENTIFY the documents
// to look at; they carry no truncation signal, because nothing here records
// finishReason, so measuring the truncation case needs that recorded first
// (ADR-0006 §10). §4.8 has the rest, including what the page-coverage check
// returns on the one row that exists.
//
// WHAT PINS THIS FILE, and how narrowly. cutoverGroup3.test.js asserts the
// absence of an `ocr` key and of `ocr` from DISPATCH_READY — both keyed on the
// string, so neither says anything about this module — and then, with the
// router told to prefer Claude every way it can be told, that the constant
// below AND the model actually handed to the client on a real ocrPdf() call are
// both Gemini ids. Reading the REQUEST is the half that fences THIS file: it
// catches a model resolved per call inside generateFromParts, which an
// assertion on the exported constant alone walks straight past.
//
// It is not airtight and does not claim to be. A provider branch keyed on an
// env var the test never sets resolves Gemini under the test and Claude in
// production, and no executing guard can enumerate env names it was not given.
// So: A NEW PROVIDER ENV READ, OR A SECOND MODEL CALL, APPEARING IN THIS FILE
// IS A REVIEWER'S CATCH — this file's whole subject is that it does neither.
// The honest claim is that §4.8 cannot be reversed here QUIETLY, not that it
// cannot be reversed. The full account of what the guard covers, the two shapes
// it does not, and why the strongest proposed fix was declined lives with the
// test itself (cutoverGroup3.test.js, the block above the §4.8 test) and in
// §4.8 — not duplicated here, where it would drift out of step with the
// assertions it describes.
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
