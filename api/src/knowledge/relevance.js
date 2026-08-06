// Semantic relevance guard for competitor intel.
//
// Structural validation already guarantees a doc can only be filed under a real
// offering of the tagged competitor. This module adds the SEMANTIC layer: does
// the content actually concern that vendor / product at all? It runs at ingest
// alongside the keypoints + scoreboard calls. A clear "no" quarantines the doc
// (metadata.relevanceVerified=false) so it's kept out of the battlecard and the
// main-intel gate until a rep confirms it.
//
// Two checks, both best-effort (never throw — a model failure returns null and
// the caller fails OPEN, treating the doc as relevant rather than blocking
// ingest on a transient error):
//   - checkDocRelevance        — is THIS document about {competitor}[ / product]?
//   - checkOfferingPlausibility — does {competitor} plausibly sell {productName}?
//
// Mirrors the structured-output + retry conventions in assessment.js.

// One-shot provider seam (ADR-0006 §9 item 5). It resolves the provider AND the
// model PER CALL — the model id is deliberately no longer captured at require
// time. A require-time `modelFor()` freezes whatever the router said when the
// process booted, so a provider flip needs a restart to take effect and, worse,
// a rollback does not take effect until one either. Same fix as personas.js in
// item 4.
const aiCall = require('../aiCall');

// Shared retry helper (ADR-0006 §7). Bound here with this module's label so
// every call site below is unchanged; the classification that used to live in
// a local copy of this function now happens once, in aiRetry.classify().
const aiRetry = require('../aiRetry');
const withRetry = aiRetry.forLabel('relevance');

// Doc body slice fed to the topicality judge. Smaller than the scoreboard cap —
// a few thousand chars is plenty to tell what a doc is about.
const INPUT_CAP = parseInt(process.env.KB_RELEVANCE_INPUT_CAP || '8000', 10);

// Quarantine when the model says off-topic, OR when it claims on-topic but with
// confidence below this floor. Conservative by default so honest-but-unsure
// verdicts don't bury legitimate docs.
const QUARANTINE_THRESHOLD = parseFloat(process.env.KB_RELEVANCE_THRESHOLD || '0.4');

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    isOnTopic:  { type: 'boolean', description: 'True only if the document genuinely concerns the named competitor (and, when given, their named product). False if it is mainly about a different vendor/product.' },
    confidence: { type: 'number', description: '0..1 — how sure you are of isOnTopic.' },
    reason:     { type: 'string', description: 'One short sentence. When off-topic, name what the doc is actually about.' },
  },
  required: ['isOnTopic', 'confidence', 'reason'],
};

const OFFERING_SCHEMA = {
  type: 'object',
  properties: {
    plausible: { type: 'boolean', description: 'True if this vendor plausibly sells/markets a product by this name. False only if it clearly belongs to a different vendor or looks invented.' },
    reason:    { type: 'string', description: 'One short sentence explaining the verdict.' },
  },
  required: ['plausible', 'reason'],
};

// Both checks below fail OPEN, which is the right default — a transient model
// error must not block ingest or bury a legitimate document. The cost of that
// default is that EVERY failure here is invisible in the product: a null verdict
// is indistinguishable from "this document is fine".
//
// That was tolerable while the only failure mode was a Gemini 5xx. Claude adds
// one that is not transient and not rare on this exact subject matter: a REFUSAL
// is HTTP 200 with `stop_reason: 'refusal'`, and competitor intelligence and
// security-vendor research are precisely what ADR-0006 §7 flags as plausible
// false positives for the elevated safeguards. A systematically-refusing model
// would quietly stop quarantining anything, for every tenant, and the only
// evidence would be one line indistinguishable from a timeout.
//
// So the failure is still swallowed — changing that would wrongly quarantine
// documents on a transient error, a worse trade — but it is no longer
// anonymous. Refusals get their own greppable marker and name the provider and
// category; everything else says which provider produced it.
function warnRelevanceFailure(where, err) {
  const provider = (err && err.provider) || 'gemini';
  const msg = (err && err.message) || String(err);
  if (err && err.refusal) {
    console.warn(
      `[relevance] REFUSAL from ${provider} in ${where} — failing open, so this document ` +
      `SKIPS THE QUARANTINE GATE. category=${err.category || 'unspecified'}: ${msg}`
    );
    return;
  }
  console.warn(`[relevance] ${where} failed on ${provider} (fail-open): ${msg}`);
}

