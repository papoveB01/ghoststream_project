// Provider seam for GROUNDED CONTEXT — a stable prefix (a persona character, a
// company-intelligence block) that many generations share, plus the turns that
// follow it.
//
// ADR-0006 §9 item 4 calls this the "caching redesign". It is really a provider
// seam, because the two providers do not model a shared prefix the same way and
// gemini.js's shape is Gemini's:
//
//   Gemini    a NAMED SERVER RESOURCE. caches.create() returns a handle with a
//             TTL; a request references it by name; it can be listed and
//             invalidated. getOrCreateCache() returns `cached`, or `inline`
//             when the body is under the model's minimum or the quota is spent.
//   Claude    a PER-REQUEST ANNOTATION. cache_control marks a block. No handle,
//             no registry, no TTL to manage, nothing to invalidate. Under the
//             minimum cacheable prefix it does not fail — it silently does not
//             cache, at full price, with no error and no warning field.
//
// So `mode: 'cached' | 'inline'` cannot be the shared vocabulary: it is one
// provider's implementation detail, and `generateForRecord` branching on it
// encodes Gemini's model into every caller. What both providers do share is
// "here is a stable prefix, here is a conversation, produce the next turn".
// That is the seam, and it is all this module is.
//
// WHAT THIS DOES NOT DO, deliberately:
//
//   - It does not replace gemini.js's cache layer. Eight call sites across seven
//     superadmin endpoints in index.js use listCachedRecords / invalidate /
//     getOrCreateCache / generateForRecord directly — the two easy to miss are
//     GET /admin/overview and GET /admin/caches, which sit outside the
//     /gemini/* block — and two of them are pinned by routeContract.test.js,
//     while geminiCacheScan.test.js pins a fix for a real incident
//     (redis.keys() blocking the Redis that also holds sessions). The layer
//     goes in Phase 5 with the /caches endpoints, not here.
//   - It does not flip any task — but the three exported functions are held
//     back by three DIFFERENT mechanisms, which lift at different times. Do not
//     collapse them, and do not reach for "DISPATCH_READY is empty": it is not
//     (relevance, preview and companyBrief joined it in group 1, ADR-0006 §9
//     item 5). Check the premise that matches the branch you are touching.
//
//     prepare()   HELD BY THE ROUTER. Its only production caller is
//                 knowledge/globalCache.js, which pins CACHE_TASK = 'personas',
//                 and `personas` is not in models.DISPATCH_READY — so
//                 resolve('personas') stays on 'gemini' whatever
//                 AI_PROVIDER_PERSONAS says. The arena group of item 5 adds
//                 `personas` to the set, and that lifts this hold, and only
//                 this one.
//     discard()   HELD BY ITS CALLER, not the router. globalCache.js passes
//                 `provider: 'gemini'` explicitly at both of its call sites and
//                 discard() prefers the explicit provider, so resolve() never
//                 runs on that path. That does NOT expire at the arena cutover
//                 — it is deliberate and permanent, for the reason discard()'s
//                 own note gives: a stored Gemini pointer is a Gemini fact.
//     generate()  NO PRODUCTION CALLER AT ALL. globalCache.js is the only
//                 module outside tests that requires this seam, and it calls
//                 prepare() and discard() and nothing else. So generateAnthropic
//                 — the larger branch, and the one carrying the consequences —
//                 stays dead past the `personas` flip too, until arena.js is
//                 separately moved off ensurePersonaCache /
//                 gemini.generateForRecord onto this seam. That port, not the
//                 set membership, is where the two asymmetries documented above
//                 generate() get decided: arena's temperature: 0.85 silently
//                 dropped with a warning, and over-budget output turning from a
//                 truncated render into a hard 502.
//
//     Tests reach the anthropic branches by adding the task to the set
//     themselves.
//
// TURN SHAPE. The neutral conversation unit is { role: 'user' | 'assistant',
// text }. Text only — this seam carries no images or PDFs. Gemini spells the
// non-user role 'model' and wraps text in `parts`; Anthropic spells it
// 'assistant' and takes a string or a block list. Both mappings live here.

