// Per-task model router — cost-optimized tiers.
//
// Three cost tiers; every AI task maps to one. Tasks pick the cheapest model
// that holds quality: high-volume structured/extraction work → LITE, reasoning/
// synthesis → FLASH, the flagship call analysis → PRO (gated by your key/plan).
//
// Tiers are env-overridable so you can flip a whole class of tasks without
// touching code, and each task keeps its legacy per-task override (which wins).
//
// Defaults are NON-BREAKING:
//   - LITE defaults to gemini-2.5-flash-lite (activates savings on the bulk of
//     calls). If your key can't run flash-lite, set GEMINI_MODEL_LITE=gemini-2.5-flash.
//   - PRO defaults to GEMINI_ANALYSIS_MODEL (Flash on a free-tier key) so the
//     premium path never errors; set GEMINI_MODEL_PRO=gemini-2.5-pro once your
//     key has Pro quota to actually upgrade call analysis.

const FLASH = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const TIERS = {
  lite:    process.env.GEMINI_MODEL_LITE || 'gemini-2.5-flash-lite',
  flash:   FLASH,
  pro:     process.env.GEMINI_MODEL_PRO || process.env.GEMINI_ANALYSIS_MODEL || FLASH,
  content: process.env.GEMINI_CONTENT_MODEL || FLASH,
};

// task → { tier, env(legacy per-task override var) }
const TASKS = {
  // LITE — high-volume, structured/extraction
  relevance:    { tier: 'lite',    env: 'GEMINI_RELEVANCE_MODEL' },
  keypoints:    { tier: 'lite',    env: 'GEMINI_KEYPOINTS_MODEL' },
  assessment:   { tier: 'lite',    env: 'GEMINI_ASSESSMENT_MODEL' },
  companyBrief: { tier: 'lite',    env: 'GEMINI_COMPANYBRIEF_MODEL' },
  preview:      { tier: 'lite',    env: 'GEMINI_PREVIEW_MODEL' },
  callEntities: { tier: 'lite',    env: 'GEMINI_ENTITY_MODEL' },
  // FLASH — reasoning / synthesis
  research:     { tier: 'flash',   env: 'GEMINI_RESEARCH_MODEL' },
  discovery:    { tier: 'flash',   env: 'GEMINI_DISCOVERY_MODEL' },
  brief:        { tier: 'flash',   env: 'GEMINI_BRIEF_MODEL' },
  compare:      { tier: 'flash',   env: 'GEMINI_COMPARE_MODEL' },
  personas:     { tier: 'flash',   env: 'GEMINI_PERSONAS_MODEL' },
  // PRO — flagship call moment-of-truth analysis (gated)
  callAnalysis: { tier: 'pro',     env: 'GEMINI_ANALYSIS_MODEL' },
  // CONTENT — writing (SOW / portal / follow-up)
  content:      { tier: 'content', env: 'GEMINI_CONTENT_MODEL' },
};

// Resolve the model id for a task: explicit per-task env override wins, else the
// task's tier model. Unknown tasks fall back to FLASH.
function modelFor(task) {
  const t = TASKS[task];
  if (!t) return TIERS.flash;
  return (t.env && process.env[t.env]) || TIERS[t.tier];
}

module.exports = { modelFor, TIERS };
