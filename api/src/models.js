// Per-task model router — cost-optimized tiers, now provider-aware.
//
// Three cost tiers; every AI task maps to one. Tasks pick the cheapest model
// that holds quality: high-volume structured/extraction work → LITE, reasoning/
// synthesis → FLASH, the flagship call analysis → PRO (gated by your key/plan).
//
// Tiers are env-overridable so you can flip a whole class of tasks without
// touching code, and each task keeps its legacy per-task override (which wins).
//
// PROVIDER SELECTION (ADR-0006 §4.5). Each task also resolves to a provider, so
// the Gemini→Claude migration moves one task at a time by env var rather than
// as one release:
//
//     AI_PROVIDER=gemini                 # global default
//     AI_PROVIDER_RELEVANCE=anthropic    # …except this task
//
// Defaults are NON-BREAKING: every task stays on Gemini until told otherwise,
// and the Gemini tier/override behaviour below is exactly what it was.
//   - LITE defaults to gemini-2.5-flash-lite (activates savings on the bulk of
//     calls). If your key can't run flash-lite, set GEMINI_MODEL_LITE=gemini-2.5-flash.
//   - PRO defaults to GEMINI_ANALYSIS_MODEL (Flash on a free-tier key) so the
//     premium path never errors; set GEMINI_MODEL_PRO=gemini-2.5-pro once your
//     key has Pro quota to actually upgrade call analysis.
//
// WHY resolve() AND modelFor() BOTH EXIST. ADR-0006 §9 item 2 specifies
// "modelFor returns {provider, model}". Changing the return type would break
// all ~20 call sites inside the PR that is supposed to change no behaviour, so
// resolve() is the new provider-aware API and modelFor() stays a string-
// returning wrapper over it. Call sites migrate to resolve() one at a time in
// phase 3 — the incremental cutover the ADR asks for — and modelFor() can be
// deleted once the last one moves.

const FLASH = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Claude tier defaults per ADR-0006 §4.1.
const TIERS = {
  gemini: {
    lite:    process.env.GEMINI_MODEL_LITE || 'gemini-2.5-flash-lite',
    flash:   FLASH,
    pro:     process.env.GEMINI_MODEL_PRO || process.env.GEMINI_ANALYSIS_MODEL || FLASH,
    content: process.env.GEMINI_CONTENT_MODEL || FLASH,
  },
  anthropic: {
    lite:    process.env.ANTHROPIC_MODEL_LITE || 'claude-haiku-4-5',
    flash:   process.env.ANTHROPIC_MODEL_FLASH || 'claude-sonnet-5',
    pro:     process.env.ANTHROPIC_MODEL_PRO || 'claude-opus-5',
    content: process.env.ANTHROPIC_MODEL_CONTENT || 'claude-sonnet-5',
  },
};

const PROVIDERS = new Set(Object.keys(TIERS));
const DEFAULT_PROVIDER = 'gemini';

