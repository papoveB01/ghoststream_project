// Competitor product discovery + competitive mapping.
//
// Given a competitor we may know little about, web-search their product lineup
// and ask Gemini to (a) list their distinct products and (b) map each to the one
// of OUR products it most directly competes with, plus a one-line read of their
// strength and where we'd win. Powers the "Discover their products" table — the
// rep can then turn the relevant ones into matchups.
//
// Best-effort and read-only: no ingest, no storage. Mirrors the structured-output
// + withRetry + fail-open conventions in relevance.js / assessment.js.

const gemini = require('../gemini');
const web = require('./web');

const MODEL = require('../models').modelFor('discovery');

// How many web hits to gather + how much scraped body to feed the model.
const MAX_HITS = parseInt(process.env.KB_DISCOVERY_MAX_HITS || '10', 10);
const SCRAPE_TOP = parseInt(process.env.KB_DISCOVERY_SCRAPE_TOP || '2', 10);
const SCRAPE_CAP = parseInt(process.env.KB_DISCOVERY_SCRAPE_CAP || '6000', 10);
const MAX_PRODUCTS = parseInt(process.env.KB_DISCOVERY_MAX_PRODUCTS || '12', 10);
// Prospect discovery casts a wider net than competitor discovery (we want many
// candidates, ranked) — its own larger caps.
const PROSPECT_MAX = parseInt(process.env.KB_DISCOVERY_PROSPECT_MAX || '30', 10);
// Hard ceiling for a single discovery turn — the user-facing "how many prospects"
// field is clamped to this. Beyond ~100 a single-shot ranked list degrades (token
// budget + relevance), so 100/turn is the cap.
const PROSPECT_HARD_MAX = parseInt(process.env.KB_DISCOVERY_PROSPECT_HARD_MAX || '100', 10);
const PROSPECT_MAX_HITS = parseInt(process.env.KB_DISCOVERY_PROSPECT_MAX_HITS || '28', 10);
const PROSPECT_SCRAPE_TOP = parseInt(process.env.KB_DISCOVERY_PROSPECT_SCRAPE_TOP || '4', 10);
// Output-token budgets for the structured JSON. The previous 4000 cap truncated
// the prospect list (30 rows × contact fields) mid-string → invalid JSON → the
// whole discovery 502'd. Sized generously now; parseItemsLoose also salvages a
// partial list if a response still gets cut off.
const PROSPECT_MAXTOK = parseInt(process.env.KB_DISCOVERY_PROSPECT_MAXTOK || '16000', 10);
const LIST_MAXTOK = parseInt(process.env.KB_DISCOVERY_LIST_MAXTOK || '8000', 10);
// Competitor discovery casts a wide net like prospects — without this the few
// brand "X competitors" aggregator pages (ZoomInfo/Craft) dominate the findings
// and return generic consumer brands instead of real product-category rivals.
const COMPETITOR_MAX_HITS = parseInt(process.env.KB_DISCOVERY_COMPETITOR_MAX_HITS || '32', 10);
const COMPETITOR_SCRAPE_TOP = parseInt(process.env.KB_DISCOVERY_COMPETITOR_SCRAPE_TOP || '6', 10);

const SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      description: 'The competitor\'s distinct products/offerings found in the findings. One row each; do not invent products that the findings do not support.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The competitor product\'s name.' },
          description: { type: 'string', description: 'One sentence: what this product does.' },
          belongsToThisCompetitor: { type: 'boolean', description: 'TRUE only if the findings clearly attribute this product to THIS competitor (it is their OWN offering). FALSE if it actually belongs to a different company (e.g. mentioned in a comparison / "vs" / alternatives / roundup).' },
          competesWithProductId: { type: 'string', description: 'The id of the ONE of OUR products it most directly competes with, chosen from the provided list. Empty string if none of ours is a direct competitor.' },
          theirStrength: { type: 'string', description: 'One short phrase: this product\'s main strength / why buyers pick it.' },
          whereWeWin: { type: 'string', description: 'One short phrase: where our competing product would win. Empty if we have no direct competitor.' },
        },
        required: ['name', 'description', 'belongsToThisCompetitor', 'competesWithProductId', 'theirStrength', 'whereWeWin'],
      },
    },
  },
  required: ['products'],
};

