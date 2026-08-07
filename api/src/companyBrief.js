// Company brief — scrape a homepage and summarize it into a confirm-able brief.
//
// Used by the post-onboarding "pull from your website" bootstrap (portfolio.js
// company-bootstrap/pull): Firecrawl scrapes the homepage, Gemini Flash distils
// it into { missionStatement, keyProducts[], primaryAudience } so the new owner
// can confirm we understood their business — and pick up product lines from it.
//
// Extracted from the original onboarding scrape job so the same logic backs both
// the (now removed) signup preview and the in-app bootstrap.

const web = require('./knowledge/web');

// One-shot provider seam (ADR-0006 §9 item 5). Resolves provider AND model per
// call, as a matched pair — no model id frozen at require time behind a routing
// decision (including the fail-closed fallback to Gemini) that can no longer be
// seen, and no code change to flip a task or roll one back. It is NOT a
// restart-free change: AI_PROVIDER_* is container env (docker-compose.yml), so
// setting one means `docker compose up -d`, which recreates the process anyway.
const aiCall = require('./aiCall');

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
  "You are DealScope's onboarding assistant. You're given the markdown of a " +
  "company's website. Summarize it for the user to CONFIRM we indexed their " +
  "business correctly. Be concrete — quote real product names from the page. " +
  "Return: missionStatement (1 sentence), keyProducts (array of named offerings " +
  "found on the page), primaryAudience (who they sell to), valuePropCount " +
  "(rough count of distinct benefit/value claims on the page).";

// Generate the brief from scraped markdown. Falls back to a minimal brief built
// from the page metadata if Gemini is unavailable or errors.
async function generateBrief(markdown, meta, tenantId = null) {
  const fallback = () => ({
    missionStatement: (meta && (meta.description || meta.title)) || 'We indexed your homepage.',
    keyProducts: [],
    primaryAudience: '',
    valuePropCount: 0,
    headline: meta && meta.title ? `Indexed: ${meta.title}` : 'We scanned your homepage.',
    // 'fallback' — the SAME sentinel preview.js uses, not a second word for the
    // same idea. On the success path `source` holds the PROVIDER that answered,
    // so the only way a consumer can ask "did a model produce this?" without
    // naming a vendor is to test `!== 'fallback'`. Under that rule the previous
    // value, 'metadata', reads as a model answer. Nothing renders this field
    // today — portfolio.js's company-bootstrap response drops it — which is
    // exactly why it is cheap to align now rather than after a UI reads it.
    source: 'fallback',
  });
  try {
    const { parsed, provider } = await aiCall.generateStructured({
      task: 'companyBrief',
      prompt: `${BRIEF_PROMPT}\n\n---WEBSITE CONTENT---\n${String(markdown).slice(0, 20000)}`,
      responseSchema: BRIEF_SCHEMA,
      maxTokens: 700,
      temperature: 0.3,
      tenantId,
      site: 'foundation.companyBrief',
    });
    const productCount = Array.isArray(parsed.keyProducts) ? parsed.keyProducts.length : 0;
    const vpCount = Number.isFinite(parsed.valuePropCount) ? parsed.valuePropCount : 0;
    const headline = productCount || vpCount
      ? `We've identified ${productCount} product line${productCount === 1 ? '' : 's'} and ${vpCount} core value proposition${vpCount === 1 ? '' : 's'} from your site.`
      : `We've indexed your site. Does this look right?`;
    // The provider, not a hardcoded vendor name — nothing reads this today, but
    // a field that silently becomes false is how the preview badge broke.
    return { ...parsed, keyProducts: parsed.keyProducts || [], headline, source: provider };
  } catch (err) {
    // "metadata fallback" was the old sentinel's name, deleted in this same
    // migration for exactly the reason the log line kept it alive: two words
    // for one concept. The sentinel is 'fallback'; so is the log line. And the
    // provider is named, as in relevance.js and preview.js.
    const provider = (err && err.provider) || 'unknown';
    console.warn(`[companyBrief] brief generation failed on ${provider}, using fallback:`, err.message);
    return fallback();
  }
}

// Scrape `website` and return its markdown + page metadata + a confirm-able brief.
// Never throws — returns { ok:false, error } when scraping isn't possible so the
// caller can degrade to manual entry.
async function scrapeAndBrief(website, tenantId = null) {
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
  const brief = await generateBrief(markdown, meta, tenantId);
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
