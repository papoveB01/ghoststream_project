// AI key-point extraction for Knowledge-Base intel.
//
// Run at ingest time (and on demand, for backfill) and STORED on the document's
// metadata as { keyPoints: [...], keyPointsKind: '...' } so the Library can show
// it without re-calling the model on every page load.
//
// The whole point is to be *useful to a salesperson at THIS tenant*, not to
// summarize the page. So:
//   • We feed the model the tenant's own portfolio + objectives (their product
//     lines and the start of their company KB docs) as context.
//   • COMPETITOR docs → "competitive points": what the competitor offers, the
//     strengths they claim, gaps/weaknesses, pricing posture, and explicitly
//     WHERE WE WIN versus them (tied to our actual products).
//   • PROSPECT docs → "opportunity points": which of the prospect's initiatives /
//     pains / signals / numbers create an opening, and which of OUR products map
//     to it — plus likely decision-maker and timing signals.
//   • Web-scrape boilerplate (cookie/consent banners, nav, footers, legal) is
//     stripped before extraction AND the prompt is told to ignore it. If little
//     of substance remains, the model returns few or no points (no padding).

const gemini = require('../gemini');
const db = require('../db');

const MODEL = require('../models').modelFor('keypoints');
const INPUT_CAP   = parseInt(process.env.KB_KEYPOINTS_INPUT_CAP || '16000', 10);
const CONTEXT_CAP = parseInt(process.env.KB_KEYPOINTS_CONTEXT_CAP || '5000', 10);

// ── boilerplate stripping ─────────────────────────────────────────────────
// Web scrapes (esp. of corporate / banking sites) drag in cookie & consent
// banners, "we value your privacy" paragraphs, nav menus, footers and legal
// text — Firecrawl often flattens a whole banner onto one long line. We drop a
// line if (a) it matches a strong cookie/consent/legal pattern anywhere, (b)
// it's short and matches a nav/footer pattern, (c) it's a bare row of markdown
// links (a menu), or (d) it packs ≥2 distinct consent/privacy keyword groups
// (catches "We take your privacy seriously and process your personal
// information in accordance with applicable regulations, continue…").
const STRONG_BOILERPLATE =
  /\b(this (site|website|page) uses cookies|uses? cookies|cookie (policy|preferences|settings|consent|notice|banner)|we( and (our|selected) partners)? use cookies|similar (technologies|methods) to (recognize|recognise|store|access)|consent (banner|management|preferences|to the (use|storing))|necessary cookies|analytics cookies|marketing cookies|functional cookies|essential (for|to) the (site|website) to function|gdpr|ccpa|all rights reserved|©\s*\d{4}|privacy (policy|notice|statement|centre|center|choices|settings)|terms (of use|of service|and conditions|& conditions)|accept all cookies?|reject all cookies?|manage (your )?(cookie )?preferences|do not sell (or share )?(my )?(personal )?(info|information|data)|by continuing (to (use|browse)|you (agree|consent))|you can (change|update|withdraw|manage) your (consent|cookie )?(preferences|settings)|we (value|take|respect) your privacy|your privacy (matters|is important to us))/i;
const NAV_BOILERPLATE =
  /\b(skip to (main )?content|sign ?in|log ?in|sign ?up|register|subscribe|newsletter|follow us|share (this|on)|download (on|the) app|app ?store|google play|play store|back to top|main menu|toggle navigation|search\.\.\.|read more|learn more|more information|cookie settings)\b/i;
// A bare row of markdown links — a navigation menu.
const LINK_ROW = /^\s*(\[[^\]]+\]\([^)]*\)\s*[|·••]?\s*){2,}\s*$/;
// Distinct consent/privacy keyword groups; ≥2 different ones firing ⇒ boilerplate.
const CONSENT_GROUPS = [
  /\bcookies?\b/i,
  /\bconsent\b/i,
  /\bprivacy\b/i,
  /\bpersonal (information|data)\b/i,
  /\b(applicable )?(regulation|legislation|gdpr|ccpa|data protection)\b/i,
  /\bpreferences?\b/i,
  /\bopt[- ]?(in|out)\b/i,
  /\bby (continuing|using (this|our) (site|website|service))\b/i,
  /\bwe and (our|selected) partners\b/i,
  /\b(process|collect|store|use) your (personal|browsing|behavioural|behavioral)\b/i,
];

