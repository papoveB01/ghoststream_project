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
// THIS MODULE CAN NOW MOVE REAL TRAFFIC. Seven tasks are in
// models.DISPATCH_READY (ADR-0006 §9 item 5) and their call sites dispatch
// through here — relevance, preview and companyBrief in group 1, keypoints,
// assessment and battlecard in group 2, research in group 3 — so
// AI_PROVIDER_RELEVANCE=anthropic
// routes BOTH relevance call sites into the anthropic branch below:
// checkDocRelevance, reached from knowledge/service.js on every competitor
// document, and checkOfferingPlausibility, a product-name plausibility check
// with no document at all, reached from portfolio.js:763 and never from ingest.
// The older shorthand here — "every competitor-document ingest" — named only the
// first of those two and quietly scoped the second out of view.
//
// Group 2 adds five more call sites of its own, and one of them is the first to
// reach this seam from a SYNCHRONOUS, rep-facing route: extractBattlecard, behind
// POST /portfolio/competitors/:id/battlecard/regenerate. It is deliberately not
// wrapped in aiRetry — the seam does not retry, and its caller decided not to —
// so a failure here becomes a 502 at once rather than after two backoffs.
//
// Group 3 adds ONE more, and it is the first where the caller's retry decision
// has to answer to TWO routes at once: knowledge/research.js's analyze() is
// reached from a fire-and-forget 202 AND from a synchronous rep-facing
// reanalyze behind nginx's 180s window, under one aiRetry label. The decision
// and the live latency numbers it rests on are at that call site. Nothing about
// it is visible here — this seam still makes exactly one request per
// invocation — which is the point: retry belongs to the caller, and what the
// caller has to fit is its tightest route.
//
// TWO env gates, not one: the shorthand "one env var away" is true only while
// ANTHROPIC_API_KEY happens to be set, because providerFor() falls back to
// Gemini and warns without it. And membership is eligibility, not
// activation — the default is still Gemini for every task. But "reached only by
// tests" stopped being true when group 1 landed. anthropic.js's header states
// both gates in full; keep this paragraph in step with it.
//
// WHAT THE TWO PROVIDERS DO NOT SHARE, and how that is resolved here:
//
//   temperature   Both take it, on the models that take it. It is forwarded to
//                 BOTH branches; anthropic.generate decides per model, because
//                 the model id is what the answer depends on and that file owns
//                 the other per-model capability lists (NO_EFFORT,
//                 NO_ADAPTIVE_THINKING). Live-probed 2026-08-06:
//                 claude-haiku-4-5 — the LITE tier serving all three group-1
//                 tasks and group 2's `assessment` — returns 200 with
//                 temperature 0.1, while Opus 5 / Sonnet 5 / Opus 4.8 / Opus 4.7
//                 / Fable 5 return 400. The seam dropping it unconditionally was
//                 therefore a real determinism loss on exactly the tier being
//                 migrated, on a judge whose confidence is thresholded at 0.4.
//                 Group 2's other two keys (`keypoints`, `battlecard`) resolve
//                 to Sonnet 5, where it IS dropped — with anthropic.js's
//                 once-per-model+site warning, not silently, which is the
//                 difference that matters.
//   effort        Claude only. Validated here against anthropic.js's own set so
//                 a bad value fails at the seam on either provider rather than
//                 passing silently on Gemini and 400ing after the flip — see
//                 the parameter block below for the thinking interlock.
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

// EVERY error this module raises itself is stamped, for the same reason
// anthropic.js stamps its own argument-validation throws. An UNSTAMPED error
// reaches aiRetry.classify() with no `provider` and falls into the Gemini
// branch, which decides transience by scraping the message. Two consequences,
// both reproduced on this seam:
//
//   - relevance.js logged `failed on gemini` for a Claude-side failure, on a
//     fail-open guard whose failures are already invisible in the product —
//     triage sent to the wrong provider is worse than no line at all.
//   - a message containing 503 / UNAVAILABLE / overloaded came back transient
//     and bought three attempts at a deterministic failure. That is the exact
//     leak the Anthropic stamp exists to close, reopened one layer up.
// Guarded, not unconditional. An error that ALREADY carries a provider was
// stamped by the module that raised it — anthropic.js sets `sdkRetried: true`
// on the statuses its client really did retry (429/5xx/connection), and
// classify() reads that to stop the app layer stacking a second set of attempts
// on top. Overwriting it here would reset that true to false and reinstate the
// 9-upstream-requests-for-one-call stacking aiRetry.js exists to remove. Only
// unattributed errors get this module's stamp.
function stamp(err, provider) {
  if (err.provider) return err;
  err.provider = provider;
  // Truthful, and READ: classify() only lets the app layer stand down when the
  // client already retried. Nothing this module raises itself went through an
  // SDK retry loop — the parse happens after the response arrived, the
  // validation before the request was built.
  err.sdkRetried = false;
  return err;
}

