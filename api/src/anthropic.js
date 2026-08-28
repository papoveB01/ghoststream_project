// Anthropic client wrapper — the Claude half of the ADR-0006 provider migration.
//
// THIS MODULE CAN NOW MOVE REAL TRAFFIC. Seven tasks are in models.DISPATCH_READY
// (ADR-0006 §9 item 5) and every one of their call sites dispatches through
// aiCall.js, so AI_PROVIDER_RELEVANCE=anthropic routes BOTH relevance call sites
// into this file — checkDocRelevance, on every competitor document, and
// checkOfferingPlausibility, a product-name plausibility check with no document
// at all. That is an environment change, not a code change.
//
//   group 1  relevance, preview, companyBrief
//   group 2  keypoints, assessment, battlecard
//   group 3  research (the `ocr` half of that group is deferred to its own
//            decision PR — see models.js)
//
//            TEN seam call sites in total now — four in group 1, five in group
//            2, one in group 3. Count the generateStructured calls, not the
//            functions holding them: knowledge/keypoints.js is one key over
//            three of them, and knowledge/research.js is one key over one.
//
//            THREE OF THE SEVEN LAND ON claude-sonnet-5, which is in
//            NO_TEMPERATURE below — the group-2 pair `keypoints` and
//            `battlecard` by way of an anthropicTier override, and group 3's
//            `research` because tier `flash` already resolves there on both
//            providers. The other four are claude-haiku-4-5. All three still
//            pass temperature (0.3), so a flip drops it here with the warning
//            rather than 400ing — which is the whole reason that list is
//            per-model and lives in this file. (This said FOUR and then listed
//            three, one line under the guarded "TEN seam call sites" number and
//            just outside its regex. The count is now COMPUTED from
//            models.TASKS in costsTelemetry.test.js rather than scraped, so it
//            cannot disagree with the router again.)
//
// TWO env gates, not one — the shorthand "one env var away" is true only while
// the key happens to be set. providerFor() falls back to Gemini and warns unless
// ANTHROPIC_API_KEY is set too, so the provider var is necessary and not
// sufficient; models.js states both gates on DISPATCH_READY itself. And
// membership in that set is eligibility, not activation. Read the membership
// and the environment together rather than separately: "reached only by tests"
// stopped being true when group 1 landed, and what stands between this file and
// production traffic is environment, not another PR.
//
// ENVIRONMENT SNAPSHOT — a fact about the deploy on 2026-08-07, not a property
// of this file, and it can go false with no commit, no diff and no review. On
// that date both ghost-api and dsp-api ran AI_PROVIDER=gemini with every
// AI_PROVIDER_<TASK> empty, while both already carried an ANTHROPIC_API_KEY: so
// the key gate was already satisfied and only the provider vars held. Check it
// (`printenv | grep -E 'AI_PROVIDER|ANTHROPIC_API_KEY'` in the container — both
// gates, since the key half is the one this paragraph just made load-bearing)
// rather than trusting this line.
//
// It is loaded by every process either way: index.js → knowledge/index.js →
// knowledge/globalCache.js → aiContext.js → here, with arena.js →
// knowledge/globalCache.js as a second route, and aiCall.js requires it too. It
// landed ahead of the cutover so that flipping a task (ADR-0006 §4.5, one env
// var at a time) changes a router entry, not a new integration written under
// time pressure.
//
// It deliberately mirrors gemini.js's shape — a lazy singleton client plus one
// generate() — so migrating a call site is a swap, not a rewrite. What it does
// NOT mirror is gemini.js's cache layer: Claude's caching is a per-request
// `cache_control` breakpoint, not a named server resource with its own
// lifecycle, so there is no registry, no skip flags and nothing to invalidate.
// Pass `cacheSystem: true` and the system prompt becomes the cached prefix.
//
// MULTI-TURN (added by ADR-0006 §9 item 4). `messages` takes a whole
// conversation where `prompt` takes one user turn. It exists because Arena
// replays its transcript on every turn, so a single-turn wrapper could not
// serve arena.js at all, cached or not — which is why the ADR makes this item a
// prerequisite for the Arena cutover rather than a detail of it.
//
// Multi-turn is NOT the agentic path. This still sends no `tools` and does not
// handle `pause_turn`; that belongs in a separate runWithTools() (ADR-0006
// §13), so the cheap path stays cheap to reason about.
//
// Four Claude behaviours this wrapper exists to absorb, because getting any of
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
//   5. `temperature` is model-gated, not absent. It 400s on the 4.7 generation
//      and later and is accepted on everything before it — including the whole
//      LITE tier. See NO_TEMPERATURE below; this file assumed the wrong half of
//      that and dropped it for every model.
//
// Retries and timeouts are the SDK's, configured once here. We do NOT wrap this
// in another retry helper. Three things about that, all measured 2026-08-05 —
// keep this in step with ADR-0006 §7, which carries the same findings.
//
//   1. THE SDK'S RETRIES ARE MOSTLY UNREACHABLE FROM HERE, which undercuts the
//      "the SDK already retries so we needn't" premise. DEFAULT_TIMEOUT_MS is
//      used BOTH as the SDK's per-attempt `timeout` and as the deadline signal
//      composed below, so on a hang the first attempt consumes the whole budget
//      and the retry never fires. Against a hanging server at timeout=3s,
//      maxRetries=2: bare SDK 10.5s / 3 attempts; with signal == timeout, 3.0s
//      / 1 attempt. Give the deadline headroom over the per-attempt timeout if
//      you want SDK retries on slow failures; today they only help fast ones.
//   2. A caller signal bounds the WHOLE sequence, not each attempt — the SDK
//      re-links it onto every attempt's controller and checks it before
//      deciding to retry. So `timeout × (max_retries + 1)` is the right worst
//      case for a BARE SDK call, but not through generate(). What is still
//      live is the OUTER multiplication: each withRetry iteration calls
//      generate() afresh, minting a new deadline — worst case
//      ANTHROPIC_TIMEOUT_MS × outer attempts = 360s at the 120s default
//      (~366s once the app layer's own 2s+4s sleeps are added).
//   3. STACKING SURVIVES EXACTLY WHERE IT IS LEAST WANTED, and 429 coverage is
//      silently lost. translateError() rewrites messages, so the call sites'
//      Gemini-shaped regexes see: 429 → no match (was 6/6 on the raw error),
//      timeouts/connection → no match, 503/529 → still 6/6, via the word
//      "Overloaded" in the preserved provider detail. Net effect of a cutover:
//      no app-level retry on the transient these helpers were written for, and
//      up to 9 attempts on the statuses Anthropic uses for overload. (500 is
//      NOT lost — the Gemini-shaped regexes never matched a 500 either.)
//
// WHERE ALL THREE LANDED:
//   - (1) is ACCEPTED, not fixed, and the accepting is deliberate. Slicing the
//     budget into per-attempt timeouts was tried and reverted — see the comment
//     on DEFAULT_TIMEOUT_MS below for the measurement that killed it. The SDK's
//     own retries fire on FAST failures only; a slow generation gets the whole
//     budget rather than being killed to make room for a retry of itself.
//   - (2) is NARROWED by (3), not eliminated, and this line used to overclaim.
//     "The app layer no longer re-enters generate() on ANY Anthropic error, so
//     there is no outer multiplication left to bound" is false in two measured
//     cases, both of which turn on `sdkRetried` being honestly false:
//       • ANTHROPIC_MAX_RETRIES=0 — SDK_RETRIES_AT_ALL below makes every stamp
//         false, so aiRetry classifies a 429 transient and an app-level wrapper
//         re-enters generate() up to `tries` times. Measured: unset ⇒ 1 upstream
//         attempt, =0 ⇒ 3. That is the correct behaviour (the retry has to live
//         SOMEWHERE), but it is outer multiplication, and it multiplies the
//         per-attempt bound below rather than a 120s constant.
//       • a 429 carrying `x-should-retry: false`, at DEFAULT settings —
//         sdkRetriesStatus subtracts it from the SDK's retryable set, so it
//         reaches the app layer unretried and transient.
//     Callers on a wall-clock-bounded route must therefore size for
//     `tries × (ANTHROPIC_TIMEOUT_MS + maxRetries × retry-after)`, not for one
//     attempt. knowledge/research.js's analyze() carries the worked example.
//   - (3) is fixed in aiRetry.js, which reads the `provider`/`sdkRetried` stamp
//     translateError() puts on errors leaving here instead of regexing a message
//     we rewrote. Nothing the SDK already retried is retried again.

