// Structured "what's in this?" preview for a document or scraped web page,
// shown BEFORE the user commits it to the Knowledge Base.
//
// Replaces the old raw-text-slice preview with: real chunk/token/char/word
// stats (from the same chunker the ingest path uses), a markdown-heading
// outline, a Gemini-Flash summary + key topics + document-type guess (with a
// metadata fallback so it still works if Gemini is down), a clean longer
// excerpt, and the full extracted text (capped) for an expandable view.

const chunker = require('./chunker');
const gemini = require('../gemini');
const db = require('../db');

const SUMMARY_MODEL = process.env.GEMINI_PREVIEW_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const COMPARE_MODEL = process.env.GEMINI_COMPARE_MODEL || process.env.GEMINI_ANALYSIS_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FULLTEXT_CAP = parseInt(process.env.KB_PREVIEW_FULLTEXT_CAP || '60000', 10);
const SUMMARY_INPUT_CAP = parseInt(process.env.KB_PREVIEW_SUMMARY_INPUT_CAP || '24000', 10);
const COMPARE_COMPETITOR_CAP = parseInt(process.env.KB_PREVIEW_COMPARE_COMPETITOR_CAP || '18000', 10);
const COMPARE_BASIS_DOC_CAP = parseInt(process.env.KB_PREVIEW_COMPARE_BASIS_DOC_CAP || '3000', 10);

