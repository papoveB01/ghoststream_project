// WEB ingestion lane — Firecrawl.
//
// One sync = one URL. We POST /v1/scrape, take the returned markdown, fake
// a multer-shaped `file` object from it, and hand off to service.ingest()
// with streamType='WEB' so the rest of the pipeline (chunk, embed, store,
// trigger global cache rebuild) runs identically to a manual upload.
//
// Effective date precedence: Firecrawl's metadata.publishedTime →
// metadata.modifiedTime → request time. Whichever lands becomes the
// retrieval-side recency signal for the tiebreaker in retrieval.js.

// service.js is required lazily inside syncUrl() — it requires THIS module
// for isConfigured() reflection in getStatus(), creating a circular import.
// At module load time, eager `require('./service')` here would capture an
// empty exports object since service.js hasn't finished assigning its
// module.exports yet. require() inside the function resolves the fully
// populated module (and is cached by Node, so essentially free).

const API_BASE = process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev/v1';
const SCRAPE_TIMEOUT_MS = parseInt(process.env.FIRECRAWL_TIMEOUT_MS || '60000', 10);

const BRAVE_BASE = process.env.BRAVE_BASE_URL || 'https://api.search.brave.com/res/v1';
const BRAVE_TIMEOUT_MS = parseInt(process.env.BRAVE_TIMEOUT_MS || '15000', 10);

