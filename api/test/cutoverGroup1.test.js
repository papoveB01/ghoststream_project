// ADR-0006 §9 item 5, group 1: relevance + preview + companyBrief on Claude.
//
// This is the first PR in the migration where real traffic can reach Anthropic,
// so what is asserted here is not "the seam works" (aiCall.test.js covers that)
// but the three things that are specific to THESE call sites and silent if wrong:
//
//   1. relevance FAILS OPEN. A refusal — HTTP 200 with stop_reason 'refusal',
//      which ADR-0006 §7 flags as plausible on exactly this subject matter —
//      would otherwise be indistinguishable from "this document is fine",
//      quietly ending quarantine for every tenant.
//   2. preview.js hosts TWO tasks in different cutover groups. `compare` must
//      stay on Gemini while `preview` moves, in the same file.
//   3. `summarySource` is rendered by web/admin/admin.js. It used to be the
//      literal 'gemini', so the "AI summary" badge would have vanished on flip.
//      The guard on that RENDERS the real card against a table of summarySource
//      values rather than grepping for one spelling of the comparison — see the
//      notes above it for the seven mutations the textual versions let through.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
// Quote/regex-aware, and shared with the two [TEXTUAL] guards — a naive `//`
// strip would truncate any line of admin.js containing a URL literal.
const { stripComments } = require('./helpers/stripComments.js');

const SRC = path.join(__dirname, '..', 'src');

// gemini.js pulls in redis.js, which opens an ioredis client at module load and
// retries forever with no Redis reachable — `node --test` then hangs rather than
// failing. preview.js still requires it for the un-migrated `compare` path.
const geminiPath = require.resolve(path.join(SRC, 'gemini.js'));
const geminiStub = { getClient: () => { throw new Error('gemini stub: compare path not exercised here'); } };
require.cache[geminiPath] = {
  id: geminiPath, filename: geminiPath, loaded: true, children: [], paths: [], exports: geminiStub,
};

const aiCall = require(path.join(SRC, 'aiCall.js'));
const models = require(path.join(SRC, 'models.js'));
const relevance = require(path.join(SRC, 'knowledge', 'relevance.js'));
const preview = require(path.join(SRC, 'knowledge', 'preview.js'));
const companyBrief = require(path.join(SRC, 'companyBrief.js'));

// Replace the seam itself so nothing resolves a provider or touches a network.
async function withSeam(impl, fn) {
  const real = aiCall.generateStructured;
  const calls = [];
  aiCall.generateStructured = async (args) => { calls.push(args); return impl(args); };
  try { return await fn(calls); } finally { aiCall.generateStructured = real; }
}

const ok = (parsed, provider = 'anthropic') => async () => ({
  parsed, text: JSON.stringify(parsed), usage: null, model: 'claude-haiku-4-5', provider,
});

test('group 1 is dispatch-ready, and compare deliberately is not', () => {
  for (const t of ['relevance', 'preview', 'companyBrief']) {
    assert.ok(models.DISPATCH_READY.has(t), `${t} was migrated, so it must be eligible`);
  }
  assert.ok(!models.DISPATCH_READY.has('compare'),
    'compare shares preview.js but belongs to a later group — flipping it here would ' +
    'cut over a task whose call site was never migrated');
});

test('relevance routes both call sites through the seam with their own labels', async () => {
  await withSeam(ok({ isOnTopic: true, confidence: 0.9, reason: 'r' }), async (calls) => {
    await relevance.checkDocRelevance({
      text: 'x'.repeat(200), competitorName: 'Acme', tenantId: 't1',
    });
    await relevance.checkOfferingPlausibility({ competitorName: 'Acme', productName: 'Widget', tenantId: 't1' });

    assert.deepStrictEqual(calls.map((c) => c.site), ['kb.relevanceDoc', 'kb.relevanceOffering']);
    assert.deepStrictEqual(calls.map((c) => c.task), ['relevance', 'relevance']);
    // The output budgets the Gemini call sites already had. On Claude max_tokens
    // covers thinking too, but thinking is off, so the sizing still holds.
    assert.deepStrictEqual(calls.map((c) => c.maxTokens), [400, 200]);
    assert.deepStrictEqual(calls.map((c) => c.temperature), [0.1, 0.1]);
    assert.deepStrictEqual(calls.map((c) => c.tenantId), ['t1', 't1']);
  });
});