// Pull ATX-style markdown headings (`## Heading`) for a quick outline. Scraped
// content (Firecrawl markdown) and uploaded .md both have these; PDFs / plain
// text usually won't, in which case the outline comes back empty.
function parseOutline(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const heading = m[2]
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // unwrap markdown links
        .replace(/[*_`]/g, '')                   // drop emphasis/code marks
        .replace(/ /g, ' ')                 // nbsp → space
        .trim();
      // Skip "headings" that are really mis-converted paragraphs (long, or
      // ending in sentence punctuation) — common in HTML→markdown scrapes.
      if (heading && heading.length <= 100 && !/[.!?]$/.test(heading)) {
        out.push({ level: m[1].length, heading });
      }
    }
    if (out.length >= 80) break;
  }
  return out;
}

function computeStats(text, sourceType) {
  const t = String(text || '');
  let estChunks = 0;
  let estTokens = 0;
  try {
    const chunks = chunker.chunk({ text: t, sourceType: sourceType || 'text' });
    estChunks = chunks.length;
    estTokens = chunks.reduce((s, c) => s + (c.tokenCount || 0), 0);
  } catch {
    try { estTokens = chunker.tokenCount(t); } catch { estTokens = Math.round(t.length / 4); }
    estChunks = Math.max(1, Math.ceil(estTokens / (chunker.DEFAULT_CHUNK_TOKENS || 512)));
  }
  return {
    chars: t.length,
    words: (t.match(/\S+/g) || []).length,
    estTokens,
    estChunks,
  };
}

// The three KB categories the upload forms expose. The preview suggests one;
// the user can still override it in the form.
const KB_CATEGORIES = ['PRODUCT_INTEL', 'ORG_INTELLIGENCE', 'BATTLECARDS'];

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    documentType: { type: 'string', description: 'What kind of content this is — e.g. "pricing page", "product datasheet", "blog post", "case study", "API documentation", "press release", "homepage", "RFP response".' },
    summary:      { type: 'string', description: '2-4 sentence plain-language summary of what this content is about and what a reader would learn from it.' },
    keyTopics:    { type: 'array', items: { type: 'string' }, description: '5-12 specific topics, sections, products, or themes covered. Quote real names from the text.' },
    suggestedCategory: {
      type: 'string',
      enum: KB_CATEGORIES,
      description:
        'Best-fit knowledge-base category. PRODUCT_INTEL: product datasheets, pricing/feature/spec pages, technical docs, API docs, case studies, anything describing what a product does. ' +
        'ORG_INTELLIGENCE: company overviews, org charts, leadership/team pages, mission, brand voice/messaging, internal process or policy docs. ' +
        'BATTLECARDS: competitor comparisons, win/loss notes, objection handling, positioning against named rivals.',
    },
  },
  required: ['documentType', 'summary', 'keyTopics', 'suggestedCategory'],
};

const SUMMARY_PROMPT =
  "You're previewing content that's about to be added to a sales-intelligence " +
  "knowledge base. Summarize it so the person uploading it can confirm it's the " +
  "right material before indexing. Be concrete — name real products/sections " +
  "from the text. Return documentType, a 2-4 sentence summary, 5-12 keyTopics, and " +
  "suggestedCategory (the best-fit KB category from the allowed enum).";

async function summarize(text, meta) {
  const fallback = () => ({
    documentType: (meta && meta.sourceType) || 'document',
    summary: (meta && (meta.description || meta.title)) || 'No automated summary available — see the extracted text below.',
    keyTopics: [],
    suggestedCategory: 'PRODUCT_INTEL',
    source: 'fallback',
  });
  const body = String(text || '').trim();
  if (body.length < 40) return fallback();
  try {
    const ai = gemini.getClient();
    const resp = await ai.models.generateContent({
      model: SUMMARY_MODEL,
      contents: [{ role: 'user', parts: [{ text: `${SUMMARY_PROMPT}\n\n---CONTENT---\n${body.slice(0, SUMMARY_INPUT_CAP)}` }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 800,
        responseMimeType: 'application/json',
        responseSchema: SUMMARY_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    return {
      documentType: parsed.documentType || ((meta && meta.sourceType) || 'document'),
      summary: parsed.summary || fallback().summary,
      keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.filter(Boolean).slice(0, 12) : [],
      suggestedCategory: KB_CATEGORIES.includes(parsed.suggestedCategory) ? parsed.suggestedCategory : 'PRODUCT_INTEL',
      source: 'gemini',
    };
  } catch (err) {
    console.warn('[preview] summary generation failed, using fallback:', err.message);
    return fallback();
  }
}

// ---------------------------------------------------------------- competitor comparison

// Pull the tenant's own portfolio: the Intelligence Matrix `products` rows
// plus the text of their TENANT-scoped ("Basis") KB documents (capped). This
// is what we compare a competitor against.
async function gatherTenantPortfolio(tenantId) {
  const prod = await db.query(
    `SELECT name, COALESCE(description, '') AS description
       FROM products WHERE tenant_id = $1 ORDER BY lower(name) LIMIT 30`,
    [tenantId]
  );
  const basis = await db.query(
    `SELECT d.title, string_agg(c.text, E'\n\n' ORDER BY c.ordinal) AS body
       FROM kb_documents d JOIN kb_chunks c ON c.document_id = d.id
      WHERE d.tenant_id = $1 AND d.scope = 'TENANT' AND d.status = 'READY'
      GROUP BY d.id, d.title, d.created_at
      ORDER BY d.created_at DESC LIMIT 6`,
    [tenantId]
  );
  const productLines = prod.rows.map((r) => `- ${r.name}${r.description ? ': ' + r.description : ''}`).join('\n');
  const basisBlocks = basis.rows.map((r) => `## ${r.title}\n${String(r.body || '').slice(0, COMPARE_BASIS_DOC_CAP)}`).join('\n\n---\n\n');
  return { hasAny: prod.rows.length > 0 || basis.rows.length > 0, productLines, basisBlocks };
}

const COMPARISON_SCHEMA = {
  type: 'object',
  properties: {
    competitorOverview: { type: 'string', description: '1-2 sentence summary of the competitor\'s offering as described in their content.' },
    dimensions: {
      type: 'array',
      description: '5-9 head-to-head comparison rows on dimensions that matter in a sales cycle (e.g. core capability, pricing model, integrations, security/compliance, deployment options, target market, support, ecosystem).',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string' },
          ours:      { type: 'string', description: 'What WE offer on this dimension (from our portfolio). "Unknown" if not evident.' },
          theirs:    { type: 'string', description: 'What THEY offer on this dimension (from their content). "Unknown" if not evident.' },
          edge:      { type: 'string', description: 'Who has the advantage: "OURS", "THEIRS", or "EVEN".' },
          note:      { type: 'string', description: 'One short clause explaining the call.' },
        },
        required: ['dimension', 'ours', 'theirs', 'edge'],
      },
    },
    similarities:  { type: 'array', items: { type: 'string' }, description: 'Genuine overlaps — things both companies do similarly.' },
    ourStrengths:  { type: 'array', items: { type: 'string' }, description: 'Where WE win — concrete differentiators to lead with.' },
    theirStrengths:{ type: 'array', items: { type: 'string' }, description: 'Where THEY win, or gaps in our portfolio — be honest.' },
    talkingPoints: { type: 'array', items: { type: 'string' }, description: '3-5 ready-to-say lines for positioning against this competitor on a call.' },
  },
  required: ['competitorOverview', 'dimensions', 'ourStrengths', 'theirStrengths', 'talkingPoints'],
};

const COMPARISON_PROMPT =
  "You're a sales engineer building a battlecard. Below is OUR company's portfolio and a " +
  "COMPETITOR's content. Produce an honest head-to-head: a comparison table across the " +
  "dimensions that decide deals; the genuine similarities; where WE win (lead with these); " +
  "where THEY win or where we have gaps (don't sugar-coat it); and 3-5 talking points a rep " +
  "can say on a call. If something isn't evident from the content, say \"Unknown\" rather than guessing.";

function normalizeEdge(e) {
  const v = String(e || '').trim().toUpperCase();
  if (v.startsWith('OUR') || v === 'US' || v === 'WE') return 'OURS';
  if (v.startsWith('THEIR') || v === 'THEM') return 'THEIRS';
  return 'EVEN';
}

