// Regression test for web/shared/url.js (DSText: escapeHtml / isSafeUrl /
// safeHref), extracted 2026-07-29 to de-duplicate copies that had been
// hand-maintained in admin.js, portal.js and arena.js and had drifted —
// portal.js ended up with no safeHref at all, and three href sinks across
// the apps were built with escapeHtml alone. escapeHtml does NOT touch ':',
// so a `javascript:` URL survives HTML-escaping completely intact; only
// safeHref's colon-before-first-separator check rejects it.
//
// No build step in this repo, so url.js has a CommonJS tail specifically so
// this file can require it directly — same bytes as what ships to the
// browser, no bundler in between.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const { escapeHtml, isSafeUrl, safeHref } = require('../../web/shared/url.js');

// ---- malicious schemes: safeHref must neutralize to '#' -------------------

const MALICIOUS = [
  ['javascript:alert(1)', 'plain javascript: URL'],
  ['JaVaScRiPt:alert(1)', 'mixed-case scheme'],
  ['java\nscript:alert(1)', 'embedded-newline obfuscation'],
  ['   javascript:alert(1)', 'leading spaces before the scheme'],
  ['\tjavascript:alert(1)', 'leading tab before the scheme'],
  ['data:text/html,<script>alert(1)</script>', 'data: URL'],
  ['vbscript:alert(1)', 'vbscript: URL'],
];

for (const [url, label] of MALICIOUS) {
  test(`safeHref neutralizes ${label}`, () => {
    assert.strictEqual(isSafeUrl(url), false, `isSafeUrl should reject: ${label}`);
    assert.strictEqual(
      safeHref(url),
      '#',
      `safeHref must return '#' for ${label} — reverting to escapeHtml-only would ` +
      `let this survive intact, since escapeHtml never touches ':'`
    );
  });
}

// ---- legitimate schemes/forms: must pass through, HTML-escaped -----------

const SAFE = [
  ['https://example.com/a?x=1&y=2', 'https URL'],
  ['http://example.com', 'http URL'],
  ['mailto:someone@example.com', 'mailto URL'],
  ['/x', 'absolute-path relative URL'],
  ['x/y', 'bare relative path'],
  ['#a', 'in-page anchor'],
  ['//host/x', 'protocol-relative URL'],
];

for (const [url, label] of SAFE) {
  test(`safeHref passes through ${label}`, () => {
    assert.strictEqual(isSafeUrl(url), true, `isSafeUrl should accept: ${label}`);
    assert.strictEqual(safeHref(url), escapeHtml(url), `safeHref should return the escaped URL for ${label}`);
  });
}

// ---- escapeHtml ------------------------------------------------------------

test('escapeHtml escapes all five HTML-sensitive characters', () => {
  assert.strictEqual(escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
});

test('escapeHtml renders the number 0 as the string "0", not empty', () => {
  // Pinning a real behaviour difference from the old hand-copied admin.js
  // version: a naive `s ? s : ''`-style guard treats 0 as falsy and drops it,
  // silently blanking any legitimately-zero value (counts, indices, scores).
  assert.strictEqual(escapeHtml(0), '0');
});

test('escapeHtml treats null/undefined as empty string', () => {
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

// ---- no re-hand-copied escaping logic in the three app bundles -----------
// The bug was the copies drifting apart; pinning that each app now delegates
// to DSText (rather than reimplementing escapeHtml/safeHref locally) is what
// stops that drift from recurring.

const APP_FILES = [
  path.join(__dirname, '..', '..', 'web', 'admin', 'admin.js'),
  path.join(__dirname, '..', '..', 'web', 'portal', 'portal.js'),
  path.join(__dirname, '..', '..', 'web', 'arena', 'arena.js'),
];

// ---- the KB preview card's source link -----------------------------------
//
// Regression pin for one specific sink, fixed 2026-08-06. renderPreviewCard
// built `href="${escapeHtml(p.sourceUrl)}"`, and p.sourceUrl is not validated
// anywhere: api/src/knowledge/web.js takes it from Firecrawl's scrape metadata
// (`meta.sourceURL || meta.url || url`) and never runs it through new URL().
// escapeHtml does not touch ':', so a `javascript:` value reaches the DOM
// intact — the failure mode this whole file exists to document, in the render
// path the ADR-0006 §9 item 5 cutover touches.
//
// Narrow on purpose. admin.js still has NINE other `href="${escapeHtml(…)}"`
// sinks (integration docsUrl, doc.source_url, competitor sourceUrl, research
// citations, watch sourceUrl); they are the same class and predate this change,
// and widening this into a blanket guard would be a security sweep wearing a
// cutover PR's clothes. Tracked separately — do not delete this note when the
// sweep lands, replace it with the blanket assertion.
test('the KB preview card builds its source href with safeHref, not escapeHtml', () => {
  const admin = fs.readFileSync(APP_FILES[0], 'utf8');
  const line = admin.split('\n').find((l) => l.includes('class="kb-preview-src"><a href='));
  assert.ok(line, 'the kb-preview-src link was renamed or removed — re-point this guard at it');
  assert.match(line, /href="\$\{safeHref\(/,
    'p.sourceUrl comes from Firecrawl scrape metadata and is never URL-validated; ' +
    'escapeHtml leaves `javascript:` completely intact');
  assert.match(line, />\$\{escapeHtml\(p\.sourceUrl\)\}/,
    'the visible link text must still be HTML-escaped — safeHref belongs on the href only, ' +
    'since it collapses an unsafe URL to "#" and would hide what the document actually claims');
});

for (const file of APP_FILES) {
  const rel = path.relative(path.join(__dirname, '..', '..'), file);
  test(`${rel} delegates escaping/URL-safety to DSText instead of reimplementing it`, () => {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /DSText/, `${rel} should reference the shared DSText helpers`);
    assert.match(
      src,
      /function\s+escapeHtml\s*\([^)]*\)\s*\{\s*return\s+DSText\.escapeHtml\(/,
      `${rel}'s escapeHtml must delegate to DSText.escapeHtml, not reimplement the regex`
    );
    assert.match(
      src,
      /function\s+safeHref\s*\([^)]*\)\s*\{\s*return\s+DSText\.safeHref\(/,
      `${rel} must expose a safeHref that delegates to DSText.safeHref (portal.js previously had none at all)`
    );
    // The actual escaping regex must not be hand-copied back into the app file.
    assert.doesNotMatch(
      src,
      /replace\(\/\[&<>"'\]\//,
      `${rel} must not contain its own copy of the escaping character class — ` +
      `that copy-paste is exactly what let the three files drift in the first place`
    );
  });
}