const Anthropic = require('@anthropic-ai/sdk');
const costs = require('./costs');
const { toAnthropicSchema } = require('./schemaCompat');

// A bad value used to propagate: `parseInt('none')` is NaN, and NaN reaching the
// SDK's validatePositiveInteger throws "timeout must be an integer" on EVERY
// request — a total outage of the Claude path from one typo in an env file.
// Fall back instead.
function envInt(name, fallback, min) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const DEFAULT_TIMEOUT_MS = envInt('ANTHROPIC_TIMEOUT_MS', 120000, 1);
const DEFAULT_MAX_RETRIES = envInt('ANTHROPIC_MAX_RETRIES', 2, 0);

// ANTHROPIC_TIMEOUT_MS is BOTH the SDK's per-attempt timeout and the whole-call
// deadline composed in generate(). That looks redundant and is not.
//
// The obvious-looking alternative — slice the budget so the SDK's own retries
// fit inside it (`timeout = budget / (maxRetries + 1)`) — shipped briefly and
// was reverted, because it rests on a false premise: that only a HANG consumes
// an attempt. A merely slow generation is retried on the SDK's connection-error
// branch exactly like a hung one, so slicing converts "slow" into "failed".
//
// Measured live 2026-08-05/06, claude-opus-5 @ max_tokens 3000 with adaptive
// thinking, same prompt both ways:
//
//   timeout = 120000 (this)      1 upstream POST,  47.3s, HTTP 200
//   timeout =  40000 (the slice) 3 upstream POSTs, abort at 120.0s
//
// Opus 5 generates ~63.7 output tok/s, so a 40s attempt ceiling is ~2,540
// output tokens — under proposals (3000), watch (6000), enrichment (8000) and
// assessment's larger call (2600), and close enough to its 2400 one to fail on
// ordinary variance. The slice bought reachable retries by making three billed
// generations of the same request the normal outcome of one slow one, and
// costs.recordClaude sits after the rethrow, so all three recorded $0.00.
//
// So: the SDK's retries fire on FAST failures (connection refused, a quick 5xx,
// a 429 with a short retry-after) and are unreachable on a slow one. That is the
// correct trade. A slow call keeps its full budget.
//
// WHAT THE DEADLINE DOES AND DOES NOT BOUND. It bounds a hang and a stalled
// stream — measured, 6.0s against a 6s budget and 8.0s against an 8s one. It
// does NOT bound a 429 carrying `retry-after`: the SDK's inter-retry sleep takes
// no signal (`client.js` calls `await sleep(ms)` with none) and it parses
// `retry-after` unclamped, so the deadline is only observed at the TOP of the
// next attempt. Measured: a 3s budget took 45.1s and a 5s budget 60.1s, one
// upstream request each. The real worst case is
// `ANTHROPIC_TIMEOUT_MS + maxRetries × retry-after`, unbounded above.
// scheduler.js's withTimeout is the only guard that actually caps that, which is
// one more reason ADR-0006 §7 says to keep it. A route with no such wrapper —
// POST /proposals/:companyId/generate is the live example — is bounded only by
// nginx's 180s proxy_read_timeout, and nginx timing out does not stop the
// handler. If Anthropic starts sending large retry-after values on a
// user-facing route, construct the client with maxRetries: 0 and own the 429
// retry at the app layer, where the sleep can be made interruptible.
const ATTEMPT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

