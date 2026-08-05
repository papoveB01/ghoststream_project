// Anthropic client wrapper — the Claude half of the ADR-0006 provider migration.
//
// NOTHING CALLS THIS YET. It lands ahead of the cutover so that when a task is
// flipped (ADR-0006 §4.5, one env var at a time) the only change is the router
// entry, not a new integration written under time pressure.
//
// It deliberately mirrors gemini.js's shape — a lazy singleton client plus one
// generate() — so migrating a call site is a swap, not a rewrite. What it does
// NOT mirror is gemini.js's cache layer: Claude's caching is a per-request
// `cache_control` breakpoint, not a named server resource with its own
// lifecycle, so there is no registry, no skip flags and nothing to invalidate.
// Pass `cacheSystem: true` and the system prompt becomes the cached prefix.
//
// Three Claude behaviours this wrapper exists to absorb, because getting any of
// them wrong is a production incident rather than a bad number:
//
//   1. A refusal is HTTP 200. Safety classifiers can decline a request and the
//      call still succeeds with `stop_reason: 'refusal'` and empty or partial
//      content. Code that reads content[0] unconditionally breaks. Competitor
//      intelligence on a security vendor is plausibly close enough to trip it,
//      so this is a real path, not a theoretical one. generate() surfaces it as
//      a typed error instead of returning a silently empty string.
//   2. `max_tokens` bounds thinking AND response text together. A budget sized
//      around the answer alone truncates mid-response once thinking is on.
//   3. Disabling thinking is only legal at effort <= 'high'; pairing it with
//      'xhigh'/'max' is a 400. Rather than pass that through to a caller who
//      cannot see it, we reject the combination here with a message that says
//      what to change.
//   4. Every `responseSchema` in this repo is written in Gemini's dialect and
//      is rejected (or worse, silently reinterpreted) by Anthropic's strict
//      validator. schemaCompat translates it on the way out — see that module
//      for the two specific incompatibilities and why one of them is silent.
//
// Retries and timeouts are the SDK's, configured once here. We do NOT wrap this
// in another retry helper: the SDK already retries 408/409/429/5xx with
// backoff, and stacking the repo's hand-rolled withRetry on top would compound
// the delay (worst case timeout x (retries+1) x outer attempts).

const Anthropic = require('@anthropic-ai/sdk');
const costs = require('./costs');
const { toAnthropicSchema } = require('./schemaCompat');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT_MS || '120000', 10);
const DEFAULT_MAX_RETRIES = parseInt(process.env.ANTHROPIC_MAX_RETRIES || '2', 10);

// Above roughly this budget the SDK refuses a non-streaming request (an idle
// connection would outlive the HTTP timeout), so we stream and reassemble.
const STREAM_THRESHOLD_TOKENS = 16000;

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// "thinking disabled is only legal at effort <= high" is an OPUS 5 rule, not a
// general one — Sonnet 5 accepts disabled at any effort (live-verified). Scoping
// it per-model matters more now that thinking defaults to off: a global rule
// would reject every xhigh/max request on the default path.
const THINKING_DISABLED_EFFORT_CAPPED = ['claude-opus-5'];
const THINKING_DISABLED_MAX_EFFORT = new Set(['low', 'medium', 'high']);

// NOT every Claude model takes the 4.6-and-later request surface, and sending a
// parameter a model does not know is a 400, not a silent ignore. Verified
// against the live API on 2026-08-05 with claude-haiku-4-5:
//
//   thinking: {type:'adaptive'}   → 400 "adaptive thinking is not supported on this model"
//   output_config: {effort:'low'} → 400 "This model does not support the effort parameter."
//   output_config: {format:...}   → OK
//
// Haiku 4.5 is our whole LITE tier (relevance, preview, companyBrief,
// callEntities, assessment), so without this every one of those tasks would
// 400 on the first provider flip — green in CI, green on deploy, broken for
// every tenant on the first real request. Structured output is unaffected.
//
// Default is "modern" so a newly released model works without a code change;
// the exceptions are the models that predate the 4.6 surface.
// THINKING AND EFFORT ARE SEPARATE AXES. claude-opus-4-5 is the case that
// proves it: it accepts `effort` and rejects adaptive thinking, so one boolean
// has no correct setting for it. Live-probed 2026-08-05:
//
//   opus-4-5  + adaptive thinking  → 400 "adaptive thinking is not supported…"
//   opus-4-5  + effort only        → OK
//   opus-4-6  + effort 'xhigh'     → 400 "does not support effort level 'xhigh'"
//
// All three are reachable today by setting ANTHROPIC_MODEL_PRO — exactly the
// knob ADR-0006 §4.5 tells an operator to turn.
const NO_ADAPTIVE_THINKING = [
  'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-0',
  'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-3-',
];
const NO_EFFORT = [
  'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-0',
  'claude-opus-4-1', 'claude-opus-4-0', 'claude-3-',
];
// `xhigh` arrived with Opus 4.7; older effort-capable models cap at max/high.
const NO_XHIGH = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5'];