function consentDensity(line) {
  let hits = 0;
  for (const re of CONSENT_GROUPS) { if (re.test(line)) { if (++hits >= 2) return hits; } }
  return hits;
}

function stripBoilerplate(text) {
  return String(text || '')
    .split('\n')
    .filter((raw) => {
      const line = raw.trim();
      if (!line) return true;                                       // keep blanks (paragraph structure)
      if (STRONG_BOILERPLATE.test(line)) return false;              // strong cookie/consent/legal — drop at any length
      if (LINK_ROW.test(line)) return false;                        // a nav menu (row of markdown links)
      if (line.length <= 80 && NAV_BOILERPLATE.test(line)) return false; // short nav/footer lines
      if (consentDensity(line) >= 2) return false;                  // consent-keyword-dense line (flattened banner)
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SCHEMA = {
  type: 'object',
  properties: {
    points: {
      type: 'array',
      description:
        'Up to 7 short, high-signal bullet points — each a single clause or sentence a sales rep could act on. ' +
        'NEVER about cookies, consent, privacy policies, website terms, or navigation. ' +
        'Fewer beats padding: if the content is thin or mostly website boilerplate, return only the genuinely useful points (or an empty array). No markdown, no leading dashes.',
      items: { type: 'string' },
    },
  },
  required: ['points'],
};

const IGNORE_CLAUSE =
  'CRITICAL: completely ignore website chrome and boilerplate — cookie/consent banners, "we use cookies", "we value/take your privacy", "we process your personal information in accordance with regulations", "by continuing to use this site", privacy policies, terms of use, navigation menus, sign-in / subscribe prompts, app-store badges, footers, copyright lines. None of that is a fact, a signal, or a key point — never quote or paraphrase it. ' +
  'After ignoring that, if there is little of real substance left, return very few points or an empty list rather than inventing or restating fluff.';

function kindFor(scope) {
  const s = String(scope || '').toUpperCase();
  if (s === 'COMPETITOR') return 'competitive';
  if (s === 'PROSPECT') return 'opportunity';
  return 'summary';
}

function promptFor(kind, hasContext) {
  if (kind === 'competitive') {
    return (
      'You are a sales engineer building a competitive battlecard. ' +
      (hasContext
        ? "Below is OUR company's product portfolio and objectives, then content about a COMPETITOR. " +
          'Produce bullet points that MATTER FOR WINNING DEALS against them: what they offer, the strengths they claim, their gaps and weaknesses, their pricing & packaging posture, and explicitly WHERE WE WIN versus them — name the specific product or capability of ours that beats them on each axis. '
        : 'Below is content about a COMPETITOR. Produce bullet points that matter for competing: what they offer, the strengths they claim, their gaps and weaknesses, their pricing posture, and where a differentiated product could win. ') +
      'Be concrete — quote real product names, numbers, and claims from the text. ' + IGNORE_CLAUSE
    );
  }
  if (kind === 'opportunity') {
    return (
      'You are a strategic account executive. ' +
      (hasContext
        ? "Below is OUR company's product portfolio and objectives, then intel about a PROSPECT we want to sell to. " +
          'Produce SALES-OPPORTUNITY bullet points that CONNECT the prospect to our portfolio: which of THEIR initiatives, pains, signals, results, or numbers create an opening — and which specific product or capability of OURS maps to it (name it). ' +
          'Reason about WHY each is an opening; don\'t just list facts. Also call out the likely decision-maker / champion and any timing signal. Lead with the strongest plays. '
        : 'Below is intel about a PROSPECT we want to sell to. Produce sales-opportunity bullet points: which of their initiatives, pains, signals, or numbers create an opening; the likely decision-makers / champions; timing signals; and the angle to lead with. Reason about WHY each is an opening, don\'t just list facts. ') +
      'Be concrete — quote real names, numbers, and stated facts. ' + IGNORE_CLAUSE
    );
  }
  return 'Extract up to 7 short, factual bullet points capturing the key information in this content. Quote real names and numbers. ' + IGNORE_CLAUSE;
}

// A compact view of the tenant: their Intelligence-Matrix product lines (with
// descriptions) plus the start of their TENANT-scoped KB docs (their company
// overview / positioning / objectives). Used for BOTH competitive and
// opportunity extraction so the points are framed in terms of our portfolio.
async function tenantContextText(tenantId) {
  if (!tenantId) return '';
  try {
    const prod = await db.query(
      `SELECT name, COALESCE(description, '') AS description
         FROM products WHERE tenant_id = $1 ORDER BY lower(name) LIMIT 30`,
      [tenantId]
    );
    const productBlock = prod.rows.length
      ? 'Our product lines:\n' + prod.rows.map((r) => `- ${r.name}${r.description ? ': ' + r.description : ''}`).join('\n')
      : '';
    // Editable company positioning/objectives (tenant_profiles) — the rep-controlled
    // foundation. Prepended first so it leads the context for every synthesis.
    let profileBlock = '';
    const prof = await db.query(
      `SELECT positioning, objectives FROM tenant_profiles WHERE tenant_id = $1`,
      [tenantId]
    );
    if (prof.rows[0]) {
      const pp = [];
      if (prof.rows[0].positioning) pp.push(`Positioning: ${prof.rows[0].positioning}`);
      if (prof.rows[0].objectives) pp.push(`Objectives: ${prof.rows[0].objectives}`);
      if (pp.length) profileBlock = 'Our positioning & objectives:\n' + pp.join('\n');
    }
    let budget = CONTEXT_CAP - productBlock.length - profileBlock.length - 64;
    let docBlock = '';
    if (budget > 400) {
      const basis = await db.query(
        `SELECT d.title, string_agg(c.text, E'\n' ORDER BY c.ordinal) AS body
           FROM kb_documents d JOIN kb_chunks c ON c.document_id = d.id
          WHERE d.tenant_id = $1 AND d.scope = 'TENANT' AND d.status = 'READY'
          GROUP BY d.id, d.title, d.created_at
          ORDER BY d.created_at DESC LIMIT 5`,
        [tenantId]
      );
      const parts = [];
      for (const r of basis.rows) {
        if (budget <= 200) break;
        const take = Math.min(1500, budget - 80);
        parts.push(`## ${r.title}\n${String(r.body || '').slice(0, take)}`);
        budget -= take + 8;
      }
      if (parts.length) docBlock = 'About our company (from our knowledge base):\n' + parts.join('\n\n');
    }
    return [profileBlock, productBlock, docBlock].filter(Boolean).join('\n\n').slice(0, CONTEXT_CAP).trim();
  } catch {
    return '';
  }
}

// extractKeyPoints({ scope, text, tenantId?, title? }) → { kind, points: [...] }
// Never throws — returns { kind, points: [] } on any failure so ingest can proceed.
async function extractKeyPoints({ scope, text, tenantId = null, title = null } = {}) {
  const kind = kindFor(scope);
  const body = stripBoilerplate(text);
  if (body.length < 80) return { kind, points: [] };

  let context = '';
  if (kind === 'competitive' || kind === 'opportunity') context = await tenantContextText(tenantId);

  try {
    const ai = gemini.getClient();
    const subjectLabel = kind === 'competitive' ? 'COMPETITOR' : kind === 'opportunity' ? 'PROSPECT' : 'CONTENT';
    const prompt =
      `${promptFor(kind, !!context)}\n\n` +
      (context ? `===OUR COMPANY (portfolio & objectives)===\n${context}\n\n` : '') +
      `===${subjectLabel}${title ? ` — ${title}` : ''}===\n${body.slice(0, INPUT_CAP)}`;
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 900,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    const points = (Array.isArray(parsed.points) ? parsed.points : [])
      .map((p) => String(p || '').replace(/^[-*•\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 7);
    return { kind, points };
  } catch (err) {
    console.warn('[keypoints] extraction failed:', err.message);
    return { kind, points: [] };
  }
}

// ── Company analysis (TENANT-scoped docs) ────────────────────────────────
//
// When a doc is filed against the rep's own company (scope=TENANT) the
// generic key-point extractor is too thin — sales reps want a sales-ready
// briefing: what we sell, where we win, who we look like in the market.
// extractCompanyAnalysis returns a structured payload that the UI renders
// as a richer view than a bullet list.
//
// Fields:
//   executiveSummary       1-2 sentences: what this company sells + to whom
//   services[]             distinct offerings called out in the doc
//                            { name, description, audience }
//   strengths[]            differentiators with a short evidence quote
//                            { claim, evidence }
//   marketPosition         category we play in + the angle we sell on +
//                          honest weaknesses or unaddressed gaps
//                            { category, differentiator, weaknesses[] }
//   competitors[]          named adjacent vendors we'd come up against
//                            { name, reason, overlap: 'high'|'medium'|'low' }
//   idealCustomerProfile   ICP description: industry / size / signals
//   salesAngles[]          where this doc is most useful in the funnel
//                          (e.g. "Lead with this in a CFO discovery call to
//                          counter the 'AI tools don't move the number' objection")
//
// All fields are optional inside the schema — Gemini drops what's not in
// the doc rather than inventing. Empty arrays / null are acceptable.

const COMPANY_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    executiveSummary: { type: 'string', description: '1-2 sentences IN FIRST PERSON PLURAL ("WE …"): what OUR company does, what WE sell, and the kind of customer WE serve. The kind of sentence a new salesperson on OUR team would write on day one. NEVER frame this as "this document covers X" — always as "We do X".' },
    services: {
      type: 'array',
      description: 'Distinct services or product offerings WE provide that are described in this doc (not the whole portfolio — only what THIS doc covers).',
      items: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'Exact name of OUR offering as it appears in the doc.' },
          description: { type: 'string', description: '1 sentence written from OUR side: "We do X for buyers who Y" or "It does X for our customers". Not a buyer-side description.' },
          audience:    { type: 'string', description: 'WHO BUYS THIS FROM US — role, industry, scale. Empty if not stated.' },
        },
        required: ['name', 'description'],
      },
    },
    strengths: {
      type: 'array',
      description: 'Up to 5 of OUR differentiators that this doc credibly establishes. First-person: "We are the only…", "We provide…". Each gets a one-sentence claim PLUS a short verbatim quote from the doc as evidence so a rep can re-use the line on a call.',
      items: {
        type: 'object',
        properties: {
          claim:    { type: 'string', description: 'The differentiator stated plainly, in first person ("We …").' },
          evidence: { type: 'string', description: 'A short verbatim quote from this doc. Keep under 30 words. Use exact numbers/names if any.' },
        },
        required: ['claim', 'evidence'],
      },
    },
    marketPosition: {
      type: 'object',
      description: 'Where WE sit in the market.',
      properties: {
        category:       { type: 'string', description: 'The category WE compete in — buyers\' words, not marketing words.' },
        differentiator: { type: 'string', description: '1 sentence in first person: "WE win because…". The honest defensible reason a buyer picks US over the obvious alternative.' },
        weaknesses: {
          type: 'array',
          description: 'Up to 3 things WE don\'t address in this doc — gaps a buyer would push back on. Each in first person ("We don\'t cover X", "Our pricing isn\'t addressed here"). Empty array if the doc is itself thin.',
          items: { type: 'string' },
        },
      },
    },
    competitors: {
      type: 'array',
      description: 'Up to 6 named vendors / products WE compete with in the same buying conversation. Use real, current company names a buyer would recognise (Gong, Outreach, Salesforce, Chorus, Apollo, …). For each, name the closest overlap with US.',
      items: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Company / product name.' },
          reason:  { type: 'string', description: '1 sentence: "They overlap with us on X" or "We beat them on Y".' },
          overlap: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = same primary use case as us; medium = adjacent; low = occasional shoot-out.' },
        },
        required: ['name', 'reason', 'overlap'],
      },
    },
    idealCustomerProfile: { type: 'string', description: '1-2 sentences DESCRIBING OUR BUYER (the customer WE sell to): "Our buyer is X in Y kind of company. They typically have Z signal." Always third-person about the buyer + first-person about us — never "this document targets" framing.' },
    salesAngles: {
      type: 'array',
      description: 'Up to 4 concrete plays for HOW A REP ON OUR TEAM should use this doc: "Lead with X in a discovery call against the Y objection". Each is an instruction TO THE REP.',
      items: { type: 'string' },
    },
  },
  required: ['executiveSummary'],
};