// Tasks whose CALL SITE can actually dispatch to a non-Gemini provider.
//
// Grows as call sites migrate — not one task per PR; groups 1 and 2 added three
// keys each, and §9 item 5's later groups are up to four keys that must flip
// together. It is NOT empty. Until a task's call site reads
// resolve().provider and branches, asking for anthropic would hand a
// Claude model id to the Gemini SDK — a 404 on every call. For `relevance` that
// is worse than an outage: it fails OPEN (relevance.js returns null and only
// warns), so every competitor document would skip the quarantine silently, for
// every tenant, with nothing in the UI or the logs that looks like a failure.
//
// BEFORE ADDING A TASK, READ THE `assessment` NOTE ABOVE TASKS. The test is
// not "does this key serve exactly one call site" — `relevance` below serves
// two and ships. It is: every call site the key serves sits at the SAME
// difficulty tier, and every one of them has been migrated. `assessment` used
// to serve two at two different tiers, so joining this set by pattern-matching
// on the line below would have sent BATTLECARD_SCHEMA synthesis to Haiku. That
// specific hazard is gone — the synthesis has its own `battlecard` key now —
// but the shape of the mistake is not. The "all of them" half bites separately
// where one FILE carries call sites for two keys: `preview.js` holds `preview`
// and `compare` and is the case where you migrate only the key you are adding,
// while `assessment.js` holds `assessment` and `battlecard` and is the case
// where you must add BOTH, because leaving one behind does not error — it just
// never moves. See the GROUP 1 and GROUP 2 lists below for how each looks.
//
// A task joins this set in the same PR that migrates its call site. Until then
// the router honours the env var by warning and staying put, so an operator who
// follows the migration runbook early gets a loud no-op instead of a silent
// corruption.
//
// GROUP 1 (ADR-0006 §9 item 5), migrated onto aiCall.generateStructured:
//   relevance     knowledge/relevance.js — both call sites
//   preview       knowledge/preview.js   — summarize() ONLY. `compare` lives in
//                 the same file and is NOT here: it belongs to a later group,
//                 so that file deliberately holds one seam call and one direct
//                 Gemini call until its own cutover.
//   companyBrief  companyBrief.js
//
// GROUP 2 (ADR-0006 §9 item 5), likewise migrated onto the seam:
//   keypoints     knowledge/keypoints.js  — ALL THREE call sites (kb.keypoints,
//                 kb.companyAnalysis, kb.productAnalysis). One key, three sites,
//                 one flip; the require-time modelFor() constant is gone.
//   assessment    knowledge/assessment.js — extractCompetitiveAssessment, the
//                 per-document scorer. Keeps its aiRetry('assessment') wrapper,
//                 now around the seam call.
//   battlecard    knowledge/assessment.js — extractBattlecard, the synthesis.
//                 Deliberately UNWRAPPED: it is synchronous behind a rep-facing
//                 regenerate, so retry would turn a fast 502 into three attempts
//                 with backoff while they wait.
//
// THE THREE GROUP-2 KEYS HAD TO LAND TOGETHER, and `battlecard` is the reason.
// assessment.js holds two call sites resolving two different keys since PR #53.
// Adding `assessment` alone leaves extractBattlecard on the Gemini SDK — and
// NOTHING ERRORS, because it keeps sending a Gemini model id and returns a
// normal battlecard, so the only symptom is §6's margin table pricing a task
// that never moved. Adding `battlecard` without migrating its call site is the
// inverse and is loud: a Claude model id posted to the Gemini SDK, a 404 on
// every regenerate. Both halves are why this is one PR.
//
// Membership alone changes nothing — it makes a task ELIGIBLE. The provider is
// still chosen by AI_PROVIDER / AI_PROVIDER_<TASK>, which default to gemini,
// and providerFor() additionally refuses to dispatch when the target provider's
// key is not configured — or when the task is in FLIP_BLOCKED below.
//
// ELIGIBLE IS NOT THE SAME AS SAFE, and the two facts are deliberately NOT
// merged into this set. This one answers "can the call site dispatch?", which is
// a property of the code and is what the EDITING note below pins. Whether a flip
// is a good idea is a property of measurements against a live provider, changes
// without a code change, and lives in FLIP_BLOCKED.
//
// EDITING THE LINE BELOW ALSO INVALIDATES PROSE. SIX blocks assert what is in
// this set and go stale with it: anthropic.js (header), aiCall.js (header),
// gemini.js (assertGeminiModel), aiContext.js ("It does not flip any task"),
// test/live/contextSeam.js (prepareVia's note on why it opens the task) — and
// `.env.example`'s "Provider routing" section, which is the only one an
// OPERATOR reads and the one that drifts hardest, because nothing in a code
// review naturally opens it. It was already listed as a P1 fix in group 1's
// review round (e69eb88, "four stale comments and .env.example") and drifted
// again within one group, which is why it is named here rather than remembered.
// contextSeam.js is the SIXTH, added in group 2's third review round: it had
// said "DISPATCH_READY is empty by design" since before group 1 landed, and was
// missed by every pass precisely because a live-probe script is not where
// anyone greps for a claim about a router set.
//
// The pins in providerRouter.test.js and aiCall.test.js carry the same list in
// their failure messages — but a message is only read on a red run, and the PR
// that changes this set deliberately greps for it, fixes both pins in the same
// pass and goes green first try, never seeing either one. That PR is the reader
// this note is for. costsTelemetry.test.js pins the seam CALL-SITE COUNT, and
// checks it against the number anthropic.js's header quotes, because a count
// living in prose is the half of this a set-equality assertion cannot see.
const DISPATCH_READY = new Set([
  'relevance', 'preview', 'companyBrief',      // group 1
  'keypoints', 'assessment', 'battlecard',     // group 2
]);