// Above roughly this budget the SDK refuses a non-streaming request (an idle
// connection would outlive the HTTP timeout), so we stream and reassemble.
const STREAM_THRESHOLD_TOKENS = 16000;

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// A fifth cache_control block is a hard 400 ("A maximum of 4 blocks with
// cache_control may be provided. Found 5."), not a silent drop — verified live
// 2026-08-05, ADR-0006 §4.3. Counted here so the failure names the budget
// rather than arriving as a provider error from four frames deeper.
const MAX_CACHE_BREAKPOINTS = 4;

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

// TEMPERATURE IS A PER-MODEL CAPABILITY, NOT A CLAUDE-WIDE GAP — which is the
// opposite of what this file used to assert, and the difference is not cosmetic.
// It was removed in the 4.7 generation and later; everything before it still
// takes it. Live-probed 2026-08-06, `temperature: 0.1` on a 16-token request:
//
//   claude-haiku-4-5  200      claude-opus-4-6   200      claude-sonnet-4-6  200
//   claude-sonnet-5   400 "`temperature` is deprecated for this model."
//   claude-opus-5     400      claude-opus-4-8   400      claude-opus-4-7    400
//   claude-fable-5    400
//
// Haiku 4.5 is the whole LITE tier — relevance, preview, companyBrief,
// callEntities, assessment — so "Claude does not take temperature" was wrong
// about every task in group 1. Dropping it there is not a neutral loss: the
// relevance judge's `confidence` is compared against QUARANTINE_THRESHOLD 0.4,
// so a sampling wobble across that line quarantines a document on one ingest
// and passes the same document on a re-upload.
//
// THE LIST LIVES HERE, not at the seam, for the same reason NO_EFFORT and
// NO_ADAPTIVE_THINKING do: the thing that decides is the MODEL ID, and this is
// the only place a model id becomes request params. Keeping it at the seam
// would mean aiCall re-deriving a capability from a model it does not own, a
// second copy to drift, and no coverage for the direct callers of generate()
// (aiContext.js today) that never pass through the seam.
//
// claude-mythos-5 is listed unprobed — it is Project Glasswing-only, and the
// published surface is Fable 5's. Over-dropping on a model we cannot reach is
// the safe direction; sending a 400 on every call is not.
//
// WHAT RE-DERIVES THIS LIST, since nothing did and it is default-allow. Being
// over-broad here is caught by the suite (adding claude-haiku-4-5 fails two
// tests); being UNDER-broad was not — deleting 'claude-opus-4-7' left the whole
// suite green while making every request to that model a hard 400. So the list
// is now checked against a probe table that is deliberately not this list:
// test/live/temperature.js holds what the live API answered per model and
// re-derives it against the real thing (spends money, out of `npm test`), and
// test/anthropicSurface.test.js asserts for free in CI that supportsTemperature()
// still agrees with that table — and that every model models.TIERS can resolve
// to appears in it, so a new tier default cannot ship unclassified.
const NO_TEMPERATURE = [
  'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5',
  'claude-opus-4-8', 'claude-opus-4-7',
];

