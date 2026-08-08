'use strict';

// Transcript bound for POST /first-loop (the only caller — see src/index.js).
//
// WHAT IT BOUNDS, AND WHY THAT IS NOT "THE TRANSCRIPT TEXT". The caller's
// `transcript` object is handed to analysis.runPipeline verbatim, and FIVE of
// its fields are rendered into model prompts, not one:
//
//   segments[i][3]  the speech text                          (analysis.js:156)
//   segments[i][2]  `who` — used verbatim as the speaker
//                   name whenever no participant has that
//                   role, so it is re-rendered PER SEGMENT   (analysis.js:154)
//   participants[]  `name` and `role` are re-rendered PER
//                   SEGMENT for every matched speaker, and
//                   name/role/title/company again in the
//                   stage-1 metadata block           (analysis.js:154, 293)
//   meetingTitle    stage-1 metadata block                   (analysis.js:291)
//   durationSeconds stage-1 metadata block                   (analysis.js:292)
//
// The first bound this route shipped with summed segments[i][3] alone. Because
// three of those five fields are re-rendered once per segment, the caller
// controls both factors of a product the guard was only reading one term of:
//
//   | body                                   | speech-only guard saw | reached the prompt |
//   | 20 KB, 20 000 chars of speech          |                20 000 |             20 132 |
//   | 43 KB, one long participants[0].name   |                   200 |          8 044 500 |
//   | 458 KB, 20 000 one-char segments       |                20 000 |            526 903 |
//   | 500 KB meetingTitle                    |                     2 |            500 123 |
//   | 1.75 MB, 5 000-entry participants[]    |                     2 |          1 574 014 |
//   | 536 KB, long seg[2] (`who`) fallback   |                 2 000 |            534 891 |
//   | 302 KB, name amplifier at the body cap |                 2 000 |        520 306 902 |
//
// That last row is why this is not only a spend bug. 520 MB sits just under
// V8's ~512 MiB single-string ceiling; nudge the multiplier and
// analysis.formatTranscript throws `Invalid string length` partway through
// building it, so the failure mode is memory pressure and a killed process on
// an api container every tenant shares.
//
// WHICH IS WHY THIS MODULE NEVER CALLS formatTranscript. Measuring
// `analysis.formatTranscript(transcript).length` would be the precise, obvious
// fix — and it requires building the exact string the attack exists to make us
// build. So the length is PROJECTED arithmetically instead: each segment
// contributes a fixed frame plus the resolved speaker name plus its text, and
// the stage-1 metadata block is added on top. Nothing larger than one
// timestamp is ever allocated, and the walk stops the moment the running total
// passes the bound.
//
// DRIFT IS THE OBVIOUS FAILURE MODE of an arithmetic projection: if
// analysis.js:150-159 changes its format string and the arithmetic here does
// not, the guard silently starts measuring a shape that no longer exists —
// the same class of defect it was written to fix. The tripwire for that is a
// test, not this paragraph: `api/test/firstLoopTranscriptBound.test.js` asserts
// projectFormattedLength(t) === analysis.formatTranscript(t).length exactly,
// over a range of transcript shapes small enough to be safe to materialise.
// Change the formatter and CI goes red here.

// The bound, in characters of projected prompt.
//
// HARDCODED ON PURPOSE — it is deliberately not `process.env.<...>`. The
// version of this guard that shipped read FIRST_LOOP_MAX_TRANSCRIPT_CHARS from
// the environment, and that knob was inert in every deployed environment: the
// api service in docker-compose.yml enumerates its environment explicitly
// (there is no `env_file:` for it) and the variable appears in neither the
// compose file, `.env` nor `.env.example` — the identical gap the compose file
// documents twenty lines above for the eleven per-task model overrides. It
// also failed open: `parseInt('twenty-thousand', 10)` is NaN and `n > NaN` is
// always false, so a typo'd override disabled the guard rather than tripping
// it. A constant can do neither. This is a superadmin-only demo/probe route;
// there is no operational scenario that needs it retuned without a code
// change, so the configurability was pretence and is now gone.
//
// 30 000 is 20 000 characters of speech — the number inboundEmail.js already
// uses for caller-supplied body text — plus the rendering the speech-only
// number never counted. The bundled sample is 1 613 characters of speech
// across 11 segments and projects to 2 166; a full hour at the sample's rate
// (~340 chars/min, ~26 s per segment) is ~19 500 characters of speech across
// ~140 segments, which projects to ~24 000. So this admits an hour of real
// conversation with headroom, caps each of the three model stages at roughly
// 7 500 tokens of caller-supplied input, and rejects every row of the table
// above except the legitimate 20 000-character baseline.
const MAX_PROMPT_CHARS = 30000;

// Length of a value after the coercion a template literal would apply to it.
// `${undefined}` is 'undefined' (9), `${{}}` is '[object Object]' (15) — the
// projection has to agree with the formatter on those, so it coerces the same
// way rather than special-casing.
function len(v) { return String(v).length; }