// Tasks whose call site CAN dispatch but which must not be flipped yet, because
// something measured against the live provider says the result would be worse
// than what we have. providerFor() refuses these exactly the way it refuses a
// task that is not dispatch-ready: fall back to Gemini, warn once, name the
// reason. A warning alone would not do — an operator following the runbook sets
// the variable and moves on, and the whole point is that the flip does not
// happen.
//
// WHY THIS IS A SECOND SET AND NOT A SUBTRACTION FROM THE FIRST. DISPATCH_READY
// is a claim about the code: this call site reads resolve().provider and
// branches. It is verifiable by reading the file, it is pinned by two tests, and
// it is what every comment in this file that says "a task joins the set in the
// same PR that migrates its call site" is about. Blocking a flip is a claim
// about a measurement against a live API — it can become false with no code
// change at all (a provider ships a fix; we reshape a schema; we add a retry).
// Folding the second into the first would make membership mean two things and
// leave the migration unable to state either one honestly.
//
// A KEY LEAVES THIS SET IN THE PR THAT FIXES OR MEASURES AWAY ITS REASON —
// exactly the symmetry by which keys JOIN DISPATCH_READY in the PR that migrates
// their call site. Removing an entry with no new evidence recorded next to it is
// the same failure as adding a task to DISPATCH_READY whose call site was never
// migrated: it looks like progress and is a silent regression. Each entry below
// therefore states what would have to be true to delete it.
const FLIP_BLOCKED = new Map([
  // Measured 2026-08-14 (group 2's confidence pass), driving extractBattlecard
  // ITSELF against the live API — buildBattlecardPrompt, aiCall.generateStructured,
  // models.resolve and anthropic.generate, nothing bypassed — across 3
  // competitors and 2 tenants: 2 OF 80 RESPONSES WERE UNPARSEABLE JSON. 2.5%,
  // 95% CI (Clopper-Pearson) 0.30%-8.74%. stop_reason 'end_turn', not
  // truncation: a stray token mid-object (output_tokens 2003, textLen 5714,
  // parse failure at position 4323). Not a schemaCompat bug — the provider
  // ACCEPTS this schema, which is why the live smoke check is green over it.
  //
  // AN EARLIER VERSION OF THIS COMMENT SAID "3 of 10 at the real request
  // shape", AND THAT WAS WRONG IN BOTH HALVES. It pooled three probes (1/3, 1/6,
  // 1/1) that each called anthropic.generate() DIRECTLY with one hard-coded
  // 302-char synthetic prompt — the real prompt is 7,546-10,755 chars — and it
  // does not reproduce: 0 of 19 completed calls on a re-run of that same
  // synthetic shape. The companion "0 of 10 on the other four group-2 schemas"
  // was 13 calls, not 40. What survived re-measurement is the DEFECT and its
  // character, not the rate; the rate is 2.5%, and 30% is rejected at
  // P(<=2 | n=80, p=0.30) = 2.5e-10. This is the third time in ADR-0006 that
  // prose ran ahead of the measurement, which is why the method is stated here
  // rather than left to be inferred.
  //
  // 2.5% IS STILL A BLOCK. extractBattlecard is the one migrated call site with
  // no retry, synchronous behind the rep-facing POST
  // /portfolio/competitors/:id/battlecard/regenerate, so a flip today means
  // roughly 1 regeneration in 40 returning a 502 the rep sees, with no second
  // attempt — on a button whose whole purpose is to be pressed again.
  //
  // TO DELETE THIS ENTRY you need BOTH a fix and a re-measurement AT THIS SHAPE:
  // 0 unparseable in >=100 calls driven through extractBattlecard (n=10 cannot
  // distinguish 2.5% from 0 — that is how the first figure came to be believed).
  // And the obvious fix does not work: wrapping the call in aiRetry does NOT
  // retry this. aiCall stamps the SyntaxError `provider: 'anthropic'`, and
  // classify()'s Anthropic branch is `transient: !perDay && !sdkRetried &&
  // status === 429` — a parse error carries no status, so it is one attempt.
  // The real change is classify() treating an anthropic-stamped parse error as
  // transient, and/or reshaping BATTLECARD_SCHEMA — and any retry here must fit
  // inside nginx's 180s proxy_read_timeout, which 3 x ANTHROPIC_TIMEOUT_MS
  // (120s) + 2s + 4s does not: that turns a 502 into a 504 mid-write.
  ['battlecard',
    '2 of 80 live claude-sonnet-5 responses were unparseable JSON when extractBattlecard itself was ' +
    'driven against the live API (2.5%, 95% CI 0.3-8.7%; measured 2026-08-14), on the one call site ' +
    'with no retry, behind a synchronous rep-facing regenerate. See ADR-0006 §9 item 5.'],

  // Measured 2026-08-14 (group 2's confidence pass, at the SHIPPED call-site
  // shape — maxTokens 2200, allowTruncation unset): kb.companyAnalysis against
  // staging document 91bfba3e-a001-451e-87df-985a6a468395 "Wibmo — homepage"
  // (body 10,685 chars; stored companyAnalysis 4,297 chars) returned
  // stop_reason 'max_tokens' 5 OF 5 TIMES. The 2200-token budgets at
  // extractCompanyAnalysis and extractProductAnalysis are GEMINI-sized and
  // truncate on Sonnet 5.
  //
  // THE ARITHMETIC THIS ENTRY FIRST RESTED ON WAS INVALID IN KIND, and the
  // correction matters because it changes which document reproduces. It read
  // staging's largest STORED companyAnalysis (6,438 chars, a Gemini output) as
  // ~2,660-3,460 output tokens via §5.2's 1.74-1.88x density. But output length
  // is driven by the SOURCE BODY and the schema, not by what a different model
  // once wrote: Sonnet's answer for that same document is ~1,150 tokens and it
  // completes 9 of 9 times. Converting a stored output back into a budget
  // estimate is not a measurement, and it happened to point at a document that
  // passes. kb.productAnalysis is NOT observed to truncate either — 15/15
  // end_turn, peak 1,871 of 2,200, which is close enough that "safe" would be
  // the wrong word for it.
  //
  // WHY THAT IS DATA LOSS AND NOT AN ERROR, observed end to end and not
  // inferred: driving the real knowledge/service.js -> keypoints.js -> aiCall ->
  // anthropic path against the live API on that document, the route answered
  // { ok: true } while the stored 4,297-char companyAnalysis was DELETED — the
  // same figure as above, which this line used to give as 4,209 for the same
  // string. Two numbers for one measurement is how one of them goes stale.
  // stop_reason 'max_tokens' with allowTruncation unset (these call sites pass
  // nothing) throws in anthropic.js; extractCompanyAnalysis catches it and
  // returns null; and the regenerate path is `if (analysis) md.companyAnalysis
  // = analysis; else delete md.companyAnalysis`. On the ingest path it is simply
  // never written; portfolio.js's company-profile draft 502s instead.
  //
  // TO DELETE THIS ENTRY: live kb.companyAnalysis calls at maxTokens 2200
  // against document 91bfba3e-a001-451e-87df-985a6a468395 — the one that
  // reproduces — showing stop_reason 'end_turn'. Repeated, not one: the current
  // measurement is 5 of 5, so a single end_turn is not evidence the budget is
  // adequate. Do NOT name the 6,438-char document here again; it passes today
  // (9/9 end_turn), so an exit criterion built on it would delete this entry
  // with the defect untouched. And do NOT just raise maxTokens — the value is
  // provider-agnostic at that call site, so raising it changes what GEMINI
  // receives and breaks the parity property group 2 shipped on. Sizing per
  // provider is the flip PR's problem to solve.
  ['keypoints',
    'the 2200-token budgets at kb.companyAnalysis / kb.productAnalysis are Gemini-sized and ' +
    'truncate on claude-sonnet-5 (measured 5 of 5 stop_reason max_tokens on staging document ' +
    '91bfba3e, a 10,685-char body); a truncated ' +
    "answer DELETES the stored analysis via service.js's regenerate path. See ADR-0006 §9 item 5."],
]);