const COMPANY_ANALYSIS_PROMPT =
  'You are a senior GTM strategist working FOR a B2B SaaS company. The document below is THEIR own intel about THEMSELVES — their own positioning, their own product, their own about-page. ' +
  'Your audience is a sales rep ON THIS COMPANY\'S TEAM who is about to walk into a discovery call. They are reading this briefing about THEIR OWN COMPANY. ' +
  'Therefore write everything in FIRST PERSON PLURAL: "WE do X", "OUR product", "OUR buyer". ' +
  'Never use third-person framing like "this document targets buyers" or "the company sells X" — that\'s a journalist describing a company from outside. We are the company. ' +
  'The "idealCustomerProfile" specifically describes WHO BUYS FROM US — written like a sales rep would describe their own ICP, not like an analyst reviewing a market. ' +
  'Be honest — name actual differentiators not marketing fluff, real gaps in this doc, real competitors a buyer would name. Quote evidence verbatim for strengths. Skip fields when the doc doesn\'t cover them. ' +
  IGNORE_CLAUSE;

async function extractCompanyAnalysis({ text, tenantId = null, title = null } = {}) {
  const body = stripBoilerplate(text);
  if (body.length < 200) return null; // not enough to analyse
  try {
    const ai = gemini.getClient();
    const context = await tenantContextText(tenantId);
    const prompt =
      `${COMPANY_ANALYSIS_PROMPT}\n\n` +
      (context ? `===OUR COMPANY (portfolio & existing intel)===\n${context}\n\n` : '') +
      `===NEW DOCUMENT${title ? ` — ${title}` : ''}===\n${body.slice(0, INPUT_CAP)}`;
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 2200,
        responseMimeType: 'application/json',
        responseSchema: COMPANY_ANALYSIS_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    // Light defensive normalisation — drop empty strings, cap arrays.
    return {
      executiveSummary: String(parsed.executiveSummary || '').trim() || null,
      services:         normaliseArray(parsed.services, 8),
      strengths:        normaliseArray(parsed.strengths, 5),
      marketPosition:   parsed.marketPosition ? {
        category:       String(parsed.marketPosition.category || '').trim() || null,
        differentiator: String(parsed.marketPosition.differentiator || '').trim() || null,
        weaknesses:     normaliseArray(parsed.marketPosition.weaknesses, 3),
      } : null,
      competitors:           normaliseArray(parsed.competitors, 6),
      idealCustomerProfile:  String(parsed.idealCustomerProfile || '').trim() || null,
      salesAngles:           normaliseArray(parsed.salesAngles, 4),
      generatedAt:           new Date().toISOString(),
      model:                 MODEL,
    };
  } catch (err) {
    console.warn('[company-analysis] extraction failed:', err.message);
    return null;
  }
}