const matches = (model, list) => {
  const m = String(model || '').toLowerCase();
  return list.some((prefix) => m.includes(prefix));
};
const supportsAdaptiveThinking = (model) => !matches(model, NO_ADAPTIVE_THINKING);
const supportsEffort = (model) => !matches(model, NO_EFFORT);

// Clamp rather than 400: an unsupported effort level is a capability gap, not a
// caller mistake, and downgrading one notch is always safe.
function effortFor(model, effort) {
  if (!supportsEffort(model)) return null;
  if (effort === 'xhigh' && matches(model, NO_XHIGH)) return 'high';
  return effort;
}

let _client;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({
    apiKey,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  });
  return _client;
}

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// A message's content is a list of blocks (thinking, text, tool_use, ...).
// Join the text ones; everything else is not part of the answer.
function textFrom(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

// A declined request is a successful HTTP call, so it has to be turned into
// something a caller cannot ignore by accident. Shaped like the errors the rest
// of the codebase throws (`status` for the route layer to map).
function refusalError(message) {
  const details = message.stop_details || {};
  const err = new Error(
    `Claude declined this request${details.category ? ` (${details.category})` : ''}` +
    `${details.explanation ? `: ${details.explanation}` : ''}`
  );
  err.status = 422;
  err.refusal = true;
  err.category = details.category || null;
  return err;
}

// Translate the SDK's typed exceptions into the same shape gemini.js's
// translateGeminiError produces, so route handlers keep one error contract
// across providers during the migration.
function translateError(err) {
  if (err instanceof Anthropic.RateLimitError) {
    const e = new Error('AI quota exhausted — retry shortly.');
    e.status = 429; e.cause = err; return e;
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    const e = new Error('AI provider rejected our credentials.');
    e.status = 502; e.cause = err; return e;
  }
  // Checked before APIError: a caller-side abort extends APIError, not
  // APIConnectionError, so the catch-all below would report our own 60s timeout
  // as "AI provider error" — which is what an on-call engineer would then go
  // and investigate at the provider.
  if (err instanceof Anthropic.APIUserAbortError) {
    const e = new Error('AI request cancelled or timed out locally.');
    e.status = 504; e.aborted = true; e.cause = err; return e;
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const e = new Error('AI request timed out.');
    e.status = 504; e.cause = err; return e;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    const e = new Error('Could not reach the AI provider.');
    e.status = 502; e.cause = err; return e;
  }
  if (err instanceof Anthropic.APIError) {
    // Keep the provider's own message. The first version of this function threw
    // away a 400 body that said exactly which parameter was wrong, which turned
    // a one-line fix into a debugging session — and would have done the same to
    // whoever was on call.
    const detail = (err.error && err.error.error && err.error.error.message) || err.message || '';
    const e = new Error(`AI provider error (${err.status || '?'})${detail ? `: ${detail}` : ''}`);
    e.status = err.status && err.status < 500 ? 400 : 502;
    e.cause = err;
    return e;
  }
  return err;
}

// One generation.
//
//   model      : a Claude model id (from models.resolve(task).model)
//   prompt     : the user turn
//   system     : optional system prompt; cached when cacheSystem is set
//   schema     : optional JSON Schema — sets structured output
//   maxTokens  : REQUIRED by the API. Remember it bounds thinking + text.
//   effort     : low | medium | high | xhigh | max
//   thinking   : true (adaptive, default) | false (disabled; effort must be <= high)
//   tenantId/site : spend telemetry, same contract as the Gemini call sites
//
// Returns { text, usage, stopReason, model }. Throws on refusal so an empty
// answer can never be mistaken for a real one.
async function generate({
  model,
  prompt,
  system = null,
  schema = null,
  maxTokens = 4096,
  effort = 'medium',
  // Default OFF, deliberately. Every Gemini call site this replaces sets
  // `thinkingConfig: { thinkingBudget: 0 }` and sizes maxOutputTokens for the
  // answer alone. Defaulting thinking on would flip that during a mechanical
  // swap AND eat the answer budget — measured at ~39% of a 700-token budget on
  // one prompt — producing a shorter answer with no signal. Turning thinking on
  // is a per-task decision made when that task is migrated, not a side effect
  // of the swap.
  thinking = false,
  cacheSystem = false,
  allowTruncation = false,
  tenantId = null,
  site = 'anthropic.generate',
  signal = null,
  ...unknown
}) {
  // Silently ignoring an unknown key is how `abortSignal` (the Gemini spelling
  // of `signal`) or `maxOutputTokens` (of `maxTokens`) would vanish during a
  // mechanical port, taking a call site's only time bound or output budget with
  // it and leaving nothing to notice.
  const stray = Object.keys(unknown);
  if (stray.length) {
    throw new Error(
      `anthropic.generate: unknown option(s) ${stray.join(', ')}. ` +
      'Gemini spellings differ: abortSignal→signal, maxOutputTokens→maxTokens; ' +
      'temperature is not supported (it is a 400 on Opus 5 and Sonnet 5).'
    );
  }
  if (!model) throw new Error('anthropic.generate: model required');
  if (!prompt) throw new Error('anthropic.generate: prompt required');
  if (!EFFORTS.has(effort)) throw new Error(`anthropic.generate: unknown effort "${effort}"`);
  if (!thinking
      && matches(model, THINKING_DISABLED_EFFORT_CAPPED)
      && !THINKING_DISABLED_MAX_EFFORT.has(effort)) {
    // Caught here rather than as a 400 from the API, because the caller cannot
    // see the constraint and the message would not say which knob to move.
    throw new Error(
      `anthropic.generate: thinking:false is only allowed at effort <= high (got "${effort}") — ` +
      'lower the effort or leave thinking on'
    );
  }

  // Each capability is gated on its own axis. Structured output works on every
  // surface, so it is never gated.
  const resolvedEffort = effortFor(model, effort);
  const outputConfig = {};
  if (resolvedEffort) outputConfig.effort = resolvedEffort;
  // Translated, not passed through: a Gemini-dialect schema is a 400 here, and
  // the one form that is NOT a 400 (`nullable` on a non-object) is worse — the
  // validator ignores it and the model can never return null again.
  if (schema) outputConfig.format = { type: 'json_schema', schema: toAnthropicSchema(schema) };

  const params = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (supportsAdaptiveThinking(model)) {
    params.thinking = thinking ? { type: 'adaptive' } : { type: 'disabled' };
  } else if (thinking) {
    // Asked for thinking on a model that has no adaptive mode. Silently running
    // without it would be a quiet quality change, so say so once.
    console.warn(`[anthropic] ${model} has no adaptive thinking — running without it`);
  }
  if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
  // A cached system prompt has to be a block list — a plain string cannot carry
  // cache_control. Below the model's minimum cacheable prefix this silently
  // does nothing, which is why callers should verify against
  // usage.cache_read_input_tokens rather than assume a hit.
  if (system) {
    params.system = cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  // NOTE: no temperature. It is removed on Opus 5 (400) and non-default values
  // are rejected on Sonnet 5. Steer with the prompt, not with sampling.

  const client = getClient();
  // The SDK's `timeout` only bounds the fetch, which for a stream ends when
  // HEADERS arrive — so the streaming path has no wall-clock bound at all
  // without an explicit signal. That is precisely the hang scheduler.js
  // documents for gemini.js, and its withTimeout wrapper can only stop waiting,
  // not cancel the socket. Compose our own deadline with any caller signal.
  const deadline = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const opts = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline };

  let message;
  try {
    if (maxTokens > STREAM_THRESHOLD_TOKENS) {
      const stream = client.messages.stream(params, opts);
      message = await stream.finalMessage();
    } else {
      message = await client.messages.create(params, opts);
    }
  } catch (err) {
    throw translateError(err);
  }

  // Record before inspecting the outcome: a refused or truncated response still
  // consumed tokens, and the point of the meter is what we were billed, not
  // what we could use. Price against the SERVING model — with server-side
  // fallbacks it can differ from the one we asked for.
  costs.recordClaude(tenantId, site, message.model || model, message.usage);

  if (message.stop_reason === 'refusal') throw refusalError(message);

  // A truncated answer is the most dangerous success there is: the caller gets
  // a well-formed string that stops mid-sentence. On the brief path that lands
  // in the database as a finished brief; on a JSON path it surfaces one step
  // later as a parse error that reads like a model problem rather than a budget
  // one. Fail loudly unless the caller has said it can cope.
  if (message.stop_reason === 'max_tokens' && !allowTruncation) {
    const err = new Error(
      `Claude hit the ${maxTokens}-token output budget and the answer is incomplete. ` +
      'Raise maxTokens, or pass allowTruncation to accept a partial answer. ' +
      'Note the budget covers thinking as well as text.'
    );
    err.status = 502;
    err.truncated = true;
    throw err;
  }

  return {
    text: textFrom(message),
    usage: message.usage || null,
    stopReason: message.stop_reason || null,
    model: message.model || model,
  };
}

module.exports = { getClient, isConfigured, generate, textFrom, translateError };