// Is this document actually about the competitor (and named product, if any)?
// Returns { isOnTopic, confidence, reason } or null on any failure (fail-open).
async function checkDocRelevance({ text, title = null, competitorName = null, competitorProductName = null, tenantId = null } = {}) {
  const body = String(text || '').trim();
  if (!body || body.length < 40 || !competitorName) return null;
  const claim = competitorProductName
    ? `This document is filed as intel about the competitor "${competitorName}", specifically their product "${competitorProductName}".`
    : `This document is filed as intel about the competitor "${competitorName}".`;
  const prompt =
    'You are a competitive-intelligence librarian doing an attribution check. ' +
    'A sales rep has filed the document below as intel about a specific competitor (and possibly one of their products). ' +
    'Decide whether the CONTENT genuinely concerns that vendor/product.\n\n' +
    'Rules: ' +
    '(1) Judge by the actual subject matter, not by a passing mention. A doc mainly about a DIFFERENT vendor that only name-drops this one is OFF-topic. ' +
    '(2) If a product name was given, the doc must concern THAT product (or the vendor broadly enough to cover it) to be on-topic. ' +
    '(3) Ignore website boilerplate (cookie/consent/nav/privacy). ' +
    '(4) When off-topic, your reason should name what the doc is actually about. ' +
    'Be decisive but fair — only mark off-topic when the mismatch is clear.\n\n' +
    `===CLAIM===\n${claim}\n\n` +
    `===DOCUMENT${title ? ` — ${title}` : ''}===\n${body.slice(0, INPUT_CAP)}`;
  try {
    const { parsed } = await withRetry(() => aiCall.generateStructured({
      task: 'relevance',
      prompt,
      responseSchema: DOC_SCHEMA,
      maxTokens: 400,
      temperature: 0.1,
      tenantId,
      site: 'kb.relevanceDoc',
    }));
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return {
      isOnTopic: parsed.isOnTopic === true,
      confidence,
      reason: String(parsed.reason || '').trim(),
    };
  } catch (err) {
    warnRelevanceFailure('checkDocRelevance', err);
    return null;
  }
}

// True when checkDocRelevance's verdict means we should quarantine the doc.
function shouldQuarantine(verdict) {
  if (!verdict) return false; // fail-open — no verdict, don't quarantine
  return !verdict.isOnTopic || verdict.confidence < QUARANTINE_THRESHOLD;
}

// Does this competitor plausibly sell a product by this name? Used as a
// non-blocking warning when a rep adds a "Their product". Returns
// { plausible, reason } or null on failure (treat as plausible → no warning).
async function checkOfferingPlausibility({ competitorName = null, productName = null, tenantId = null } = {}) {
  const comp = String(competitorName || '').trim();
  const prod = String(productName || '').trim();
  if (!comp || !prod) return null;
  const prompt =
    'You are a market analyst. A user is cataloguing a competitor\'s product line. ' +
    `Does the company "${comp}" plausibly sell, market, or offer a product/service called "${prod}"?\n\n` +
    'Answer plausible=false ONLY if the name clearly belongs to a DIFFERENT, well-known vendor, ' +
    'or reads as obviously invented / unrelated to this company. ' +
    'If you are unsure, or the name is generic enough that it could plausibly be theirs, answer plausible=true. ' +
    'Keep the reason to one short sentence.';
  try {
    const { parsed } = await withRetry(() => aiCall.generateStructured({
      task: 'relevance',
      prompt,
      responseSchema: OFFERING_SCHEMA,
      maxTokens: 200,
      temperature: 0.1,
      tenantId,
      site: 'kb.relevanceOffering',
    }));
    return {
      plausible: parsed.plausible !== false,
      reason: String(parsed.reason || '').trim(),
    };
  } catch (err) {
    warnRelevanceFailure('checkOfferingPlausibility', err);
    return null;
  }
}

module.exports = {
  checkDocRelevance,
  shouldQuarantine,
  checkOfferingPlausibility,
  QUARANTINE_THRESHOLD,
  // Exported for the live-schema smoke check (test/live/) only. These two carry
  // the most risk of any schema in the repo: relevance fails OPEN, so a schema
  // the provider rejects skips the competitor quarantine silently.
  DOC_SCHEMA,
  OFFERING_SCHEMA,
};