function normaliseArray(v, max) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x !== null && x !== undefined && (typeof x !== 'string' || x.trim())).slice(0, max);
}

// ── Product analysis (TENANT-scope docs filed under a product line) ──────
//
// When a doc is filed under a specific product line (category=PRODUCT_INTEL,
// productIds[0] set), the analysis lens is narrower than the company-wide
// view: this doc is about ONE OF OUR PRODUCTS, named [X]. The output gives
// the rep a product-specific cheat sheet — what it does, who buys it, the
// competing products it goes up against, and how to pitch IT (not the
// broader company).

const PRODUCT_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    executiveSummary: { type: 'string', description: '1-2 sentences in first person plural: "OUR product [NAME] does X for Y kind of buyer." Specific to this product, not the broader company.' },
    capabilities: {
      type: 'array',
      description: 'Up to 8 concrete capabilities OUR product has, as described in this doc. Each is one short noun-phrase + a one-line buyer-benefit, written from OUR side.',
      items: {
        type: 'object',
        properties: {
          capability: { type: 'string', description: 'The capability, named concretely. E.g. "Real-time transaction scoring", not "AI-powered insights".' },
          benefit:    { type: 'string', description: 'In first person: "Lets our customers do X without Y". The buyer-impact in plain language.' },
        },
        required: ['capability', 'benefit'],
      },
    },
    problemsSolved: {
      type: 'array',
      description: 'Up to 5 specific buyer problems OUR product addresses. Frame as the BUYER\'S problem, not our marketing.',
      items: { type: 'string' },
    },
    whoBuysIt: { type: 'string', description: '1-2 sentences: WHO ON THE BUYER SIDE buys OUR product — title, function, scale, signals. First-person about us, third-person about the buyer.' },
    integrations: {
      type: 'array',
      description: 'Up to 8 specific tools, platforms or systems OUR product integrates with as named in this doc. Tech stack signals only — drop if not stated.',
      items: { type: 'string' },
    },
    pricingPosture: { type: 'string', description: '1 sentence on how OUR product is priced/packaged if the doc says — usage-based / per-seat / tier / not stated. Empty string if absent.' },
    competingProducts: {
      type: 'array',
      description: 'Up to 6 SPECIFIC PRODUCTS (not just company names) that a buyer would shortlist alongside OURS for the same job. Use real, current product names (e.g. "Splunk SOAR" not just "Splunk"; "Salesforce Einstein Conversation Insights" not just "Salesforce").',
      items: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Product (and vendor if needed for disambiguation) — e.g. "Gong Engage" or "Outreach Kaia".' },
          reason:  { type: 'string', description: '1 sentence: "Buyers compare us on X" or "We beat them on Y".' },
          overlap: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = same use case as ours; medium = adjacent; low = occasional shoot-out.' },
        },
        required: ['name', 'reason', 'overlap'],
      },
    },
    pitchAngles: {
      type: 'array',
      description: 'Up to 4 concrete plays for selling OUR product: which buyer moment, which objection, which question. Each is an instruction to the rep.',
      items: { type: 'string' },
    },
  },
  required: ['executiveSummary'],
};

