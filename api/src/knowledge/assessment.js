// Competitive Scoreboard — structured "us vs them" assessment for battlecards.
//
// Runs alongside extractKeyPoints whenever a COMPETITOR-scoped doc (or any
// BATTLECARDS doc) is ingested. Produces a per-axis weighted scoreboard, an
// overall verdict, and the top improvements we'd need to make to flip the
// matchup. Stored on metadata.assessment so the Library can render it
// without re-calling Gemini, and folded into the global cache text body
// so the Arena AI uses it when roleplaying a prospect.
//
// Honesty discipline: the prompt forces the model to (a) base every score
// on evidence quoted from the doc, (b) say "unknown" with weight 0 when
// the doc is silent on an axis, and (c) put the gap-to-overcome and
// improvement plan in our own voice — i.e. concrete work WE need to do,
// not generic sales platitudes.
//
// Axes are FIXED (8) so cards are comparable across competitors. The LLM
// proposes weights per card (sum=100), reflecting what matters most in
// THIS matchup.

const gemini = require('../gemini');
const keypoints = require('./keypoints');

const MODEL =
  process.env.GEMINI_ASSESSMENT_MODEL ||
  process.env.GEMINI_ANALYSIS_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-2.5-flash';
const INPUT_CAP = parseInt(process.env.KB_ASSESSMENT_INPUT_CAP || '16000', 10);

// Fixed scoreboard axes. Names are stable strings used both server-side
// (verdict computation) and client-side (rendering). DO NOT rename without
// migrating stored metadata.assessment payloads.
const AXES = [
  { key: 'product_strength',   label: 'Product strength',          hint: 'breadth & depth of features, technical capability, reliability' },
  { key: 'brand_credibility',  label: 'Brand credibility',         hint: 'name recognition, analyst standing, marketing presence, trust' },
  { key: 'pricing',            label: 'Pricing',                   hint: 'list price, value perception, packaging flexibility, TCO' },
  { key: 'customer_support',   label: 'Customer support',          hint: 'response time, account management, professional services' },
  { key: 'integrations',       label: 'Integrations & ecosystem',  hint: 'API quality, partner network, marketplace presence' },
  { key: 'geographic_reach',   label: 'Geographic / market reach', hint: 'regions served, local presence, regulatory coverage' },
  { key: 'customer_base',      label: 'Customer base & references',hint: 'logos, case studies, segments penetrated, referenceability' },
  { key: 'innovation_pace',    label: 'Innovation pace',           hint: 'release velocity, R&D investment, roadmap public posture' },
];
const AXIS_KEYS = AXES.map((a) => a.key);

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences naming the single biggest reason this competitor wins or loses for the buyers WE care about. Honest. No marketing voice.' },
    axes: {
      type: 'array',
      description: 'Exactly the 8 fixed axes, in any order. Every axis MUST appear. If the doc is silent on an axis, set winner="unknown", weight=0, scores=0, and explain in evidence/gapToOvercome why no judgement is possible.',
      items: {
        type: 'object',
        properties: {
          key:       { type: 'string', enum: AXIS_KEYS, description: 'Axis identifier — must be one of the fixed 8.' },
          weight:    { type: 'integer', description: 'Importance of this axis IN THIS matchup, 0-100. Sum across all 8 axes MUST equal 100. Set 0 only when the axis is genuinely irrelevant (rare) or unknown.' },
          ourScore:  { type: 'integer', description: 'How strong WE are on this axis, 0-10 (10 = best in market). Based on the tenant portfolio + objectives context above.' },
          theirScore:{ type: 'integer', description: 'How strong the COMPETITOR is on this axis, 0-10. Based ONLY on evidence in the dossier.' },
          winner:    { type: 'string', enum: ['us', 'them', 'tie', 'unknown'], description: 'us = we win clearly; them = they win clearly; tie = within 1 point; unknown = doc has nothing.' },
          evidence:  { type: 'array', items: { type: 'string' }, description: 'Up to 3 short quotes/facts from the dossier that justify theirScore. Real text from the doc — not invented.' },
          gapToOvercome: { type: 'string', description: 'If winner=them or tie: ONE concrete thing WE need to build, change, or message to flip this. Empty string when winner=us or unknown.' },
        },
        required: ['key', 'weight', 'ourScore', 'theirScore', 'winner', 'evidence', 'gapToOvercome'],
      },
    },
    topImprovements: {
      type: 'array',
      description: 'The 3 highest-leverage improvements OUR side should prioritise to win deals against this competitor. Concrete and specific — name a product capability, a pricing change, a reference customer to land, etc. Ordered most-impactful first.',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'axes', 'topImprovements'],
};