test('a REFUSAL still fails open — but says so, and says what it costs', async () => {
  const refusal = Object.assign(new Error('Claude declined this request (harmful_content): competitor research'), {
    status: 422, refusal: true, category: 'harmful_content', provider: 'anthropic',
  });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    await withSeam(async () => { throw refusal; }, async () => {
      const verdict = await relevance.checkDocRelevance({
        text: 'x'.repeat(200), competitorName: 'Acme', tenantId: 't1',
      });
      // Fail-open is preserved deliberately: quarantining on a model error would
      // bury legitimate documents, which is the worse trade.
      assert.strictEqual(verdict, null);
      assert.strictEqual(relevance.shouldQuarantine(verdict), false);
    });
  } finally { console.warn = realWarn; }

  const line = warnings.find((w) => w.includes('REFUSAL'));
  assert.ok(line, 'a refusal must not read like a timeout — it is not transient and will recur');
  assert.match(line, /anthropic/, 'name the provider');
  assert.match(line, /harmful_content/, 'name the category');
  assert.match(line, /SKIPS THE QUARANTINE GATE/, 'say what the fail-open actually costs');
});

test('an ordinary failure names the provider that produced it', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    await withSeam(async () => { throw Object.assign(new Error('boom'), { provider: 'anthropic' }); },
      async () => { await relevance.checkDocRelevance({ text: 'x'.repeat(200), competitorName: 'A' }); });
  } finally { console.warn = realWarn; }
  assert.ok(warnings.some((w) => /checkDocRelevance failed on anthropic/.test(w)),
    'two providers now serve this path; a log line that names neither cannot be triaged');
});

test('an UNSTAMPED failure says so rather than blaming the provider that is not running', async () => {
  // The default used to be 'gemini', so anything that lost its stamp — the
  // JSON.parse inside aiCall was the live case — printed the wrong vendor with
  // full confidence, on the one guard whose failures are otherwise invisible.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    await withSeam(async () => { throw new Error('boom'); },
      async () => { await relevance.checkDocRelevance({ text: 'x'.repeat(200), competitorName: 'A' }); });
  } finally { console.warn = realWarn; }
  assert.ok(warnings.some((w) => /checkDocRelevance failed on unknown/.test(w)),
    'an unattributable failure must read as unattributed, not as a Gemini failure');
  assert.ok(!warnings.some((w) => /failed on gemini/.test(w)));
});

test('companyBrief and preview use ONE sentinel for "no model answered"', async () => {
  // Two words for one concept is how `!== 'fallback'` quietly starts treating a
  // fallback as a model answer. companyBrief said 'metadata' until this test.
  await withSeam(async () => { throw new Error('down'); }, async () => {
    const brief = await companyBrief.generateBrief('some markdown', { title: 'Acme' }, 't1');
    assert.strictEqual(brief.source, 'fallback',
      "the non-model sentinel is 'fallback' everywhere — anything else reads as a provider name");
  });
});

test('the two fallback paths name the provider, like relevance next door', async () => {
  // relevance.js got provider attribution in the same commit these two did not,
  // so one of three fail-open paths was triagable and two were not. Also pins
  // that companyBrief's line stopped saying "metadata fallback": 'metadata' was
  // the sentinel this migration DELETED, and a log line is where a deleted
  // vocabulary survives longest.
  for (const [label, run] of [
    ['preview', () => preview.buildPreview('y'.repeat(300), { tenantId: 't1' })],
    ['companyBrief', () => companyBrief.generateBrief('md', { title: 'Acme' }, 't1')],
  ]) {
    for (const [stamped, expected] of [['anthropic', 'anthropic'], [null, 'unknown']]) {
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (...a) => warnings.push(a.map(String).join(' '));
      try {
        const err = new Error('down');
        if (stamped) err.provider = stamped;
        await withSeam(async () => { throw err; }, run);
      } finally { console.warn = realWarn; }
      assert.ok(warnings.some((w) => new RegExp(`failed on ${expected}`).test(w)),
        `${label} (provider=${stamped}) must log "failed on ${expected}": ${warnings.join(' | ')}`);
      assert.ok(!warnings.some((w) => /metadata fallback/.test(w)),
        `${label} must not name the deleted 'metadata' sentinel`);
    }
  }
});

