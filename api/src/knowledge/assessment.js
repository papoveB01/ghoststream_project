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
const db = require('../db');

const MODEL = require('../models').modelFor('assessment');
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

// ── Per-competitor battlecard (aggregated across all of their docs) ──────
//
// This is the OPERATIONAL artefact reps actually read before a call. It
// synthesises:
//   - aggregate axes (weighted average of every per-doc assessment)
//   - "where we win" / "where we lose" (derived from aggregate axes)
//   - talk track (3-5 lines the rep uses when the prospect mentions this
//     competitor)
//   - objection handlers (their typical claim → our response, with evidence)
//   - migration story (how to switch a customer from them to us)
//   - verdict.headline (one-sentence honest verdict)
//
// Stored on competitors.battlecard (jsonb). Manual edits live under
// .manualEdits.<sectionKey> and override the AI fields at render time —
// regenerate keeps manualEdits intact.

const BATTLECARD_SCHEMA = {
  type: 'object',
  properties: {
    verdictHeadline: { type: 'string', description: 'One sentence, honest: the single biggest thing that decides this matchup for the buyers we care about. Plain language, no marketing voice, NEVER "we are the best at everything".' },
    whereWeWin: {
      type: 'array',
      description: 'Up to 4 specific advantages we have over THIS competitor, derived from the docs. Each is one short claim + evidence (a real fact from the docs). First-person about us.',
      items: {
        type: 'object',
        properties: {
          claim:    { type: 'string', description: 'In first person: "We win on X because Y."' },
          evidence: { type: 'string', description: 'A short verbatim quote or fact from the docs. Under 30 words.' },
        },
        required: ['claim', 'evidence'],
      },
    },
    whereWeLose: {
      type: 'array',
      description: 'Up to 4 axes where THIS competitor beats us, honestly. Each gets a claim + the concrete gap WE\'d need to close. Empty array if the docs show no clear losses.',
      items: {
        type: 'object',
        properties: {
          claim:    { type: 'string', description: 'In first person: "They beat us on X — they have Y / we don\'t." Honest.' },
          gapToOvercome: { type: 'string', description: 'ONE concrete action WE could take to flip this — a product capability, a pricing move, a partnership, a reference. Specific. NOT "improve marketing".' },
        },
        required: ['claim', 'gapToOvercome'],
      },
    },
    talkTrack: {
      type: 'array',
      description: '3-5 lines a rep SAYS OUT LOUD when the prospect mentions this competitor. Direct quotes the rep can use verbatim on a call — not bullet points. First person, conversational, no marketing voice. The first line is the leading position; the rest are follow-ups.',
      items: { type: 'string' },
    },
    objections: {
      type: 'array',
      description: 'Up to 5 things the prospect WILL claim about this competitor in a deal cycle, paired with how we respond. Each response is what the rep says (in first person), not advice. If the docs don\'t support enough objections, return fewer.',
      items: {
        type: 'object',
        properties: {
          claim:    { type: 'string', description: 'What the prospect says: "Gong is the market leader" or "We already use them for X". Their voice, paraphrased.' },
          response: { type: 'string', description: 'What WE say back, in first person. Concrete, specific, includes a fact or proof point from the docs where possible.' },
          evidence: { type: 'string', description: 'Optional: a short fact or quote that backs the response. Empty string if the response is positioning rather than fact-led.' },
        },
        required: ['claim', 'response'],
      },
    },
    migrationStory: { type: 'string', description: '2-4 sentences: HOW we move a customer off this competitor onto us. Concrete steps if the docs surface them (data migration tooling, switching incentives, parallel run period, etc.). Empty string if the docs are silent.' },
    // Optional inline scoring — used when no per-doc assessments are
    // available (the aggregate above is all zero). When per-doc data IS
    // available, the aggregate wins; these are ignored.
    axesScored: {
      type: 'array',
      description: 'OPTIONAL — only fill this in when the aggregate scoreboard above shows mostly zeros / no clear scores. Score the matchup across the 8 FIXED axes (product_strength, brand_credibility, pricing, customer_support, integrations, geographic_reach, customer_base, innovation_pace). Use evidence from the docs. Same conventions as a per-doc assessment.',
      items: {
        type: 'object',
        properties: {
          key:       { type: 'string', enum: ['product_strength', 'brand_credibility', 'pricing', 'customer_support', 'integrations', 'geographic_reach', 'customer_base', 'innovation_pace'] },
          weight:    { type: 'integer', description: '0-100, importance in this matchup. Sum across all 8 should equal 100.' },
          ourScore:  { type: 'integer', description: '0-10' },
          theirScore:{ type: 'integer', description: '0-10' },
          winner:    { type: 'string', enum: ['us', 'them', 'tie', 'unknown'] },
        },
        required: ['key', 'weight', 'ourScore', 'theirScore', 'winner'],
      },
    },
  },
  required: ['verdictHeadline', 'whereWeWin', 'whereWeLose', 'talkTrack', 'objections'],
};

