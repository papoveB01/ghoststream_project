// POST /first-loop transcript bound — behavioural regression test.
//
// WHY THIS TEST EXISTS: `transcript` on this route is fully caller-supplied and
// reaches three model stages verbatim (analysis.formatTranscript applies no
// bound of its own). The only limit was express.json({ limit: '2mb' }) — about
// half a million tokens per request, three times over, plus a real
// stream.ingestFromUrl + createClip. src/index.js now rejects anything past
// FIRST_LOOP_MAX_TRANSCRIPT_CHARS before the meeting record is created, i.e.
// before anything is spent.
//
// This exercises the route handler itself, not a helper and not the source
// text, and it checks BOTH directions — a guard that rejected every transcript
// would pass the over-limit half and fail the under-limit half. `store` is
// stubbed to throw a sentinel so an accepted transcript stops at the first
// side effect instead of reaching Redis, Postgres or a model.
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

// The default when the caller sends no transcript. Kept in the assertions
// below so the bound is checked against the thing the route exists to replay.
const sampleTranscript = require('../src/sample-transcript.js');

const MAX = parseInt(process.env.FIRST_LOOP_MAX_TRANSCRIPT_CHARS || '20000', 10);

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

// [startSec, endSec, speaker, text] — only the text counts toward the bound.
function transcriptWithSpeechChars(chars) {
  return {
    meetingTitle: 'bound probe',
    durationSeconds: 60,
    participants: [{ role: 'rep', name: 'R' }, { role: 'prospect', name: 'P' }],
    segments: [[0, 60, 'rep', 'x'.repeat(chars)]],
  };
}

async function invoke(body) {
  const res = fakeRes();
  let nextErr;
  await firstLoopHandler()({ body }, res, (err) => { nextErr = err; });
  return { res, nextErr };
}

test('a transcript over the character bound is rejected before anything is spent', async () => {
  createMeetingCalls = 0;
  const { res } = await invoke({ transcript: transcriptWithSpeechChars(MAX + 1) });

  assert.strictEqual(res.statusCode, 413,
    `expected 413 for a ${MAX + 1}-char transcript, got ${res.statusCode}. Without this bound the only ` +
    'limit on POST /first-loop is express.json\'s 2mb body cap — roughly 500k tokens through three model ' +
    'stages, plus a Cloudflare Stream ingest and clip, per request.');
  assert.strictEqual(res.body && res.body.code, 'TRANSCRIPT_TOO_LONG');
  assert.strictEqual(createMeetingCalls, 0,
    'the over-length transcript reached store.createMeeting — the guard must reject BEFORE the meeting ' +
    'record and the model calls, or rejecting costs the same as accepting');
});

test('a transcript within the bound is NOT rejected (the guard is not a blanket refusal)', async () => {
  createMeetingCalls = 0;
  const { res, nextErr } = await invoke({ transcript: transcriptWithSpeechChars(MAX) });

  assert.strictEqual(res.statusCode, null,
    `a transcript of exactly ${MAX} chars was rejected with ${res.statusCode} — the bound is inclusive, ` +
    'and a guard that refuses everything is not a guard');
  assert.strictEqual(createMeetingCalls, 1, 'an in-bound transcript should have proceeded past the guard');
  assert.strictEqual(nextErr && nextErr.message, 'STOP-AFTER-GUARD');
});

test('the bundled sample call sits comfortably inside the bound', () => {
  const chars = sampleTranscript.segments.reduce((n, seg) => n + String(seg[3] || '').length, 0);
  assert.ok(chars < MAX,
    `the sample transcript this route exists to replay is ${chars} chars, which the ${MAX}-char bound ` +
    'would reject — the bound is wrong, not the sample');
});

test('a malformed transcript is a 400, not a 500 from inside the pipeline', async () => {
  createMeetingCalls = 0;
  const { res } = await invoke({ transcript: { meetingTitle: 'no segments' } });

  assert.strictEqual(res.statusCode, 400,
    'a transcript with no segments[] used to reach analysis.formatTranscript and throw a TypeError there, ' +
    'surfacing as a 500');
  assert.strictEqual(createMeetingCalls, 0);
});

after(() => {
  try { require('../src/redis.js').disconnect(); } catch { /* best-effort */ }
});
