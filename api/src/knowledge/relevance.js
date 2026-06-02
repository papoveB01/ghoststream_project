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

const gemini = require('../gemini');

const MODEL = require('../models').modelFor('relevance');

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

// Retry on transient Gemini errors (mirrors assessment.js, including the
// per-day-quota carve-out so we don't burn retries against the daily cap).
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      const is429 = /\b429\b|RESOURCE_EXHAUSTED/i.test(msg);
      const isDailyQuota = /per[_\s-]?day|PerDay|free_tier_requests/i.test(msg);
      const transient = /\b(503|UNAVAILABLE|overloaded)\b|high demand|deadline[ _]?exceeded/i.test(msg) || (is429 && !isDailyQuota);
      if (!transient || i === tries - 1) throw err;
      const m = msg.match(/retryDelay["']?\s*[:=]\s*["']?(\d+)/i);
      const waitMs = m ? Math.min(parseInt(m[1], 10) * 1000 + 500, 30000) : 2000 * (i + 1);
      console.warn(`[relevance] transient Gemini error (attempt ${i + 1}/${tries}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Is this document actually about the competitor (and named product, if any)?
// Returns { isOnTopic, confidence, reason } or null on any failure (fail-open).
async function checkDocRelevance({ text, title = null, competitorName = null, competitorProductName = null } = {}) {
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
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 400,
        responseMimeType: 'application/json',
        responseSchema: DOC_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const parsed = JSON.parse(resp.text);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return {
      isOnTopic: parsed.isOnTopic === true,
      confidence,
      reason: String(parsed.reason || '').trim(),
    };
  } catch (err) {
    console.warn(`[relevance] checkDocRelevance failed (fail-open): ${(err && err.message) || err}`);
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
async function checkOfferingPlausibility({ competitorName = null, productName = null } = {}) {
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
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 200,
        responseMimeType: 'application/json',
        responseSchema: OFFERING_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const parsed = JSON.parse(resp.text);
    return {
      plausible: parsed.plausible !== false,
      reason: String(parsed.reason || '').trim(),
    };
  } catch (err) {
    console.warn(`[relevance] checkOfferingPlausibility failed (skip warning): ${(err && err.message) || err}`);
    return null;
  }
}

module.exports = {
  checkDocRelevance,
  shouldQuarantine,
  checkOfferingPlausibility,
  QUARANTINE_THRESHOLD,
};