// Build the synthesis prompt. The model gets: portfolio context, this
// competitor's identity, an aggregate matrix view of per-doc axes, and TWO
// symmetric evidence blocks: OUR side (our company + product intel, full
// bodies) and THEIR side (every competitor doc + per-doc assessments). The
// productName, when set, narrows OUR side to one product line.
// competitorProductName, when set, narrows THEIR side to one of their offerings.
function buildBattlecardPrompt({ competitorName, productName, competitorProductName, usEvidence, aggregatedAxes, themEvidence, market }) {
  const ourSide = productName ? `our product ${productName}` : 'our whole portfolio';
  const theirSide = competitorProductName ? `their product ${competitorProductName}` : `${competitorName}`;
  const productFocus = productName
    ? `This battlecard is for ONE of our products specifically: ${productName}. Frame "we/our" as THAT product, and judge the matchup as ${ourSide} vs ${theirSide} — not our whole portfolio. `
    : `This battlecard covers our whole portfolio against ${theirSide}. `;
  const theirFocus = competitorProductName
    ? `On the competitor side, focus specifically on their product ${competitorProductName} (one of ${competitorName}'s offerings) — judge "${theirSide}", not ${competitorName} as a whole, even though the evidence below spans the competitor. `
    : '';
  const marketFocus = market
    ? `Judge this matchup FOR THE ${market} MARKET specifically: weigh local presence, reference customers, partnerships, regulatory/compliance fit, pricing and support coverage in ${market}; prefer evidence about that market, and explicitly flag claims where the evidence doesn't cover ${market}. `
    : '';
  return (
    'You are a senior sales enablement strategist building a BATTLECARD — the artefact a rep reads RIGHT BEFORE a call where the prospect is comparing us against a specific competitor. ' +
    productFocus +
    theirFocus +
    marketFocus +
    'Write in FIRST PERSON PLURAL about us ("we", "our"), third person about the competitor and the prospect. ' +
    'The talk track and objection responses should be DIRECT QUOTES the rep can say out loud on a call — not bullet points, not theory. Conversational. Specific. ' +
    'Be honest. Where we lose, say so + name the concrete fix. Never write "we lead on everything" — that\'s useless. ' +
    'Ground every claim in the TWO evidence blocks below — OUR side and THEIR side carry equal weight; quote facts verbatim where possible. If the evidence is thin on a section, return fewer items rather than inventing. ' +
    '\n\n' +
    `===OUR SIDE — our company + product intel===\n${usEvidence || '(no company/product intel on file — score ourScore conservatively and call this out)'}\n\n` +
    `===THEIR SIDE — competitor ${competitorName}===\n\n` +
    `===AGGREGATE 8-AXIS SCOREBOARD (across all docs filed under this competitor)===\n${aggregatedAxes}\n\n` +
    `===THEIR EVIDENCE (every doc filed under this competitor, with per-doc assessments)===\n${themEvidence}`
  );
}

// Gather OUR-side evidence for a battlecard: full bodies of our scope=TENANT
// company + product docs. When productId is set we apply the house rule
// ("hard filter + global fallback", see migration 0004): product-tagged docs
// for THAT product first, then untagged company-wide docs as backfill. With
// no productId, every TENANT doc is fair game. Returns a string capped to
// `budget` chars, product-relevant docs ordered first.
async function gatherUsEvidence(tenantId, productId, budget) {
  const docs = await db.query(
    `SELECT d.id, d.title,
            string_agg(c.text, E'\n' ORDER BY c.ordinal) AS body,
            (SELECT array_agg(jp.product_id)
               FROM kb_document_products jp WHERE jp.document_id = d.id) AS product_ids
       FROM kb_documents d
       LEFT JOIN kb_chunks c ON c.document_id = d.id
      WHERE d.tenant_id = $1 AND d.scope = 'TENANT' AND d.status = 'READY'
      GROUP BY d.id
      ORDER BY d.created_at DESC
      LIMIT 30`,
    [tenantId]
  );

  let rows = docs.rows.map((r) => ({ ...r, product_ids: r.product_ids || [] }));
  if (productId) {
    // Keep docs tagged with this product OR untagged (= company-wide/global).
    rows = rows.filter((r) => r.product_ids.length === 0 || r.product_ids.includes(productId));
    // Product-specific docs first, global backfill after.
    rows.sort((a, b) => (b.product_ids.includes(productId) ? 1 : 0) - (a.product_ids.includes(productId) ? 1 : 0));
  }

  const parts = [];
  let left = budget;
  for (const r of rows) {
    if (left <= 600) break;
    const take = Math.min(3000, left - 200);
    const body = String(r.body || '').slice(0, take);
    if (!body.trim()) continue;
    const tag = productId && r.product_ids.includes(productId) ? ' [this product]' : '';
    parts.push(`## ${r.title}${tag}\n\n${body}`);
    left -= take + 100;
  }
  return parts.join('\n\n---\n\n');
}