test('preview reports the provider that answered, never a hardcoded vendor', async () => {
  await withSeam(ok({ documentType: 'doc', summary: 's', keyTopics: [], suggestedCategory: null }), async (calls) => {
    const card = await preview.buildPreview('y'.repeat(300), { tenantId: 't1', sourceType: 'pdf' });
    assert.strictEqual(calls[0].task, 'preview');
    assert.strictEqual(calls[0].site, 'kb.preview');
    assert.strictEqual(card.summarySource, 'anthropic',
      'this was the literal string "gemini" — after a flip it would have been a lie');
  });
  await withSeam(ok({ documentType: 'doc', summary: 's', keyTopics: [], suggestedCategory: null }, 'gemini'),
    async () => {
      const card = await preview.buildPreview('y'.repeat(300), { tenantId: 't1' });
      assert.strictEqual(card.summarySource, 'gemini');
    });
});

test('the fallback path stays distinguishable from a model answer', async () => {
  // 'fallback' is the ONLY non-model value, which is what lets the frontend
  // badge test `!== 'fallback'` instead of naming a vendor.
  await withSeam(async () => { throw new Error('down'); }, async () => {
    const card = await preview.buildPreview('y'.repeat(300), { tenantId: 't1' });
    assert.strictEqual(card.summarySource, 'fallback');
  });
});

// web/admin/admin.js, found by walking up for a directory that holds BOTH api/
// and web/ — never a fixed `../..`.
//
// rules/commands.md documents running the suite from `api/` with only that
// directory mounted (`docker run -v "$PWD":/app -w /app`), where `../../web`
// does not exist and readFileSync throws ENOENT. A guard that dies on the
// project's own documented workflow gets deleted or skipped, and then it is
// guarding nothing. It must still never SKIP, though — a guard that quietly
// finds nothing to check is the exact failure mode this whole test exists to
// close — so a genuinely absent web/ is an explicit failure naming the mount.
function readAdminJs() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'api')) && fs.existsSync(path.join(dir, 'web'))) {
      return fs.readFileSync(path.join(dir, 'web', 'admin', 'admin.js'), 'utf8');
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  assert.fail(
    'could not find a directory containing both api/ and web/ above ' + __dirname + '.\n' +
    'This guard reads web/admin/admin.js, so the REPO ROOT must be mounted, not just api/ — ' +
    'run it as:\n  docker compose run --rm --no-deps -v "$PWD":/repo -w /repo/api api npm test\n' +
    'Do not skip this test to make it pass: it is the only thing keeping the "AI summary" ' +
    'badge working across a summarySource provider flip.'
  );
}

// Lift the badge — and then the whole card — out of admin.js so it can be RUN
// rather than spell-checked. The first version of this guard matched source text for
// `summarySource === '…'`, which pinned exactly one spelling: mutating the real
// file seven ways defeated it six times — double quotes, backticks, Yoda order,
// `['gemini'].includes(…)`, `startsWith('gem')`, and deleting the badge outright.
// There is no eslint or prettier in this repo, so the double-quote rewrite is an
// ordinary edit, not a contrived one. Behaviour is the thing worth pinning.
//
// SLICED TO renderPreviewCard's BODY FIRST, because the whole-file version had
// three silent passes of its own in a 13k-line file:
//
//   1. a SECOND `const aiTag =` anywhere earlier in the file — admin.js is one
//      IIFE, so a same-named local in another render function is legal — made
//      the extractor take the first match and then test a decoy while the real
//      badge went unchecked;
//   2. deleting `${aiTag}` from the div while any comment still mentioned it
//      satisfied the whole-file interpolation match;
//   3. that same whole-file match was satisfied by an `${aiTag}` inside a
//      DIFFERENT card, so gating the real interpolation on a provider still
//      passed.
//
// Bounded by the next top-level `function ` at the same indent, which is how
// every sibling in this file's IIFE is written.
function previewCardBody(admin) {
  const start = admin.indexOf('function renderPreviewCard(');
  if (start === -1) return null;
  const rest = admin.slice(start + 1);
  const end = rest.search(/\n {2}function \w/);
  return end === -1 ? rest : rest.slice(0, end);
}

