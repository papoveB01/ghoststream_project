// Company brief — scrape a homepage and summarize it into a confirm-able brief.
//
// Used by the post-onboarding "pull from your website" bootstrap (portfolio.js
// company-bootstrap/pull): Firecrawl scrapes the homepage, Gemini Flash distils
// it into { missionStatement, keyProducts[], primaryAudience } so the new owner
// can confirm we understood their business — and pick up product lines from it.
//
// Extracted from the original onboarding scrape job so the same logic backs both
// the (now removed) signup preview and the in-app bootstrap.

const gemini = require('./gemini');
const web = require('./knowledge/web');

const BRIEF_MODEL = require('./models').modelFor('companyBrief');

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    missionStatement: { type: 'string', description: 'One sentence describing what the company does and for whom.' },
    keyProducts:      { type: 'array', items: { type: 'string' }, description: 'Named product lines or core offerings.' },
    primaryAudience:  { type: 'string', description: 'Who buys from / uses this company.' },
    valuePropCount:   { type: 'integer', description: 'Roughly how many distinct value propositions / benefit claims the site makes.' },
  },
  required: ['missionStatement', 'keyProducts', 'primaryAudience', 'valuePropCount'],
};

const BRIEF_PROMPT =
  "You are GhostStream's onboarding assistant. You're given the markdown of a " +
  "company's website. Summarize it for the user to CONFIRM we indexed their " +
  "business correctly. Be concrete — quote real product names from the page. " +
  "Return: missionStatement (1 sentence), keyProducts (array of named offerings " +
  "found on the page), primaryAudience (who they sell to), valuePropCount " +
  "(rough count of distinct benefit/value claims on the page).";

// Generate the brief from scraped markdown. Falls back to a minimal brief built
// from the page metadata if Gemini is unavailable or errors.
async function generateBrief(markdown, meta) {
  const fallback = () => ({
    missionStatement: (meta && (meta.description || meta.title)) || 'We indexed your homepage.',
    keyProducts: [],
    primaryAudience: '',
    valuePropCount: 0,
    headline: meta && meta.title ? `Indexed: ${meta.title}` : 'We scanned your homepage.',
    source: 'metadata',
  });
  try {
    const ai = gemini.getClient();
    const resp = await ai.models.generateContent({
      model: BRIEF_MODEL,
      contents: [{ role: 'user', parts: [{ text: `${BRIEF_PROMPT}\n\n---WEBSITE CONTENT---\n${String(markdown).slice(0, 20000)}` }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 700,
        responseMimeType: 'application/json',
        responseSchema: BRIEF_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    const productCount = Array.isArray(parsed.keyProducts) ? parsed.keyProducts.length : 0;
    const vpCount = Number.isFinite(parsed.valuePropCount) ? parsed.valuePropCount : 0;
    const headline = productCount || vpCount
      ? `We've identified ${productCount} product line${productCount === 1 ? '' : 's'} and ${vpCount} core value proposition${vpCount === 1 ? '' : 's'} from your site.`
      : `We've indexed your site. Does this look right?`;
    return { ...parsed, keyProducts: parsed.keyProducts || [], headline, source: 'gemini' };
  } catch (err) {
    console.warn('[companyBrief] brief generation failed, using metadata fallback:', err.message);
    return fallback();
  }
}

// Scrape `website` and return its markdown + page metadata + a confirm-able brief.
// Never throws — returns { ok:false, error } when scraping isn't possible so the
// caller can degrade to manual entry.
async function scrapeAndBrief(website) {
  if (!web.isConfigured()) {
    return { ok: false, error: 'website research is temporarily unavailable — you can add details manually.' };
  }
  let data;
  try {
    data = await web.scrape(website);
  } catch (err) {
    console.warn(`[companyBrief] scrape failed for ${website}: ${err.message}`);
    return { ok: false, error: "we couldn't research your website right now — you can add details manually." };
  }
  const markdown = String((data && data.markdown) || '').trim();
  if (markdown.length < 50) {
    return { ok: false, error: "we couldn't read your website (it may block crawlers or be JS-only) — you can add details manually." };
  }
  const meta = data.metadata || {};
  const brief = await generateBrief(markdown, meta);
  return {
    ok: true,
    markdown,
    meta: {
      title: meta.title || null,
      description: meta.description || null,
      sourceUrl: meta.sourceURL || meta.url || website,
      publishedTime: meta.publishedTime || meta.modifiedTime || null,
    },
    brief,
  };
}

module.exports = { scrapeAndBrief, generateBrief, BRIEF_SCHEMA };