// Aggregate the 8-axis scoreboard across all per-doc assessments. Each axis
// gets a weighted-average of our/their scores, the most common winner, and
// the concatenated evidence + gapToOvercome list. Per-doc weights matter
// more than recency for now (each doc speaks to a partial view); recency
// can be a future tiebreaker.
function aggregateAxes(perDocAssessments) {
  const out = {};
  for (const axis of AXES) {
    let totalWeight = 0;
    let ourSum = 0, theirSum = 0;
    const winnerCounts = { us: 0, them: 0, tie: 0, unknown: 0 };
    const evidence = [];
    const gaps = [];
    for (const a of perDocAssessments) {
      const row = (a.axes || []).find((x) => x.key === axis.key);
      if (!row) continue;
      const w = Math.max(0, Number(row.weight) || 0);
      if (w > 0) {
        totalWeight += w;
        ourSum  += (Number(row.ourScore)  || 0) * w;
        theirSum+= (Number(row.theirScore)|| 0) * w;
      }
      winnerCounts[row.winner || 'unknown'] = (winnerCounts[row.winner || 'unknown'] || 0) + 1;
      if (Array.isArray(row.evidence)) evidence.push(...row.evidence.slice(0, 2));
      if (row.gapToOvercome) gaps.push(row.gapToOvercome);
    }
    const us    = totalWeight ? +(ourSum   / totalWeight).toFixed(1) : 0;
    const them  = totalWeight ? +(theirSum / totalWeight).toFixed(1) : 0;
    const winner = Object.entries(winnerCounts).sort((a, b) => b[1] - a[1])[0][0];
    out[axis.key] = {
      label: axis.label,
      us, them,
      weight: Math.round(totalWeight / Math.max(perDocAssessments.length, 1)),
      winner,
      evidence: [...new Set(evidence)].slice(0, 3),
      gaps:     [...new Set(gaps)].slice(0, 3),
    };
  }
  // Weighted advantage = sum_axis( (us - them) * weight ) / total weight, scaled to %
  const summed = AXES.reduce((acc, a) => {
    const row = out[a.key];
    return acc + ((row.us - row.them) * (row.weight || 0));
  }, 0);
  const totalW = AXES.reduce((acc, a) => acc + (out[a.key].weight || 0), 0) || 1;
  const weightedAdvantage = Math.round((summed / totalW) * 10); // -100..+100 range
  return { axes: out, weightedAdvantage };
}

// Pretty-print the aggregate scoreboard for the prompt.
function formatAggregateAxesForPrompt(agg) {
  const lines = [];
  for (const a of AXES) {
    const row = agg.axes[a.key];
    if (!row) continue;
    lines.push(`- ${a.label} (weight ${row.weight}%): us ${row.us}/10, them ${row.them}/10 — winner: ${row.winner}`);
    if (row.evidence.length) lines.push(`    evidence: ${row.evidence.join(' | ')}`);
    if (row.gaps.length)     lines.push(`    gap to flip: ${row.gaps.join(' | ')}`);
  }
  lines.push(`Aggregate verdict: ${agg.weightedAdvantage > 0 ? `We lead by ${agg.weightedAdvantage}%` : agg.weightedAdvantage < 0 ? `We trail by ${Math.abs(agg.weightedAdvantage)}%` : 'Tied'}`);
  return lines.join('\n');
}

