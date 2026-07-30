// Semantic validation for model output.
//
// `responseSchema` constrains SHAPE — types, enums, required keys. It cannot
// express the constraints that depend on THIS request: that endSeconds falls
// inside this particular recording, that citation [7] is one of the four
// sources we actually supplied, that a "verbatim quote" appears in the document
// it claims to come from. Those are checked here, after the parse.
//
// Two conventions, both deliberate:
//
//   1. Nothing here throws, and nothing repairs by guessing. Each helper either
//      reports a verdict or returns a filtered value; the caller decides
//      whether that means drop the row, null the field, or flag it for the UI.
//      Coercing an incoherent value into a plausible one is how a hallucination
//      becomes a fact — see the clamp note in knowledge/relevance.js.
//
//   2. Where a check cannot reach a verdict (no duration on file, a quote too
//      short to be evidence of anything) it reports "not disproven" rather than
//      "invalid", so absent context never manufactures a failure.

// Timestamps can legitimately land a hair past a recording's stated duration —
// transcript rounding, container vs. stream length. A second of slack keeps
// that from being read as a hallucination.
const DURATION_SLACK_SEC = 1;

// A published date may be hours ahead of our clock through timezone offsets and
// publisher scheduling, but not days.
const FUTURE_SLACK_MS = 36 * 60 * 60 * 1000;

// A quote shorter than this (in words) will match almost any text by chance, so
// a substring test on it proves nothing either way.
const MIN_QUOTE_WORDS = 4;

// Number() maps null, '', false and [] to 0 — all "finite", so a missing
// timestamp would sail through as second zero. Absent must stay absent: this is
// exactly the coercion-invents-a-value trap the header warns about.
function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── time ranges ───────────────────────────────────────────────────────────
// A clip range is usable only if both ends are finite, ordered, non-negative,
// and inside the recording. durationSeconds may be null/unknown, in which case
// only the internal consistency is checked.
function validTimeRange(start, end, durationSeconds = null) {
  const s = toFiniteNumber(start);
  const e = toFiniteNumber(end);
  if (s === null || e === null) return false;
  if (s < 0 || e <= s) return false;
  const d = toFiniteNumber(durationSeconds);
  if (d !== null && d > 0 && e > d + DURATION_SLACK_SEC) return false;
  return true;
}

// ── dates ─────────────────────────────────────────────────────────────────
// A real calendar date, not merely a YYYY-MM-DD-shaped string. Two distinct
// failures hide behind the shape:
//   '2027-13-45' → new Date() gives Invalid Date, which Postgres rejects on a
//                  timestamptz column, taking the insert with it.
//   '2026-02-31' → new Date() SILENTLY rolls it to March 3rd. No error anywhere,
//                  just a wrong date stored as fact — the worse of the two.
// So the components are validated by round-trip rather than trusted to parse.
// Returns the original string when it is a genuine, non-future date, else null.
function realPastDate(value, now = Date.now()) {
  const raw = String(value == null ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Any rollover (month 13, Feb 31) lands on a different calendar date.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (dt.getTime() > now + FUTURE_SLACK_MS) return null; // dated after the present
  return raw;
}

// ── citation indices ──────────────────────────────────────────────────────
// Keep only citations that point at evidence we actually supplied. `valid` is
// the set of numbers offered to the model — not a 1..N range, because a
// truncated dossier may not contain every source it was built from.
function keepCitations(list, valid) {
  if (!Array.isArray(list)) return [];
  const allowed = valid instanceof Set ? valid : new Set(valid || []);
  return [...new Set(list.filter((n) => Number.isInteger(n) && allowed.has(n)))];
}

// The citable source numbers actually present in a dossier — the `## [n]` heads
// written by research.js buildDossier. Parsing the final string (rather than
// trusting the source array) also handles the truncation case correctly: a
// source whose head was cut off was never visible to the model.
function citableNumbers(dossierMd) {
  const out = new Set();
  const re = /^##\s*\[(\d+)\]/gm;
  let m;
  while ((m = re.exec(String(dossierMd || ''))) !== null) out.add(parseInt(m[1], 10));
  return out;
}

// ── quote fidelity ────────────────────────────────────────────────────────
// Collapse to comparable form: unify smart quotes/dashes, drop punctuation and
// case, squeeze whitespace. Deliberately lossy — we are testing whether the
// passage EXISTS in the source, not whether it was transcribed byte-perfectly.
function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/…/g, '...')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Does a claimed-verbatim quote appear in the text it was taken from?
//
// Catches outright fabrication. Does NOT distinguish fabrication from
// paraphrase — a model that rewords a real passage fails this too — so callers
// should FLAG rather than delete on a false. Returns true when the quote is too
// short to test, since a three-word match proves nothing.
function quoteAppearsIn(quote, source) {
  const needle = normalizeForMatch(quote);
  if (!needle) return false;
  if (needle.split(' ').length < MIN_QUOTE_WORDS) return true; // not testable
  return normalizeForMatch(source).includes(needle);
}

module.exports = {
  validTimeRange,
  realPastDate,
  keepCitations,
  citableNumbers,
  quoteAppearsIn,
  normalizeForMatch,
  MIN_QUOTE_WORDS,
};
