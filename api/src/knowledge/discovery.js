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
const PROSPECT_MAX_HITS = parseInt(process.env.KB_DISCOVERY_PROSPECT_MAX_HITS || '28', 10);
const PROSPECT_SCRAPE_TOP = parseInt(process.env.KB_DISCOVERY_PROSPECT_SCRAPE_TOP || '4', 10);

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
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const parsed = JSON.parse(resp.text);
    const raw = Array.isArray(parsed.products) ? parsed.products : [];
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
        },
        required: ['name', 'description', 'website', 'region', 'whyRelevant', 'theirStrength', 'threatToProductIds', 'threatLevel'],
      },
    },
  },
  required: ['competitors'],
};

// Find companies that compete with OUR company, optionally focused on a region.
// Returns { competitors: [...] } (possibly empty) or null on hard failure.
// Read-only research: no ingest, no storage (the rep adds the relevant ones).
async function discoverCompetitors({ companyName, ourProducts = [], positioning = '', region = '' } = {}) {
  const name = String(companyName || '').trim();
  if (!name) return null;

  const regionLabel = String(region || '').trim();
  const regionIsGlobal = !regionLabel || /global|any|worldwide/i.test(regionLabel);
  const regionTerm = regionIsGlobal ? '' : regionLabel.replace(/\s*\/\s*/g, ' ');
  const topProducts = (ourProducts || []).map((p) => p && p.name).filter(Boolean).slice(0, 3);

  // Queries: rivals of the company + alternatives to our products, region-scoped.
  const queries = [
    `${name} competitors${regionTerm ? ' ' + regionTerm : ''}`,
    `${name} alternatives`,
    `top competitors of ${name}${regionTerm ? ' in ' + regionTerm : ''}`,
  ];
  if (topProducts.length) {
    queries.push(`${topProducts[0]} competitors${regionTerm ? ' ' + regionTerm : ''}`);
  }
  if (regionTerm) queries.push(`${regionTerm} companies like ${name}`);

  const findings = await gatherFromQueries(queries);
  if (!findings.text || findings.text.length < 40) return { competitors: [] };

  const ourIds = new Set((ourProducts || []).map((p) => p && p.id).filter(Boolean));
  const byId = new Map((ourProducts || []).filter((p) => p && p.id).map((p) => [p.id, p.name]));
  const portfolio = (ourProducts || []).length
    ? (ourProducts || []).map((p) => `- id="${p.id}" · ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '(no products on file — leave threatToProductIds empty for all)';

  const ctx = [
    `Name: ${name}`,
    positioning ? `Positioning: ${String(positioning).slice(0, 800)}` : '',
  ].filter(Boolean).join('\n');

  const prompt =
    'You are a competitive-intelligence analyst. Using ONLY the web findings below, ' +
    'list companies that DIRECTLY compete with OUR company (described under ===OUR COMPANY===). ' +
    (regionIsGlobal
      ? 'Cover competitors broadly. '
      : `Focus on competitors operating in or serving the target region: ${regionLabel}. `) +
    'For EACH competitor, also assess: their main strength; which of OUR products (by id, from the ' +
    'list) they most directly THREATEN; and a threatLevel 1-5 (5 = critical / head-on) weighing ' +
    'product overlap, their strength, and market presence.\n' +
    'Rules: only list companies the findings actually support (don\'t invent); EXCLUDE our own ' +
    'company; one company per row; keep strings short; threatToProductIds MUST be chosen from the ' +
    'provided ids (or empty); give the primary website domain only if evident; ignore website ' +
    'boilerplate (cookie/nav/legal).\n\n' +
    `===OUR COMPANY===\n${ctx}\n\n` +
    `===OUR PRODUCTS (choose threatToProductIds from these ids)===\n${portfolio}\n\n` +
    (regionIsGlobal ? '' : `===TARGET REGION===\n${regionLabel}\n\n`) +
    `===WEB FINDINGS===\n${findings.text}`;

  try {
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.2,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
        responseSchema: COMPETITORS_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const parsed = JSON.parse(resp.text);
    const raw = Array.isArray(parsed.competitors) ? parsed.competitors : [];
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
      description: 'Companies that are strong POTENTIAL CUSTOMERS for OUR company/products, supported by the findings — especially ones showing a recent buying signal. Do not invent companies the findings do not support; exclude OUR own company.',
      items: {
        type: 'object',
        properties: {
          name:       { type: 'string', description: 'The prospect company\'s name.' },
          domain:     { type: 'string', description: 'Their primary website domain (e.g. acme.com) if evident, else empty string.' },
          signal:     { type: 'string', description: 'The recent buying signal / why-now (e.g. "rolled out a new core banking system", "raised Series B", "expanding to 3 new markets").' },
          matchedProductIds: { type: 'array', items: { type: 'string' }, description: 'The ids of OUR products that fit the need this signal creates, chosen ONLY from the provided product id list. Empty if none clearly fits.' },
          fitReason:  { type: 'string', description: 'One sentence: why our product(s) meet the need the signal creates.' },
          priority:   { type: 'integer', description: 'How strong + timely a prospect, 1 (low) to 5 (critical: clear product fit AND a fresh, relevant signal).' },
        },
        required: ['name', 'domain', 'signal', 'matchedProductIds', 'fitReason', 'priority'],
      },
    },
  },
  required: ['prospects'],
};

// Find potential customers for OUR company, scoped by region + industry, ranked
// by priority. Returns { prospects: [...] } (possibly empty) or null on failure.
async function discoverProspects({ companyName, ourProducts = [], positioning = '', region = '', industry = '' } = {}) {
  const name = String(companyName || '').trim();
  if (!name) return null;

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

  // Cast a wide, product-aligned net: many buying-signal angles + one query per
  // product capability. gatherFromQueries dedupes by URL and stops at the cap.
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
  const queriesClean = [...new Set(queries.map((q) => q.replace(/\s+/g, ' ').trim()))].filter((q) => q.length > 6);
  if (!queriesClean.length) queriesClean.push(`${name} ideal customers`);

  const findings = await gatherFromQueries(queriesClean, { maxHits: PROSPECT_MAX_HITS, scrapeTop: PROSPECT_SCRAPE_TOP, searchLimit: 6 });
  if (!findings.text || findings.text.length < 40) return { prospects: [] };

  const portfolio = (ourProducts || []).length
    ? (ourProducts || []).map((p) => `- id="${p.id}" · ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '(no products on file — leave matchedProductIds empty for all)';
  const ctx = [
    `Name: ${name}`,
    positioning ? `Positioning: ${String(positioning).slice(0, 800)}` : '',
  ].filter(Boolean).join('\n');

  const prompt =
    'You are a B2B sales-prospecting analyst. Using ONLY the web findings below, identify COMPANIES ' +
    'that are strong POTENTIAL CUSTOMERS for OUR company/products (===OUR COMPANY===) — especially ones ' +
    'showing a RECENT BUYING SIGNAL (new tech adoption, expansion, funding, hiring, regulatory or ' +
    'leadership change) that creates a need OUR products meet. ' +
    (indIsAny ? '' : `Focus on the ${ind} industry. `) +
    (regionIsGlobal ? '' : `Focus on companies in or serving ${regionLabel}. `) +
    'For each company: the signal (why now), which of OUR products fit (ids from the list) + a one-sentence ' +
    'fit reason, and priority 1-5 (5 = critical: clear product fit AND a fresh relevant signal).\n' +
    'Aim for BREADTH: list EVERY distinct company in the findings that plausibly fits our products ' +
    `(up to ${PROSPECT_MAX}). Include lower-priority ones too (rank them 1-2) — do not drop a real ` +
    'company just because the signal is mild. Rank strongest fit + freshest signal highest.\n' +
    'Rules: only companies the findings actually support (don\'t invent); EXCLUDE our own company; ' +
    'matchedProductIds MUST be from the provided ids (or empty); keep strings short; ignore boilerplate.\n\n' +
    `===OUR COMPANY===\n${ctx}\n\n` +
    `===OUR PRODUCTS (choose matchedProductIds from these ids)===\n${portfolio}\n\n` +
    (indIsAny ? '' : `===TARGET INDUSTRY===\n${ind}\n\n`) +
    (regionIsGlobal ? '' : `===TARGET REGION===\n${regionLabel}\n\n`) +
    `===WEB FINDINGS===\n${findings.text}`;

  try {
    const ai = gemini.getClient();
    const resp = await withRetry(() => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
        responseSchema: PROSPECTS_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }));
    const parsed = JSON.parse(resp.text);
    const raw = Array.isArray(parsed.prospects) ? parsed.prospects : [];
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
      });
      if (prospects.length >= PROSPECT_MAX) break;
    }
    // Rank by priority (highest first), then name for stable ties.
    prospects.sort((a, b) => (b.priority - a.priority) || a.name.localeCompare(b.name));
    return { prospects };
  } catch (err) {
    console.warn(`[discovery] discoverProspects failed: ${(err && err.message) || err}`);
    return null;
  }
}

module.exports = { discoverCompetitorProducts, discoverCompetitors, discoverProspects };