// task → { tier, env(legacy per-task override), anthropicEnv, anthropicTier }
//
// `anthropicTier` re-tiers a task for Claude only, leaving Gemini untouched.
// keypoints is mis-tiered as LITE (ADR-0006 §4.1): COMPANY_ANALYSIS_SCHEMA asks
// for `differentiator` and `idealCustomerProfile`, and PRODUCT_ANALYSIS_SCHEMA
// for `pricingPosture`, `whoBuysIt` and `competingProducts` — judgment, not
// extraction, on TWO of the key's three call sites, and Haiku would regress both
// visibly. (`pricingPosture` lives in the PRODUCT schema, not the COMPANY one;
// this comment said otherwise, as did ADR §4.1, which understated the case by
// attributing everything to one schema.) Correcting the Gemini tier at the same
// time would be a silent quality-and-cost change in a PR meant to change nothing.
//
// THE THIRD CALL SITE IS THE BEND, and it is worth naming rather than leaving
// implied. `kb.keypoints` is plain bullet extraction and runs on EVERY ingested
// document — the highest-volume site this key serves — and it inherits Sonnet
// because a tier is per key, not per call site. That is the mirror image of the
// `assessment` hazard below: there one key rounded two sites DOWN to Haiku and
// silently degraded the harder one; here one key rounds three sites UP and the
// cheapest one overpays. Over-tiering is the safe direction and §6 prices this
// key at FLASH throughout, so it is a deliberate bend, not an oversight. The
// residual risk is the knob §4.5 invites an operator to turn:
// ANTHROPIC_KEYPOINTS_MODEL=claude-haiku-4-5 would save money on the extraction
// site by demoting the two judgment sites — the exact regression the tier exists
// to prevent, reachable without touching this file.
//
// ADR-0006 §4.1's SECOND correction — the `assessment` split — IS made here.
// `battlecard` below is that new key: per-document competitive scoring keeps
// `assessment`, and the BATTLECARD_SCHEMA synthesis (knowledge/assessment.js)
// takes `battlecard`, which is FLASH on Claude and unchanged LITE on Gemini.
//
// This is what lifts the block that used to sit here. The rule was:
// `assessment` MUST NOT join DISPATCH_READY until it is split, because one key
// served two call sites of very different difficulty and flipping it sent
// BATTLECARD_SCHEMA synthesis to Haiku — a worse battlecard, which is not an
// error anyone sees. That rule was UNCONDITIONAL, not contingent on
// DISPATCH_READY being empty (an earlier wording said "harmless while
// DISPATCH_READY is empty", which expired the moment group 1 landed and read as
// a condition to check rather than a prerequisite to satisfy). It is satisfied
// now, and only because the split happened: battlecard no longer resolves
// through `assessment` at all, so `assessment` cannot carry it to Haiku.
//
// DONE as of group 2's cutover PR (ADR-0006 §9 item 5, `keypoints` +
// `assessment` + `battlecard`): all three keys are in DISPATCH_READY above and
// all FIVE of their call sites dispatch through aiCall — three in keypoints.js
// under the one `keypoints` key, two in assessment.js under two keys. What
// that changed is
// ELIGIBILITY only — AI_PROVIDER / AI_PROVIDER_<TASK> still default to gemini,
// so the provider serving 100% of this traffic is unmoved and every `tier` below
// is still the one it was.
//
// The `anthropicTier` overrides on `keypoints` and `battlecard` are what keep
// that true. They exist precisely so a Claude re-tier costs the Gemini path
// nothing: both keys stay tier `lite` on Gemini and get FLASH only on Claude. A
// later PR that "tidies" either tier field is not tidying — it is a live
// quality-and-cost change to whichever provider is serving at the time.
const TASKS = {
  // LITE — high-volume, structured/extraction
  relevance:    { tier: 'lite',    env: 'GEMINI_RELEVANCE_MODEL',    anthropicEnv: 'ANTHROPIC_RELEVANCE_MODEL' },
  keypoints:    { tier: 'lite',    env: 'GEMINI_KEYPOINTS_MODEL',    anthropicEnv: 'ANTHROPIC_KEYPOINTS_MODEL', anthropicTier: 'flash' },
  assessment:   { tier: 'lite',    env: 'GEMINI_ASSESSMENT_MODEL',   anthropicEnv: 'ANTHROPIC_ASSESSMENT_MODEL' },
  // Battlecard SYNTHESIS, split out of `assessment` (ADR-0006 §4.1). Same
  // `anthropicTier` pattern as keypoints above, for the same reason and with
  // the same restraint: tier stays `lite` so the Gemini model this call site
  // gets is byte-for-byte what it got before, and only the Claude path moves to
  // FLASH. Re-tiering Gemini here would be a live quality-and-cost change to
  // 100% of today's traffic inside a router-only PR.
  //
  // "byte-for-byte what it got before" holds because both keys fall through to
  // the same `lite` tier default. It is conditional on ONE thing: the legacy
  // override `GEMINI_ASSESSMENT_MODEL` used to steer this call site too, and
  // after the split it steers only the per-document scorer. Set it, and the
  // synthesis silently drops back to the tier default while the scorer follows
  // the override. It is unset in every deployed environment (staging `ghost-api`
  // and production `dsp-api` both pass it through empty), so nothing moves —
  // but an operator pinning the battlecard must now use
  // `GEMINI_BATTLECARD_MODEL`.
  //
  //
  // ⚠ `AI_PROVIDER_BATTLECARD=anthropic` IS REFUSED — this key is in
  // FLIP_BLOCKED above, which is where the measurement and the exit criteria
  // live. Not repeated here: two copies of a number is how one of them goes
  // stale, and the one an operator hits at run time is the one that must be
  // right.
  battlecard:   { tier: 'lite',    env: 'GEMINI_BATTLECARD_MODEL',   anthropicEnv: 'ANTHROPIC_BATTLECARD_MODEL', anthropicTier: 'flash' },
  companyBrief: { tier: 'lite',    env: 'GEMINI_COMPANYBRIEF_MODEL', anthropicEnv: 'ANTHROPIC_COMPANYBRIEF_MODEL' },
  preview:      { tier: 'lite',    env: 'GEMINI_PREVIEW_MODEL',      anthropicEnv: 'ANTHROPIC_PREVIEW_MODEL' },
  callEntities: { tier: 'lite',    env: 'GEMINI_ENTITY_MODEL',       anthropicEnv: 'ANTHROPIC_ENTITY_MODEL' },
  // FLASH — reasoning / synthesis
  research:     { tier: 'flash',   env: 'GEMINI_RESEARCH_MODEL',     anthropicEnv: 'ANTHROPIC_RESEARCH_MODEL' },
  discovery:    { tier: 'flash',   env: 'GEMINI_DISCOVERY_MODEL',    anthropicEnv: 'ANTHROPIC_DISCOVERY_MODEL' },
  marketWatch:  { tier: 'flash',   env: 'GEMINI_MARKETWATCH_MODEL',  anthropicEnv: 'ANTHROPIC_MARKETWATCH_MODEL' },
  brief:        { tier: 'flash',   env: 'GEMINI_BRIEF_MODEL',        anthropicEnv: 'ANTHROPIC_BRIEF_MODEL' },
  compare:      { tier: 'flash',   env: 'GEMINI_COMPARE_MODEL',      anthropicEnv: 'ANTHROPIC_COMPARE_MODEL' },
  personas:     { tier: 'flash',   env: 'GEMINI_PERSONAS_MODEL',     anthropicEnv: 'ANTHROPIC_PERSONAS_MODEL' },
  // PRO — flagship call moment-of-truth analysis (gated)
  callAnalysis: { tier: 'pro',     env: 'GEMINI_ANALYSIS_MODEL',     anthropicEnv: 'ANTHROPIC_ANALYSIS_MODEL' },
  proposal:     { tier: 'pro',     env: 'GEMINI_PROPOSAL_MODEL',     anthropicEnv: 'ANTHROPIC_PROPOSAL_MODEL' },
  // CONTENT — writing (SOW / portal / follow-up)
  content:      { tier: 'content', env: 'GEMINI_CONTENT_MODEL',      anthropicEnv: 'ANTHROPIC_CONTENT_MODEL' },
};

