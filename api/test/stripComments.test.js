// The shared comment-stripper the [TEXTUAL] guards depend on.
//
// It gets its own tests because both guards are only as good as it is: a `//`
// it mishandles deletes a line of real source, and the call site on that line
// disappears from the guard's view with nothing failing. The first version was
// defeated exactly this way.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { stripComments } = require('./helpers/stripComments.js');

test('a // inside a string literal is not a comment', () => {
  // The real line, from src/ics.js.
  const src = "  prodId = '-//DealScope//Meeting Invite//EN',";
  assert.strictEqual(stripComments(src), src);
});

test('a // inside a regex literal is not a comment', () => {
  // The real line, from src/portfolio.js.
  const src = "  const d = u.replace(/^https?:\\/\\//i, '');";
  assert.strictEqual(stripComments(src), src);
});

test('a // inside a template literal is not a comment', () => {
  const src = 'const u = `${base}//${path}`;';
  assert.strictEqual(stripComments(src), src);
});

test('real line comments are still stripped', () => {
  assert.strictEqual(stripComments('const a = 1; // set a\nconst b = 2;'), 'const a = 1; \nconst b = 2;');
  assert.strictEqual(stripComments('// whole line\nkeep();'), '\nkeep();');
});

test('block comments are stripped but keep their newlines', () => {
  const out = stripComments('a();\n/* two\n   lines */\nb();');
  assert.match(out, /a\(\);/);
  assert.match(out, /b\(\);/);
  assert.doesNotMatch(out, /lines/);
  assert.strictEqual(out.split('\n').length, 4, 'line numbers must survive stripping');
});

test('an escaped quote does not end the string early', () => {
  const src = "const s = 'it\\'s // not a comment';";
  assert.strictEqual(stripComments(src), src);
});

test('division is not mistaken for a regex', () => {
  const src = 'const r = (a) / (b); // c';
  assert.strictEqual(stripComments(src), 'const r = (a) / (b); ');
});

test('a URL in a comment does not survive', () => {
  assert.strictEqual(stripComments('x(); // see https://example.com/a//b'), 'x(); ');
});

// The regression that motivated the shared helper: prove the two real src/
// lines survive a strip of their whole file, so neither guard is reading a
// truncated version of them.
test('the two real src/ lines that defeated the old stripper survive', () => {
  const SRC = path.join(__dirname, '..', 'src');
  for (const [file, needle] of [
    ['ics.js', 'DealScope'],
    ['portfolio.js', 'https?:'],
  ]) {
    const full = path.join(SRC, file);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full, 'utf8');
    if (!raw.includes(needle)) continue;
    const stripped = stripComments(raw);
    assert.ok(stripped.includes(needle),
      `${file}: stripComments deleted live code containing ${needle} — any guarded call site ` +
      'on that line is invisible to the [TEXTUAL] guards');
  }
});