const models = require('./models');
const gemini = require('./gemini');
const anthropic = require('./anthropic');
const costs = require('./costs');

function toGeminiContents(turns) {
  return (turns || []).map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.text }],
  }));
}

function toAnthropicMessages(turns) {
  return (turns || []).map((t) => ({ role: t.role, content: t.text }));
}

function assertTurns(turns, label) {
  if (!Array.isArray(turns)) throw new Error(`aiContext: ${label} must be an array`);
  for (const t of turns) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant')) {
      throw new Error(
        `aiContext: ${label} role must be "user" or "assistant" (got ${JSON.stringify(t && t.role)}) — ` +
        'Gemini\'s "model" is spelled "assistant" in the neutral shape'
      );
    }
    if (typeof t.text !== 'string') throw new Error(`aiContext: ${label} entries need a text string`);
  }
}

// Prepare a reusable prefix for `task`.
//
//   task            routes the provider (models.resolve) — nothing else here
//                   decides it
//   name            the registry name on Gemini; a label only on Claude
//   systemInstruction / turns   the prefix itself, in the neutral shape
//   ttlSec          Gemini only; Claude's breakpoints have a fixed 5m/1h TTL
//   geminiModel     override for the Gemini branch ONLY. globalCache.js has
//                   always built its cache against GEMINI_ANALYSIS_MODEL rather
//                   than its task's tier, and changing which model a cache is
//                   created against is a behaviour change that does not belong
//                   in a seam PR. Ignored on Claude, where the model comes from
//                   the task and a prefix is not model-scoped at all.
//
// Returns a record carrying `provider`, `model`, `mode` and the neutral prefix.
// On Gemini, `mode` is whatever getOrCreateCache decided ('cached' | 'inline').
// On Claude it is 'breakpoint': there is nothing to create, so prepare() makes
// no API call at all and cannot fail.
//
// ONE ASYMMETRY the seam does not hide: an empty `turns` with only a system
// instruction is a valid Claude context (the system block becomes the cached
// prefix) and is NOT preparable on Gemini, where caches.create rejects empty
// contents. Callers that might have an empty body must handle the throw.
async function prepare({
  task,
  name,
  systemInstruction = null,
  turns = [],
  ttlSec = undefined,
  geminiModel = null,
}) {
  if (!task) throw new Error('aiContext.prepare: task required');
  if (!name) throw new Error('aiContext.prepare: name required');
  assertTurns(turns, 'prepare turns');

  const { provider, model } = models.resolve(task);

  if (provider === 'anthropic') {
    return {
      provider,
      mode: 'breakpoint',
      name,
      model,
      systemInstruction: systemInstruction || null,
      turns,
    };
  }

  const record = await gemini.getOrCreateCache({
    name,
    model: geminiModel || model,
    systemInstruction,
    contents: toGeminiContents(turns),
    ...(ttlSec === undefined ? {} : { ttlSec }),
  });
  // The neutral turns ride along so generate() has one source for the prefix
  // whichever branch it took, and so an inline record does not have to be
  // read back in Gemini's shape.
  return { ...record, provider: 'gemini', turns };
}

// Drop a prepared prefix.
//
// On Gemini this deletes the server resource and clears the registry entry. On
// Claude there is no resource: a breakpoint expires on its own and re-caches on
// the next request whose prefix still matches. Returning false there is honest
// — nothing was invalidated because nothing existed — and callers must not read
// it as a failure.
//
// `provider` overrides what the task resolves to TODAY, and a caller holding a
// stored pointer must pass it. Resolving from the task alone orphans the
// resource across a flip: a caller with a saved `cache_name` (which only the
// Gemini branch ever writes) would get a no-op the moment its task moved to
// Claude, then overwrite that pointer with NULL — leaving a live cachedContent
// and its registry key with nothing left that can name them. A stored Gemini
// pointer is a Gemini fact, whatever the task is doing now.
async function discard({ task, name, provider = null }) {
  if (!task && !provider) throw new Error('aiContext.discard: task or provider required');
  if (!name) throw new Error('aiContext.discard: name required');
  const p = provider || models.resolve(task).provider;
  if (p === 'anthropic') return false;
  return gemini.invalidate(name);
}