const matches = (model, list) => {
  const m = String(model || '').toLowerCase();
  return list.some((prefix) => m.includes(prefix));
};
const supportsAdaptiveThinking = (model) => !matches(model, NO_ADAPTIVE_THINKING);
const supportsEffort = (model) => !matches(model, NO_EFFORT);
const supportsTemperature = (model) => !matches(model, NO_TEMPERATURE);

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
  if (!apiKey) throw stamp(new Error('ANTHROPIC_API_KEY is not set'), null, false);
  _client = new Anthropic({
    apiKey,
    timeout: ATTEMPT_TIMEOUT_MS,
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

// Normalize a caller's conversation into the `messages` array the API wants.
//
// Content may be a plain string or a block list — the block list is how a
// cache_control breakpoint is expressed, so it cannot be flattened away.
//
// CONSECUTIVE SAME-ROLE MESSAGES ARE MERGED. This is defensive, not a claim
// about what the API accepts: the seam that feeds this concatenates a stable
// prefix with a live transcript, and whether the join lands user-on-user
// depends on how a persona seed happens to end. Merging makes that a non-event
// instead of a 400 that only appears for some personas.
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw argError('anthropic.generate: messages must be a non-empty array');
  }
  const out = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw argError(
        `anthropic.generate: message role must be "user" or "assistant" (got ${JSON.stringify(m && m.role)}). ` +
        'There is no "system" or "model" role here — the system prompt is its own parameter, ' +
        'and Gemini\'s "model" role is spelled "assistant".'
      );
    }
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
      throw argError('anthropic.generate: message content must be a string or a block array');
    }
    if (typeof m.content === 'string' && m.content.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      const asBlocks = (c) => (Array.isArray(c) ? c : [{ type: 'text', text: c }]);
      prev.content = (typeof prev.content === 'string' && typeof m.content === 'string')
        ? `${prev.content}\n\n${m.content}`
        : [...asBlocks(prev.content), ...asBlocks(m.content)];
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  if (out.length === 0) throw argError('anthropic.generate: messages contained no content');
  if (out[0].role !== 'user') {
    throw argError('anthropic.generate: the first message must be from the user');
  }
  return out;
}

