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

const MODEL =
  process.env.GEMINI_KEYPOINTS_MODEL ||
  process.env.GEMINI_ANALYSIS_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-2.5-flash';
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
    let budget = CONTEXT_CAP - productBlock.length - 64;
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
    return [productBlock, docBlock].filter(Boolean).join('\n\n').slice(0, CONTEXT_CAP).trim();
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

module.exports = { extractKeyPoints, kindFor, stripBoilerplate, tenantContextText };
