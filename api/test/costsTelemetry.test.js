// Vendor-spend telemetry (ADR-0006 phase 0).
//
// usage_costs shipped with migration 0049 and a working recorder, and then sat
// empty for two months: only 4 of ~30 model call sites ever called it, and
// nothing read the table. "What did we spend last month" was unanswerable from
// the running system — which is a bad position from which to change providers.
//
// Three properties are pinned here:
//
//  1. [TEXTUAL] every models.generateContent() call site sits in a file that
//     also records. This is the one that stops the drift recurring: adding a
//     model call without telemetry now fails the suite rather than quietly
//     widening the blind spot.
//  2. Claude's cache-token accounting. Its `input_tokens` is the UNCACHED
//     REMAINDER, and prompt tokens split across three fields billing at three
//     different rates. Porting Gemini's mapping field-for-field under-reports
//     every cached call — i.e. exactly the calls ADR-0006 §4.3 leans on.
//  3. Longest-prefix rate matching: 'gemini-2.5-flash-lite' contains
//     'gemini-2.5-flash', so a naive substring match bills lite calls at 3× and
//     the error is invisible in any single row.
//
// No Postgres: db is replaced in require.cache before costs is required, per
// the pattern in test/queryBounds.test.js and test/geminiCacheScan.test.js.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(SRC, relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const inserted = [];
let lastSelect = null;

stubModule('db', {
  async query(text, params) {
    if (/^\s*INSERT INTO usage_costs/.test(text)) {
      inserted.push({ text, params });
      return { rows: [] };
    }
    lastSelect = { text, params };
    return { rows: [] };
  },
});

const costs = require(path.join(SRC, 'costs.js'));

// Params order in record(): tenant_id, service, site, units, unit_kind, est_cost_cents, meta
const P = { TENANT: 0, SERVICE: 1, SITE: 2, UNITS: 3, KIND: 4, CENTS: 5, META: 6 };

function lastRow() {
  return inserted[inserted.length - 1];
}