const PRODUCT_ANALYSIS_PROMPT_HEADER =
  'You are a senior product marketer working FOR a B2B SaaS company. The document below describes ONE of THEIR products — the rep on their team needs a product cheat sheet for pitching IT specifically (not the broader company). ' +
  'Write everything in FIRST PERSON PLURAL about us ("WE", "OUR product"), third person about the buyer ("our buyers do X"). ' +
  'Never use third-person framing like "this document describes the product" or "the product solves" — we own this product. ' +
  'Focus tightly on THIS PRODUCT — its capabilities, who buys it, what it integrates with, and the products it competes with at the shortlist stage. Don\'t describe the broader company. ' +
  'Be honest: name real competing products by name (not "legacy vendors"), name actual integrations, name the actual buyer role. Skip fields if the doc is silent on them. ' +
  IGNORE_CLAUSE;

async function extractProductAnalysis({ text, tenantId = null, productId = null, title = null } = {}) {
  const body = stripBoilerplate(text);
  if (body.length < 200) return null;
  try {
    const ai = gemini.getClient();
    const context = await tenantContextText(tenantId);
    // Look up the named product so the prompt can refer to it explicitly.
    let productHeader = '';
    if (productId) {
      try {
        const r = await db.query(
          `SELECT name, description FROM products WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [tenantId, productId]
        );
        if (r.rows[0]) {
          productHeader = `===THE PRODUCT THIS DOC IS ABOUT===\n` +
            `Name: ${r.rows[0].name}` +
            (r.rows[0].description ? `\nWhat we know about it already: ${r.rows[0].description}` : '') +
            `\n`;
        }
      } catch { /* non-fatal */ }
    }
    const prompt =
      `${PRODUCT_ANALYSIS_PROMPT_HEADER}\n\n` +
      (context ? `===OUR COMPANY (portfolio & existing intel)===\n${context}\n\n` : '') +
      (productHeader ? `${productHeader}\n` : '') +
      `===NEW DOCUMENT${title ? ` — ${title}` : ''}===\n${body.slice(0, INPUT_CAP)}`;
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 2200,
        responseMimeType: 'application/json',
        responseSchema: PRODUCT_ANALYSIS_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    return {
      executiveSummary:  String(parsed.executiveSummary || '').trim() || null,
      capabilities:      normaliseArray(parsed.capabilities, 8),
      problemsSolved:    normaliseArray(parsed.problemsSolved, 5),
      whoBuysIt:         String(parsed.whoBuysIt || '').trim() || null,
      integrations:      normaliseArray(parsed.integrations, 8),
      pricingPosture:    String(parsed.pricingPosture || '').trim() || null,
      competingProducts: normaliseArray(parsed.competingProducts, 6),
      pitchAngles:       normaliseArray(parsed.pitchAngles, 4),
      productId,
      generatedAt:       new Date().toISOString(),
      model:             MODEL,
    };
  } catch (err) {
    console.warn('[product-analysis] extraction failed:', err.message);
    return null;
  }
}

module.exports = { extractKeyPoints, extractCompanyAnalysis, extractProductAnalysis, kindFor, stripBoilerplate, tenantContextText };
