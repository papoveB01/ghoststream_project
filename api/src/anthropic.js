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
//
// Retries and timeouts are the SDK's, configured once here. We do NOT wrap this
// in another retry helper: the SDK already retries 408/409/429/5xx with
// backoff, and stacking the repo's hand-rolled withRetry on top would compound
// the delay (worst case timeout x (retries+1) x outer attempts).

const Anthropic = require('@anthropic-ai/sdk');
const costs = require('./costs');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT_MS || '120000', 10);
const DEFAULT_MAX_RETRIES = parseInt(process.env.ANTHROPIC_MAX_RETRIES || '2', 10);

// Above roughly this budget the SDK refuses a non-streaming request (an idle
// connection would outlive the HTTP timeout), so we stream and reassemble.
const STREAM_THRESHOLD_TOKENS = 16000;

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
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
const LEGACY_REQUEST_SURFACE = [
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-3-',        // every 3.x
];

function isLegacySurface(model) {
  const m = String(model || '').toLowerCase();
  return LEGACY_REQUEST_SURFACE.some((prefix) => m.includes(prefix));
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
  thinking = true,
  cacheSystem = false,
  tenantId = null,
  site = 'anthropic.generate',
  signal = null,
}) {
  if (!model) throw new Error('anthropic.generate: model required');
  if (!prompt) throw new Error('anthropic.generate: prompt required');
  if (!EFFORTS.has(effort)) throw new Error(`anthropic.generate: unknown effort "${effort}"`);
  if (!thinking && !THINKING_DISABLED_MAX_EFFORT.has(effort)) {
    // Caught here rather than as a 400 from the API, because the caller cannot
    // see the constraint and the message would not say which knob to move.
    throw new Error(
      `anthropic.generate: thinking:false is only allowed at effort <= high (got "${effort}") — ` +
      'lower the effort or leave thinking on'
    );
  }

  // Legacy-surface models take neither `thinking` nor `effort`; they simply run
  // without them. Structured output works on both surfaces.
  const legacy = isLegacySurface(model);
  const outputConfig = {};
  if (!legacy) outputConfig.effort = effort;
  if (schema) outputConfig.format = { type: 'json_schema', schema };

  const params = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (!legacy) params.thinking = thinking ? { type: 'adaptive' } : { type: 'disabled' };
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
  const opts = signal ? { signal } : undefined;

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
  // what we could use.
  costs.recordClaude(tenantId, site, model, message.usage);

  if (message.stop_reason === 'refusal') throw refusalError(message);

  return {
    text: textFrom(message),
    usage: message.usage || null,
    stopReason: message.stop_reason || null,
    model: message.model || model,
  };
}

module.exports = { getClient, isConfigured, generate, textFrom, translateError };