function badgeExpression(body) {
  // Anchored on the assignment and terminated by the statement's semicolon. A
  // rename or a deletion returns null and fails the test below.
  const m = body.match(/const\s+aiTag\s*=\s*([\s\S]*?);\s*\n/);
  return m ? m[1] : null;
}

// The card's WHOLE declaration, so it can be EXECUTED rather than read.
//
// The seventh mutation the expression-level version let through: the guard
// checked that `${aiTag}` still appeared in the comment-stripped body, and
// stripComments strips JAVASCRIPT comments. The badge is interpolated inside a
// template literal, so `…${escapeHtml(p.summary)}</div><!-- badge ${aiTag}
// moved -->` is not a JS comment at all — it is live template text that emits an
// HTML comment. The regex stayed satisfied, the suite stayed 10/10, and the
// badge rendered where no browser shows it. That is not a contrived edit; it is
// what commenting markup out looks like when a developer does it in a hurry.
//
// A second blind spot in the same line, found while re-running the bypasses: a
// genuine `/* … */` written INSIDE a template interpolation is not stripped
// either, because stripComments is quote-aware and treats template contents as
// string text. Both are the same mistake — reasoning about rendered markup from
// JavaScript source text.
//
// Rendering closes both of those, and every other way JS source text can be
// rearranged around the badge — but calling it "the whole class" overclaimed,
// which is the same mistake one level up. The assertion is only ever as strong
// as what visible() considers painted, and three mutants beat the first version
// of that (see visible() below). Text-level checks are kept above it, because
// they are what catches a guard pointed at the WRONG code (a decoy declaration,
// a second card, a call site pointed elsewhere) — the failure a render cannot
// see, because it renders whatever it was given.
//
// previewCardBody starts one character in (it slices from the match, not the
// keyword), so re-attach the `f`, and cut at the declaration's own closing brace
// — the last `\n  }` in the slice, since every brace nested inside the card is
// indented deeper than its own.
function previewCardSource(admin) {
  const body = previewCardBody(admin);
  if (body == null) return null;
  const close = body.lastIndexOf('\n  }');
  return close === -1 ? null : 'f' + body.slice(0, close + 4);
}

// The card closes over its siblings inside admin.js's one IIFE. They are
// STUBBED rather than lifted out: the badge is what is under test, and a guard
// that needs a new stub every time the card starts calling a new helper is a
// guard that gets deleted the first time it fails for an unrelated edit. So an
// identifier this test has never heard of resolves to a no-op returning '' —
// while a real global (String, JSON, Number) still resolves to the real thing,
// or ordinary code inside the card would silently evaluate to ''.
const CARD_HELPERS = {
  escapeHtml: (s) => String(s == null ? '' : s),
  safeHref: (s) => String(s == null ? '' : s),
  fmtNum: (n) => String(n),
  fmtDate: (d) => String(d),
  prettyCategory: (c) => String(c),
  renderComparison: () => '',
};

function renderCard(source, p) {
  const noop = () => '';
  const scope = Object.assign({ p }, CARD_HELPERS);
  const env = new Proxy(scope, {
    has: (target, key) => (key in target) || !(key in globalThis),
    // `with` probes Symbol.unscopables on the object; handing it a function
    // would let a stub decide the scoping rules.
    get: (target, key) => (key in target ? target[key] : (typeof key === 'symbol' ? undefined : noop)),
  });
  let make;
  try {
    // `with` is illegal in strict code, and a Function-constructor body does not
    // inherit this file's 'use strict' — which is the only reason this works.
    // The card is a function EXPRESSION assigned to a const inside the block, so
    // that const's own declarative scope wins the name lookup over the proxy.
    make = new Function('__env', `with (__env) { const __card = ${source}; return __card; }`);
  } catch (err) {
    assert.fail(
      'could not compile renderPreviewCard out of admin.js (' + err.message + ').\n' +
      'The slice runs from `function renderPreviewCard(` to the next sibling `\\n  function`, so a ' +
      'sibling written another way — an `async function`, a different indent — makes it swallow ' +
      'code that is not part of the card. Fix the boundary; do not delete this guard.'
    );
  }
  return String(make(env)(p) || '');
}

