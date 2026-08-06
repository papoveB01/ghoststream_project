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
//      The guard on that runs the real badge expression against a table of
//      values rather than grepping for one spelling of the comparison — see the
//      note above it for the six mutations the textual version let through.

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

// Lift the badge expression out of admin.js so it can be RUN rather than
// spell-checked. The previous version of this guard matched the source text for
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

test('[BEHAVIOURAL] the admin badge gates on "a model answered", not on a vendor name', () => {
  // web/ is a live bind mount and api/ is a baked image, so the two sides never
  // change at the same instant on a deploy. A frontend comparing summarySource
  // to a vendor name would blank the "AI summary" badge for every tenant the
  // moment the api started answering with the other one — silently, since a
  // missing badge looks like a document that simply had no summary.
  const admin = readAdminJs();
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
  // In the SAME slice, and with comments stripped: an `${aiTag}` in another
  // card, or one left behind in a comment, is not this card rendering the badge.
  assert.match(stripComments(body).replace(expr, ''), /\$\{aiTag\}/,
    'the badge is computed inside renderPreviewCard but never interpolated into its own output');

  // Executing the real expression is what makes the spelling irrelevant.
  const badge = new Function('p', `return (${expr});`);
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
    const out = String(badge({ summarySource }) || '');
    assert.strictEqual(out.includes('kb-preview-ai-tag'), expected,
      `summarySource=${JSON.stringify(summarySource)} should ${expected ? '' : 'NOT '}show the AI badge`);
  }
});
