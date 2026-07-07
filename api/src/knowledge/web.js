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

// ── SSRF guard ─────────────────────────────────────────────────────────────
// Firecrawl fetches whatever URL we hand it, server-side. If FIRECRAWL_BASE_URL
// is ever pointed at a self-hosted instance inside the VPC, a user-supplied URL
// becomes a direct internal-network fetch. Reject non-http(s) schemes and hosts
// that are IP literals in private / loopback / link-local / reserved space
// (incl. the 169.254.169.254 cloud metadata endpoint), plus obvious internal
// names. DNS rebinding via a public hostname that resolves to an internal IP is
// out of scope here (Firecrawl is the egress); this blocks the direct-literal
// and localhost cases, which are the ones a caller controls outright.
function ipv4Blocked(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null; // not an IPv4 literal
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;            // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64.0.0/10
  if (a >= 224) return true;                          // multicast / reserved / broadcast
  return false;
}
function isBlockedHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  const v4 = ipv4Blocked(host);
  if (v4 !== null) return v4;
  if (host.includes(':')) {                           // IPv6 literal
    if (host === '::1' || host === '::') return true;
    if (/^(fc|fd)/.test(host)) return true;           // unique local fc00::/7
    if (/^fe[89ab]/.test(host)) return true;          // link-local fe80::/10
    const mapped = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // ::ffff:a.b.c.d
    if (mapped) return ipv4Blocked(mapped[1]) === true;
  }
  return false;
}
// Validate a caller-supplied URL before we hand it to Firecrawl. Throws a 400
// on a non-http(s) or private/internal target; returns the parsed URL.
function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); }
  catch { const e = new Error('Invalid URL.'); e.status = 400; throw e; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const e = new Error('Only http(s) URLs can be fetched.'); e.status = 400; throw e;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 [brackets]
  if (isBlockedHost(host)) {
    const e = new Error('That URL points to a private or internal address.'); e.status = 400; throw e;
  }
  return u;
}

async function scrape(url) {
  if (!isConfigured()) {
    const err = new Error('FIRECRAWL_API_KEY not set — add it to .env and restart');
    err.status = 503;
    throw err;
  }
  assertPublicHttpUrl(url); // SSRF guard — every scrape path funnels through here

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
//
// Returns null (NOT []) on a hard failure (HTTP error such as 402 over-quota /
// 429 rate-limit / 5xx, or a network/timeout error) so search() can tell a
// genuine "no results" from "Brave is down" and fall back to Firecrawl. An
// empty array means Brave answered but found nothing.
async function searchBrave(query, { limit = 5, freshness = undefined } = {}) {
  if (!isBraveConfigured() || !query) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRAVE_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ q: query, count: String(Math.max(1, Math.min(20, limit))) });
    // Brave freshness: pd | pw | pm | py | YYYY-MM-DDtoYYYY-MM-DD
    if (freshness) params.set('freshness', freshness);
    const res = await fetch(`${BRAVE_BASE}/web/search?${params}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[web.search] Brave HTTP ${res.status} for "${query.slice(0, 60)}" — falling back to Firecrawl`);
      return null;
    }
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
    return null; // network/timeout — signal failure so search() can fall back
  } finally {
    clearTimeout(timer);
  }
}

// Firecrawl /v1/search — web search with optional inline scraping of results.
// Kept as a fallback when Brave isn't configured. `scrape` (bool) toggles
// Firecrawl's inline content scraping (one scrape per result — costs credits).
async function searchFirecrawl(query, { limit = 5, scrape: doScrape = false, freshness = undefined } = {}) {
  if (!isConfigured() || !query) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const body = { query, limit };
    // Approximate Brave's freshness via Google tbs; custom ranges fall back to a year.
    if (freshness) body.tbs = { pd: 'qdr:d', pw: 'qdr:w', pm: 'qdr:m', py: 'qdr:y' }[freshness] || 'qdr:y';
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
//
// Resilience: if Brave HARD-FAILS (returns null: HTTP error like 402 over-quota
// / 429 / 5xx, or a network/timeout error) we transparently fall back to
// Firecrawl when it's configured, so an exhausted Brave plan degrades instead
// of silently killing all discovery. A Brave answer of [] (genuinely nothing
// found) is returned as-is — no wasteful second provider call.
async function search(query, opts = {}) {
  if (isBraveConfigured()) {
    const r = await searchBrave(query, opts);
    if (r !== null) return r;
    if (isConfigured()) return searchFirecrawl(query, opts);
    return [];
  }
  return searchFirecrawl(query, opts);
}

// Firecrawl /v1/map — discover URLs on a site (cheap). Returns string[] of URLs.
// Best-effort: [] on failure.
async function mapSite(url, { limit = 30, search: q = undefined } = {}) {
  if (!isConfigured() || !url) return [];
  try { assertPublicHttpUrl(url); } catch { return []; } // SSRF guard (keep the []-on-bad contract)
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

module.exports = { isConfigured, isBraveConfigured, scrape, scrapeMarkdown, search, mapSite, syncUrl, assertPublicHttpUrl };