// Retry on transient Gemini errors (mirrors assessment.js / relevance.js).
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
      console.warn(`[discovery] transient Gemini error (attempt ${i + 1}/${tries}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Parse the model's structured-JSON array, tolerating truncation. A response cut
// off at the output-token cap leaves an unterminated string → JSON.parse throws;
// rather than fail the whole discovery we salvage every COMPLETE array-element
// object that did make it (the partial final one is dropped). Returns null only
// when there's no usable output at all (so callers can treat that as a failure).
function parseItemsLoose(text, key) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return null;
  try {
    const p = JSON.parse(s);
    return Array.isArray(p[key]) ? p[key] : [];
  } catch {
    // Salvage: extract objects that open one level inside the wrapper (i.e. the
    // array elements), ignoring braces inside strings. Brackets aren't counted,
    // so an element sits at brace-depth 1 even though it's inside the array.
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth === 1) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 1 && start >= 0) { try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip */ } start = -1; } }
    }
    return out;
  }
}

// Run a set of web searches (deduped by URL) + scrape the top few hits for
// richer body. Best-effort throughout — returns whatever it could gather.
// opts.maxHits / opts.scrapeTop / opts.searchLimit override the module defaults
// (used by prospect discovery to cast a much wider net).
async function gatherFromQueries(queries, opts = {}) {
  const maxHits = opts.maxHits || MAX_HITS;
  const scrapeTop = opts.scrapeTop || SCRAPE_TOP;
  const searchLimit = opts.searchLimit || 5;
  const concurrency = opts.concurrency || 4; // bounded so we don't hammer the search API

  // Searches run with bounded concurrency (was fully sequential → slow / 504s).
  // Results are kept in query order so dedupe is deterministic.
  const resultsByQuery = new Array(queries.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < queries.length) {
      const i = next++;
      const q = queries[i];
      if (!q) { resultsByQuery[i] = []; continue; }
      try { resultsByQuery[i] = await web.search(q, { limit: searchLimit }); }
      catch { resultsByQuery[i] = []; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queries.length || 1) }, worker));

  // Dedupe by URL in query order, cap at maxHits.
  const seen = new Set();
  const hits = [];
  for (const results of resultsByQuery) {
    for (const h of (results || [])) {
      if (!h || !h.url || seen.has(h.url)) continue;
      seen.add(h.url);
      hits.push({ url: h.url, title: h.title || h.url, description: h.description || '' });
      if (hits.length >= maxHits) break;
    }
    if (hits.length >= maxHits) break;
  }

  // Scrape the top few hits IN PARALLEL (the previous sequential scrape — up to
  // scrapeTop × the per-scrape timeout — was the main cause of gateway timeouts).
  const scraped = await Promise.all(hits.slice(0, scrapeTop).map((h) =>
    web.scrapeMarkdown(h.url)
      .then((md) => (md && md.markdown) ? `# ${h.title}\n${md.markdown.slice(0, SCRAPE_CAP)}` : null)
      .catch(() => null)
  ));
  const bodies = scraped.filter(Boolean);

  const snippetBlock = hits.map((h) => `- ${h.title} — ${h.description} (${h.url})`).join('\n');
  return { hits, text: `SEARCH RESULTS:\n${snippetBlock}\n\n${bodies.join('\n\n---\n\n')}`.trim() };
}

// Gather web findings about the competitor's products: a few targeted searches
// (deduped by URL) + scraped body from the top hits. Best-effort throughout.
// When the competitor's own domain is known we bias to THEIR site first, so the
// findings (and the products extracted) are actually theirs — not rivals'.
async function gatherFindings(competitorName, domain) {
  const queries = [];
  if (domain) {
    queries.push(`${competitorName} products site:${domain}`);
    queries.push(`site:${domain} products solutions`);
  }
  queries.push(`${competitorName} products`);
  queries.push(`${competitorName} product line`);
  queries.push(`${competitorName} pricing plans`);
  return gatherFromQueries(queries);
}