// ── 1. coverage invariant ───────────────────────────────────────────────────

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    // `.js` is not the only module extension Node loads, and a sweep that
    // cannot see api/src/foo.cjs is a sweep a lying claim can be parked outside
    // of. Verified: a .cjs carrying two wrong counts was invisible here.
    else if (/\.[cm]?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Comments must not count. A reviewer defeated the first version of this guard
// twice: once with a commented-out `// costs.recordGemini(...) // TODO` next to
// a genuinely unrecorded call, and once by reformatting an existing call so the
// call-regex stopped matching while its stale recorder still did — the counts
// balanced and the suite went green with live unrecorded spend in the tree.
//
// A third defeat, found by review of the live-schema guard that copied this
// function: the original strip also fired on a `//` inside a string or a regex
// literal, deleting the rest of the line. `src/ics.js`'s
// `'-//DealScope//Meeting Invite//EN'` and `src/portfolio.js`'s `/\/\//` are
// both truncated by it today, so putting a model call on such a line hid it.
// The stripper now lives in one place, with its own tests.
const { stripComments } = require('./helpers/stripComments.js');

// Tolerate the formatting a prettier pass or a human would produce: any client
// variable, a newline before the options object.
//
// `embedContent` is deliberately NOT in this pattern. Verified against the live
// API on 2026-08-05: an embedContent response carries no `usageMetadata` at all
// (top-level keys are `sdkHttpResponse, embeddings`), so `recordGemini` would
// hit its `if (!usage) return` and write nothing. Widening this regex would
// force a recorder that silently records zero — a green guard over invisible
// spend, which is worse than the acknowledged gap. Embedding spend needs its
// own recorder that estimates tokens rather than reading them; tracked as a
// follow-up, and `knowledge/embeddings.js` is the one uninstrumented model
// surface until then.
const CALL_RE = /\.\s*models\s*\.\s*generateContent\s*\(\s*\{/g;
const RECORD_RE = /costs\s*\.\s*record(?:Gemini|Claude)\s*\(/g;

test('[TEXTUAL] every model call site sits in a file that records spend', () => {
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const calls = (src.match(CALL_RE) || []).length;
    if (calls === 0) continue;
    const records = (src.match(RECORD_RE) || []).length;
    if (records < calls) {
      offenders.push(`${path.relative(SRC, file)} — ${calls} call site(s), ${records} recorder(s)`);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'a model call site without a recorder is spend we cannot see — add costs.recordGemini() ' +
    'next to the call, threading tenantId in if the enclosing function lacks it:\n  ' + offenders.join('\n  ')
  );
});

// The counting guard above still cannot pair a specific call to a specific
// recorder — two recorders on one call site and none on another passes. This
// narrows that gap for the common shape: within each file, every recorder must
// name a distinct site, so the "two recorders, one call" bypass needs two
// distinct labels to go unnoticed, which is no longer an accident.
test('[TEXTUAL] no file records the same site label twice', () => {
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const seen = new Map();
    for (const m of src.matchAll(/costs\.record(?:Gemini|Claude)\([^,]+,\s*'([^']+)'/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
    for (const [label, n] of seen) {
      if (n > 1) offenders.push(`${path.relative(SRC, file)} — '${label}' recorded ${n}×`);
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n  '));
});

// A migrated call site no longer records its own spend: aiCall.generateStructured
// records for Gemini and anthropic.generate records for Claude, both keyed on the
// `site` the caller passes. So the sweep has to count BOTH spellings, or the floor
// below simply erodes as ADR-0006 §9 item 5 proceeds — one call site at a time,
// each drop individually unremarkable, until the guard is counting almost nothing
// and still passing. Group 1 alone moved four of them.
// Whitespace-tolerant, exactly like CALL_RE above — and for the same reason.
// The first version spelled this `/\.generateStructured\(\{/g`, so
// `.generateStructured( {` (a prettier pass, or a human) and a destructured
// `const { generateStructured } = require(...); generateStructured({…})` both
// escaped it. Each escape silently takes its `site:` off the floor the last
// test in this section asserts, one call site at a time, exactly as the
// migration proceeds — which is the erosion that floor exists to catch.
//
// The dot-less alternative must still skip aiCall.js's own
// `async function generateStructured({…})` — a definer, with no site to pass —
// so `function` is excluded explicitly rather than by requiring the dot.
const SEAM_CALL_RE =
  /(?:\.\s*generateStructured|(?<![.\w])(?<!function\s)generateStructured)\s*\(\s*\{/g;

// Brace-matched, not a fixed window. The 1200-char window this replaces is
// ALREADY too small for the next group: analysis.js's config key sits 1235+
// chars into its call, so the very next cutover would have reported a
// legitimately-labelled call site as unlabelled — or, with the label past the
// window, missed a genuinely missing one. Depth counting has no such ceiling,
// and an unbalanced call (truncated file, a brace inside a string) returns null
// and is reported as an offender rather than silently passing.
function callWindow(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

function seamSiteLabels(src) {
  const out = [];
  for (const m of src.matchAll(SEAM_CALL_RE)) {
    const window = callWindow(src, m.index + m[0].indexOf('('));
    // An unbalanced call is reported, never skipped: "we could not read this
    // call site" and "this call site has no label" are both failures of the
    // sweep, and silently dropping the first is how a guard starts counting
    // less than it claims to.
    if (window === null) { out.push({ unreadable: true }); continue; }
    const site = window.match(/\bsite:\s*'([^']+)'/);
    out.push(site ? site[1] : null);
  }
  return out;
}

test('[TEXTUAL] every seam call site passes an explicit site label', () => {
  // Without one, aiCall falls back to `ai.<task>` — which is not the
  // '<area>.<operation>' convention the rollup groups on, and would quietly
  // fragment a task's spend across two labels during a migration.
  const offenders = [];
  for (const file of walkJs(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    seamSiteLabels(src).forEach((label, i) => {
      if (label && label.unreadable) {
        offenders.push(`${path.relative(SRC, file)} — generateStructured #${i + 1} has unbalanced ` +
          'braces/parens, so this sweep could not read it at all');
      } else if (!label) {
        offenders.push(`${path.relative(SRC, file)} — generateStructured #${i + 1} has no site:`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n  '));
});

test('[TEXTUAL] the recorded site labels are unique and namespaced', () => {
  const labels = [];
  for (const file of walkJs(SRC)) {
    // stripComments, like every other sweep in this file. Reading raw was
    // defeat #1 from this file's own header comment, reproduced against the new
    // seam counting: two commented-out `// aiCall.generateStructured({ site:
    // 'fake' })` lines padded the floor below back to 25 while real call sites
    // went uninstrumented.
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/costs\.recordGemini\([^,]+,\s*'([^']+)'/g)) labels.push(m[1]);
    for (const label of seamSiteLabels(src)) if (typeof label === 'string') labels.push(label);
  }
  assert.ok(labels.length >= 25, `expected the full call-site sweep to be instrumented, found ${labels.length}`);
  for (const l of labels) {
    assert.match(l, /^[a-z][a-zA-Z]*\.[a-zA-Z]+$/, `site label '${l}' should read '<area>.<operation>'`);
  }
  assert.strictEqual(new Set(labels).size, labels.length,
    'two call sites sharing a label make their costs indistinguishable in the rollup');
});

// ── prose sweeps ────────────────────────────────────────────────────────────
//
// Three numbers in this migration live in PROSE as well as in code: how many
// seam call sites there are, how many DISPATCH_READY keys land on Sonnet 5, and
// how big DISPATCH_READY is. Each is swept out of every file under src/ and
// compared against the code, because every narrower version has been defeated
// with the suite green: reading one canonical file missed aiCall.js's twin of
// the Sonnet count, and taking only the first match missed a restatement two
// lines below the guarded sentence.
//
// WHAT THIS CATCHES AND WHAT IT DOES NOT — stated exactly, because the previous
// version of this comment said the number "may not disagree with the router,
// anywhere under src/" and the code beneath it did not do that. Each sweep
// matches a SHAPE: a count token governing one specific phrase. A restatement
// that avoids the shape — same claim, different verb — still escapes, and one
// was demonstrated escaping in `knowledge/research.js`, a file over from the
// twin this PR set out to close. These are tripwires on the phrasings this ADR
// actually uses. They are not a proof about prose, and the honest reading of
// three generations of defeat is that no regex over English will be.
//
// Widening is not free either, which is the other half of the sibling guard's
// old rationale and is kept: a guard that reddens on a TRUE sentence gets
// deleted. So the count is a NUMBER TOKEN and never `\w+` (the `\w+` version
// reddened on "keypoints, battlecard and research land on claude-sonnet-5" and
// then told the reader to add `research` to WORDS), and a sentence can opt out
// with `not-a-count`. THE OPT-OUT IS SENTENCE-SCOPED, not a character window:
// the marker has to sit in the SAME sentence as the match (bounded by `.`/`;`),
// and the opt-out must also be added to the pinned list in the test below, in
// the same diff. A marker one sentence away does nothing — that is the whole
// point of it, and stating the old ±80-character rule anywhere is now wrong.
//
// GENERATION FOUR, AND THE LAST ONE THAT SHOULD BE A REGEX. Count them: (1) one
// canonical file, first match only; (2) every file under src/, two hard-coded
// wordings; (3) a claim SHAPE instead of wordings; (4) this round — the floor
// anchored to the canonical phrase, the opt-out sentence-scoped and its every
// use pinned, and `.cjs`/`.mjs` swept. An independent pass defeated (3) in AT
// LEAST EIGHT WAYS, the ones reconstructible from its report (it counted
// eleven): `dispatch to`, `route to`, `are served by`, `are mapped to`, a
// single `.` anywhere in the filler (`models.js`, `§4.1`, `2.5`),
// `half-dozen`, `Sonnet5`, `call-sites`.
// The first two of those verbs are the ones anthropic.js and aiCall.js already
// use about this mechanism in their own opening paragraphs, so the most likely
// ACCIDENTAL restatement is also an escaping one. And this shape is not a
// different KIND of guard from the proximity rule it was chosen over, only a
// different blast radius: proximity reds on today's live-probe tables, and this
// will red on a future row of that same table ("2 of 5 retried calls stay on
// the Sonnet tier") with the wrong diagnosis and `not-a-count` as its only
// remedy.
//
// DECISION (2026-08-29, ADR-0006 §10): the next time this drifts, do NOT write
// a fifth regex. Either delete the prose copies so the number lives once and is
// derived, or move it into a structured token the test parses exactly
// (`@count sonnetKeys 3`) with the prose referring to that. No regex over
// English is a proof, and the honest form of that sentence is a decision, not
// a caveat.
//
// NOTE FOR THE NEXT WIDENING: these sweep src/ ONLY. Pointing them at test/ is
// the obvious next move and this file would self-trip on its own worked
// examples — the mutation quotes below carry deliberately wrong numbers. Break
// those literals or mark them before widening.
const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// Prose in this repo spells its counts out in words ("TEN seam call sites"), so
// the guards have to read words. The map is SHARED because it was not before:
// the Sonnet-count guard carried a private copy that stopped at `seven`, and
// the next cutover group takes DISPATCH_READY to eight — at which point
// `Number('eight')` is NaN and the guard failed as `NaN !== 8`. Safe, and
// useless to the implementer holding it. One map, one lookup that says what to
// do, and it is only ever reached once the shape has PROVEN the token is a
// count (see NUMBER below).
function wordToNumber(word, where) {
  const n = WORDS[String(word).toLowerCase()] ?? Number(word);
  assert.ok(Number.isFinite(n),
    `this guard read the count "${word}" out of ${where} and cannot turn it into a number. ` +
    'If that is a spelled-out number past the end of WORDS in test/costsTelemetry.test.js, ADD IT ' +
    'THERE: the map is word-shaped because the prose is, and the guard has to go on comparing the ' +
    'prose against the code. If instead the sentence is not a count claim at all, mark it ' +
    '`not-a-count` — the sweeps skip a match whose OWN SENTENCE (bounded by `.` or `;`) carries ' +
    'that marker, so it has to go in the sentence itself, not merely near it — AND add the ' +
    "sentence to the pinned opt-out list in this file's \"every not-a-count opt-out\" test, in the " +
    'same diff. Marking without pinning fails that test, which is deliberate: an opt-out is a ' +
    'decision someone has to see.');
  return n;
}

// A COUNT TOKEN, never `\w+`. Two things this rules out, both of them true
// sentences the first version of this guard reddened on: a bare noun where a
// number would go ("research land on claude-sonnet-5"), and the digits inside a
// hyphenated model id (the `4` in `claude-haiku-4-5` must not start a claim).
const NUMBER = `(?<![\\w-])(${['\\d+', ...Object.keys(WORDS)].join('|')})(?![\\w-])`;

// The three claim shapes. Filler is bounded and may not cross a sentence break,
// so a count in one sentence cannot reach a subject in the next.
const SEAM_SITES = new RegExp(`${NUMBER}[^.;]{0,20}?seam call sites(?: in total)?`, 'gi');
const SONNET_KEYS = new RegExp(
  `${NUMBER}(?: of the ${NUMBER})?[^.;]{0,40}?` +
  '\\b(?:land|lands|resolve|resolves|end up|ends up|sit|sits|map|maps|run|runs|go|goes)\\b' +
  '[^.;]{0,20}?\\b(?:on|to|onto)\\b[^.;]{0,20}?(?:claude-)?sonnet[ -]5\\b', 'gi');
const READY_SIZE = new RegExp(`${NUMBER} (?:tasks|keys) are in (?:models\\.)?DISPATCH_READY`, 'gi');

// Comment markers, markdown emphasis, backticks and line wrapping are
// normalised away first, so re-flowing or bolding a paragraph cannot silently
// un-guard it: `THREE **OF THE** SEVEN` has to read the same as the original,
// and it did not before. Underscores are deliberately left alone —
// `models.DISPATCH_READY` has to survive this to be matchable at all.
const prose = (src) => src
  .replace(/^[ \t]*\/\/ ?/gm, '')
  .replace(/[*`]/g, '')
  .replace(/\s+/g, ' ');

// EVERY match in EVERY file under src/, with an opt-out. The marker exists
// because a shape will eventually misread a true sentence, and the alternative
// — a reviewer deleting the guard to get their PR green — is how this class of
// check dies. models.js's "all three keys are in DISPATCH_READY" is the first
// real one: three named keys, not the size of the set.
//
// TWO THINGS NARROW THE OPT-OUT, which as a bare ±80-char window was a hole:
//
//   - it is scoped to the SENTENCE the match sits in, bounded by `.`/`;` the
//     same way the shape's own filler is. A character window shields whatever
//     happens to sit near a legitimate marker.
//   - every skip is PINNED by the test below. That is the part that bites: a
//     marker can still be written into the same sentence as a lying count (and
//     a claim inserted directly above models.js's marker is inside its sentence
//     with no punctuation between them — both were green at 22/22), but it
//     cannot be added without the pinned list changing, so an opt-out is a
//     visible diff and a reviewer's decision rather than a silent one.
//
// WHAT THE PIN FIXES IS THE OPT-OUT'S IDENTITY, NOT THE SHIELDED SENTENCE'S
// CONTENT. It keys on `file: quote`, so an existing sanctioned opt-out can be
// rewritten IN PLACE into a different false claim with the same quote and the
// pin will not move (demonstrated green). Pinning the surrounding sentence
// instead would red on every ordinary reword of a marked comment, which is the
// brittleness that gets guards deleted — so this is a stated limit, not an
// oversight. The defence against it is that the marked sentences are few, named
// here, and land in review as a diff on a line a reviewer is already looking
// at.
function sweepSrc(re) {
  const matched = [];
  const skipped = [];
  for (const file of walkJs(SRC)) {
    const text = prose(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(re)) {
      const entry = { file: path.relative(SRC, file), quote: m[0], count: m[1], outOf: m[2] };
      const head = text.slice(0, m.index);
      const from = Math.max(head.lastIndexOf('.'), head.lastIndexOf(';')) + 1;
      const tailAt = m.index + m[0].length;
      const tail = text.slice(tailAt);
      const stop = tail.search(/[.;]/);
      const sentence = text.slice(from, tailAt + (stop === -1 ? tail.length : stop));
      if (sentence.includes('not-a-count')) skipped.push(entry);
      else matched.push(entry);
    }
  }
  return { matched, skipped };
}

// A floor per canonical file: a sweep that matches nothing is a guard that
// checks nothing, and rewording the sentence is the cheapest way to get there
// by accident.
function assertPresentIn(found, files, what) {
  for (const f of files) {
    assert.ok(found.some((c) => c.file === f),
      `${f} no longer states ${what}. That sentence is a canonical prose copy of a number this ` +
      'file pins against the code; if it was reworded, re-point the pattern in ' +
      'test/costsTelemetry.test.js at the new wording rather than dropping the file — an ' +
      'unguarded copy is how every one of these drifted in the first place.');
  }
}

test('[TEXTUAL] the number of seam call sites is pinned, so prose has something to disagree with', () => {
  // ADR-0006's migration is described in prose that COUNTS call sites —
  // anthropic.js's header, models.js's DISPATCH_READY block, the ADR's §9 item
  // 5 register, the PR bodies. Group 2 shipped with three of those disagreeing
  // with the code and with each other ("six call sites", "eleven in total"),
  // from counting the functions that had to be edited rather than the
  // generateStructured calls that resulted.
  //
  // The existing tripwire for that class — providerRouter.test.js's set-equality
  // pin — cannot catch it: it is a failure MESSAGE listing the dependent prose,
  // and a message is only ever read on a red run. Verified by rewriting
  // anthropic.js's header to claim "group 2 (nothing yet) — FOUR seam call
  // sites": the suite stayed green. A count needs a number to contradict.
  //
  // The number, not the labels, because the labels are already pinned above and
  // a task can legitimately serve several sites (`keypoints` serves three). When
  // this fails, the next cutover PR is telling you which comments to re-read.
  let sites = 0;
  for (const file of walkJs(SRC)) {
    sites += seamSiteLabels(stripComments(fs.readFileSync(file, 'utf8'))).length;
  }
  assert.strictEqual(sites, 11,
    `${sites} aiCall.generateStructured call sites in src/, pinned at 11 (group 1: relevance x2, ` +
    'preview, companyBrief; group 2: keypoints x3, assessment, battlecard; group 3: research; ' +
    'group 4: compare). ' +
    'If you added or ' +
    "moved one, update this number AND the prose that quotes it: anthropic.js's header, " +
    "models.js's DISPATCH_READY / group lists, and ADR-0006 §9 item 5.");

  // …AND the number the prose actually quotes — EVERY copy of it, in every
  // file under src/.
  //
  // Pinning only the code count catches a call site being added or deleted, and
  // is blind to the drift that actually happened — a comment claiming a
  // different number while the code is unchanged. Verified: rewriting that
  // sentence to claim four sites left the count above green, because nothing in
  // src/ had moved. Two numbers that must agree is the only shape that catches
  // both directions.
  //
  // THIS READ ONE FILE, ON ITS FIRST MATCH, AND THAT IS THE HALF THAT DID NOT
  // HOLD. Its old rationale — "deliberately ONE canonical prose site, because a
  // guard that greps the whole tree for digits fails on the next unrelated
  // sentence and gets deleted" — was right about the failure mode and wrong
  // about the fix: the answer to false reds is the number-token rule in NUMBER
  // above, not a short file list. Three restatements were green at 403/403
  // against the one-file version — one two lines below anthropic.js's sentence,
  // one in aiCall.js, and one in models.js's DISPATCH_READY block, which is the
  // very place this test's own failure message tells you to check by hand.
  const quoted = sweepSrc(SEAM_SITES).matched;
  // THE FLOOR IS: at least one match in anthropic.js whose quote carries `in
  // total`. That is narrower than a file-level floor and wider than "the
  // canonical sentence" — it cannot tell the two apart, and the comment here
  // used to claim it could.
  //
  // Why the `in total` anchor at all: anthropic.js carries a SECOND,
  // decorative match — `the guarded "TEN seam call sites" number`, in the
  // paragraph narrating the last drift — and a file-level floor was satisfied
  // by that aside, so rewording the canonical sentence to "A handful of seam
  // call-sites in total now" went green while the same edit RED on main. The
  // aside does not carry `in total` today and must not be reworded to: doing
  // that, together with dropping the canonical sentence's number, is green here
  // — but it is two coordinated edits, it defeats `main` identically, and it is
  // not the one-plausible-edit erosion this test exists to stop.
  assertPresentIn(quoted.filter((q) => /in total/i.test(q.quote)), ['anthropic.js'],
    "'<N> seam call sites in total' — anthropic.js must carry at least one match saying `in " +
    'total`, which today is the canonical sentence and must not become the decorative aside');
  for (const q of quoted) {
    const where = `${q.file}: "${q.quote}"`;
    assert.strictEqual(wordToNumber(q.count, where), sites,
      `${where} claims ${q.count} seam call sites; src/ has ${sites}. ` +
      "Fix whichever is wrong, then check the same number in models.js's DISPATCH_READY block " +
      'and ADR-0006 §9 item 5 — those three drifted apart in group 2 and had to be repaired by hand.');
  }
});

test('the Sonnet-5 count in prose is COMPUTED from the router, not scraped', () => {
  // A companion to the count above, and a different KIND of guard on purpose.
  // That one is [TEXTUAL] — a regex over a comment — and it is why the sentence
  // one line BELOW the number it pins was able to claim FOUR keys and then
  // enumerate three, while the suite stayed green. (Worded, not quoted: quoting
  // it would make this file self-match if these sweeps are ever pointed at test/.)
  // Widening the regex would just move the edge; the fix is to derive the number
  // from the thing it is a claim about.
  //
  // Which matters because that sentence is the operator-facing statement of
  // "your temperature will be dropped after a flip": anthropic.js's
  // NO_TEMPERATURE is per model, so the set of migrated keys landing on Sonnet 5
  // IS the set whose determinism setting silently goes away.
  const models = require(path.join(SRC, 'models.js'));
  const sonnet = [...models.DISPATCH_READY]
    .filter((task) => {
      const t = models.TASKS[task];
      const tier = (t && t.anthropicTier) || (t && t.tier);
      return models.TIERS.anthropic[tier] === 'claude-sonnet-5';
    })
    .sort();
  assert.deepStrictEqual(sonnet, ['battlecard', 'compare', 'keypoints', 'research'],
    'these are the migrated keys whose temperature is dropped after a flip');

  // EVERY match of the CLAIM SHAPE, in EVERY file under src/ — not the first
  // match in one file. Both of those narrowings were defeated with the suite
  // green at 403/403, and the shape itself was defeated one wording over:
  //
  //   - `header.match()` returns only the FIRST hit, so a restatement appended
  //     two lines under the guarded sentence was invisible to it.
  //   - reading only anthropic.js left aiCall.js's twin of the same claim
  //     unguarded, and setting it to a wrong number stayed green.
  //   - the first fix for those two matched two hard-coded wordings, so the
  //     same claim phrased with a different verb — in anthropic.js beside the
  //     true sentence, and again in knowledge/research.js — was green a third
  //     time. SONNET_KEYS matches a shape instead: a count, then any of the
  //     assignment verbs, then the model. What it cannot do is cover English,
  //     and the comment above says so rather than claiming otherwise.
  //
  // Neither prose copy is deleted, which is the other way to close this.
  // aiCall.js is where a caller reads what happens to `temperature` at the
  // seam, so the claim earns its place there — and removing a comment to "keep
  // the number in one place" leaves nothing to stop the next copy being
  // written, which is exactly how this one arrived.
  const claims = sweepSrc(SONNET_KEYS).matched;
  assertPresentIn(claims, ['anthropic.js', 'aiCall.js'],
    'how many migrated keys land on claude-sonnet-5 (the operator-facing statement of ' +
    '"your temperature will be dropped after a flip")');
  // The "of the <M>" half is the ONLY thing checking <M> against the set size,
  // and it has no floor of its own unless one is written: dropping that phrase
  // from the sentence while taking DISPATCH_READY to eight was green.
  assert.ok(claims.some((c) => c.outOf !== undefined),
    'no prose copy states the Sonnet count AS A FRACTION of DISPATCH_READY any more, so nothing ' +
    'compares that <M> against the set size — and dropping the phrase is exactly how the check ' +
    'was made to disappear while the set grew. Restore the "<N> of the <M>" form in ' +
    "anthropic.js's header, or re-point SONNET_KEYS at whatever replaced it.");
  for (const c of claims) {
    const where = `${c.file}: "${c.quote}"`;
    assert.strictEqual(wordToNumber(c.count, where), sonnet.length,
      `${where} claims ${c.count} keys on claude-sonnet-5; the router resolves ${sonnet.length} (${sonnet.join(', ')})`);
    if (c.outOf !== undefined) {
      assert.strictEqual(wordToNumber(c.outOf, where), models.DISPATCH_READY.size,
        `${where} says "of the ${c.outOf}"; DISPATCH_READY holds ${models.DISPATCH_READY.size}`);
    }
  }
});

test('the DISPATCH_READY size quoted in prose is checked against the set', () => {
  // "Seven tasks are in models.DISPATCH_READY" heads BOTH anthropic.js and
  // aiCall.js — the two files this PR edited to close an unguarded twin of a
  // guarded number — and until now nothing read either one. The Sonnet guard's
  // "of the <M>" half only reaches the M in its own sentence.
  //
  // Group 4 takes the set to eight, at which point both go stale silently, in
  // the paragraph an operator reads first to find out what is flippable.
  const models = require(path.join(SRC, 'models.js'));
  const ready = sweepSrc(READY_SIZE).matched;
  assertPresentIn(ready, ['anthropic.js', 'aiCall.js'], "'<N> tasks are in models.DISPATCH_READY'");
  for (const r of ready) {
    const where = `${r.file}: "${r.quote}"`;
    assert.strictEqual(wordToNumber(r.count, where), models.DISPATCH_READY.size,
      `${where} claims ${r.count} tasks in DISPATCH_READY; the set holds ${models.DISPATCH_READY.size} ` +
      `(${[...models.DISPATCH_READY].join(', ')}). The next cutover group has to move BOTH headers, ` +
      'and ADR-0006 §9 item 5 with them.');
  }
});

test('every not-a-count opt-out under src/ is pinned, so adding one is a visible diff', () => {
  // The opt-out is the guards' escape hatch and therefore their weakest point:
  // a marker anywhere in a matched sentence turns a checked claim into an
  // unchecked one, silently. Demonstrated at 22/22 green — a wrong count
  // carrying `(not-a-count)` in anthropic.js, and a wrong count inserted
  // directly above models.js's legitimate marker, inside its sentence.
  //
  // So the list is pinned by value. Marking a sentence is fine; marking one
  // without saying so in a diff is not. If you are here because this failed:
  // read the quoted sentence, decide whether it really is not a count, and add
  // it below with the reason — do not widen the pin to make it pass.
  const skipped = [SEAM_SITES, SONNET_KEYS, READY_SIZE]
    .flatMap((re) => sweepSrc(re).skipped)
    .map((s) => `${s.file}: ${s.quote}`)
    .sort();
  assert.deepStrictEqual(skipped, ['models.js: three keys are in DISPATCH_READY'],
    'the set of `not-a-count` opt-outs under src/ changed. The only sanctioned one is models.js\'s ' +
    '"all three keys are in DISPATCH_READY" — three NAMED keys, not the size of the set. Anything ' +
    'else here is a claim that stopped being checked; anything missing means a marker was dropped.');
});

// ── 2. Claude usage accounting ──────────────────────────────────────────────

test('recordClaude bills fresh, cache-write and cache-read input at their own rates', async () => {
  // Sonnet 5: $3/MTok in, $15/MTok out → 300 / 1500 cents per MTok.
  // 1M fresh + 1M cache-write + 1M cache-read + 1M out
  //   = 300 + (300 × 2) + (300 × 0.1) + 1500 = 2430 cents.
  // The cache-write leg uses the 1h multiplier because this fixture supplies
  // the aggregate `cache_creation_input_tokens` with no per-TTL split; see the
  // constants in costs.js for why the ambiguous case resolves to 1h.
  await costs.recordClaude('t1', 'analysis.moments', 'claude-sonnet-5', {
    input_tokens: 1e6,
    cache_creation_input_tokens: 1e6,
    cache_read_input_tokens: 1e6,
    output_tokens: 1e6,
  });
  const row = lastRow();
  assert.strictEqual(row.params[P.SERVICE], 'claude');
  assert.strictEqual(Number(row.params[P.CENTS]), 2430);
});

test('recordClaude counts cached prompt tokens in units — input_tokens is only the remainder', async () => {
  await costs.recordClaude('t1', 'analysis.moments', 'claude-sonnet-5', {
    input_tokens: 1000,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 30000,
    output_tokens: 500,
  });
  const row = lastRow();
  // The regression this guards: treating input_tokens as the whole prompt
  // reports 1500 units for a call that actually moved 33500.
  assert.strictEqual(Number(row.params[P.UNITS]), 33500);
  const meta = JSON.parse(row.params[P.META]);
  assert.strictEqual(meta.cacheRead, 30000);
  assert.strictEqual(meta.cacheWrite, 2000);
});

test('a cached call costs materially less than the same call uncached', async () => {
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', { input_tokens: 1e6, output_tokens: 0 });
  const uncached = Number(lastRow().params[P.CENTS]);
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', { cache_read_input_tokens: 1e6, output_tokens: 0 });
  const cached = Number(lastRow().params[P.CENTS]);
  assert.strictEqual(cached, uncached * 0.1,
    'cache reads bill at 0.1× input — if this drifts, the ADR-0006 §4.3 margin case is unverifiable');
});

test('an unknown model records tokens with a null cost rather than a wrong one', async () => {
  await costs.recordClaude('t1', 'a.b', 'claude-from-the-future', { input_tokens: 1000, output_tokens: 10 });
  const row = lastRow();
  assert.strictEqual(row.params[P.CENTS], null);
  assert.strictEqual(Number(row.params[P.UNITS]), 1010);
});

// ── 3. rate matching ────────────────────────────────────────────────────────

test('flash-lite bills at the lite rate, not the flash rate it is a prefix of', async () => {
  await costs.recordGemini('t1', 'kb.relevanceDoc', 'gemini-2.5-flash-lite', {
    promptTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const lite = Number(lastRow().params[P.CENTS]);
  await costs.recordGemini('t1', 'discovery.queries', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const flash = Number(lastRow().params[P.CENTS]);
  assert.strictEqual(lite, 10, 'flash-lite input is $0.10/MTok');
  assert.strictEqual(flash, 30, 'flash input is $0.30/MTok');
  assert.ok(lite < flash, 'a substring match would bill both at the flash rate');
});

test('Gemini thinking tokens count as output', async () => {
  await costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', {
    promptTokenCount: 0, candidatesTokenCount: 1e6, thoughtsTokenCount: 1e6,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 500, '2M output tokens at $2.50/MTok');
});

// ── 4. read path bounds ─────────────────────────────────────────────────────

test('rollups are bounded and clamp the day window', async () => {
  await costs.rollupByTenant({ days: 99999 });
  assert.match(lastSelect.text, /LIMIT \d+/, 'an unbounded read over usage_costs is the next queryBounds entry');
  assert.strictEqual(lastSelect.params[0], 365, 'day window clamps to a year');

  await costs.rollupBySite({ days: 'not-a-number' });
  assert.strictEqual(lastSelect.params[0], 30, 'a junk window falls back to 30 days, never to unbounded');

  await costs.rollupByTenant({ days: 7, tenantId: 't1' });
  assert.strictEqual(lastSelect.params[1], 't1');
  assert.match(lastSelect.text, /AND tenant_id = \$2/);
});

test('telemetry failures never propagate to the caller', async () => {
  const dbFull = require.resolve(path.join(SRC, 'db.js'));
  const good = require.cache[dbFull].exports.query;
  require.cache[dbFull].exports.query = async () => { throw new Error('postgres is down'); };
  try {
    await assert.doesNotReject(
      () => costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', { promptTokenCount: 1 }),
      'record() is fire-and-forget — a telemetry outage must not fail the action it observes'
    );
  } finally {
    // Restore even if the assertion throws, so a future test appended after
    // this one does not silently inherit a permanently-broken db stub.
    require.cache[dbFull].exports.query = good;
  }
});

// ── 5. the absent-usage case ────────────────────────────────────────────────

// The real-world shape CI cannot reach. A live probe on 2026-08-05 confirmed
// generateContent DOES return usageMetadata for both the plain and
// responseSchema call shapes, with thoughtsTokenCount/cachedContentTokenCount
// simply absent when unused — so the `|| 0` guards are load-bearing and correct.
// This pins the no-usage branch anyway: it is how a recorded call site can still
// produce zero rows, which is the failure mode that looks identical to "nobody
// used the product".
test('a response with no usage block records nothing rather than a zero-cost row', async () => {
  const before = inserted.length;
  await costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', undefined);
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', null);
  assert.strictEqual(inserted.length, before,
    'a missing usage block must not write a row — a $0 row is indistinguishable from a free call');
});

test('absent optional token fields are treated as zero, not NaN', async () => {
  // Exactly the live shape: no thoughtsTokenCount, no cachedContentTokenCount.
  await costs.recordGemini('t1', 'a.b', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, candidatesTokenCount: 1e6,
  });
  const row = lastRow();
  assert.strictEqual(Number(row.params[P.CENTS]), 280, '1M in @ $0.30 + 1M out @ $2.50');
  assert.strictEqual(Number(row.params[P.UNITS]), 2e6);
});

test('Gemini cached prompt tokens bill at a quarter of the input rate', async () => {
  // promptTokenCount INCLUDES the cached prefix, unlike Claude's input_tokens.
  await costs.recordGemini('t1', 'arena.turn', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, cachedContentTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const allCached = Number(lastRow().params[P.CENTS]);
  await costs.recordGemini('t1', 'arena.turn', 'gemini-2.5-flash', {
    promptTokenCount: 1e6, candidatesTokenCount: 0,
  });
  const noneCached = Number(lastRow().params[P.CENTS]);
  assert.strictEqual(allCached, 7.5, '1M fully-cached input at 0.25 × $0.30');
  assert.strictEqual(noneCached, 30);
  assert.ok(allCached < noneCached,
    'the whole purpose of gemini.js is context caching — billing it at full rate ' +
    'reports the Arena and global-KB paths at up to 4× their real cost');
});

test('Claude 1h cache writes bill at 2x, not the 5m 1.25x', async () => {
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', {
    cache_creation: { ephemeral_1h_input_tokens: 1e6 }, output_tokens: 0,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 600, '1M @ $3.00 × 2');
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', {
    cache_creation: { ephemeral_5m_input_tokens: 1e6 }, output_tokens: 0,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 375, '1M @ $3.00 × 1.25');
  // No split present → fall back to the 1h rate, over-reporting rather than under.
  await costs.recordClaude('t1', 'a.b', 'claude-sonnet-5', {
    cache_creation_input_tokens: 1e6, output_tokens: 0,
  });
  assert.strictEqual(Number(lastRow().params[P.CENTS]), 600);
});

test('rollups exclude the smoke check without hiding unlabelled rows', async () => {
  // The clause that changes what the spend view shows, and the only one in
  // these queries that was unasserted. Deleting it silently fills the coverage
  // rollup with synthetic sites; writing it without the NULL guard silently
  // drops rows recorded through the bare record().
  for (const fn of [costs.rollupByTenant, costs.rollupBySite]) {
    await fn({ days: 30 });
    assert.match(lastSelect.text, /site NOT LIKE 'smoke\.%'/,
      'the live-schema smoke check is not product usage — its rows must not enter the rollups');
    assert.match(lastSelect.text, /site IS NULL OR/,
      "NULL NOT LIKE '...' is NULL, so an unlabelled row would fail the WHERE and disappear from " +
      'the very view that exists to show what is not being recorded');
  }
});

test('rollups surface how many rows could not be priced', async () => {
  await costs.rollupByTenant({ days: 30 });
  assert.match(lastSelect.text, /FILTER \(WHERE est_cost_cents IS NULL\)/,
    'COALESCE(SUM(...),0) turns "we could not price this" into "this was free" — ' +
    'the unpriced count is what keeps the two distinguishable');
  await costs.rollupBySite({ days: 30 });
  assert.match(lastSelect.text, /FILTER \(WHERE est_cost_cents IS NULL\)/);
  assert.match(lastSelect.text, /MIN\(created_at\)/,
    'without first_seen, a coverage change reads as a cost change');
});

test('a sub-day window falls back to 30 days rather than querying nothing', async () => {
  await costs.rollupByTenant({ days: 0.5 });
  assert.strictEqual(lastSelect.params[0], 30,
    "Math.floor(0.5) is 0, and '0 days' is a zero-length window that looks like a successful empty query");
});