function countBreakpoints(params) {
  let n = 0;
  const scan = (content) => {
    if (!Array.isArray(content)) return;
    for (const b of content) if (b && b.cache_control) n += 1;
  };
  scan(params.system);
  for (const m of params.messages) scan(m.content);
  return n;
}

// A prefix under the model's minimum cacheable size does not error — it returns
// HTTP 200 with cache_creation_input_tokens: 0 and no warning field of any kind
// (measured 2026-08-05; the minimums are 512 / 1,024 / 4,096 tokens and do NOT
// track tier order — Haiku 4.5's is the largest). So a request that asked to
// cache and cached nothing is invisible unless something says so. Once per
// model+site, because these run in loops — so callers that leave `site` on the
// default share one key and can silence each other.
const _cacheMissWarned = new Set();
function warnIfNothingCached(model, site, usage) {
  const u = usage || {};
  if ((u.cache_creation_input_tokens || 0) > 0 || (u.cache_read_input_tokens || 0) > 0) return;
  const key = `${model}:${site}`;
  if (_cacheMissWarned.has(key)) return;
  _cacheMissWarned.add(key);
  console.warn(
    `[anthropic] ${site} asked to cache a prefix on ${model} but nothing was cached ` +
    '(cache_creation and cache_read are both 0) — the prefix is most likely under this ' +
    "model's minimum cacheable size. Billing at full input rate on every call."
  );
}

// A determinism setting silently disappearing is the change nobody sees for
// three weeks and then reports as "the model got flakier". Once per model+site
// because these run in loops, same as the cache-miss warning above.
const _tempDropWarned = new Set();
function warnTemperatureDropped(model, site, temperature) {
  const key = `${model}:${site}`;
  if (_tempDropWarned.has(key)) return;
  _tempDropWarned.add(key);
  console.warn(
    `[anthropic] ${site} set temperature ${temperature}, which ${model} rejects with a 400 ` +
    '("`temperature` is deprecated for this model") — dropping it. Determinism has to come ' +
    'from the prompt on this model; models before the 4.7 generation (Haiku 4.5, Opus/Sonnet 4.6) ' +
    'still honour it. See NO_TEMPERATURE above and ADR-0006 §7.'
  );
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
  // Stamped like a translated error even though it never passes through
  // translateError: an unstamped error falls into aiRetry's GEMINI branch and
  // gets message-scraped. A refusal explanation is free-form provider prose, so
  // "…would leave the service unavailable" is one substring away from being
  // retried three times as a transient. It is deterministic; it must not be.
  return stamp(err, null, false);
}

// Translate the SDK's typed exceptions into the same shape gemini.js's
// translateGeminiError produces, so route handlers keep one error contract
// across providers during the migration.
// Every error leaving this module at RUNTIME is stamped with `provider` and
// `sdkRetried` — translated SDK errors, refusals, truncation and the missing-key
// error — so aiRetry.classify() has something structured to read instead of
// scraping a message we ourselves rewrote. That INCLUDES the
// `anthropic.generate: …` argument-validation throws. They were left plain at
// first on the reasoning that a literal message cannot match a transient
// regex — but they interpolate caller-supplied values, so `effort:
// '503 UNAVAILABLE'` and `role: 'overloaded'` both came back transient and
// bought three attempts at a deterministic throw. Only reachable from a code
// bug, but the cost of closing it is one helper.
// `provider` decides which branch classifies it;
// `sdkRetried` decides whether the app layer may try again, and IS READ —
// aiRetry.classify() consults it, which is why it has to be true per branch
// rather than blanket-true. The SDK retries 408/409/429/5xx and connection
// failures; it does NOT retry 401/403/other 4xx, and an abort we raised
// ourselves never entered its retry path at all. Claiming otherwise would deny
// an app-level retry to errors that never got one.
//
// It is also gated on the CONFIGURED retry count, and that is not pedantry:
// `ANTHROPIC_MAX_RETRIES=0` is a permitted value, and with a static per-class
// stamp it meant the wrapper announcing "the SDK already retried this" about a
// client that had just been told never to retry. The app layer then stood down
// too, so a deployment setting it to 0 silently lost 429 retry ENTIRELY rather
// than moving it up a layer. Measured: 1 upstream request, zero retries anywhere.
const SDK_RETRIES_AT_ALL = DEFAULT_MAX_RETRIES > 0;

