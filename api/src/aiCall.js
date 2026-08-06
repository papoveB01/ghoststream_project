// Provider seam for ONE-SHOT STRUCTURED CALLS — the shape most of this codebase
// actually uses: one prompt in, one schema-shaped JSON answer out, no shared
// prefix and no conversation.
//
// aiContext.js already seams the OTHER shape (a cached/grounded prefix plus
// turns). Nothing seamed this one, so each per-task cutover PR (ADR-0006 §9
// item 5, ~12 of them) would have hand-rolled the same four things: the
// provider branch, the two different config vocabularies, the cost recording,
// and the JSON parse. That is exactly how six divergent `withRetry` copies
// happened — and the divergence that mattered there (proposals having no
// retryDelay parser) was invisible precisely because it lived in one line of
// one module nobody diffed against the other five.
//
// THIS MODULE FLIPS NOTHING. models.resolve() returns 'gemini' for every task
// while DISPATCH_READY is empty, so the anthropic branch below is reached only
// by tests until a cutover PR adds a task to that set.
//
// WHAT THE TWO PROVIDERS DO NOT SHARE, and how that is resolved here:
//
//   temperature   Gemini takes it. Claude does not — it is a hard 400 on Opus 5
//                 and Sonnet 5, and there is no substitute on the LITE tier
//                 (claude-haiku-4-5 rejects `effort` too). Passed through on
//                 Gemini, dropped on Claude with a one-time warning naming the
//                 task, because a determinism setting silently disappearing is
//                 the kind of change that shows up as "the model got flakier"
//                 three weeks later. ADR-0006 §7 calls this an unmitigated
//                 capability loss; this is where it first bites.
//   thinking      Gemini: thinkingConfig.thinkingBudget = 0. Claude: thinking
//                 false. Both default OFF here, matching every call site being
//                 migrated, so a swap does not silently start paying for
//                 reasoning tokens out of the answer's budget.
//   responseSchema  Gemini dialect in, both dialects out — anthropic.generate
//                 runs it through schemaCompat at its own boundary, so callers
//                 keep writing one schema. ADR-0006 §4.6. The PARAMETER KEEPS
//                 GEMINI'S NAME on purpose: liveSchemaCoverage.test.js finds
//                 every schema in the product by scanning src/ for the literal
//                 token `responseSchema:`, and the live smoke registry is keyed
//                 on `file::expr` from that scan. Renaming it to Claude's
//                 `schema` at call sites would delete the token from every
//                 migrated file, so the guard would go on passing while
//                 covering nothing — the exact silent-green failure it exists
//                 to prevent. One vocabulary at the seam, two behind it.
//   cost          Gemini is recorded HERE; Claude is recorded INSIDE
//                 anthropic.generate. Recording it in both places would double
//                 count, so this module records for exactly one provider and
//                 says so rather than looking like an omission.

const models = require('./models');
const gemini = require('./gemini');
const anthropic = require('./anthropic');
const costs = require('./costs');

const _warned = new Set();
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(message);
}

// One structured generation for `task`, on whichever provider it resolves to.
//
//   task        routes the provider AND the model (models.resolve) — nothing
//               else here decides either
//   prompt      the single user turn
//   system      optional system instruction
//   responseSchema  schema in GEMINI dialect (translated for Claude). Named
//               for Gemini so the coverage guard keeps seeing it — see header
//   maxTokens   output budget. On Claude this covers thinking too, but thinking
//               is off, so the sizing a Gemini call site already had still holds
//   temperature Gemini only — see the header
//   site        the cost-telemetry label, e.g. 'kb.relevanceDoc'
//
// Returns { text, parsed, usage, model, provider }. `parsed` is the JSON.parse
// of `text` when a schema was given, and parsing is the CALLER'S error to
// handle if it throws — the same as before this seam existed.
async function generateStructured({
  task,
  prompt,
  system = null,
  responseSchema = null,
  maxTokens = 1024,
  temperature = null,
  effort = 'medium',
  thinking = false,
  allowTruncation = false,
  tenantId = null,
  site = null,
  signal = null,
  ...unknown
}) {
  // Same reasoning as anthropic.generate's guard: a silently-ignored key is how
  // maxOutputTokens or abortSignal vanishes in a mechanical port, taking a call
  // site's output budget or its only wall-clock bound with it.
  const stray = Object.keys(unknown);
  if (stray.length) {
    throw new Error(
      `aiCall.generateStructured: unknown option(s) ${stray.join(', ')}. ` +
      'Gemini spellings differ: maxOutputTokens→maxTokens, abortSignal→signal.'
    );
  }
  if (!task) throw new Error('aiCall.generateStructured: task required');
  if (!prompt) throw new Error('aiCall.generateStructured: prompt required');

  const { provider, model } = models.resolve(task);
  const label = site || `ai.${task}`;

  if (provider === 'anthropic') {
    if (temperature != null) {
      warnOnce(`temp:${task}`,
        `[aiCall] task "${task}" sets temperature ${temperature}, which Claude does not accept — ` +
        'dropping it. There is no substitute on the LITE tier (claude-haiku-4-5 rejects `effort`), ' +
        'so determinism has to come from the prompt (ADR-0006 §7).'
      );
    }
    // Cost is recorded inside generate(), against the SERVING model — with
    // server-side fallbacks that can differ from the one we asked for.
    const r = await anthropic.generate({
      model, prompt, system, schema: responseSchema, maxTokens, effort, thinking,
      allowTruncation, tenantId, site: label, signal,
    });
    return {
      text: r.text,
      parsed: responseSchema ? JSON.parse(r.text) : null,
      usage: r.usage,
      model: r.model,
      provider,
    };
  }

  const ai = gemini.getClient();
  const config = {
    maxOutputTokens: maxTokens,
    thinkingConfig: { thinkingBudget: thinking ? -1 : 0 },
  };
  if (temperature != null) config.temperature = temperature;
  if (responseSchema) {
    config.responseMimeType = 'application/json';
    config.responseSchema = responseSchema;
  }
  if (system) config.systemInstruction = system;
  if (signal) config.abortSignal = signal;

  const resp = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config,
  });
  costs.recordGemini(tenantId, label, model, resp.usageMetadata);
  return {
    text: resp.text,
    parsed: responseSchema ? JSON.parse(resp.text) : null,
    usage: resp.usageMetadata || null,
    model,
    provider,
  };
}

module.exports = { generateStructured };