// Generate the next turn against a prepared prefix.
//
//   record            from prepare()
//   turns             the conversation so far, neutral shape
//   message           optional final user turn, appended after `turns`
//   temperature       GEMINI ONLY. Claude removed it (a 400 on Opus 5,
//                     non-default rejected on Sonnet 5), so on the anthropic
//                     branch it is dropped with a warning rather than passed
//                     through — arena.js's 0.85 exists specifically for persona
//                     variety across runs and there is no parameter substitute
//                     (ADR-0006 §7, §10). Losing it silently would look like the
//                     model got blander.
//   effort / thinking ANTHROPIC ONLY. The Gemini branch keeps thinkingBudget: 0,
//                     which is what every call site being replaced sends.
//   allowTruncation   ANTHROPIC ONLY, and it matters — see below.
//
// TWO DELIBERATE ASYMMETRIES A CUTOVER MUST DECIDE ABOUT, because neither is
// visible in a diff:
//
//   1. RUNNING OUT OF OUTPUT BUDGET. Gemini returns the partial text with
//      `finishReason: 'MAX_TOKENS'` and the caller decides. Claude THROWS a 502
//      unless `allowTruncation` is set (anthropic.js documents why: a
//      well-formed string that stops mid-sentence is the most dangerous
//      success there is). So the same over-long answer renders truncated today
//      and becomes a hard failure after a flip. `arena.js` runs at 400–600
//      output tokens with a persona told to give "two to four sentences" — it
//      is the call site most likely to meet this. Pass `allowTruncation: true`
//      to keep today's behaviour, or raise the budget; do it knowingly.
//   2. DEFAULTS DIFFER FROM `gemini.generateForRecord`, which this replaces:
//      that one defaults `temperature: 0.8` and sends NO `thinkingConfig`.
//      Here temperature is unset unless you pass it, and `thinkingBudget: 0` is
//      always sent. Mechanically porting `/gemini/roleplay/:slug` would change
//      sampling and thinking with nothing in the diff to show it. (`arena.js`
//      passes both explicitly, so its own port is unaffected.)
//
// Returns { provider, text, usage, mode, finishReason }. `usage` is the
// provider's own shape — costs.record{Gemini,Claude} already understand the
// difference, and flattening it here would lose the cache split that ADR-0006
// §4.4 needs to verify the margin model.
const GENERATE_OPTS = new Set([
  'record', 'turns', 'message', 'maxOutputTokens', 'temperature', 'effort',
  'thinking', 'allowTruncation', 'tenantId', 'site', 'signal',
]);

async function generate(opts) {
  const { record, turns = [], message = null } = opts || {};
  if (!record) throw new Error('aiContext.generate: record required');

  // The same guard anthropic.generate() carries, for the same reason and one
  // layer up — silently ignoring an unknown key is how an option vanishes
  // during a mechanical port. It matters MORE here, because this seam inverts
  // the spellings again: a call site moved off anthropic.generate() brings
  // `maxTokens`, one moved off a Gemini config brings `abortSignal`, and both
  // would be dropped without a trace, taking that call site's output budget or
  // its only time bound with them.
  const stray = Object.keys(opts).filter((k) => !GENERATE_OPTS.has(k));
  if (stray.length) {
    throw new Error(
      `aiContext.generate: unknown option(s) ${stray.join(', ')}. ` +
      'This seam uses the Gemini spellings: maxTokens→maxOutputTokens, signal (not abortSignal).'
    );
  }

  assertTurns(turns, 'generate turns');
  if (turns.length === 0 && !message) {
    throw new Error('aiContext.generate: turns or message required');
  }

  return record.provider === 'anthropic' ? generateAnthropic(opts) : generateGemini(opts);
}