// buildCompetitorComparison(tenantId, competitorText, competitorName)
//   → { available:true, competitorName, competitorOverview, dimensions[], similarities[],
//       ourStrengths[], theirStrengths[], talkingPoints[] }   on success
//   → { available:false, reason }                              when we can't (no portfolio / model error)
async function buildCompetitorComparison(tenantId, competitorText, competitorName) {
  if (!tenantId) return { available: false, reason: 'No workspace context available for a comparison.' };
  const body = String(competitorText || '').trim();
  if (body.length < 60) return { available: false, reason: 'The competitor content is too thin to compare against.' };

  let ctx;
  try { ctx = await gatherTenantPortfolio(tenantId); }
  catch (err) { console.warn('[preview] portfolio fetch failed:', err.message); return { available: false, reason: 'Could not load your company portfolio.' }; }
  if (!ctx.hasAny) {
    return { available: false, reason: 'Add a document under "Our company" (or finish onboarding) so we know your product portfolio — then competitor uploads get a head-to-head comparison.' };
  }

  try {
    const ai = gemini.getClient();
    const prompt =
      `${COMPARISON_PROMPT}\n\n` +
      `===OUR COMPANY PORTFOLIO===\n` +
      `${ctx.productLines ? `Product lines:\n${ctx.productLines}\n\n` : ''}` +
      `${ctx.basisBlocks ? `From our knowledge base:\n${ctx.basisBlocks}\n` : ''}\n` +
      `===COMPETITOR${competitorName ? ` (${competitorName})` : ''}===\n${body.slice(0, COMPARE_COMPETITOR_CAP)}`;
    const resp = await ai.models.generateContent({
      model: COMPARE_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 1800,
        responseMimeType: 'application/json',
        responseSchema: COMPARISON_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    const dimensions = (Array.isArray(parsed.dimensions) ? parsed.dimensions : []).map((d) => ({
      dimension: d.dimension || '',
      ours: d.ours || 'Unknown',
      theirs: d.theirs || 'Unknown',
      edge: normalizeEdge(d.edge),
      note: d.note || '',
    })).filter((d) => d.dimension);
    return {
      available: true,
      competitorName: competitorName || null,
      competitorOverview: parsed.competitorOverview || '',
      dimensions,
      similarities: (parsed.similarities || []).filter(Boolean),
      ourStrengths: (parsed.ourStrengths || []).filter(Boolean),
      theirStrengths: (parsed.theirStrengths || []).filter(Boolean),
      talkingPoints: (parsed.talkingPoints || []).filter(Boolean),
    };
  } catch (err) {
    console.warn('[preview] competitor comparison failed:', err.message);
    return { available: false, reason: 'Comparison generation failed — you can still ingest this as a battlecard and refine it manually.' };
  }
}

// ---------------------------------------------------------------- main preview

// buildPreview(text, { title, sourceUrl, effectiveDate, sourceType, streamType, description,
//                      scope, tenantId, competitorName })
//   → the structured preview object the UI renders. `text` is the extracted /
//   scraped plain text or markdown. When scope === 'COMPETITOR' and a tenantId
//   is given, a head-to-head `comparison` block is included.
async function buildPreview(text, meta = {}) {
  const t = String(text || '');
  const outline = parseOutline(t);
  const stats = computeStats(t, meta.sourceType);
  const summary = await summarize(t, meta);
  // A cleaner, longer excerpt than the old 400-char slice: collapse blank-line
  // runs, take the first ~1800 chars on a word boundary.
  const cleaned = t.replace(/\n{3,}/g, '\n\n').trim();
  let excerpt = cleaned.slice(0, 1800);
  if (cleaned.length > 1800) excerpt = excerpt.replace(/\s+\S*$/, '') + ' …';

  // Competitor-scoped material lives in BATTLECARDS by default regardless of
  // what the summarizer guessed; everything else takes the AI's pick. The user
  // can still override the category in the upload form.
  const isCompetitor = String(meta.scope || '').toUpperCase() === 'COMPETITOR';
  const suggestedCategory = isCompetitor ? 'BATTLECARDS' : summary.suggestedCategory;

  const out = {
    title: meta.title || null,
    sourceUrl: meta.sourceUrl || null,
    sourceType: meta.sourceType || null,
    streamType: meta.streamType || null,
    effectiveDate: meta.effectiveDate || null,
    scope: meta.scope || null,
    documentType: summary.documentType,
    summary: summary.summary,
    summarySource: summary.source,
    keyTopics: summary.keyTopics,
    suggestedCategory,
    suggestedCategorySource: isCompetitor ? 'scope' : summary.source,
    outline,
    stats,
    excerpt,
    fullText: cleaned.slice(0, FULLTEXT_CAP),
    fullTextTruncated: cleaned.length > FULLTEXT_CAP,
  };

  if (isCompetitor) {
    out.comparison = await buildCompetitorComparison(meta.tenantId, t, meta.competitorName || null);
  }
  return out;
}

module.exports = { buildPreview, buildCompetitorComparison, parseOutline, computeStats };