// Discover the competitor's products and map each to one of ours.
// Returns { products: [...] } (possibly empty) or null on hard failure.
async function discoverCompetitorProducts({ competitorName, competitorDomain = '', ourProducts = [] } = {}) {
  const name = String(competitorName || '').trim();
  if (!name) return null;
  const domain = String(competitorDomain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase() || null;
  const ourIds = new Set((ourProducts || []).map((p) => p && p.id).filter(Boolean));
  const byId = new Map((ourProducts || []).filter((p) => p && p.id).map((p) => [p.id, p.name]));

  const findings = await gatherFindings(name, domain);
  if (!findings.text || findings.text.length < 40) return { products: [] };

  const portfolio = (ourProducts || []).length
    ? (ourProducts || []).map((p) => `- id="${p.id}" · ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '(no products on file — leave competesWithProductId empty for all)';

  const prompt =
    `You are a competitive-intelligence analyst cataloguing the product line of ONE specific competitor — "${name}"${domain ? ` (their website: ${domain})` : ''} — and mapping it against OUR portfolio. ` +
    'Using ONLY the web findings below, list ONLY the products/offerings that the findings clearly attribute to THIS competitor — products THIS company itself makes or sells.\n' +
    'CRITICAL — relevance to this competitor only: the findings may include comparison articles, "X vs Y", "alternatives to", or roundups that mention OTHER companies\' products. DO NOT list those. A product belongs here ONLY if it is one of ' +
    `${name}'s OWN offerings. If you are not sure a product is theirs, leave it out, and set belongsToThisCompetitor accordingly.\n` +
    'For each of their products, choose which ONE of OUR products (by id, from the list) it most DIRECTLY competes with — or empty string if none. Give a one-phrase read of their strength and where our product would win.\n\n' +
    'Rules: only products the findings attribute to THIS competitor (don\'t invent, don\'t borrow other vendors\' products); ' +
    'competesWithProductId MUST be one of the provided ids or empty; keep strings short; ignore website boilerplate (cookie/nav/legal).\n\n' +
    `===COMPETITOR===\n${name}${domain ? `\nWebsite: ${domain}` : ''}\n\n` +
    `===OUR PRODUCTS (choose competesWithProductId from these ids)===\n${portfolio}\n\n` +
    `===WEB FINDINGS===\n${findings.text}`;

  try {
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.2,
        maxOutputTokens: LIST_MAXTOK,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const raw = parseItemsLoose(resp.text, 'products');
    if (raw === null) return null; // no usable model output → caller 502s (no charge)
    const products = raw
      // Keep only products the model attributes to THIS competitor (drop rivals'
      // products that leaked in from comparison/roundup findings).
      .filter((p) => p && p.belongsToThisCompetitor !== false)
      .slice(0, MAX_PRODUCTS)
      .map((p) => {
        const cwId = (typeof p.competesWithProductId === 'string' && ourIds.has(p.competesWithProductId)) ? p.competesWithProductId : null;
        return {
          name: String(p.name || '').trim(),
          description: String(p.description || '').trim(),
          competesWithProductId: cwId,
          competesWithProductName: cwId ? (byId.get(cwId) || null) : null,
          theirStrength: String(p.theirStrength || '').trim(),
          whereWeWin: String(p.whereWeWin || '').trim(),
        };
      }).filter((p) => p.name);
    return { products };
  } catch (err) {
    console.warn(`[discovery] discoverCompetitorProducts failed: ${(err && err.message) || err}`);
    return null;
  }
}

// Location + public contact details extracted from the findings (empty string
// when not evident — never invented). Spread into the prospect/competitor schemas
// and mapped onto each result so the UI can show "where + how to reach them".
const CONTACT_PROPS = {
  country: { type: 'string', description: 'Country, if evident in the findings; else empty string.' },
  city:    { type: 'string', description: 'City/locality, if evident; else empty string.' },
  address: { type: 'string', description: 'Street/postal address, if evident; else empty string.' },
  phone:   { type: 'string', description: 'Public phone number, if evident; else empty string.' },
  email:   { type: 'string', description: 'Public contact email, if evident; else empty string.' },
};
const CONTACT_REQUIRED = ['country', 'city', 'address', 'phone', 'email'];
const CONTACT_INSTRUCTION =
  'Also extract, ONLY when the findings clearly state it, each company\'s location (country, city, address) ' +
  'and public contact details (phone, email). Leave any of these empty if not found — never guess or invent contact info.';
function pickContact(c) {
  return {
    country: String((c && c.country) || '').trim(),
    city:    String((c && c.city) || '').trim(),
    address: String((c && c.address) || '').trim(),
    phone:   String((c && c.phone) || '').trim(),
    email:   String((c && c.email) || '').trim(),
  };
}

// ── Competitor discovery (find rivals of OUR company) ─────────────────────

const COMPETITORS_SCHEMA = {
  type: 'object',
  properties: {
    competitors: {
      type: 'array',
      description: 'Companies that DIRECTLY compete with OUR company, supported by the findings. Do not invent companies the findings do not mention; exclude OUR own company.',
      items: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'The competitor company\'s name.' },
          description: { type: 'string', description: 'One sentence: what this company does / sells.' },
          website:     { type: 'string', description: 'Their primary website domain (e.g. acme.com) if evident in the findings, else empty string.' },
          region:      { type: 'string', description: 'Their primary region or HQ if evident, else empty string.' },
          whyRelevant: { type: 'string', description: 'One short phrase: why they compete with us / overlap with our offering.' },
          theirStrength: { type: 'string', description: 'One short phrase: this competitor\'s main strength / why buyers pick them.' },
          threatToProductIds: { type: 'array', items: { type: 'string' }, description: 'The ids of OUR products this competitor most directly threatens, chosen ONLY from the provided product id list. Empty array if none of ours overlaps.' },
          threatLevel: { type: 'integer', description: 'How directly/severely they compete with us, 1 (minimal) to 5 (critical / head-on). Weigh overlap with our products, their strength, and market presence.' },
          incumbentAtProspects: { type: 'array', items: { type: 'string' }, description: 'Names chosen ONLY from the provided OUR PROSPECTS list that the findings indicate this competitor ALREADY works with / serves / is a vendor to. Empty array if none — do NOT guess.' },
          ...CONTACT_PROPS,
        },
        required: ['name', 'description', 'website', 'region', 'whyRelevant', 'theirStrength', 'threatToProductIds', 'threatLevel', 'incumbentAtProspects', ...CONTACT_REQUIRED],
      },
    },
  },
  required: ['competitors'],
};