const PROMPT =
  'You are a competitive intelligence analyst writing a battlecard scoreboard. ' +
  'Below is OUR company\'s product portfolio and objectives, then a COMPETITOR dossier. ' +
  'Score the matchup HONESTLY across the 8 FIXED axes. Be willing to say we lose on axes where the doc shows it. ' +
  '\n\nRules: ' +
  '(1) Every score must be defensible from the dossier — for theirScore, quote evidence verbatim or paraphrase a real fact. For ourScore, base it on OUR portfolio above (or our generally known posture if portfolio is empty). ' +
  '(2) Weights reflect what actually matters when selling against THIS competitor in this market — sum exactly to 100 across all 8 axes. If an axis is irrelevant or unknown, give it weight 0 and move that budget elsewhere. ' +
  '(3) When winner is "them" or "tie", gapToOvercome must name ONE concrete thing we need to do — a product capability to build, a packaging move, a partnership, a reference to land. Generic phrases like "improve brand awareness" are NOT acceptable; be specific. ' +
  '(4) topImprovements is our prioritised action list — three items, biggest lever first, each tied to a real gap surfaced above. ' +
  '(5) "summary" must name the SINGLE biggest reason we win or lose this matchup. No diplomatic hedging. ' +
  '\n\nCRITICAL — completely ignore website boilerplate (cookie/consent banners, privacy notices, terms-of-use, navigation). None of that is evidence; never quote it.';

