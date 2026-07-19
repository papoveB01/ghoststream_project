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
// Best-effort by contract: any failure (no API key, oversized file, model
// error, empty result) returns null so the caller falls back to the original
// short-text result and the existing 4xx error still fires.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gemini = require('../gemini');
const { TIERS } = require('../models');

// Vision-capable model for transcription. Flash (not flash-lite) by default for
// OCR fidelity; override with GEMINI_OCR_MODEL.
const OCR_MODEL = process.env.GEMINI_OCR_MODEL || TIERS.flash;

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

async function generateFromParts(client, parts) {
  const resp = await client.models.generateContent({
    model: OCR_MODEL,
    contents: [{ role: 'user', parts }],
    config: { temperature: 0, maxOutputTokens: OCR_MAX_OUTPUT_TOKENS },
  });
  return stripPreamble(resp.text || '').trim();
}

async function ocrInline(client, buffer, mimeType) {
  return generateFromParts(client, [
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: OCR_PROMPT },
  ]);
}

// For files too large to inline: upload via the Files API, wait until ACTIVE,
// reference it, then clean up both the temp file and the remote file.
async function ocrViaFilesApi(client, buffer, mimeType) {
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
    ]);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    if (uploaded && uploaded.name) {
      try { await client.files.delete({ name: uploaded.name }); }
      catch (err) { console.warn('[kb-ocr] remote file cleanup failed:', err.message); }
    }
  }
}

// Returns extracted text (form-feed-separated pages) or null on any failure.
async function ocrPdf(buffer, { mimeType = 'application/pdf' } = {}) {
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
      ? await ocrViaFilesApi(client, buffer, mimeType)
      : await ocrInline(client, buffer, mimeType);
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.warn('[kb-ocr] OCR fallback failed:', err.message);
    return null;
  }
}

module.exports = { ocrPdf, OCR_MODEL };
