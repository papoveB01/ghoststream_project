// Semantic validation of model output (src/semantics.js). These guard the
// checks that responseSchema structurally cannot make: a clip range inside THIS
// recording, a citation pointing at evidence we actually supplied, a date that
// exists on a calendar, a "verbatim" quote that is really in the source.
//
// Pure functions — no DB, no Gemini.

const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../src/semantics');

test('validTimeRange: accepts a sane range inside the recording', () => {
  assert.strictEqual(s.validTimeRange(30, 75, 285), true);
  assert.strictEqual(s.validTimeRange(0, 285, 285), true, 'the full recording is a valid range');
});

test('validTimeRange: rejects inverted, zero-length, negative and out-of-recording ranges', () => {
  assert.strictEqual(s.validTimeRange(75, 30, 285), false, 'end before start');
  assert.strictEqual(s.validTimeRange(30, 30, 285), false, 'zero-length clip');
  assert.strictEqual(s.validTimeRange(-5, 40, 285), false, 'negative start');
  assert.strictEqual(s.validTimeRange(30, 400, 285), false, 'ends past the recording');
});

test('validTimeRange: rejects non-numeric values, tolerates 1s of rounding slack', () => {
  assert.strictEqual(s.validTimeRange(null, 40, 285), false);
  assert.strictEqual(s.validTimeRange(30, undefined, 285), false);
  assert.strictEqual(s.validTimeRange(30, NaN, 285), false);
  assert.strictEqual(s.validTimeRange(30, 286, 285), true, 'a second past duration is rounding, not hallucination');
  assert.strictEqual(s.validTimeRange(30, 288, 285), false, 'three seconds past is not');
});

test('validTimeRange: with no duration on file, checks only internal consistency', () => {
  assert.strictEqual(s.validTimeRange(30, 99999, null), true, 'unknown duration cannot disprove the range');
  assert.strictEqual(s.validTimeRange(99, 30, null), false, 'but ordering is still checked');
});

test('realPastDate: accepts real past dates, rejects calendar-invalid ones', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  assert.strictEqual(s.realPastDate('2026-06-04', now), '2026-06-04');
  // Shape-valid, calendar-invalid: these are what reach a timestamptz column
  // and take the whole insert batch down with them.
  assert.strictEqual(s.realPastDate('2027-13-45', now), null, 'month 13 / day 45');
  assert.strictEqual(s.realPastDate('2026-02-31', now), null, 'February 31st');
  assert.strictEqual(s.realPastDate('not-a-date', now), null);
  assert.strictEqual(s.realPastDate('', now), null);
  assert.strictEqual(s.realPastDate(null, now), null);
});

test('realPastDate: rejects the future beyond timezone slack', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  assert.strictEqual(s.realPastDate('2027-01-15', now), null, 'a hallucinated future date must not read as freshest');
  assert.strictEqual(s.realPastDate('2026-07-31', now), '2026-07-31', 'tomorrow is within publisher/tz slack');
});

test('keepCitations: keeps only supplied evidence numbers, deduped', () => {
  const valid = new Set([1, 2, 3, 4]);
  assert.deepStrictEqual(s.keepCitations([1, 3], valid), [1, 3]);
  assert.deepStrictEqual(s.keepCitations([1, 9, 2, 99], valid), [1, 2], 'out-of-set citations dropped');
  assert.deepStrictEqual(s.keepCitations([2, 2, 2], valid), [2], 'deduped');
  assert.deepStrictEqual(s.keepCitations([1.5, '2', null, 0, -1], valid), [], 'non-integers and 0/negatives dropped');
  assert.deepStrictEqual(s.keepCitations('nope', valid), [], 'non-array input');
  assert.deepStrictEqual(s.keepCitations([1], []), [], 'nothing supplied → nothing citable');
});

test('citableNumbers: reads the [n] heads the model was actually shown', () => {
  const dossier = [
    '# Research dossier: Acme',
    '## [1] Acme raises Series B',
    'URL: https://example.com/a',
    '## [2] Acme opens Lagos office',
    'URL: https://example.com/b',
    'Body text mentioning [7] inline, which is not a source head.',
  ].join('\n\n');
  const nums = s.citableNumbers(dossier);
  assert.deepStrictEqual([...nums].sort(), [1, 2]);
  assert.strictEqual(nums.has(7), false, 'an inline [7] in body text is not a citable source');
});

test('citableNumbers: a truncated dossier yields only the sources still visible', () => {
  // DOSSIER_CAP can cut mid-document; a source whose head was removed was never
  // shown to the model, so citing it cannot be legitimate.
  const full = '## [1] One\n\nbody\n\n## [2] Two\n\nbody';
  const cut = full.slice(0, full.indexOf('## [2]'));
  assert.deepStrictEqual([...s.citableNumbers(cut)], [1]);
  assert.deepStrictEqual([...s.citableNumbers('')], []);
});

test('quoteAppearsIn: finds a real quote despite punctuation and casing drift', () => {
  const transcript = '[1:04-1:20] Sara Chen (prospect): The payback period just doesn’t work for us at that price.';
  assert.strictEqual(s.quoteAppearsIn('the payback period just doesn\'t work for us', transcript), true,
    'smart vs straight apostrophe must not matter');
  assert.strictEqual(s.quoteAppearsIn('The  payback   period just doesn’t work', transcript), true,
    'whitespace is normalized');
  assert.strictEqual(s.quoteAppearsIn('THE PAYBACK PERIOD JUST DOESN\'T WORK', transcript), true,
    'case is normalized');
});

test('quoteAppearsIn: rejects a fabricated quote', () => {
  const transcript = 'REP: We can get you live in six weeks.\n\nPROSPECT: That timeline is fine.';
  assert.strictEqual(s.quoteAppearsIn('we guarantee a four week implementation', transcript), false);
  assert.strictEqual(s.quoteAppearsIn('', transcript), false, 'an empty quote verifies nothing');
});

test('quoteAppearsIn: a quote too short to test is not reported as fabricated', () => {
  // A three-word fragment matches almost any text by chance, so a false here
  // would be noise, not signal.
  assert.strictEqual(s.quoteAppearsIn('too expensive', 'a completely unrelated transcript'), true);
  assert.ok(s.MIN_QUOTE_WORDS >= 4, 'the not-testable floor should stay at 4+ words');
});
