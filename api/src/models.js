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
// Grows one task per cutover PR; it is NOT empty. Until a task's call site
// reads resolve().provider and branches, asking for anthropic would hand a
// Claude model id to the Gemini SDK — a 404 on every call. For `relevance` that
// is worse than an outage: it fails OPEN (relevance.js returns null and only
// warns), so every competitor document would skip the quarantine silently, for
// every tenant, with nothing in the UI or the logs that looks like a failure.
//
// BEFORE ADDING A TASK, READ THE `assessment` NOTE ABOVE TASKS, and check that
// the key you are adding serves exactly ONE call site. `assessment` used to
// serve two at two different difficulty levels, so joining this set by
// pattern-matching on the line below would have sent BATTLECARD_SCHEMA
// synthesis to Haiku. That specific hazard is gone — the synthesis has its own
// `battlecard` key now — but the shape of the mistake is not.
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
// Membership alone changes nothing — it makes a task ELIGIBLE. The provider is
// still chosen by AI_PROVIDER / AI_PROVIDER_<TASK>, which default to gemini,
// and providerFor() additionally refuses to dispatch when the target provider's
// key is not configured.
const DISPATCH_READY = new Set(['relevance', 'preview', 'companyBrief']);

// task → { tier, env(legacy per-task override), anthropicEnv, anthropicTier }
//
// `anthropicTier` re-tiers a task for Claude only, leaving Gemini untouched.
// keypoints is mis-tiered as LITE (ADR-0006 §4.1) — COMPANY_ANALYSIS_SCHEMA
// asks for differentiator / idealCustomerProfile / pricingPosture, which is
// judgment, not extraction, and Haiku would regress it visibly. Correcting the
// Gemini tier at the same time would be a silent quality-and-cost change in a
// PR that is meant to change nothing.
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
// What is still NOT done, and is deliberately not done here: neither
// `assessment` nor `battlecard` is in DISPATCH_READY, and neither of their call
// sites can dispatch to Claude yet. Both of those keys move in group 2's
// cutover PR (ADR-0006 §9 item 5, `keypoints` + `assessment` + `battlecard`) —
// this is a router-only change, so it flips no traffic and re-tiers nothing on
// the provider currently serving 100% of it.
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
// out in DISPATCH_READY's comment below.
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
  TIERS, TASKS, DISPATCH_READY,
};
