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

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

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

test('[TEXTUAL] the admin badge does not gate on a provider name', () => {
  // web/ is a live bind mount and api/ is a baked image, so the two sides never
  // change at the same instant on a deploy. A frontend comparing summarySource
  // to a vendor name would blank the "AI summary" badge for every tenant the
  // moment the api started answering with the other one — silently, since a
  // missing badge looks like a document that simply had no summary.
  const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'admin', 'admin.js'), 'utf8');
  const offenders = [...admin.matchAll(/summarySource\s*[!=]==\s*'([^']+)'/g)].map((m) => m[1])
    .filter((v) => v !== 'fallback');
  assert.deepStrictEqual(offenders, [],
    `admin.js gates on summarySource === ${offenders.join(', ')}; test against 'fallback' instead`);
});