async function generateGemini({
  record, turns = [], message = null, maxOutputTokens = 1024,
  temperature = null, tenantId = null, site = 'aiContext.generate', signal = null,
}) {
  // A cached record's prefix already lives server-side; sending it again would
  // pay for it twice. An inline one has to carry it — and losing it there is
  // silent: the model just answers without its persona. `contents` is the same
  // prefix in Gemini's shape, which getOrCreateCache puts on every inline
  // record, so a record that reached here without `turns` (round-tripped
  // through storage, hand-built by a caller) still grounds correctly.
  //
  // Test `.length`, not truthiness: `[]` is truthy, so `turns: []` on a record
  // that DOES carry `contents` would take the turns branch, produce nothing, and
  // drop the prefix — which is the exact failure this fallback exists to
  // prevent, dressed as the fix for it.
  const inlinePrefix = record.mode === 'inline'
    ? (Array.isArray(record.turns) && record.turns.length
      ? toGeminiContents(record.turns)
      : (record.contents || []))
    : [];

  const contents = [
    ...inlinePrefix,
    ...toGeminiContents(turns),
    ...(message ? [{ role: 'user', parts: [{ text: message }] }] : []),
  ];

  const config = { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } };
  if (temperature != null) config.temperature = temperature;
  if (record.mode === 'cached') config.cachedContent = record.cacheName;
  else if (record.systemInstruction) config.systemInstruction = record.systemInstruction;
  if (signal) config.abortSignal = signal;

  const response = await gemini.getClient().models.generateContent({
    model: record.model,
    contents,
    config,
  });
  costs.recordGemini(tenantId, site, record.model, response.usageMetadata);

  return {
    provider: 'gemini',
    text: response.text,
    usage: response.usageMetadata || null,
    mode: record.mode,
    finishReason: response.candidates?.[0]?.finishReason || null,
  };
}

// Per site, not per process: a single flag would let the first call site to warn
// silence every other one, which is the failure this warning exists to prevent.
// The guarantee only holds for callers that actually pass `site` — everything
// left on the default shares one key.
const _temperatureWarned = new Set();

async function generateAnthropic({
  record, turns = [], message = null, maxOutputTokens = 1024,
  temperature = null, effort = 'medium', thinking = false, allowTruncation = false,
  tenantId = null, site = 'aiContext.generate', signal = null,
}) {
  if (temperature != null && !_temperatureWarned.has(site)) {
    _temperatureWarned.add(site);
    console.warn(
      `[aiContext] temperature ${temperature} dropped at ${site}: Claude removed the parameter ` +
      '(400 on Opus 5, non-default rejected on Sonnet 5). Where it was buying output variety, ' +
      'that variety now has to be elicited by the prompt — see ADR-0006 §7.'
    );
  }

  // ONE breakpoint, at the end of the stable prefix. Caching is prefix-based,
  // so a breakpoint on the last prefix turn already covers the system block
  // above it; a second breakpoint on the system alone would only create a
  // shorter, redundant entry against a budget of four. When there is no prefix
  // to mark, cacheSystem is the only place a breakpoint can go.
  const prefix = toAnthropicMessages(record.turns || []);
  if (prefix.length > 0) {
    const last = prefix[prefix.length - 1];
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }

  const messages = [
    ...prefix,
    ...toAnthropicMessages(turns),
    ...(message ? [{ role: 'user', content: message }] : []),
  ];

  const result = await anthropic.generate({
    model: record.model,
    messages,
    system: record.systemInstruction || null,
    cacheSystem: prefix.length === 0 && Boolean(record.systemInstruction),
    maxTokens: maxOutputTokens,
    effort,
    thinking,
    allowTruncation,
    tenantId,
    site,
    signal,
  });

  return {
    provider: 'anthropic',
    text: result.text,
    usage: result.usage,
    mode: 'breakpoint',
    finishReason: result.stopReason,
  };
}

module.exports = {
  prepare,
  discard,
  generate,
  toGeminiContents,
  toAnthropicMessages,
};
