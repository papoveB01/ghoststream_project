// Source-file → plain text extraction.
//
// Returns { text, pages?, meta } where pages is an optional array used to
// preserve page boundaries when the chunker is invoked. Each parser MUST
// normalize whitespace so the downstream content_hash is stable across
// re-uploads of bit-identical PDFs that pdf-parse may emit slightly
// differently (trailing form-feeds, etc.).

const pdfParse = require('pdf-parse');
const ocr = require('./ocr');

const PDF_MIME = new Set(['application/pdf']);
const MARKDOWN_MIME = new Set(['text/markdown', 'text/x-markdown']);
const TEXT_MIME = new Set(['text/plain']);

// Below this many extracted chars we treat the PDF as having no usable text
// layer (scanned / image-only / outlined glyphs) and try the OCR fallback.
const OCR_TRIGGER_CHARS = parseInt(process.env.KB_OCR_TRIGGER_CHARS || '100', 10);

function inferSourceType({ mimetype, filename }) {
  const mt = (mimetype || '').toLowerCase();
  if (PDF_MIME.has(mt)) return 'pdf';
  if (MARKDOWN_MIME.has(mt)) return 'markdown';
  if (TEXT_MIME.has(mt)) return 'text';

  // Multer/browser sometimes sends application/octet-stream; fall back to ext.
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}

function normalize(text) {
  return String(text || '')
    // Collapse Windows line endings.
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Strip form-feed (pdf-parse uses this as a page separator — we capture
    // pages separately, so the body text shouldn't carry FF chars).
    .replace(/\f/g, '\n')
    // Trim trailing spaces on each line — keeps hashes stable across re-uploads.
    .replace(/[ \t]+(\n|$)/g, '$1')
    // Collapse 3+ blank lines to a single blank line.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildPdfResult(rawText, { pageCount, pdfInfo, ocr: didOcr } = {}) {
  // pdf-parse (and our OCR prompt) emit one form-feed (\f) per page boundary;
  // split on that to preserve page numbers in chunk metadata.
  const rawPages = (rawText || '').split('\f');
  const pages = rawPages.map((t, i) => ({
    page: i + 1,
    text: normalize(t),
  })).filter((p) => p.text.length > 0);

  return {
    text: normalize(rawText || ''),
    pages,
    meta: {
      pdfPageCount: pageCount || rawPages.length,
      pdfInfo: pdfInfo || {},
      ...(didOcr ? { ocr: true, ocrModel: ocr.OCR_MODEL } : {}),
    },
  };
}

async function parsePdf(buffer) {
  const data = await pdfParse(buffer);
  const result = buildPdfResult(data.text || '', {
    pageCount: data.numpages,
    pdfInfo: data.info || {},
  });

  // No usable embedded text layer → image-only / scanned / outlined PDF.
  // Fall back to Gemini OCR (best-effort; returns null on any failure, in which
  // case we keep the short result and let the caller raise the usual error).
  if (result.text.length < OCR_TRIGGER_CHARS) {
    const ocrText = await ocr.ocrPdf(buffer, { mimeType: 'application/pdf' });
    if (ocrText) {
      return buildPdfResult(ocrText, {
        pageCount: data.numpages,
        pdfInfo: data.info || {},
        ocr: true,
      });
    }
  }

  return result;
}

function parseMarkdown(buffer) {
  // Markdown is largely usable as-is; we don't strip the syntax because the
  // chunker treats `#` and `##` as natural section boundaries.
  return {
    text: normalize(buffer.toString('utf8')),
    pages: null,
    meta: {},
  };
}

function parseText(buffer) {
  return {
    text: normalize(buffer.toString('utf8')),
    pages: null,
    meta: {},
  };
}

// `file` = { buffer, mimetype, originalname }
async function parseFile(file) {
  const sourceType = inferSourceType({
    mimetype: file.mimetype,
    filename: file.originalname,
  });
  if (!sourceType) {
    const err = new Error(`unsupported file type: ${file.mimetype || file.originalname}`);
    err.status = 400;
    throw err;
  }

  switch (sourceType) {
    case 'pdf':      return { sourceType, ...(await parsePdf(file.buffer)) };
    case 'markdown': return { sourceType, ...parseMarkdown(file.buffer) };
    case 'text':     return { sourceType, ...parseText(file.buffer) };
    default:         throw new Error('unreachable');
  }
}

module.exports = { parseFile, inferSourceType, normalize };