function stamp(e, err, sdkRetried) {
  e.provider = 'anthropic';
  e.sdkRetried = sdkRetried === true && SDK_RETRIES_AT_ALL;
  if (err) e.cause = err;
  return e;
}

// Argument-validation failures, stamped like everything else that leaves here.
// A function declaration so it is hoisted above normalizeMessages, which throws
// several of these and runs before this point in the file.
function argError(msg) {
  return stamp(new Error(msg), null, false);
}

// The SDK's own retry predicate, mirrored for statuses it decided on. Kept
// narrow and explicit rather than inferred, so a divergence is visible here.
// `x-should-retry: false` is an explicit provider instruction NOT to retry, and
// the SDK honours it ahead of the status — so a 429 carrying it was never
// retried and must not be stamped as though it were.
function sdkRetriesStatus(status, headers) {
  try {
    if (headers && typeof headers.get === 'function' && headers.get('x-should-retry') === 'false') {
      return false;
    }
  } catch { /* a header bag that will not answer is not a reason to fail here */ }
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
}

function translateError(err) {
  if (err instanceof Anthropic.RateLimitError) {
    // Keep the provider detail. The 429 branch used to discard it, which made
    // aiRetry's per-day carve-out permanently dead on this path — it matches on
    // the message, and the message no longer said which quota was exhausted. A
    // daily cap would then be retried against an allowance that resets tomorrow,
    // the exact thing all six hand-rolled copies carried a carve-out to prevent.
    const detail = (err.error && err.error.error && err.error.error.message) || '';
    const e = new Error(`AI quota exhausted — retry shortly.${detail ? ` (${detail})` : ''}`);
    e.status = 429; return stamp(e, err, sdkRetriesStatus(429, err.headers));
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    const e = new Error('AI provider rejected our credentials.');
    e.status = 502; return stamp(e, err, false);
  }
  // Checked before APIError: a caller-side abort extends APIError, not
  // APIConnectionError, so the catch-all below would report our own 60s timeout
  // as "AI provider error" — which is what an on-call engineer would then go
  // and investigate at the provider.
  if (err instanceof Anthropic.APIUserAbortError) {
    // Our own deadline or the caller's signal. The SDK checks the signal before
    // deciding to retry, so this error never went through its retry path —
    // sdkRetried is false, and it is non-transient anyway: another attempt would
    // just spend a budget that has already run out.
    const e = new Error('AI request cancelled or timed out locally.');
    e.status = 504; e.aborted = true; return stamp(e, err, false);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const e = new Error('AI request timed out.');
    e.status = 504; return stamp(e, err, true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    const e = new Error('Could not reach the AI provider.');
    e.status = 502; return stamp(e, err, true);
  }
  if (err instanceof Anthropic.APIError) {
    // Keep the provider's own message. The first version of this function threw
    // away a 400 body that said exactly which parameter was wrong, which turned
    // a one-line fix into a debugging session — and would have done the same to
    // whoever was on call.
    const detail = (err.error && err.error.error && err.error.error.message) || err.message || '';
    const e = new Error(`AI provider error (${err.status || '?'})${detail ? `: ${detail}` : ''}`);
    e.status = err.status && err.status < 500 ? 400 : 502;
    return stamp(e, err, sdkRetriesStatus(err.status, err.headers));
  }
  // Anything that is not an SDK error class — an AnthropicError from option
  // validation, a stream-reassembly failure, a bug in this module. It used to
  // leave unstamped, which sent it to aiRetry's Gemini message-scraper: an
  // Anthropic-path error retried or not on whether some proxy's prose happened
  // to contain "unavailable". Stamp it in place; nothing the SDK never saw is
  // claimed as retried.
  if (err instanceof Error) return stamp(err, null, false);
  // A non-Error throw value would otherwise leave unstamped and be scraped:
  // translateError('a raw string 503 UNAVAILABLE') came back transient.
  return stamp(new Error(String(err)), null, false);
}

// One generation.
//
//   model      : a Claude model id (from models.resolve(task).model)
//   prompt     : the user turn — sugar for a one-message conversation
//   messages   : a whole conversation, [{role:'user'|'assistant', content}],
//                content being a string or a block list. Exactly one of
//                prompt/messages. Content blocks are how a cache_control
//                breakpoint is carried, which is why they are not flattened.
//   system     : optional system prompt; cached when cacheSystem is set
//   schema     : optional JSON Schema — sets structured output
//   maxTokens  : REQUIRED by the API. Remember it bounds thinking + text.
//   effort     : low | medium | high | xhigh | max
//   thinking   : true (adaptive, default) | false (disabled; effort must be <= high)
//   temperature: passed through on models that take it, dropped with a one-time
//                warning on the ones that 400 — see NO_TEMPERATURE above. null
//                means "don't send it", which is not the same as sending 1.0
//   tenantId/site : spend telemetry, same contract as the Gemini call sites
//
// Returns { text, usage, stopReason, model }. Throws on refusal so an empty
// answer can never be mistaken for a real one.
async function generate({
  model,
  prompt = null,
  messages = null,
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
  temperature = null,
  cacheSystem = false,
  allowTruncation = false,
  tenantId = null,
  site = 'anthropic.generate',
  signal = null,
  ...unknown
} = {}) {
  // Silently ignoring an unknown key is how `abortSignal` (the Gemini spelling
  // of `signal`) or `maxOutputTokens` (of `maxTokens`) would vanish during a
  // mechanical port, taking a call site's only time bound or output budget with
  // it and leaving nothing to notice.
  const stray = Object.keys(unknown);
  if (stray.length) {
    throw argError(
      `anthropic.generate: unknown option(s) ${stray.join(', ')}. ` +
      'Gemini spellings differ: abortSignal→signal, maxOutputTokens→maxTokens; ' +
      'a Gemini-dialect schema is passed as `schema` and translated here.'
    );
  }
  if (!model) throw argError('anthropic.generate: model required');
  if (prompt && messages) {
    throw argError('anthropic.generate: pass prompt OR messages, not both');
  }
  if (!prompt && !messages) throw argError('anthropic.generate: prompt or messages required');
  if (!EFFORTS.has(effort)) throw argError(`anthropic.generate: unknown effort "${effort}"`);
  if (!thinking
      && matches(model, THINKING_DISABLED_EFFORT_CAPPED)
      && !THINKING_DISABLED_MAX_EFFORT.has(effort)) {
    // Caught here rather than as a 400 from the API, because the caller cannot
    // see the constraint and the message would not say which knob to move.
    throw argError(
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
    messages: messages ? normalizeMessages(messages) : [{ role: 'user', content: prompt }],
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
  // Temperature is forwarded on the models that take it and dropped on the ones
  // that 400 — the per-model split is in NO_TEMPERATURE above, with the live
  // probe that produced it. Dropping SILENTLY was the defect: it removed the
  // determinism setting from the LITE tier, which accepts it.
  if (temperature != null) {
    if (supportsTemperature(model)) params.temperature = temperature;
    else warnTemperatureDropped(model, site, temperature);
  }

  const breakpoints = countBreakpoints(params);
  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    throw argError(
      `anthropic.generate: ${breakpoints} cache_control breakpoints, max is ${MAX_CACHE_BREAKPOINTS} ` +
      '— the API rejects the fifth with a 400 rather than dropping it. ' +
      'Cache the longest stable prefixes and leave the rest uncached.'
    );
  }

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

  if (breakpoints > 0) warnIfNothingCached(message.model || model, site, message.usage);

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
    throw stamp(err, null, false);
  }

  return {
    text: textFrom(message),
    usage: message.usage || null,
    stopReason: message.stop_reason || null,
    model: message.model || model,
  };
}

// refusalError is exported for tests: it never passes through translateError,
// so nothing else could assert that it carries the stamp aiRetry branches on.
// EFFORTS is exported so aiCall.js can validate the vocabulary at the seam
// against THIS set rather than a second copy: an effort typo on a
// Gemini-serving task is silent until the flip, and two lists would drift the
// moment a new level ships (as `xhigh` did).
// NO_TEMPERATURE and supportsTemperature are exported FOR THE GUARDS, not for
// callers: nothing outside this file decides temperature (that is the point of
// the list living here), but the capability is unobservable from the request
// shape alone for a model no test happens to call, which is how an under-broad
// list stayed invisible. See the note above NO_TEMPERATURE.
module.exports = {
  getClient, isConfigured, generate, textFrom, translateError, refusalError, EFFORTS,
  NO_TEMPERATURE, supportsTemperature,
};