async function extractBattlecard(tenantId, competitorId, productId = null, competitorProductId = null, market = null) {
  if (!tenantId || !competitorId) {
    const e = new Error('tenantId and competitorId required'); e.status = 400; throw e;
  }
  const cr = await db.query(
    `SELECT name FROM competitors WHERE tenant_id = $1 AND id = $2`,
    [tenantId, competitorId]
  );
  if (!cr.rows[0]) { const e = new Error('competitor not found'); e.status = 404; throw e; }
  const competitorName = cr.rows[0].name;

  // Resolve OUR product line this card is scoped to (if any).
  let productName = null;
  if (productId) {
    const pr = await db.query(
      `SELECT name FROM products WHERE tenant_id = $1 AND id = $2`,
      [tenantId, productId]
    );
    if (!pr.rows[0]) { const e = new Error('product not found'); e.status = 404; throw e; }
    productName = pr.rows[0].name;
  }

  // Resolve THEIR product (offering) this card targets (if any). Frames the
  // synthesis on a specific competitor offering; evidence retrieval below stays
  // competitor-wide.
  let competitorProductName = null;
  if (competitorProductId) {
    const cpr = await db.query(
      `SELECT name FROM competitor_offerings WHERE tenant_id = $1 AND competitor_id = $2 AND id = $3`,
      [tenantId, competitorId, competitorProductId]
    );
    if (!cpr.rows[0]) { const e = new Error('competitor product not found'); e.status = 404; throw e; }
    competitorProductName = cpr.rows[0].name;
  }

  // Pull every doc tagged with this competitor along with its per-doc
  // assessment + body text. Limit to last 20 docs to cap the prompt size.
  const docs = await db.query(
    `SELECT d.id, d.title, d.metadata,
            string_agg(c.text, E'\n' ORDER BY c.ordinal) AS body
       FROM kb_documents d
       JOIN kb_document_competitors j ON j.document_id = d.id
       LEFT JOIN kb_chunks c ON c.document_id = d.id
      WHERE d.tenant_id = $1 AND j.competitor_id = $2 AND d.status = 'READY'
        AND COALESCE(d.metadata->>'relevanceVerified', 'true') <> 'false'
        AND COALESCE(d.metadata->>'isBattlecardSnapshot', '') <> 'true'
      GROUP BY d.id
      ORDER BY d.created_at DESC
      LIMIT 20`,
    [tenantId, competitorId]
  );

  // Aggregate axes from per-doc assessments.
  const perDocAssessments = docs.rows
    .map((r) => (r.metadata && r.metadata.assessment) || null)
    .filter(Boolean);
  const aggregated = aggregateAxes(perDocAssessments);
  const sourceDocIds = docs.rows.map((r) => r.id);

  // Build THEIR evidence block — capped per-doc so the prompt stays manageable.
  // Half the input budget goes here; the other half to OUR side below, so the
  // two sides of the matchup are weighed symmetrically.
  const themBudget = Math.floor(INPUT_CAP / 2);
  const evidenceParts = [];
  let budget = themBudget;
  for (const r of docs.rows) {
    if (budget <= 800) break;
    const take = Math.min(3000, budget - 400);
    const body = String(r.body || '').slice(0, take);
    const aSummary = (r.metadata && r.metadata.assessment && r.metadata.assessment.summary) || '';
    evidenceParts.push(
      `## ${r.title}` +
      (aSummary ? `\n[per-doc verdict] ${aSummary}` : '') +
      `\n\n${body}`
    );
    budget -= take + 200;
  }
  const themEvidence = evidenceParts.join('\n\n---\n\n');
  // Bail only when there's literally no source material. Per-doc assessments
  // are PREFERRED evidence (they pre-score the matchup), but raw doc bodies
  // are perfectly usable on their own — Gemini scores the axes inline from
  // the text when nothing is pre-aggregated.
  if (!themEvidence) {
    return {
      verdictHeadline: null,
      whereWeWin: [], whereWeLose: [],
      talkTrack: [], objections: [], migrationStory: null,
      axes: aggregated.axes,
      weightedAdvantage: aggregated.weightedAdvantage,
      sourceDocIds,
      productId: productId || null,
      competitorProductId: competitorProductId || null,
      market: market || null,
      manualEdits: {},
      lastRefreshedAt: new Date().toISOString(),
      model: null,
      empty: true,
    };
  }

  // OUR side: full-body company + product intel, scoped to this product line
  // when one is pinned. Gets the other half of the input budget so it weighs
  // symmetrically against the competitor dossier. Falls back to the lighter
  // tenant-context summary if no TENANT docs exist yet.
  let usEvidence = await gatherUsEvidence(tenantId, productId, INPUT_CAP - themBudget);
  if (!usEvidence) usEvidence = await keypoints.tenantContextText(tenantId);

  const prompt = buildBattlecardPrompt({
    competitorName,
    productName,
    competitorProductName,
    usEvidence,
    aggregatedAxes: formatAggregateAxesForPrompt(aggregated),
    themEvidence,
    market,
  });

  try {
    const ai = gemini.getClient();
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 2600,
        responseMimeType: 'application/json',
        responseSchema: BATTLECARD_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);

    // If we have no per-doc aggregate (all axes weight=0), use Gemini's
    // inline scoring as the matrix. Otherwise the aggregate wins.
    let axes = aggregated.axes;
    let weightedAdvantage = aggregated.weightedAdvantage;
    const hasAggregate = Object.values(aggregated.axes).some((a) => (a.weight || 0) > 0);
    if (!hasAggregate && Array.isArray(parsed.axesScored) && parsed.axesScored.length) {
      const inline = {};
      for (const a of AXES) {
        const row = parsed.axesScored.find((x) => x.key === a.key);
        if (!row) continue;
        const us   = Math.max(0, Math.min(10, parseInt(row.ourScore,  10) || 0));
        const them = Math.max(0, Math.min(10, parseInt(row.theirScore, 10) || 0));
        const w    = Math.max(0, Math.min(100, parseInt(row.weight, 10) || 0));
        inline[a.key] = {
          label: a.label, us, them, weight: w,
          winner: ['us', 'them', 'tie', 'unknown'].includes(row.winner) ? row.winner : 'unknown',
          evidence: [], gaps: [],
        };
      }
      axes = inline;
      const summed = AXES.reduce((acc, a) => acc + (((inline[a.key]?.us || 0) - (inline[a.key]?.them || 0)) * (inline[a.key]?.weight || 0)), 0);
      const totalW = AXES.reduce((acc, a) => acc + (inline[a.key]?.weight || 0), 0) || 1;
      weightedAdvantage = Math.round((summed / totalW) * 10);
    }

    return {
      verdictHeadline: String(parsed.verdictHeadline || '').trim() || null,
      whereWeWin:      Array.isArray(parsed.whereWeWin)  ? parsed.whereWeWin.slice(0, 4)  : [],
      whereWeLose:     Array.isArray(parsed.whereWeLose) ? parsed.whereWeLose.slice(0, 4) : [],
      talkTrack:       Array.isArray(parsed.talkTrack)   ? parsed.talkTrack.filter(Boolean).slice(0, 5) : [],
      objections:      Array.isArray(parsed.objections)  ? parsed.objections.slice(0, 5)  : [],
      migrationStory:  String(parsed.migrationStory || '').trim() || null,
      axes,
      weightedAdvantage,
      sourceDocIds,
      productId: productId || null,
      competitorProductId: competitorProductId || null,
      market: market || null,
      // Manual edits are preserved by the caller — extractBattlecard only
      // produces the AI fields; the route stitches them with stored edits.
      lastRefreshedAt: new Date().toISOString(),
      model: MODEL,
    };
  } catch (err) {
    console.warn('[battlecard] synthesis failed:', err.message);
    const e = new Error(`battlecard synthesis failed: ${err.message}`);
    e.status = 502;
    throw e;
  }
}

// Merge manual edits over the auto-generated battlecard. Manual edits can
// override any of: verdictHeadline, whereWeWin, whereWeLose, talkTrack,
// objections, migrationStory. Per-section overrides win whole — partial
// merges (e.g. edit one line in talkTrack) are not supported in v1.
function mergeBattlecard(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const m = stored.manualEdits || {};
  return {
    ...stored,
    verdictHeadline: m.verdictHeadline   !== undefined ? m.verdictHeadline : stored.verdictHeadline,
    whereWeWin:      m.whereWeWin        !== undefined ? m.whereWeWin     : stored.whereWeWin,
    whereWeLose:     m.whereWeLose       !== undefined ? m.whereWeLose    : stored.whereWeLose,
    talkTrack:       m.talkTrack         !== undefined ? m.talkTrack      : stored.talkTrack,
    objections:      m.objections        !== undefined ? m.objections     : stored.objections,
    migrationStory:  m.migrationStory    !== undefined ? m.migrationStory : stored.migrationStory,
    // Surface which sections were rep-edited so the UI can show the indicator.
    editedSections:  Object.keys(m),
  };
}

module.exports = { extractCompetitiveAssessment, renderAssessmentText, AXES, AXIS_KEYS, extractBattlecard, mergeBattlecard };
