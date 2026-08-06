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
// Empty on purpose: this phase ships the router and the client, not the call
// sites. Until a task's call site reads resolve().provider and branches, asking
// for anthropic would hand a Claude model id to the Gemini SDK — a 404 on every
// call. For `relevance` that is worse than an outage: it fails OPEN
// (relevance.js returns null and only warns), so every competitor document
// would skip the quarantine silently, for every tenant, with nothing in the UI
// or the logs that looks like a failure.
//
// A task joins this set in the same PR that migrates its call site. Until then
// the router honours the env var by warning and staying put, so an operator who
// follows the migration runbook early gets a loud no-op instead of a silent
// corruption.
const DISPATCH_READY = new Set([]);

// task → { tier, env(legacy per-task override), anthropicEnv, anthropicTier }
//
// `anthropicTier` re-tiers a task for Claude only, leaving Gemini untouched.
// keypoints is mis-tiered as LITE (ADR-0006 §4.1) — COMPANY_ANALYSIS_SCHEMA
// asks for differentiator / idealCustomerProfile / pricingPosture, which is
// judgment, not extraction, and Haiku would regress it visibly. Correcting the
// Gemini tier at the same time would be a silent quality-and-cost change in a
// PR that is meant to change nothing.
//
// ADR-0006 §4.1 names a SECOND correction that is deliberately NOT made here:
// `assessment` should split, with per-document scoring staying LITE and the
// BATTLECARD_SCHEMA synthesis (knowledge/assessment.js) moving to FLASH. That
// needs a new task key AND a change at the battlecard call site, so it belongs
// with that call site's phase-3 migration rather than in a router-only PR.
// Until then both assessment call sites share one tier — which is harmless
// while DISPATCH_READY is empty, and must be fixed before `assessment` is added
// to it, or battlecards get synthesised by Haiku.
const TASKS = {
  // LITE — high-volume, structured/extraction
  relevance:    { tier: 'lite',    env: 'GEMINI_RELEVANCE_MODEL',    anthropicEnv: 'ANTHROPIC_RELEVANCE_MODEL' },
  keypoints:    { tier: 'lite',    env: 'GEMINI_KEYPOINTS_MODEL',    anthropicEnv: 'ANTHROPIC_KEYPOINTS_MODEL', anthropicTier: 'flash' },
  assessment:   { tier: 'lite',    env: 'GEMINI_ASSESSMENT_MODEL',   anthropicEnv: 'ANTHROPIC_ASSESSMENT_MODEL' },
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

// Per-task override wins, then the global default, then Gemini. An unknown
// value falls back rather than throwing: a typo in an env var must not take the
// api down on boot, and the fallback is the provider we were already on.
function providerFor(task) {
  const raw = process.env[providerEnvName(task)] || process.env.AI_PROVIDER || DEFAULT_PROVIDER;
  const p = String(raw).trim().toLowerCase();
  if (!PROVIDERS.has(p)) {
    console.warn(`[models] unknown provider "${raw}" for task "${task}" — falling back to ${DEFAULT_PROVIDER}`);
    return DEFAULT_PROVIDER;
  }
  if (p !== DEFAULT_PROVIDER && !DISPATCH_READY.has(task)) {
    // Once per task+provider. This used to fire once per process for `personas`
    // because personas.js resolved its model at require time; resolving on read
    // (ADR-0006 §9 item 4) moved it onto the Arena's per-turn path, where an
    // operator following the migration runbook — which is precisely who sets
    // this variable — would get the same line on every request.
    warnOnce(`dispatch:${task}:${p}`,
      `[models] task "${task}" is configured for ${p} but its call site cannot dispatch yet — ` +
      `staying on ${DEFAULT_PROVIDER}. Remove ${providerEnvName(task)} or migrate the call site first.`
    );
    return DEFAULT_PROVIDER;
  }
  // Checked AFTER dispatch-readiness so the message an operator gets names the
  // thing they can actually fix, and checked on every resolve rather than once
  // at boot because a key can be rotated into a running process's environment.
  if (p !== DEFAULT_PROVIDER && !isProviderConfigured(p)) {
    warnOnce(`unconfigured:${task}:${p}`,
      `[models] task "${task}" is configured for ${p} but ${p.toUpperCase()}_API_KEY is not set — ` +
      `staying on ${DEFAULT_PROVIDER}. Dispatching anyway would throw on every call, and for ` +
      'fail-open tasks like "relevance" that is a silent quarantine bypass, not an outage.'
    );
    return DEFAULT_PROVIDER;
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