// Shared grounding block for discovery prompts: separates WHAT WE DO
// (positioning) from WHO WE SELL TO (ICP) so the model targets buyers, not peers.
function buildContext({ name, positioning = '', objectives = '', idealCustomerProfile = '' }) {
  return [
    `Name: ${name}`,
    positioning ? `What we do: ${String(positioning).slice(0, 800)}` : '',
    objectives ? `Our goals: ${String(objectives).slice(0, 400)}` : '',
    idealCustomerProfile ? `WHO WE SELL TO (our buyers / ICP): ${String(idealCustomerProfile).slice(0, 600)}` : '',
  ].filter(Boolean).join('\n');
}

const QUERIES_SCHEMA = {
  type: 'object',
  properties: { queries: { type: 'array', items: { type: 'string' }, description: '6-8 concise web-search queries (no quotes/operators).' } },
  required: ['queries'],
};

// Turn the business context into targeted web-search queries. mode='prospect'
// finds the tenant's BUYERS (per the ICP); mode='competitor' finds rival vendors
// offering a similar solution to the SAME buyers. Returns [] on failure so
// callers fall back to their hardcoded query builders (no hard dependency).
async function generateSearchQueries({ mode, ctx, products = [], region = '', segment = '' }) {
  try {
    const portfolio = (products || []).map((p) => `- ${p.name}${p.description ? ': ' + p.description : ''}`).join('\n') || '(none)';
    const regionLine = region && !/global|any|worldwide/i.test(region) ? `Region focus: ${region}.` : 'No region restriction.';
    const task = mode === 'competitor'
      ? 'Generate web-search queries to find VENDORS WHOSE PRODUCT DIRECTLY COMPETES WITH OURS — i.e. other companies selling the SAME PRODUCT CATEGORY (see OUR PRODUCTS) to the same kind of buyers. Target each product category by its industry term (e.g. "3-D Secure server vendors", "card tokenization platform providers", "fraud detection software for banks", "payment gateway software vendors", "card management system providers"). ' +
        'IMPORTANT: many top competitors are GLOBAL specialist/infrastructure vendors that SERVE the region rather than being headquartered there — so include BOTH global product-category queries AND a few region-scoped ones. Do NOT target our own customers, generic consumer payment apps/wallets, or our buyers\' industry at large.'
      : 'Generate web-search queries to find OUR POTENTIAL CUSTOMERS — the businesses in WHO WE SELL TO that would BUY our product (target their type, location, recent openings/expansion/hiring). Do NOT target companies like us (peers/competitors) or our suppliers.';
    const prompt =
      'You are a B2B research assistant. ' + task + '\n' +
      'Return 6-8 short, high-signal search queries (plain words, no quotes or operators). ' + regionLine + '\n' +
      (segment ? `Target customer segment hint: ${segment}.\n` : '') +
      `\n===OUR BUSINESS===\n${ctx}\n\n===OUR PRODUCTS===\n${portfolio}`;
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.4, maxOutputTokens: 600, responseMimeType: 'application/json', responseSchema: QUERIES_SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
    }));
    const parsed = JSON.parse(resp.text);
    const qs = Array.isArray(parsed.queries) ? parsed.queries : [];
    return [...new Set(qs.map((q) => String(q || '').replace(/\s+/g, ' ').trim()).filter((q) => q.length > 4))].slice(0, 8);
  } catch (err) {
    console.warn(`[discovery] generateSearchQueries(${mode}) failed: ${(err && err.message) || err}`);
    return [];
  }
}

