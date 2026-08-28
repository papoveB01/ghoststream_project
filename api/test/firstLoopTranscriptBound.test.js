// POST /first-loop transcript bound — behavioural regression test.
//
// WHY THIS TEST EXISTS: `transcript` on this route is fully caller-supplied and
// reaches three model stages verbatim (analysis.formatTranscript applies no
// bound of its own). The only limit was express.json({ limit: '2mb' }) — about
// half a million tokens per request, three times over, plus a real
// stream.ingestFromUrl + createClip. src/firstLoopBound.js now rejects anything
// past MAX_PROMPT_CHARS before the meeting record is created, i.e. before
// anything is spent.
//
// AND WHY IT IS NOT JUST "IS BIG INPUT REJECTED". The first version of this
// guard summed `segments[i][3]` — the speech text — and that is the wrong
// dimension: participants[].name/.role and segments[i][2] are re-rendered ONCE
// PER SEGMENT by analysis.js:150-159, and meetingTitle / durationSeconds /
// the whole participants[] block go into the stage-1 metadata at
// analysis.js:290-293. So the caller controlled both factors of a product the
// guard was reading one term of, and a 43 KB body that measured 200 characters
// rendered 8 044 500 into the prompt. §2 below re-runs every one of those
// amplifiers and asserts BOTH that the current guard rejects it AND that the
// speech-only metric would have waved it through — a bound that stops
// measuring the right dimension fails here rather than silently.
//
// §3 is the drift tripwire. The guard projects the formatted length
// arithmetically (building the string is the attack), so its arithmetic has to
// mirror analysis.js's format string. Prose cannot enforce that; these
// assertions can, by pinning the projection against the real formatter
// character for character.
//
// Same require-side-effect gotcha as routeContract.test.js: requiring
// src/index.js opens an ioredis client that keeps the event loop alive, so it
// is disconnected in the `after` hook below.

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-test-jwt-secret-at-least-32-bytes-long-xx';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-test-encryption-key-not-a-real-secret';

// Patch the store module object BEFORE index.js captures it. index.js does
// `const store = require('./store')` and calls `store.createMeeting(...)` off
// that object, so replacing the property here is what the handler will call.
const store = require('../src/store');
let createMeetingCalls = 0;
store.createMeeting = async () => {
  createMeetingCalls += 1;
  throw new Error('STOP-AFTER-GUARD');
};

const app = require('../src/index.js');
const bound = require('../src/firstLoopBound.js');
const analysis = require('../src/analysis.js');

// The default when the caller sends no transcript. Kept in the assertions
// below so the bound is checked against the thing the route exists to replay.
const sampleTranscript = require('../src/sample-transcript.js');

const MAX = bound.MAX_PROMPT_CHARS;