function isConfigured() {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

function isBraveConfigured() {
  return Boolean(process.env.BRAVE_API_KEY);
}

async function scrape(url) {
  if (!isConfigured()) {
    const err = new Error('FIRECRAWL_API_KEY not set — add it to .env and restart');
    err.status = 503;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        // Markdown is the canonical chunkable surface; we also ask for the
        // page metadata so we can stamp the effective_date accurately.
        formats: ['markdown'],
        // Keep the main article content and drop site chrome (nav, headers,
        // footers, sidebars) — cuts most cookie-banner / boilerplate noise
        // before it ever reaches the chunker or the key-point analysis.
        onlyMainContent: true,
        excludeTags: ['nav', 'header', 'footer', 'aside'],
        removeBase64Images: true,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const msg = body.error || body.message || `HTTP ${res.status}`;
      const err = new Error(`Firecrawl scrape failed: ${msg}`);
      err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
      throw err;
    }
    return body.data || {};
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Firecrawl scrape timed out after ${SCRAPE_TIMEOUT_MS}ms for ${url}`);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Brave Search /web/search — discovery only (no inline scrape support).
// Returns the same row shape as the Firecrawl path so callers don't care
// which provider served them. `page_age` is Brave's ISO timestamp for when
// the page was last seen with new content; we map it to publishedTime so the
// dossier date field still populates.
async function searchBrave(query, { limit = 5 } = {}) {
  if (!isBraveConfigured() || !query) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRAVE_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ q: query, count: String(Math.max(1, Math.min(20, limit))) });
    const res = await fetch(`${BRAVE_BASE}/web/search?${params}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    const rows = (json && json.web && Array.isArray(json.web.results)) ? json.web.results : [];
    return rows.map((r) => ({
      url: r.url || null,
      title: r.title || null,
      description: r.description || null,
      markdown: null,
      publishedTime: r.page_age || (r.age && /^\d{4}-\d{2}-\d{2}/.test(r.age) ? r.age : null) || null,
    })).filter((r) => r.url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Firecrawl /v1/search — web search with optional inline scraping of results.
// Kept as a fallback when Brave isn't configured. `scrape` (bool) toggles
// Firecrawl's inline content scraping (one scrape per result — costs credits).
async function searchFirecrawl(query, { limit = 5, scrape: doScrape = false } = {}) {
  if (!isConfigured() || !query) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const body = { query, limit };
    if (doScrape) body.scrapeOptions = { formats: ['markdown'], onlyMainContent: true };
    const res = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) return [];
    const rows = Array.isArray(json.data) ? json.data : (Array.isArray(json.results) ? json.results : []);
    return rows.map((r) => ({
      url: r.url || r.link || null,
      title: r.title || (r.metadata && r.metadata.title) || null,
      description: r.description || r.snippet || (r.metadata && r.metadata.description) || null,
      markdown: typeof r.markdown === 'string' ? r.markdown : null,
      publishedTime: (r.metadata && (r.metadata.publishedTime || r.metadata.modifiedTime)) || null,
    })).filter((r) => r.url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Discovery — Brave when BRAVE_API_KEY is set (cheap, returns URL/title/snippet
// only), else Firecrawl /search (more expensive, can inline-scrape). Callers
// always get the same row shape; scrape() / scrapeMarkdown() handles full text
// downstream regardless of which provider served discovery.
async function search(query, opts = {}) {
  if (isBraveConfigured()) return searchBrave(query, opts);
  return searchFirecrawl(query, opts);
}

// Firecrawl /v1/map — discover URLs on a site (cheap). Returns string[] of URLs.
// Best-effort: [] on failure.
async function mapSite(url, { limit = 30, search: q = undefined } = {}) {
  if (!isConfigured() || !url) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const body = { url, limit };
    if (q) body.search = q;
    const res = await fetch(`${API_BASE}/map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) return [];
    const links = Array.isArray(json.links) ? json.links : (Array.isArray(json.data) ? json.data : []);
    return links.map((l) => (typeof l === 'string' ? l : (l && l.url))).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// scrape() but returns just { markdown, title, description, publishedTime, url }
// and never throws (returns null on failure) — convenient for best-effort
// research scraping where one bad page shouldn't sink the run.
async function scrapeMarkdown(url) {
  try {
    const data = await scrape(url);
    const meta = data.metadata || {};
    return {
      url: meta.sourceURL || meta.url || url,
      markdown: String(data.markdown || ''),
      title: meta.title || null,
      description: meta.description || null,
      publishedTime: meta.publishedTime || meta.modifiedTime || null,
    };
  } catch {
    return null;
  }
}

// Title for a scraped page: explicit > Firecrawl metadata.title > url path.
function deriveTitle(explicit, metadata, url) {
  if (explicit) return explicit;
  if (metadata && metadata.title) return metadata.title;
  try { return new URL(url).hostname + new URL(url).pathname; }
  catch { return url; }
}

async function syncUrl({ tenantId = null, url, category, title, dryRun = false, productIds = null, personaIds = null, competitorIds = null, transientForMissionId = null, companyId = null, scope = 'TENANT', competitorName = null, appliesToProductIds = null, competitorProductId = null }) {
  if (!url || typeof url !== 'string') {
    const err = new Error('url (string) required'); err.status = 400; throw err;
  }
  try { new URL(url); }
  catch { const err = new Error(`invalid url: ${url}`); err.status = 400; throw err; }

  const data = await scrape(url);
  const text = String(data.markdown || '').trim();
  if (text.length < 10) {
    const err = new Error('scraped content too short — likely a paywall, JS-only page, or empty doc');
    err.status = 422; throw err;
  }

  const meta = data.metadata || {};
  const effectiveDate = meta.publishedTime || meta.modifiedTime || new Date().toISOString();
  const resolvedTitle = deriveTitle(title, meta, url);
  const sourceUrl = meta.sourceURL || meta.url || url;

  if (dryRun) {
    // Structured preview — same shape file uploads produce, so the UI renders
    // both with one card. Lazy-require to dodge the service↔web cycle.
    const preview = require('./preview');
    const card = await preview.buildPreview(text, {
      title: resolvedTitle,
      sourceUrl,
      effectiveDate,
      sourceType: 'markdown',
      streamType: 'WEB',
      description: meta.description || null,
      scope,
      tenantId,
      competitorName,
    });
    return { dryRun: true, url, ...card };
  }

  // Lazy require — see comment at top of file.
  const service = require('./service');

  // Hand off to service.ingest() via a synthetic multer-shaped file.
  const filename = (resolvedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'scraped') + '.md';
  return service.ingest({
    tenantId,
    file: {
      buffer: Buffer.from(text, 'utf8'),
      mimetype: 'text/markdown',
      originalname: filename,
    },
    category,
    title: resolvedTitle,
    metadata: {
      firecrawl: {
        title: meta.title,
        description: meta.description,
        language: meta.language,
        statusCode: meta.statusCode,
        publishedTime: meta.publishedTime,
        modifiedTime: meta.modifiedTime,
      },
    },
    streamType: 'WEB',
    effectiveDate,
    sourceUrl,
    productIds,
    personaIds,
    competitorIds,
    appliesToProductIds,
    competitorProductId,
    transientForMissionId,
    companyId,
    scope,
  });
}

module.exports = { isConfigured, isBraveConfigured, scrape, scrapeMarkdown, search, mapSite, syncUrl };