// Find companies that compete with OUR company, optionally focused on a region.
// Returns { competitors: [...] } (possibly empty) or null on hard failure.
// Read-only research: no ingest, no storage (the rep adds the relevant ones).
async function discoverCompetitors({ companyName, ourProducts = [], positioning = '', objectives = '', idealCustomerProfile = '', region = '', buyerMarket = '', prospects = [] } = {}) {
  const name = String(companyName || '').trim();
  if (!name) return null;
  // Our existing prospects → let the model flag competitors already entrenched at
  // them ("incumbent at account"). Names only; capped to keep the prompt lean.
  const prospectNames = [...new Set((prospects || []).map((p) => String((p && p.name) || p || '').trim()).filter(Boolean))].slice(0, 60);
  const prospectSet = new Map(prospectNames.map((n) => [n.toLowerCase(), n]));

  const regionLabel = String(region || '').trim();
  const regionIsGlobal = !regionLabel || /global|any|worldwide/i.test(regionLabel);
  const regionTerm = regionIsGlobal ? '' : regionLabel.replace(/\s*\/\s*/g, ' ');
  const topProducts = (ourProducts || []).map((p) => p && p.name).filter(Boolean).slice(0, 3);
  // Rivals (other vendors of our kind of product) are usually national/global,
  // NOT in the buyer's city — so `buyerMarket` (e.g. "Houston, US") is context
  // about WHO we serve, kept separate from the competitor search scope (region).
  const ctx = buildContext({ name, positioning, objectives, idealCustomerProfile })
    + (buyerMarket ? `\nOur customers/market are located in: ${buyerMarket}` : '');

  // LLM-generated product-category queries are FIRST so they fill (and get
  // scraped into) the findings — the brand-anchored "X competitors" queries go
  // LAST because they mostly return generic aggregator listicles (ZoomInfo/Craft)
  // that name household consumer brands as "competitors" and otherwise dominate.
  // Two passes of category queries: GLOBAL (so the findings actually contain the
  // major infrastructure-software vendors — which serve the region but aren't
  // headquartered there) AND region-scoped (regional players). Without the
  // global pass every result is a local PSP and the model can't surface the
  // global category leaders. Global pages go first so they're in the findings.
  const [genGlobal, genRegion] = await Promise.all([
    generateSearchQueries({ mode: 'competitor', ctx, products: ourProducts, region: '' }),
    regionIsGlobal ? Promise.resolve([]) : generateSearchQueries({ mode: 'competitor', ctx, products: ourProducts, region: regionLabel }),
  ]);
  const baseQueries = [
    `${name} competitors${regionTerm ? ' ' + regionTerm : ''}`,
  ];
  if (topProducts.length) baseQueries.push(`${topProducts[0]} competitors`);
  // Interleave regional + global so BOTH segments get scraped into the findings
  // (a flat concat let whichever came first dominate → all-regional or all-global).
  const zipped = [];
  for (let i = 0; i < Math.max(genRegion.length, genGlobal.length); i++) {
    if (genRegion[i]) zipped.push(genRegion[i]);
    if (genGlobal[i]) zipped.push(genGlobal[i]);
  }
  const queries = [...new Set([...zipped, ...baseQueries])];

  // Wide net (like prospect discovery) so the category-specific results — not the
  // few brand listicles — make up the findings the model reasons over.
  const findings = await gatherFromQueries(queries, { maxHits: COMPETITOR_MAX_HITS, scrapeTop: COMPETITOR_SCRAPE_TOP, searchLimit: 6 });
  if (!findings.text || findings.text.length < 40) return { competitors: [] };

  const ourIds = new Set((ourProducts || []).map((p) => p && p.id).filter(Boolean));
  const byId = new Map((ourProducts || []).filter((p) => p && p.id).map((p) => [p.id, p.name]));
  const portfolio = (ourProducts || []).length
    ? (ourProducts || []).map((p) => `- id="${p.id}" · ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '(no products on file — leave threatToProductIds empty for all)';

  const prompt =
    'You are a competitive-intelligence analyst with deep, current knowledge of this company\'s industry ' +
    'and its vendor landscape. Identify the companies whose PRODUCT directly competes with one of OUR ' +
    'PRODUCTS (===OUR PRODUCTS===) — i.e. they sell the SAME PRODUCT CATEGORY (e.g. a rival 3-D Secure ' +
    'server, card tokenization platform, fraud/risk engine, payment gateway/processor, or card-management ' +
    'system) to the same kind of buyers.\n' +
    'USE BOTH your own market knowledge AND the web findings below: name the real, specific vendors that ' +
    'genuinely compete in each of our product categories — do not settle for whatever generic names happen ' +
    'to appear in the findings. The findings are supporting evidence (recency, regional presence, specifics), ' +
    'NOT the limit of what you may list. Only include companies that REALLY EXIST and genuinely offer a ' +
    'competing product (never invent a company).\n' +
    'STRONGLY PREFER specialist / infrastructure / software vendors that match our product categories ' +
    '(including GLOBAL vendors that serve the target market). DEPRIORITIZE / EXCLUDE generic consumer ' +
    'payment apps & wallets, money-transfer/remittance services, and SMB merchant-account resellers unless ' +
    'they directly sell one of our product categories. When a household-name consumer brand and a specialist ' +
    'vendor both fit, prefer the specialist. Be sure to ALSO include the major GLOBAL bank / issuer / ' +
    'acquirer infrastructure-software vendors for our product categories (e.g. rival 3-D Secure servers, ' +
    'tokenization, fraud, card-management and gateway software sold to banks) — not only regional payment ' +
    'service providers. Do NOT list our own customers or suppliers. ' +
    (regionIsGlobal
      ? 'Cover the most relevant competitors broadly. '
      : `Prioritise competitors operating in or SERVING the target region: ${regionLabel} (they need NOT be headquartered there — global vendors serving it count, and are often the most important). `) +
    (regionIsGlobal ? '' : `Return a BLEND: BOTH the major global category leaders AND the most significant vendors operating in / serving ${regionLabel}. `) +
    'Aim for a useful, reasonably comprehensive list (up to ~15), ordered by how directly they threaten us.\n' +
    'For EACH competitor, also assess: their main strength; which of OUR products (by id, from the ' +
    'list) they most directly THREATEN; and a threatLevel 1-5 (5 = critical / head-on) weighing ' +
    'product overlap, their strength, and market presence.\n' +
    (prospectNames.length
      ? 'Also, for each competitor, set incumbentAtProspects to any names from ===OUR PROSPECTS=== that you ' +
        'know or the findings indicate this competitor ALREADY serves / is a vendor to (an entrenched ' +
        'incumbent at that account). Use ONLY names from that list; empty array if none — do not guess.\n'
      : '') +
    CONTACT_INSTRUCTION + '\n' +
    'Rules: only REAL companies that genuinely offer a competing product; EXCLUDE our own ' +
    'company; one company per row; keep strings short; threatToProductIds MUST be chosen from the ' +
    'provided ids (or empty); give the primary website domain only if you are confident; ignore website ' +
    'boilerplate (cookie/nav/legal).\n\n' +
    `===OUR COMPANY===\n${ctx}\n\n` +
    `===OUR PRODUCTS (choose threatToProductIds from these ids)===\n${portfolio}\n\n` +
    (prospectNames.length ? `===OUR PROSPECTS (choose incumbentAtProspects ONLY from these names)===\n${prospectNames.join('\n')}\n\n` : '') +
    (regionIsGlobal ? '' : `===TARGET REGION===\n${regionLabel}\n\n`) +
    `===WEB FINDINGS===\n${findings.text}`;

  try {
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.2,
        maxOutputTokens: LIST_MAXTOK,
        responseMimeType: 'application/json',
        responseSchema: COMPETITORS_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const raw = parseItemsLoose(resp.text, 'competitors');
    if (raw === null) return null; // no usable model output → caller 502s (no charge)
    const ownName = name.toLowerCase();
    const seen = new Set();
    const competitors = [];
    for (const c of raw) {
      const cName = String((c && c.name) || '').trim();
      if (!cName) continue;
      const key = cName.toLowerCase();
      if (key === ownName || seen.has(key)) continue; // drop self + dupes
      seen.add(key);
      const threatIds = Array.isArray(c.threatToProductIds)
        ? c.threatToProductIds.filter((id) => typeof id === 'string' && ourIds.has(id))
        : [];
      let threatLevel = Number.isFinite(c.threatLevel) ? Math.round(c.threatLevel) : 3;
      threatLevel = Math.max(1, Math.min(5, threatLevel));
      // Keep only incumbent flags that match an actual prospect name (the model
      // is told to use the provided list; this enforces it).
      const incumbentAtProspects = Array.isArray(c.incumbentAtProspects)
        ? [...new Set(c.incumbentAtProspects.map((n) => prospectSet.get(String(n || '').trim().toLowerCase())).filter(Boolean))]
        : [];
      competitors.push({
        name: cName,
        description: String(c.description || '').trim(),
        website: String(c.website || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''),
        region: String(c.region || '').trim(),
        whyRelevant: String(c.whyRelevant || '').trim(),
        theirStrength: String(c.theirStrength || '').trim(),
        threatToProductIds: threatIds,
        threatToProductNames: threatIds.map((id) => byId.get(id)).filter(Boolean),
        threatLevel,
        incumbentAtProspects,
        ...pickContact(c),
      });
      if (competitors.length >= MAX_PRODUCTS) break;
    }
    // Order by competing threat (highest first), then name for stable ties.
    competitors.sort((a, b) => (b.threatLevel - a.threatLevel) || a.name.localeCompare(b.name));
    return { competitors };
  } catch (err) {
    console.warn(`[discovery] discoverCompetitors failed: ${(err && err.message) || err}`);
    return null;
  }
}

// ── Prospect discovery (find potential CUSTOMERS for OUR company) ─────────

const PROSPECTS_SCHEMA = {
  type: 'object',
  properties: {
    prospects: {
      type: 'array',
      description: 'Real companies that are strong POTENTIAL CUSTOMERS for OUR company/products — they fit our ICP; especially ones showing a recent buying signal. Use market knowledge + findings, but only REAL companies (never invent); exclude OUR own company and competitors.',
      items: {
        type: 'object',
        properties: {
          name:       { type: 'string', description: 'The prospect company\'s name.' },
          domain:     { type: 'string', description: 'Their primary website domain (e.g. acme.com) if evident, else empty string.' },
          signal:     { type: 'string', description: 'The recent buying signal / why-now if one is evidenced in the findings (e.g. "rolled out a new core banking system", "raised Series B", "expanding to 3 new markets"). If this is a known ICP-fit company but the findings show no fresh event, give a short fit-based rationale instead — do NOT fabricate a specific event.' },
          matchedProductIds: { type: 'array', items: { type: 'string' }, description: 'The ids of OUR products that fit the need this signal creates, chosen ONLY from the provided product id list. Empty if none clearly fits.' },
          fitReason:  { type: 'string', description: 'One sentence: why our product(s) meet the need the signal creates.' },
          priority:   { type: 'integer', description: 'How strong + timely a prospect, 1 (low) to 5 (critical: clear product fit AND a fresh, relevant signal).' },
          ...CONTACT_PROPS,
        },
        required: ['name', 'domain', 'signal', 'matchedProductIds', 'fitReason', 'priority', ...CONTACT_REQUIRED],
      },
    },
  },
  required: ['prospects'],
};

// Find potential customers for OUR company, scoped by region + industry, ranked
// by priority. Returns { prospects: [...] } (possibly empty) or null on failure.
async function discoverProspects({ companyName, ourProducts = [], positioning = '', objectives = '', idealCustomerProfile = '', region = '', industry = '', limit } = {}) {
  const name = String(companyName || '').trim();
  if (!name) return null;
  // How many prospects this turn returns — clamped to [1, PROSPECT_HARD_MAX].
  // Falls back to the module default when unset/invalid so existing callers are
  // unchanged. Drives both the prompt target and the post-filter cap below.
  const want = Math.max(1, Math.min(PROSPECT_HARD_MAX, parseInt(limit, 10) || PROSPECT_MAX));

  const regionLabel = String(region || '').trim();
  const regionIsGlobal = !regionLabel || /global|any|worldwide/i.test(regionLabel);
  const regionTerm = regionIsGlobal ? '' : regionLabel.replace(/\s*\/\s*/g, ' ');
  const ind = String(industry || '').trim();
  const indIsAny = !ind || /^any|all industries/i.test(ind);
  const indTerm = indIsAny ? '' : ind;

  const ourIds = new Set((ourProducts || []).map((p) => p && p.id).filter(Boolean));
  const byId = new Map((ourProducts || []).filter((p) => p && p.id).map((p) => [p.id, p.name]));

  // Capability phrase for a product: prefer its description, strip a leading brand
  // token (e.g. "Wibmo ACS (Authentication Control Server)" → "ACS Authentication
  // Control Server") so the web query targets the NEED, not our brand name.
  const companyToken = (name.split(/\s+/)[0] || '').toLowerCase();
  const capabilityOf = (p) => {
    let t = String((p && p.description) || (p && p.name) || '').trim();
    if (companyToken) t = t.replace(new RegExp('^' + companyToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i'), '');
    return t.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 7).join(' ').trim();
  };
  const prodCaps = [...new Set((ourProducts || []).map(capabilityOf).filter((c) => c && c.length > 3))].slice(0, 6);

  const ctx = buildContext({ name, positioning, objectives, idealCustomerProfile });

  // Primary: LLM-generated queries that target OUR BUYERS (per the ICP) — adapts
  // to the actual business (local venues vs enterprise) instead of a fixed list.
  // Fallback (generation failed): the legacy industry+buying-signal net.
  let queriesClean = await generateSearchQueries({ mode: 'prospect', ctx, products: ourProducts, region: regionLabel, segment: indTerm });
  if (!queriesClean.length) {
    const base = [indTerm, regionTerm].filter(Boolean).join(' ').trim();
    const SIGNALS = [
      'digital transformation initiative', 'recently implemented new technology',
      'expanding into new markets', 'raised funding round', 'launching new product',
      'modernization project', 'new strategic partnership', 'regulatory compliance upgrade',
      'rapid growth scaling',
    ];
    const queries = [];
    for (const s of SIGNALS) queries.push(`${base} companies ${s}`.trim());
    for (const cap of prodCaps) queries.push(`${base} companies need ${cap}`.trim());
    queriesClean = [...new Set(queries.map((q) => q.replace(/\s+/g, ' ').trim()))].filter((q) => q.length > 6);
    if (!queriesClean.length) queriesClean.push(`${name} ideal customers`);
  }

  const findings = await gatherFromQueries(queriesClean, { maxHits: PROSPECT_MAX_HITS, scrapeTop: PROSPECT_SCRAPE_TOP, searchLimit: 6 });
  if (!findings.text || findings.text.length < 40) return { prospects: [] };

  const portfolio = (ourProducts || []).length
    ? (ourProducts || []).map((p) => `- id="${p.id}" · ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '(no products on file — leave matchedProductIds empty for all)';

  const prompt =
    'You are a B2B sales-prospecting analyst with strong, current knowledge of this company\'s target ' +
    'market. Identify real COMPANIES that are strong POTENTIAL CUSTOMERS for OUR company — businesses that ' +
    'MATCH WHO WE SELL TO (our ICP, in ===OUR COMPANY===) and would BUY our product.\n' +
    'USE BOTH your market knowledge AND the web findings below: name the real, specific companies that fit ' +
    'our ICP in the target segment/region — do not settle for only the names that happen to appear in the ' +
    'findings. The findings are supporting evidence (buying signals, recency, specifics), NOT the limit of ' +
    'what you may list. Only include companies that REALLY EXIST — never invent a company.\n' +
    'CRITICAL: return only our BUYERS — do NOT return companies like US (peers/competitors/other vendors of ' +
    'our kind of product) or our suppliers. ' +
    (indIsAny ? '' : `Our target customer segment is "${ind}" — find buyers in/around it (not companies like us). `) +
    (regionIsGlobal ? '' : `Focus on companies in or serving ${regionLabel}. `) +
    'For each company: the signal/why-now, which of OUR products fit (ids from the list) + a one-sentence ' +
    'fit reason, and priority 1-5.\n' +
    'PRIORITY RUBRIC — apply STRICTLY; do not bunch everything at one level:\n' +
    '  • 5 = a FRESH, specific buying signal evidenced in the WEB FINDINGS below (new opening/expansion, ' +
    'hiring, funding, tech adoption, leadership/regulatory change) AND a strong fit with our products.\n' +
    '  • 4 = a buying signal evidenced in the WEB FINDINGS, but weaker/older or a looser product fit.\n' +
    '  • 3 = NO signal, but a CORE buyer from your knowledge: fits MULTIPLE of our products, or is a flagship ' +
    'target in a priority market.\n' +
    '  • 2 = NO signal; a clear fit with at least one of our products; a mainstream buyer.\n' +
    '  • 1 = NO signal; a more peripheral/smaller/adjacent fit, or only a marginal product match.\n' +
    'HARD RULE 1: priority 4 and 5 are RESERVED for companies whose buying signal is actually evidenced in the ' +
    '===WEB FINDINGS===. A company included from your own knowledge with no such finding MUST be 1-3 — never 4 or 5.\n' +
    'HARD RULE 2: grade the knowledge-only companies by the 1/2/3 criteria above (product-match breadth + how ' +
    'core a buyer) and ACTUALLY USE ALL THREE LEVELS — they are NOT all equal. Do not park them all at 3: as a ' +
    'guide, only the clear multi-product / flagship buyers earn 3, the solid single-product fits are 2, and the ' +
    'weaker/peripheral fits are 1. For a knowledge-only company use a short fit-based rationale as its signal; ' +
    'never fabricate a specific event the findings do not support.\n' +
    CONTACT_INSTRUCTION + '\n' +
    `TARGET COUNT — IMPORTANT: aim to actually REACH ${want} distinct REAL companies. The web findings name only a few; do NOT stop there. Draw PRIMARILY on your own up-to-date knowledge of companies that match "WHO WE SELL TO" in the target segment/region to enumerate up to ${want}, and use the findings to attach signals + set priority on the ones they cover. Companies you add from knowledge (no fresh signal) get a short fit-based rationale and a lower priority — that is expected and wanted. Only return fewer than ${want} if there genuinely are not that many real ICP-fit companies (never invent to pad). Order best-fit first.\n` +
    'Rules: REAL companies only (never invent); EXCLUDE our own company and our competitors; matchedProductIds ' +
    'MUST be from the provided ids (or empty); keep strings short; ignore boilerplate.\n\n' +
    `===OUR COMPANY===\n${ctx}\n\n` +
    `===OUR PRODUCTS (choose matchedProductIds from these ids)===\n${portfolio}\n\n` +
    (indIsAny ? '' : `===TARGET CUSTOMER SEGMENT===\n${ind}\n\n`) +
    (regionIsGlobal ? '' : `===TARGET REGION===\n${regionLabel}\n\n`) +
    `===WEB FINDINGS===\n${findings.text}`;

  try {
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        // Scale the JSON budget with the requested count (~400 tok/prospect row
        // incl. contact fields) so a large list isn't truncated mid-array; never
        // below the default, capped to the model's output ceiling.
        maxOutputTokens: Math.min(65000, Math.max(PROSPECT_MAXTOK, want * 400)),
        responseMimeType: 'application/json',
        responseSchema: PROSPECTS_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const raw = parseItemsLoose(resp.text, 'prospects');
    if (raw === null) return null; // no usable model output → caller 502s (no charge)
    const ownName = name.toLowerCase();
    const seen = new Set();
    const prospects = [];
    for (const c of raw) {
      const cName = String((c && c.name) || '').trim();
      if (!cName) continue;
      const key = cName.toLowerCase();
      if (key === ownName || seen.has(key)) continue;
      seen.add(key);
      const ids = Array.isArray(c.matchedProductIds)
        ? c.matchedProductIds.filter((id) => typeof id === 'string' && ourIds.has(id))
        : [];
      let priority = Number.isFinite(c.priority) ? Math.round(c.priority) : 3;
      priority = Math.max(1, Math.min(5, priority));
      prospects.push({
        name: cName,
        domain: String(c.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''),
        signal: String(c.signal || '').trim(),
        matchedProductIds: ids,
        matchedProductNames: ids.map((id) => byId.get(id)).filter(Boolean),
        fitReason: String(c.fitReason || '').trim(),
        priority,
        ...pickContact(c),
      });
    }
    // Rank by priority (highest first), then name for stable ties, THEN cap to
    // the requested count — so the top `want` by priority are kept, not just the
    // first `want` in model order (preserves relevance when the list is trimmed).
    prospects.sort((a, b) => (b.priority - a.priority) || a.name.localeCompare(b.name));
    return { prospects: prospects.slice(0, want) };
  } catch (err) {
    console.warn(`[discovery] discoverProspects failed: ${(err && err.message) || err}`);
    return null;
  }
}

module.exports = { discoverCompetitorProducts, discoverCompetitors, discoverProspects, generateSearchQueries, buildContext, gatherFromQueries };