// Pull the route's own handler out of the Express stack — the last function on
// the route layer, i.e. the one after auth/superadmin. Calling it directly is
// deliberate: the middleware in front needs a session, Redis and Postgres, and
// none of that is what this test is about.
function firstLoopHandler() {
  for (const layer of app._router.stack) {
    const route = layer.route;
    if (route && route.path === '/first-loop' && route.methods && route.methods.post) {
      return route.stack[route.stack.length - 1].handle;
    }
  }
  throw new Error('POST /first-loop not found in the Express route table — did the route move?');
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function invoke(body) {
  const res = fakeRes();
  let nextErr;
  await firstLoopHandler()({ body }, res, (err) => { nextErr = err; });
  return { res, nextErr };
}

// The metric the first version of this guard used: sum of segments[i][3].
// Every amplifier in §2 defeats it; it is asserted against, not used.
function speechOnlyChars(t) {
  return t.segments.reduce((n, seg) => n + String((Array.isArray(seg) && seg[3]) || '').length, 0);
}
const SPEECH_ONLY_MAX = 20000;

const P2 = [{ role: 'rep', name: 'R' }, { role: 'prospect', name: 'P' }];

// ===========================================================================
// 1. The route: rejected before anything is spent, and not a blanket refusal.
// ===========================================================================

test('an over-bound transcript is rejected by the ROUTE before anything is spent', async () => {
  createMeetingCalls = 0;
  const { res } = await invoke({
    transcript: {
      meetingTitle: 't', durationSeconds: 60, participants: P2,
      segments: [[0, 60, 'rep', 'x'.repeat(MAX + 1)]],
    },
  });

  assert.strictEqual(res.statusCode, 413,
    `expected 413, got ${res.statusCode}. Without this bound the only limit on POST /first-loop is ` +
    "express.json's 2mb body cap — roughly 500k tokens through three model stages, plus a Cloudflare " +
    'Stream ingest and clip, per request.');
  assert.strictEqual(res.body && res.body.code, 'TRANSCRIPT_TOO_LONG');
  assert.strictEqual(createMeetingCalls, 0,
    'the over-length transcript reached store.createMeeting — the guard must reject BEFORE the meeting ' +
    'record, analysis.runPipeline and the Stream ingest+clip, or rejecting costs the same as accepting');
});

test('the bundled sample call — what this route exists to replay — is accepted', () => {
  const v = bound.checkTranscript(sampleTranscript);
  assert.strictEqual(v.ok, true,
    `the bundled sample transcript was REJECTED (${JSON.stringify(v.body)}). It is ` +
    `${speechOnlyChars(sampleTranscript)} characters of speech across ${sampleTranscript.segments.length} ` +
    'segments; if the bound rejects it, the bound is wrong, not the sample.');
  assert.ok(v.chars < MAX, `sample projects to ${v.chars}, bound is ${MAX}`);
});

test('20 000 characters of speech — a full hour of real conversation — is accepted', async () => {
  createMeetingCalls = 0;
  const { res, nextErr } = await invoke({
    transcript: {
      meetingTitle: 'bound probe', durationSeconds: 3600, participants: P2,
      segments: [[0, 3600, 'rep', 'x'.repeat(20000)]],
    },
  });
  assert.strictEqual(res.statusCode, null,
    `20 000 characters of speech was rejected with ${res.statusCode} — that is the volume this route ` +
    'is meant to carry (the sample is ~340 chars/minute, so 20 000 is a full hour), and a guard that ' +
    'refuses legitimate input is the opposite failure to the one being fixed');
  assert.strictEqual(createMeetingCalls, 1, 'an in-bound transcript should have proceeded past the guard');
  assert.strictEqual(nextErr && nextErr.message, 'STOP-AFTER-GUARD');
});

test('the bound is inclusive at exactly MAX_PROMPT_CHARS and rejects at MAX+1', () => {
  // Build a transcript whose projection lands exactly on the bound: measure a
  // one-segment skeleton, then size the speech to fill the remainder.
  const skeleton = (text) => ({
    meetingTitle: 't', durationSeconds: 60, participants: P2,
    segments: [[0, 60, 'rep', text]],
  });
  const overhead = bound.projectFormattedLength(skeleton('')) + bound.projectStage1MetaLength(skeleton(''));
  const atMax = skeleton('x'.repeat(MAX - overhead));
  const overMax = skeleton('x'.repeat(MAX - overhead + 1));

  const a = bound.checkTranscript(atMax);
  assert.strictEqual(a.ok, true, `a transcript projecting to exactly ${MAX} was rejected — the bound must be inclusive`);
  assert.strictEqual(a.chars, MAX, `expected the projection to land exactly on ${MAX}, got ${a.chars}`);

  const b = bound.checkTranscript(overMax);
  assert.strictEqual(b.ok, false, `a transcript projecting to ${MAX + 1} was accepted — off-by-one at the bound`);
  assert.strictEqual(b.status, 413);
});

// ===========================================================================
// 2. The amplifiers. Each row: the speech-only metric waves it through; the
//    projection stops it. Measured against the real handler before the fix.
// ===========================================================================

const AMPLIFIERS = [
  ['one long participants[0].name, re-rendered across 200 segments', 8044500, {
    meetingTitle: 't', durationSeconds: 600,
    participants: [{ role: 'rep', name: 'N'.repeat(40000) }, { role: 'prospect', name: 'P' }],
    segments: Array.from({ length: 200 }, (_, i) => [i, i + 1, 'rep', 'x']),
  }],
  ['20 000 one-character segments (per-segment framing, not speech)', 526903, {
    meetingTitle: 't', durationSeconds: 600, participants: P2,
    segments: Array.from({ length: 20000 }, (_, i) => [i, i + 1, 'rep', 'x']),
  }],
  ['a 500 000-character meetingTitle (stage-1 metadata block)', 500123, {
    meetingTitle: 'T'.repeat(500000), durationSeconds: 60, participants: P2,
    segments: [[0, 60, 'rep', 'hi']],
  }],
  ['a 5 000-entry participants[] (stage-1 and stage-2 metadata blocks)', 1574014, {
    meetingTitle: 't', durationSeconds: 60,
    participants: Array.from({ length: 5000 }, (_, i) => ({
      role: 'r' + i, name: 'N'.repeat(100), title: 'T'.repeat(100), company: 'C'.repeat(100),
    })).concat(P2),
    segments: [[0, 60, 'rep', 'hi']],
  }],
  ['a long segments[i][2] (`who`), used verbatim when no participant matches', 534891, {
    meetingTitle: 't', durationSeconds: 6000, participants: [{ role: 'nobody', name: 'x' }],
    segments: Array.from({ length: 2000 }, (_, i) => [i, i + 1, 'W'.repeat(250), 'x']),
  }],
  ['the name amplifier tuned to the 2mb body cap', 520306902, {
    meetingTitle: 't', durationSeconds: 6000,
    participants: [{ role: 'rep', name: 'N'.repeat(260000) }, { role: 'prospect', name: 'P' }],
    segments: Array.from({ length: 2000 }, (_, i) => [i, i + 1, 'rep', 'x']),
  }],
];

for (const [label, measuredPromptChars, transcript] of AMPLIFIERS) {
  test(`amplifier rejected: ${label}`, () => {
    const speech = speechOnlyChars(transcript);
    assert.ok(speech <= SPEECH_ONLY_MAX,
      `this case is only interesting if the speech-only metric waves it through; it measures ${speech}, ` +
      `over the ${SPEECH_ONLY_MAX} it was compared against — rewrite the case, not the assertion`);

    const v = bound.checkTranscript(transcript);
    assert.strictEqual(v.ok, false,
      `ACCEPTED. The speech-only metric saw ${speech} characters; this body renders ~${measuredPromptChars} ` +
      'characters into the stage-1 prompt, three model stages over. The guard is measuring the wrong ' +
      'dimension again — see the table at the top of src/firstLoopBound.js.');
    assert.strictEqual(v.status, 413);
    assert.strictEqual(v.body.code, 'TRANSCRIPT_TOO_LONG');
  });
}

test('the V8 string-ceiling shape is rejected WITHOUT the projection ever building the string', () => {
  // The same amplifier tuned past V8's ~512 MiB single-string ceiling. This is
  // the row that makes the bound a stability fix and not only a spend fix:
  // analysis.formatTranscript cannot even finish here, so on an api container
  // shared by every tenant the failure mode is memory pressure and a dead
  // process, reached by one HTTP request from any caller past the gate.
  const transcript = {
    meetingTitle: 't', durationSeconds: 6000,
    participants: [{ role: 'rep', name: 'N'.repeat(300000) }, { role: 'prospect', name: 'P' }],
    segments: Array.from({ length: 2000 }, (_, i) => [i, i + 1, 'rep', 'x']),
  };

  // The projection says how long the string WOULD be, having allocated none of it.
  const projected = bound.projectFormattedLength(transcript);
  const V8_MAX_STRING = 2 ** 29 - 24;
  assert.ok(projected > V8_MAX_STRING,
    `this case is only interesting past V8's string ceiling; it projects to ${projected}, ceiling is ${V8_MAX_STRING}`);

  // And the formatter, given the same body, cannot produce it at all. (Cheap
  // and safe to assert: V8 rejects on the computed total length, so this
  // throws in a few ms having allocated under a megabyte.)
  assert.throws(() => analysis.formatTranscript(transcript), /Invalid string length/,
    'analysis.formatTranscript no longer throws on this body — if the formatter changed, the whole ' +
    'premise of projecting instead of measuring needs re-checking');

  const before = process.memoryUsage().heapUsed;
  const v = bound.checkTranscript(transcript);
  const grew = process.memoryUsage().heapUsed - before;

  assert.strictEqual(v.ok, false, 'the string-ceiling body was ACCEPTED — it would kill the process');
  assert.strictEqual(v.status, 413);
  assert.ok(grew < 32 * 1024 * 1024,
    `the guard allocated ${(grew / 1048576).toFixed(1)} MB deciding this. It must not build the transcript ` +
    'to measure it — building it IS the attack (this body needs ~1.2 GB before V8 gives up). If someone ' +
    'replaced the projection with analysis.formatTranscript(t).length, this is where it shows.');
});

// ===========================================================================
// 3. Drift tripwire. The projection is arithmetic that mirrors analysis.js's
//    format strings; if the formatter changes and the arithmetic does not, the
//    guard silently starts measuring a shape that no longer exists — the same
//    class of defect this file was written about. These pin them together.
// ===========================================================================

// Verbatim copy of analysis.js:290-293's caller-controlled metadata, minus the
// fixed literals ('## Call metadata\n', 'Title: ', …) that no caller controls.
function stage1MetaVerbatim(transcript) {
  return `${transcript.meetingTitle}` +
    `${transcript.durationSeconds}` +
    transcript.participants
      .map((p) => `- ${p.name} (${p.role}${p.title ? ', ' + p.title : ''}${p.company ? ', ' + p.company : ''})`)
      .join('\n');
}

// Small enough to materialise safely; broad enough to hit every branch of the
// format string — matched speaker, unmatched `who` fallback, duplicate roles
// (find() takes the first), zero/one/many segments, padStart on the seconds,
// negative and large timestamps, and non-string values reaching `${}`.
const DRIFT_SHAPES = [
  ['bundled sample', sampleTranscript],
  ['empty segments', { meetingTitle: 'e', durationSeconds: 0, participants: P2, segments: [] }],
  ['one segment, no join newline', { meetingTitle: 'o', durationSeconds: 9, participants: P2, segments: [[0, 9, 'rep', 'hi']] }],
  ['unmatched who falls back to the raw speaker string', {
    meetingTitle: 'u', durationSeconds: 60, participants: [{ role: 'rep', name: 'R' }],
    segments: [[0, 30, 'rep', 'a'], [30, 60, 'someone-else', 'b']],
  }],
  ['duplicate roles — find() takes the first', {
    meetingTitle: 'd', durationSeconds: 60,
    participants: [{ role: 'rep', name: 'First' }, { role: 'rep', name: 'SecondMuchLonger' }],
    segments: [[0, 60, 'rep', 'a']],
  }],
  ['padStart on the seconds, and multi-digit minutes', {
    meetingTitle: 'p', durationSeconds: 4000, participants: P2,
    segments: [[0, 5, 'rep', 'a'], [59, 61, 'rep', 'b'], [600, 3661, 'rep', 'c']],
  }],
  ['negative and huge timestamps', {
    meetingTitle: 'n', durationSeconds: 1, participants: P2,
    segments: [[-5, -1, 'rep', 'a'], [1e12, 1e15, 'rep', 'b']],
  }],
  ['non-numeric timestamps coerce to NaN in both', {
    meetingTitle: 'x', durationSeconds: 1, participants: P2,
    segments: [['abc', null, 'rep', 'a']],
  }],
  ['non-string text/who/name coerce identically', {
    meetingTitle: 12345, durationSeconds: null,
    participants: [{ role: 'rep' }, { role: 7, name: [1, 2, 3], title: 'T', company: 'C' }],
    segments: [[0, 1, 'rep', 42], [1, 2, 'rep', null], [2, 3, 'rep', { a: 1 }], [3, 4, 7, [1, 2]], [4, 5, 'ghost', undefined]],
  }],
  ['participant with title and company', {
    meetingTitle: 'tc', durationSeconds: 60,
    participants: [{ role: 'rep', name: 'R', title: 'AE', company: 'DealScope' }, { role: 'prospect', name: 'P', company: 'Helix' }],
    segments: [[0, 60, 'prospect', 'hello']],
  }],
];

for (const [label, transcript] of DRIFT_SHAPES) {
  test(`projection matches analysis.formatTranscript exactly: ${label}`, () => {
    const projected = bound.projectFormattedLength(transcript);
    const actual = analysis.formatTranscript(transcript).length;
    assert.strictEqual(projected, actual,
      `src/firstLoopBound.js projectFormattedLength() says ${projected}, analysis.formatTranscript() ` +
      `produces ${actual}. These have DRIFTED. The guard measures the projection, so a projection that ` +
      'no longer matches the formatter is a guard measuring a shape that does not exist — the exact ' +
      'defect this bound was rewritten to fix. Update projectFormattedLength() to track ' +
      'analysis.js:150-159, do not relax this assertion.');
  });

  test(`stage-1 metadata projection matches analysis.js:290-293 exactly: ${label}`, () => {
    const projected = bound.projectStage1MetaLength(transcript);
    const actual = stage1MetaVerbatim(transcript).length;
    assert.strictEqual(projected, actual,
      `projectStage1MetaLength() says ${projected}, the stage-1 metadata block renders ${actual}. ` +
      'Update the projection to track analysis.js:290-293.');
  });
}

// ===========================================================================
// 4. Malformed input is a 400 from the guard, not a 500 from inside the model
//    pipeline. formatTranscript destructures every segment (throws on a
//    non-iterable) and reads p.role off every participant (throws on null).
// ===========================================================================

const MALFORMED = [
  ['no segments[]', { meetingTitle: 'no segments' }],
  ['segments is not an array', { participants: [], segments: 'nope' }],
  ['participants is not an array', { participants: 'nope', segments: [] }],
  ['a null participant (analysis.js:153 reads p.role off it)', {
    meetingTitle: 'm', durationSeconds: 1, participants: [null], segments: [[0, 1, 'rep', 'a']],
  }],
  ['a non-array segment (analysis.js:152 destructures it)', {
    meetingTitle: 'm', durationSeconds: 1, participants: P2, segments: [42],
  }],
  ['a value that cannot be coerced to a string', {
    meetingTitle: 'm', durationSeconds: 1, participants: P2,
    segments: [[0, 1, 'rep', JSON.parse('{"toString":"not a function"}')]],
  }],
];

for (const [label, transcript] of MALFORMED) {
  test(`malformed transcript is a 400, not a 500 from inside the pipeline: ${label}`, async () => {
    createMeetingCalls = 0;
    const { res } = await invoke({ transcript });
    assert.strictEqual(res.statusCode, 400,
      `expected 400, got ${res.statusCode} — this shape reaches analysis.formatTranscript and throws there, ` +
      'surfacing as a 500');
    assert.strictEqual(res.body && res.body.code, 'TRANSCRIPT_INVALID');
    assert.strictEqual(createMeetingCalls, 0);
  });
}

// ===========================================================================
// 5. The bound is a constant, not an environment variable.
// ===========================================================================

test('the bound cannot be disabled from the environment', () => {
  // The version of this guard that shipped read FIRST_LOOP_MAX_TRANSCRIPT_CHARS
  // via parseInt, which (a) was passed through by neither docker-compose.yml,
  // .env nor .env.example, so it was inert in every deployed environment, and
  // (b) failed OPEN — parseInt('twenty-thousand', 10) is NaN and `n > NaN` is
  // always false, so a typo'd override silently removed the bound.
  const saved = process.env.FIRST_LOOP_MAX_TRANSCRIPT_CHARS;
  process.env.FIRST_LOOP_MAX_TRANSCRIPT_CHARS = 'twenty-thousand';
  try {
    delete require.cache[require.resolve('../src/firstLoopBound.js')];
    const reloaded = require('../src/firstLoopBound.js');
    assert.strictEqual(reloaded.MAX_PROMPT_CHARS, MAX,
      'the bound moved when an environment variable was set. It is a constant on purpose: an env-var ' +
      'bound here was both inert (never passed through docker-compose.yml) and fail-open (NaN). If a ' +
      'knob is genuinely wanted, wire it through compose AND .env.example AND validate it as a finite ' +
      'positive integer with a fallback — do not just delete this test.');
    const v = reloaded.checkTranscript({
      meetingTitle: 't', durationSeconds: 60, participants: P2,
      segments: [[0, 60, 'rep', 'x'.repeat(MAX + 1)]],
    });
    assert.strictEqual(v.ok, false, 'the guard let an over-bound transcript through after the env var was set');
  } finally {
    if (saved === undefined) delete process.env.FIRST_LOOP_MAX_TRANSCRIPT_CHARS;
    else process.env.FIRST_LOOP_MAX_TRANSCRIPT_CHARS = saved;
    delete require.cache[require.resolve('../src/firstLoopBound.js')];
  }
});

after(() => {
  try { require('../src/redis.js').disconnect(); } catch { /* best-effort */ }
});