// What a browser actually PAINTS, projected onto a string this test can assert
// over: element class names plus text nodes, and nothing else.
//
// The first version stripped HTML comments and called the result "what a browser
// would show", which overclaimed — it was still a substring test over a markup
// string. Three ordinary-looking edits put the badge somewhere no user can see it
// and kept the guard green: the whole span moved into an ATTRIBUTE value
// (`data-badge="<span class=…>AI summary</span>"`), the span wrapped in
// `<div style="display:none">`, and the span parked inside
// `<script type="text/template">`. All three are markup that contains the badge
// and renders none of it.
//
// So: comments go, the bodies of script/style/template go, a display:none
// subtree goes, tags are consumed quote-aware (an attribute value may legally
// contain '>', which is exactly where the first mutant hid), and of each tag only
// its FIRST class attribute survives — which is what keeps the assertion below
// able to look for kb-preview-ai-tag at all.
//
// What this deliberately does NOT model, so nobody reads more into a pass than is
// there: CSS from stylesheets (there is none in scope here — admin.css is not
// loaded), `visibility:hidden`, the `hidden` attribute, off-screen positioning,
// zero sizing, and element nesting of the same tag inside a display:none subtree.
// It models the ways markup can swallow the badge, not the whole of CSS.
function visible(html) {
  const markup = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(\w+)\b[^>]*?\bstyle\s*=\s*(["'])[^"']*display\s*:\s*none[\s\S]*?<\/\1\s*>/gi, '');

  let out = '';
  let i = 0;
  while (i < markup.length) {
    const lt = markup.indexOf('<', i);
    if (lt === -1) { out += markup.slice(i); break; }
    out += markup.slice(i, lt);           // a text node — painted
    let j = lt + 1;
    let quote = null;
    for (; j < markup.length; j++) {
      const c = markup[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === '\'') quote = c;
      else if (c === '>') break;
    }
    const tag = markup.slice(lt, j + 1);
    const cls = tag.match(/\sclass\s*=\s*(["'])([^"']*)\1/i);
    out += cls ? ' ' + cls[2] + ' ' : ' ';  // every other attribute value: not painted
    i = j + 1;
  }
  return out;
}

test('[BEHAVIOURAL] the admin badge gates on "a model answered", not on a vendor name', () => {
  // web/ is a live bind mount and api/ is a baked image, so the two sides never
  // change at the same instant on a deploy. A frontend comparing summarySource
  // to a vendor name would blank the "AI summary" badge for every tenant the
  // moment the api started answering with the other one — silently, since a
  // missing badge looks like a document that simply had no summary.
  const admin = readAdminJs();

  // ONE definition, or this guard and the browser are reading different code:
  // admin.js is a single IIFE, so a second `function renderPreviewCard(` is
  // legal, the LAST one wins at runtime, and everything below slices to the
  // first.
  const definitions = (admin.match(/function renderPreviewCard\(/g) || []).length;
  assert.strictEqual(definitions, 1,
    `admin.js declares renderPreviewCard ${definitions} times — the browser uses the last one and ` +
    'this guard reads the first, so the card being checked need not be the card being shipped');

  // …and it must be the definition the page actually CALLS. "Exactly one
  // `function renderPreviewCard(`" proves membership of the file, not wiring:
  // adding a badge-less renderPreviewCardV2 and repointing the two
  // `result.innerHTML = …(x.preview || {})` sites at it leaves the original
  // intact, this file green, and the badge gone for every tenant — which is the
  // very failure the definition count was added to stop. Reassigning the name
  // after its declaration does the same thing without touching a call site.
  const wired = stripComments(admin);
  const callSites = [...wired.matchAll(/innerHTML\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*[A-Za-z_$][\w$]*\.preview\b/g)]
    .map((m) => m[1]);
  assert.ok(callSites.length >= 2,
    `found ${callSites.length} preview-card call sites in admin.js, expected the file/web dry-run pair — ` +
    'either they were rewritten into a shape this guard cannot see, in which case fix the match, ' +
    'or nothing renders the preview card any more');
  assert.deepStrictEqual([...new Set(callSites)], ['renderPreviewCard'],
    `the preview card is rendered by ${[...new Set(callSites)].join(', ')} — this guard reads, slices and ` +
    'executes renderPreviewCard, so anything else at the call site means it is testing code the browser ' +
    'never runs');
  assert.ok(!/renderPreviewCard\s*=[^=]/.test(wired),
    'renderPreviewCard is reassigned somewhere in admin.js — the declaration this guard renders is then ' +
    'not the function the call sites invoke');

  const body = previewCardBody(admin);
  assert.ok(body,
    'no `function renderPreviewCard(` in admin.js — the preview card was renamed or removed, ' +
    'and this guard can no longer find the badge it exists to protect.');

  // Exactly one, inside the slice. Two would mean the extractor below is free
  // to test a decoy; zero means the badge is gone.
  const declarations = (body.match(/const\s+aiTag\s*=/g) || []).length;
  assert.strictEqual(declarations, 1,
    `renderPreviewCard declares aiTag ${declarations} times — this guard reads the first, ` +
    'so any other declaration lets the real badge go unchecked');

  const expr = badgeExpression(body);
  assert.ok(expr,
    'no `const aiTag = …` in renderPreviewCard — the "AI summary" badge was renamed or removed. ' +
    'Deleting it is not a way to satisfy this guard: summarySource exists to tell a model ' +
    'answer from the fallback, and the badge is the only place a user sees the difference.');
  assert.match(expr, /kb-preview-ai-tag/,
    'the badge expression no longer emits the kb-preview-ai-tag span, so nothing renders');
  // In the SAME slice, and with JS comments stripped: an `${aiTag}` in another
  // card, or one left behind in a comment, is not this card rendering the badge.
  // Necessary but NOT sufficient — see previewCardSource above for the HTML
  // comment this exact line was defeated by. The render below is what decides.
  assert.match(stripComments(body).replace(expr, ''), /\$\{aiTag\}/,
    'the badge is computed inside renderPreviewCard but never interpolated into its own output');

  // Rendering the real card is what makes both the spelling AND the surrounding
  // markup irrelevant: what is asserted is the HTML a browser would show.
  const source = previewCardSource(admin);
  assert.ok(source,
    'renderPreviewCard has no closing `\\n  }` inside its slice — the card is written at an ' +
    'indent this guard cannot bound, so it can no longer be executed');
  const render = (summarySource) =>
    visible(renderCard(source, { summary: 'a one-line summary', summarySource }));
  const cases = [
    // Both providers in flight during ADR-0006 §9 item 5 must badge…
    ['gemini', true],
    ['anthropic', true],
    // …and so must one that does not exist yet. summarySource carries whatever
    // models.resolve() returned, so a guard listing today's vendors is the same
    // bug with a longer list.
    ['some-future-provider', true],
    // 'fallback' is the one and only non-model value (preview.js, and now
    // companyBrief.js).
    ['fallback', false],
    // A preview from an older api, or a card built before summarize() ran.
    [undefined, false],
    [null, false],
    ['', false],
  ];
  for (const [summarySource, expected] of cases) {
    assert.strictEqual(render(summarySource).includes('kb-preview-ai-tag'), expected,
      `summarySource=${JSON.stringify(summarySource)} should ${expected ? '' : 'NOT '}show the AI badge ` +
      'in the card\'s PAINTED output — see visible(): a badge inside <!-- -->, inside an attribute value, ' +
      'inside <script>/<style>/<template>, or inside a display:none subtree is markup a user never sees');
  }
});