// analysis.js:155, reproduced rather than approximated. Safe to build: a
// number stringifies to at most ~25 characters and any non-numeric value to
// 'NaN', so this allocates nothing meaningful however hostile `sec` is.
function stamp(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// analysis.js:153 resolves each segment's speaker with
// `participants.find((p) => p.role === who)` INSIDE the per-segment map, i.e.
// O(segments x participants). Reproducing that here would make the guard its
// own amplifier — a 2 MB body carries on the order of 500 000 segments and
// 40 000 participants, and 2e10 comparisons is a CPU stall before a single
// character has been counted. One Map, built once, keyed by role and keeping
// the FIRST entry for each role, returns exactly what find() would and makes
// the walk O(participants + segments).
function speakerNameLengths(participants) {
  const byRole = new Map();
  for (const p of participants) {
    // `${speaker.name} (${speaker.role})` — analysis.js:154.
    if (!byRole.has(p.role)) byRole.set(p.role, len(p.name) + 2 + len(p.role) + 1);
  }
  return byRole;
}

// Projected length of analysis.formatTranscript(transcript), WITHOUT building
// it. Mirrors analysis.js:150-159:
//
//   segments.map(([s, e, who, text]) => `[${t(s)}-${t(e)}] ${name}: ${text}`)
//           .join('\n')
//
// so each segment is 6 fixed characters ('[', '-', '] ', ': ') plus the two
// timestamps, the resolved name and the text, and the join adds one newline
// between segments.
//
// `stopAt` short-circuits: once the running total passes it the answer cannot
// change the verdict, and continuing would do the attacker's O(n) work for
// them. The returned number is then a lower bound, which is what the caller
// reports ("at least N"). Called with no `stopAt` it is exact — that is the
// mode the drift tripwire test uses.
function projectFormattedLength(transcript, stopAt = Infinity) {
  const nameLengths = speakerNameLengths(transcript.participants);
  const segments = transcript.segments;
  let n = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i > 0) n += 1;                                  // the '\n' join
    const named = nameLengths.get(seg[2]);
    n += 6                                              // '[', '-', '] ', ': '
      + stamp(seg[0]).length
      + stamp(seg[1]).length
      + (named === undefined ? len(seg[2]) : named)     // matched speaker, or `who` verbatim
      + len(seg[3]);
    if (n > stopAt) return n;
  }
  return n;
}

// Projected length of the caller-controlled part of the stage-1 metadata block
// (analysis.js:290-293) — the title, the duration, and one line per
// participant:
//
//   `- ${p.name} (${p.role}${p.title ? ', ' + p.title : ''}${p.company ? ', ' + p.company : ''})`
//
// joined by '\n'. Stage 2 (analysis.js:378) renders the same participants with
// name/role/title only, so it is strictly shorter and is covered by this.
// Fixed literals ('## Call metadata\n', 'Title: ', …) are excluded on purpose:
// this counts what the CALLER contributes, which is what the bound is about.
function projectStage1MetaLength(transcript, stopAt = Infinity) {
  const participants = transcript.participants;
  let n = len(transcript.meetingTitle) + len(transcript.durationSeconds);
  if (participants.length > 0) n += participants.length - 1;   // the '\n' join
  for (const p of participants) {
    n += 2 + len(p.name) + 2 + len(p.role) + 1;                // '- ', ' (', ')'
    if (p.title) n += 2 + len(p.title);                        // ', '
    if (p.company) n += 2 + len(p.company);                    // ', '
    if (n > stopAt) return n;
  }
  return n;
}

function bad(message) {
  return { ok: false, status: 400, body: { error: message, code: 'TRANSCRIPT_INVALID' } };
}

// The guard. Returns { ok: true, chars } or { ok: false, status, body }.
//
// Validation first, and it is not cosmetic: analysis.formatTranscript
// destructures every segment (`[s, e, who, text]`), which throws on a
// non-iterable, and reads `p.role` off every participant, which throws on
// null — both of those surface as a 500 from inside the pipeline today. They
// are caller input, so they are 400s.
function checkTranscript(transcript) {
  if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript) ||
      !Array.isArray(transcript.segments) || !Array.isArray(transcript.participants)) {
    return bad('transcript must be an object with segments[] and participants[]');
  }
  for (const p of transcript.participants) {
    if (p === null || typeof p !== 'object') {
      return bad('transcript.participants[] entries must be objects with name and role');
    }
  }
  for (const seg of transcript.segments) {
    if (!Array.isArray(seg)) {
      return bad('transcript.segments[] entries must be [startSeconds, endSeconds, speaker, text] arrays');
    }
  }

  let chars;
  try {
    // Metadata first: it is O(participants) and independent of the segment
    // count, so a body whose participants[] alone blows the bound is rejected
    // without the segment walk running at all.
    const meta = projectStage1MetaLength(transcript, MAX_PROMPT_CHARS);
    chars = meta > MAX_PROMPT_CHARS
      ? meta
      : meta + projectFormattedLength(transcript, MAX_PROMPT_CHARS - meta);
  } catch (err) {
    // A JSON object carrying its own `toString` property is not callable, so
    // String() on it throws — and so would the template literal in
    // analysis.js, as a 500. Caller input, so: 400.
    return bad(`transcript contains a value that cannot be rendered into a prompt (${err.message})`);
  }

  if (chars > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      status: 413,
      body: {
        // "at least": the projection short-circuits once the verdict is
        // settled rather than finishing the attacker's arithmetic.
        error: `transcript too large (projects to at least ${chars} characters of model prompt, ` +
          `max ${MAX_PROMPT_CHARS})`,
        code: 'TRANSCRIPT_TOO_LONG',
        maxChars: MAX_PROMPT_CHARS,
        projectedChars: chars,
      },
    };
  }
  return { ok: true, chars };
}

module.exports = {
  MAX_PROMPT_CHARS,
  checkTranscript,
  // Exported for the drift tripwire in api/test/firstLoopTranscriptBound.test.js,
  // which pins these against analysis.js's real prompt-building sites.
  projectFormattedLength,
  projectStage1MetaLength,
};