// Retry on transient Gemini errors (mirrors research.js with the same
// per-day-quota carve-out so we don't burn retries when the daily cap hit).
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
      console.warn(`[assessment] transient Gemini error (attempt ${i + 1}/${tries}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Coerce + validate the model's output. Fills missing axes with unknown rows,
// trims weights to sum 100, clamps scores to [0,10], derives weightedAdvantage.
function normalize(raw) {
  const byKey = new Map();
  for (const a of Array.isArray(raw.axes) ? raw.axes : []) {
    if (!a || !AXIS_KEYS.includes(a.key)) continue;
    byKey.set(a.key, {
      key: a.key,
      weight:     Math.max(0, Math.min(100, parseInt(a.weight, 10) || 0)),
      ourScore:   Math.max(0, Math.min(10,  parseInt(a.ourScore, 10) || 0)),
      theirScore: Math.max(0, Math.min(10,  parseInt(a.theirScore, 10) || 0)),
      winner:     ['us', 'them', 'tie', 'unknown'].includes(a.winner) ? a.winner : 'unknown',
      evidence:   (Array.isArray(a.evidence) ? a.evidence : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3),
      gapToOvercome: String(a.gapToOvercome || '').trim(),
    });
  }
  // Fill any missing axis with an unknown placeholder so the UI shape is stable.
  const axes = AXES.map((spec) => byKey.get(spec.key) || {
    key: spec.key, weight: 0, ourScore: 0, theirScore: 0,
    winner: 'unknown', evidence: [], gapToOvercome: '',
  }).map((a) => ({ ...a, label: AXES.find((s) => s.key === a.key).label }));

  // Force weights to sum to 100 — if the model is off, scale and bias the
  // largest axis to absorb the rounding remainder. If all weights are 0
  // (model bailed entirely), distribute evenly across known-winner axes.
  let sum = axes.reduce((s, a) => s + a.weight, 0);
  if (sum <= 0) {
    const winnable = axes.filter((a) => a.winner !== 'unknown');
    if (winnable.length) {
      const w = Math.floor(100 / winnable.length);
      winnable.forEach((a, i) => { a.weight = w + (i === 0 ? 100 - w * winnable.length : 0); });
      sum = 100;
    }
  } else if (sum !== 100) {
    const scaled = axes.map((a) => ({ ...a, weight: Math.round((a.weight / sum) * 100) }));
    let diff = 100 - scaled.reduce((s, a) => s + a.weight, 0);
    // Apply diff to the heaviest axis to keep the rest stable.
    scaled.sort((a, b) => b.weight - a.weight);
    if (scaled[0]) scaled[0].weight += diff;
    // Restore original axis order by key.
    const order = AXIS_KEYS;
    scaled.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    for (let i = 0; i < axes.length; i++) axes[i] = scaled[i];
  }

  // Weighted advantage = sum(weight * (ourScore - theirScore)) / 100, mapped
  // from [-10, +10] to [-100%, +100%]. Positive = we lead, negative = we trail.
  const rawAdv = axes.reduce((s, a) => s + a.weight * (a.ourScore - a.theirScore), 0) / 100;
  const weightedAdvantage = Math.round(rawAdv * 10); // -100..100

  return {
    summary: String(raw.summary || '').trim(),
    axes,
    topImprovements: (Array.isArray(raw.topImprovements) ? raw.topImprovements : [])
      .map((s) => String(s || '').replace(/^[-*•\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 3),
    weightedAdvantage,
    axesSpec: AXES,
    generatedAt: new Date().toISOString(),
    version: 1,
  };
}

// extractCompetitiveAssessment({ text, tenantId?, title?, competitorName?, appliesProductNames? })
//   → { summary, axes[8], topImprovements[≤3], weightedAdvantage, axesSpec, version, generatedAt }
// `appliesProductNames` — names of OUR products this battlecard applies to. Empty
// array (or null) is interpreted as "all our products" and the model scores
// against the full portfolio. Non-empty narrows the lens so a "Fraud Solution
// vs Acme" card doesn't get scored on irrelevant payment-gateway features.
// Never throws — returns null on any failure so ingest proceeds.
async function extractCompetitiveAssessment({ text, tenantId = null, title = null, competitorName = null, appliesProductNames = [] } = {}) {
  const body = keypoints.stripBoilerplate(String(text || ''));
  if (body.length < 80) return null;

  let context = '';
  try { context = await keypoints.tenantContextText(tenantId); } catch { context = ''; }

  const scope = Array.isArray(appliesProductNames) && appliesProductNames.length
    ? `This battlecard scores OUR offering on these specific products: ${appliesProductNames.join(', ')}. Restrict ourScore reasoning to these — ignore unrelated parts of our portfolio.`
    : `This battlecard scores OUR full portfolio against the competitor (no product restriction was set).`;

  try {
    const ai = gemini.getClient();
    const axesBlock = AXES.map((a) => `- ${a.key} (${a.label}): ${a.hint}`).join('\n');
    const prompt =
      `${PROMPT}\n\n` +
      `===THE 8 FIXED AXES===\n${axesBlock}\n\n` +
      `===SCOPE===\n${scope}\n\n` +
      (context
        ? `===OUR COMPANY (portfolio & objectives)===\n${context}\n\n`
        : `===OUR COMPANY===\n(No portfolio on file — score ourScore conservatively and call this out in the summary.)\n\n`) +
      `===COMPETITOR${competitorName ? `: ${competitorName}` : ''}${title ? ` — ${title}` : ''}===\n${body.slice(0, INPUT_CAP)}`;
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.25,
        maxOutputTokens: 2400,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const parsed = JSON.parse(resp.text);
    return normalize(parsed);
  } catch (err) {
    console.warn('[assessment] extraction failed:', err.message);
    return null;
  }
}

// Compact text rendering of a stored assessment — used by globalCache.js
// to fold the scoreboard into the Arena's grounding payload. Designed to be
// short and LLM-readable, NOT a UI surface.
function renderAssessmentText(assessment) {
  if (!assessment || !Array.isArray(assessment.axes)) return '';
  const verdict = assessment.weightedAdvantage > 5  ? `we LEAD by ${assessment.weightedAdvantage}%`
                : assessment.weightedAdvantage < -5 ? `we TRAIL by ${Math.abs(assessment.weightedAdvantage)}%`
                : `roughly TIED (${assessment.weightedAdvantage >= 0 ? '+' : ''}${assessment.weightedAdvantage}%)`;
  const lines = [
    `Scoreboard verdict: ${verdict}.`,
    assessment.summary ? `Summary: ${assessment.summary}` : null,
    'Axes (weight · us/them · winner · gap):',
    ...assessment.axes.map((a) => {
      const w = `${a.weight}%`;
      const score = `${a.ourScore}/${a.theirScore}`;
      const gap = a.gapToOvercome ? ` — gap: ${a.gapToOvercome}` : '';
      const label = (AXES.find((s) => s.key === a.key) || {}).label || a.key;
      return `  • ${label} [${w} · ${score} · ${a.winner}]${gap}`;
    }),
    assessment.topImprovements && assessment.topImprovements.length
      ? `Top improvements we need: ${assessment.topImprovements.map((s, i) => `(${i + 1}) ${s}`).join(' ')}`
      : null,
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = { extractCompetitiveAssessment, renderAssessmentText, AXES, AXIS_KEYS };
