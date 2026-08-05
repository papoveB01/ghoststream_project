// Comment stripping for the [TEXTUAL] guards (costsTelemetry, liveSchemaCoverage).
//
// Shared rather than copied. The first version of this lived in
// costsTelemetry.test.js, was copied into liveSchemaCoverage.test.js, and the
// copy inherited a defect neither file's tests would have caught — which is the
// argument for one implementation with its own tests.
//
// The defect: a naive `//`-to-end-of-line strip also fires on a `//` INSIDE a
// string or a regex literal, deleting the rest of a line of real code. Two
// lines in src/ are hit by it today:
//
//   ics.js       prodId = '-//DealScope//Meeting Invite//EN',
//   portfolio.js .replace(/^https?:\/\//i, '')
//
// Neither carries a guarded call today — but the bypass is trivial and silent:
// put `const PID = '-//x//y';` on the same line as a new model call site and it
// vanishes from the guard's view entirely.
//
// Not a JS parser, and does not need to be. It tracks the three string
// delimiters, regex literals, and block comments well enough that no `//`
// inside one is treated as a comment. Template-literal `${...}` interpolation
// is treated as ordinary template text: a `//` there would be over-preserved,
// never over-stripped, which is the safe direction for a guard.

'use strict';

// A `/` starts a regex literal (rather than being division) only where a value
// cannot legally have just ended. This is the standard heuristic: look at the
// last non-space character emitted.
function regexAllowedAfter(ch) {
  if (ch === undefined) return true;
  return !/[)\]}\w$'"`]/.test(ch);
}

function stripComments(src) {
  let out = '';
  let i = 0;
  let lastMeaningful; // last non-whitespace char kept, for the regex heuristic

  const push = (ch) => { out += ch; if (!/\s/.test(ch)) lastMeaningful = ch; };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // line comment
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue; // leave the newline in place so line numbers survive
    }
    // block comment — replaced by its newlines, again to keep line numbers
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    // string / template literal — copied verbatim, escapes respected
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      push(ch); i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === quote) { push(quote); i++; break; }
        out += src[i]; i++;
      }
      continue;
    }
    // regex literal — the `/\//` case is why this exists
    if (ch === '/' && regexAllowedAfter(lastMeaningful)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        for (let k = i; k <= j; k++) out += src[k];
        lastMeaningful = '/';
        i = j + 1;
        continue;
      }
      // unterminated on this line — it was division after all
    }
    push(ch);
    i++;
  }
  return out;
}

module.exports = { stripComments };