// JSON.parse of a model answer, attributed to the model that produced it.
// V8's SyntaxError message QUOTES THE FIRST TEN CHARACTERS of the input, so an
// unstamped Claude answer opening "overloaded…" — measured, not hypothetical —
// arrives at classify() as `Unexpected token 'o', "overloaded"...`, matches
// Gemini's transient regex and is retried three times.
//
// GEMINI'S CLASSIFICATION IS UNCHANGED BY THE STAMP (its branch scrapes either
// way) BUT ITS COST IS NOT, and the earlier version of this comment claimed
// otherwise. relevance.js now runs the parse INSIDE withRetry, so a Gemini
// answer whose first ten characters match GEMINI_TRANSIENT_RE — V8 quotes
// exactly ten, so `overloaded…` matches and `The model is overloaded.` does not
// — costs three metered generations instead of one. That is the price of
// keeping a regenerate able to fix malformed JSON on the provider that serves
// every task today; it is a trade, not a no-op.
//
// A VALID-JSON NON-OBJECT IS REJECTED HERE, not passed through. `[]`, `5`,
// `"hi"` and `true` all parse, and every schema in this repo describes an
// object — so a non-object answer reaching a caller reads as a fully-populated
// verdict with every field undefined. On relevance that is not a crash but an
// inversion: `parsed.isOnTopic === true` is false and `Number(undefined) || 0`
// is 0, so checkDocRelevance returns { isOnTopic: false, confidence: 0 } and
// QUARANTINES A LEGITIMATE DOCUMENT with no log line at all. `null` was worse
// still — an unstamped TypeError, logged as `failed on unknown`, sending triage
// after a missing stamp that was never missing.
function parseAnswer(text, provider) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw stamp(err, provider);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw stamp(
      new Error(
        `aiCall: ${provider} returned valid JSON that is not an object ` +
        // `typeof null === 'object'`, so the obvious spelling of this line
        // printed "is not an object (object)" for the one input the sentence is
        // most about — self-contradictory, on the string that is the entire
        // signal this branch produces.
        `(${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}) — ` +
        'every schema in this repo describes an object, so this cannot be read as a verdict.'
      ),
      provider
    );
  }
  return parsed;
}