// Env var suffix for a task's provider override: marketWatch → AI_PROVIDER_MARKET_WATCH.
function providerEnvName(task) {
  return `AI_PROVIDER_${String(task).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

const _warned = new Set();
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(message);
}

// Is this provider actually usable in this process? Checked by env rather than
// by requiring the client modules, which keeps this file free of a require
// cycle and matches exactly what those modules test on their own first call.
//
// WHY DISPATCHING TO AN UNCONFIGURED PROVIDER MUST FAIL CLOSED. `getClient()`
// throws "ANTHROPIC_API_KEY is not set" on every call. For most tasks that is a
// visible outage. For `relevance` it is worse than an outage and completely
// silent: checkDocRelevance catches everything, returns null, and
// shouldMarkQuarantine(null) is false — so every competitor document skips the
// quarantine gate, for every tenant, with nothing in the UI or the logs that
// looks like a failure. The same fail-open shape is why `relevance` was singled
// out in DISPATCH_READY's comment above.
//
// So a provider with no credentials is not "configured but broken", it is not
// available, and the router treats it the way it treats an unknown provider
// name: stay on Gemini and say so loudly.
const PROVIDER_CONFIGURED = {
  gemini: () => Boolean(process.env.GEMINI_API_KEY),
  anthropic: () => Boolean(process.env.ANTHROPIC_API_KEY),
};

function isProviderConfigured(provider) {
  const check = PROVIDER_CONFIGURED[provider];
  return check ? check() : false;
}

// Every fallback to DEFAULT_PROVIDER goes through here so it can say the one
// thing the three call sites below all omitted: whether the provider we are
// falling back TO is itself usable. isProviderConfigured('gemini') was defined
// and never called, so with an Anthropic key and no Gemini key the router
// cheerfully "stayed on Gemini" — into gemini.getClient() throwing on every
// call, which assessment.js and keypoints.js swallow into null. That is the
// same silent fail-open the guard exists to prevent, one provider over.
function fallbackToDefault(task, key, reason) {
  const escalation = isProviderConfigured(DEFAULT_PROVIDER)
    ? ''
    : ` AND ${DEFAULT_PROVIDER.toUpperCase()}_API_KEY IS NOT SET EITHER — there is no working ` +
      `provider for "${task}" in this process. Every call will throw, and the callers that ` +
      'swallow errors (relevance, assessment, keypoints) will degrade silently rather than fail.';
  warnOnce(key, reason + escalation);
  return DEFAULT_PROVIDER;
}

// Per-task override wins, then the global default, then Gemini. An unknown
// value falls back rather than throwing: a typo in an env var must not take the
// api down on boot, and the fallback is the provider we were already on.
function providerFor(task) {
  const raw = process.env[providerEnvName(task)] || process.env.AI_PROVIDER || DEFAULT_PROVIDER;
  const p = String(raw).trim().toLowerCase();
  if (!PROVIDERS.has(p)) {
    // warnOnce, not console.warn. Pre-cutover the three group-1 tasks resolved
    // their model ONCE at require time, so a typo'd AI_PROVIDER printed one
    // line per process. Resolving per call (ADR-0006 §9 item 4) put this on the
    // hot path — relevance alone runs twice per ingested document — so a raw
    // console.warn turns one typo into a log flood. The two branches below
    // already document exactly this hazard; this one had not been given the
    // same treatment.
    return fallbackToDefault(task, `unknown:${task}:${p}`,
      `[models] unknown provider "${raw}" for task "${task}" — falling back to ${DEFAULT_PROVIDER}.`);
  }
  if (p !== DEFAULT_PROVIDER && !DISPATCH_READY.has(task)) {
    // Once per task+provider. This used to fire once per process for `personas`
    // because personas.js resolved its model at require time; resolving on read
    // (ADR-0006 §9 item 4) moved it onto the Arena's per-turn path, where an
    // operator following the migration runbook — which is precisely who sets
    // this variable — would get the same line on every request.
    return fallbackToDefault(task, `dispatch:${task}:${p}`,
      `[models] task "${task}" is configured for ${p} but its call site cannot dispatch yet — ` +
      `staying on ${DEFAULT_PROVIDER}. Remove ${providerEnvName(task)} or migrate the call site first.`
    );
  }
  // Between dispatch-readiness and the key check on purpose. A blocked task IS
  // migrated, so "migrate the call site first" would be wrong advice; and adding
  // a key would not unblock it either, so this has to be said before that
  // message is. It is a Map rather than a Set so the reason travels with the
  // key: an operator told only "blocked" goes looking for the ADR, and the
  // number is the thing that stops them arguing with it.
  if (p !== DEFAULT_PROVIDER && FLIP_BLOCKED.has(task)) {
    return fallbackToDefault(task, `flipblocked:${task}:${p}`,
      `[models] task "${task}" is MIGRATED but BLOCKED from ${p} — staying on ${DEFAULT_PROVIDER}. ` +
      `${FLIP_BLOCKED.get(task)} Unset ${providerEnvName(task)}. This is a measured defect, not a ` +
      'code gap: the call site dispatches fine, the result would be worse than what you have.'
    );
  }
  // Checked AFTER dispatch-readiness so the message an operator gets names the
  // thing they can actually fix, and checked on every resolve rather than once
  // at boot because a key can be rotated into a running process's environment.
  if (p !== DEFAULT_PROVIDER && !isProviderConfigured(p)) {
    return fallbackToDefault(task, `unconfigured:${task}:${p}`,
      `[models] task "${task}" is configured for ${p} but ${p.toUpperCase()}_API_KEY is not set — ` +
      `staying on ${DEFAULT_PROVIDER}. Dispatching anyway would throw on every call, and for ` +
      'fail-open tasks like "relevance" that is a silent quarantine bypass, not an outage.'
    );
  }
  return p;
}

// Resolve a task to { provider, model }: explicit per-task env override wins,
// else the task's tier model for that provider. Unknown tasks fall back to the
// provider's FLASH tier, matching the previous behaviour.
function resolve(task) {
  const provider = providerFor(task);
  const t = TASKS[task];
  const tiers = TIERS[provider];
  if (!t) return { provider, model: tiers.flash };

  const envName = provider === 'anthropic' ? t.anthropicEnv : t.env;
  const override = envName && process.env[envName];
  if (override) return { provider, model: override };

  const tier = (provider === 'anthropic' && t.anthropicTier) || t.tier;
  return { provider, model: tiers[tier] };
}

// Back-compat: the model id only. Every existing call site uses this.
function modelFor(task) {
  return resolve(task).model;
}

// The inverse of resolve(): which provider a MODEL ID belongs to.
//
// Exists because a resolved model id can reach the wrong SDK entirely.
// personas.js resolves modelFor('personas') and arena.js hands the result
// straight to gemini.caches.create(), so AI_PROVIDER_PERSONAS=anthropic would
// post a Claude id to Google's caches API (ADR-0006 §9 item 4). gemini.js uses
// this to refuse that request with a message that names the cause, instead of a
// 404 from Google that names nothing.
//
// null for an id we don't recognise, and that is deliberate: the point is to
// block a confidently-WRONG id, not to allow-list model names. A model released
// after this was written, or a custom endpoint id set via GEMINI_*_MODEL, must
// keep working without an edit here.
function providerOfModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('claude') || m.startsWith('anthropic')) return 'anthropic';
  if (m.includes('gemini') || m.includes('gemma')) return 'gemini';
  return null;
}

module.exports = {
  modelFor, resolve, providerFor, providerEnvName, providerOfModel,
  isProviderConfigured,
  TIERS, TASKS, DISPATCH_READY, FLIP_BLOCKED,
};