// The seam's own pre-dispatch throws. `provider` is 'aiCall' rather than a
// vendor name because NO PROVIDER HAS BEEN RESOLVED YET — models.resolve() has
// not run, and cannot when `task` is the thing that is missing. Naming Gemini
// or Claude here would be a guess that reads as fact in a log line; leaving it
// blank would hand the error to the message-scraping branch, and the
// unknown-option message interpolates CALLER-SUPPLIED key names, so a
// mechanical port passing `{ deadlineExceeded: … }` would be retried three
// times over a caller bug. classify() treats 'aiCall' as never transient.
function seamError(msg) {
  return stamp(new Error(msg), 'aiCall');
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
//   temperature forwarded to both providers; the Claude wrapper drops it on the
//               models that 400 on it. See the header
//   effort      CLAUDE ONLY, and silently ignored on Gemini — validated here
//               anyway. THE INTERLOCK: this seam defaults `thinking: false`,
//               and anthropic.generate rejects thinking:false above effort
//               'high' on claude-opus-5. So a future PRO cutover written as
//               `effort: 'xhigh'` works perfectly on Gemini (ignored) and
//               throws on EVERY Claude call the moment the env var flips.
//               Validating the vocabulary here at least makes a typo fail the
//               same way on both providers; the thinking interlock is
//               anthropic.js's to enforce, and it does
//   signal      abort semantics DIFFER BY BRANCH, verified in @google/genai:
//               Claude rejects an already-aborted signal immediately, Google
//               IGNORES it and sends the request anyway. And Google's own
//               docstring says aborting does not cancel server-side work and
//               you are still billed for it — while costs.recordGemini below
//               sits AFTER the await, so an aborted Gemini call spends money
//               this meter never sees. missions/brief.js already passes an
//               abortSignal, so this is live, not hypothetical
//   site        the cost-telemetry label, e.g. 'kb.relevanceDoc'
//
// Returns { text, parsed, usage, model, provider }. `parsed` is the JSON.parse
// of `text` when a schema was given, and parsing is the CALLER'S error to
// handle if it throws — the same as before this seam existed, except that the
// error now carries the provider that produced the unparseable answer (see
// parseAnswer).
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
} = {}) {   // `= {}` so a bare generateStructured() throws the stamped "task required" below, not an unstamped destructuring TypeError
  // Same reasoning as anthropic.generate's guard: a silently-ignored key is how
  // maxOutputTokens or abortSignal vanishes in a mechanical port, taking a call
  // site's output budget or its only wall-clock bound with it.
  const stray = Object.keys(unknown);
  if (stray.length) {
    throw seamError(
      `aiCall.generateStructured: unknown option(s) ${stray.join(', ')}. ` +
      'Gemini spellings differ: maxOutputTokens→maxTokens, abortSignal→signal.'
    );
  }
  if (!task) throw seamError('aiCall.generateStructured: task required');
  if (!prompt) throw seamError('aiCall.generateStructured: prompt required');
  // Rejected at the seam rather than at the wrapper, because the wrapper is
  // only reached on the Claude branch: an unknown effort on a Gemini-serving
  // task would otherwise be a silent no-op right up until the flip, which is
  // the worst possible moment to discover a typo.
  if (!anthropic.EFFORTS.has(effort)) {
    throw seamError(
      `aiCall.generateStructured: unknown effort "${effort}" for task "${task}" — ` +
      `one of ${[...anthropic.EFFORTS].join(', ')}. Gemini ignores this parameter, so an ` +
      'invalid value would sit unnoticed until the task is flipped to Claude.'
    );
  }

  const { provider, model } = models.resolve(task);
  const label = site || `ai.${task}`;

  if (provider === 'anthropic') {
    // Cost is recorded inside generate(), against the SERVING model — with
    // server-side fallbacks that can differ from the one we asked for.
    // temperature goes THROUGH: the wrapper drops it per model (NO_TEMPERATURE
    // there), which keeps it on claude-haiku-4-5 — the tier every group-1 task
    // and group 2's `assessment` resolve to, and the one that accepts it — and
    // drops it, loudly, on the claude-sonnet-5 that `keypoints` and `battlecard`
    // resolve to.
    const r = await anthropic.generate({
      model, prompt, system, schema: responseSchema, maxTokens, effort, thinking,
      temperature, allowTruncation, tenantId, site: label, signal,
    });
    return {
      text: r.text,
      parsed: responseSchema ? parseAnswer(r.text, provider) : null,
      usage: r.usage,
      model: r.model,
      provider,
    };
  }

  // `effort` has no Gemini equivalent and is dropped here. Said once per task,
  // because a capability disappearing quietly is the same class of bug the
  // temperature drop was — and a task tuned to 'max' on Claude that is rolled
  // back to Gemini would otherwise regress in silence.
  if (effort !== 'medium') {
    warnOnce(`effort:${task}`,
      `[aiCall] task "${task}" asks for effort "${effort}", which Gemini has no equivalent for — ` +
      'ignoring it. It takes effect only when this task resolves to anthropic.'
    );
  }

  // getClient() throws "GEMINI_API_KEY is not set" with no stamp of its own, so
  // it reached classify() as an unattributed error and was routed by scraping
  // its message — falsifying this file's own "every error is attributable"
  // invariant. Reachable today, not hypothetical: providerFor() only key-checks
  // NON-DEFAULT providers, so a process missing GEMINI_API_KEY resolves happily
  // to gemini and fails here.
  let ai;
  try {
    ai = gemini.getClient();
  } catch (err) {
    throw stamp(err, provider);
  }
  // SEMANTICALLY identical to the four call sites this replaced, not
  // byte-identical — the earlier wording overclaimed and someone will diff this
  // eventually. The keys are assembled in a different ORDER here (maxOutputTokens
  // and thinkingConfig first; temperature, the schema pair, systemInstruction and
  // abortSignal appended as they apply), where the originals interleaved them
  // per call site. Same keys, same values, and object key order is not
  // significant to @google/genai or to the JSON body it serialises — so there is
  // no behaviour difference to go looking for, and no discrepancy to re-derive.
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
    parsed: responseSchema ? parseAnswer(resp.text, provider) : null,
    usage: resp.usageMetadata || null,
    model,
    provider,
  };
}

// stamp is exported for tests, for the same reason anthropic.js exports
// refusalError: nothing that reaches generateStructured's callers exercises the
// already-stamped branch today (an error from anthropic.generate propagates
// without passing through here), so the guard that keeps a future wrapper from
// resetting `sdkRetried: true` would otherwise be untestable — and therefore
// silently removable.
module.exports = { generateStructured, stamp };
