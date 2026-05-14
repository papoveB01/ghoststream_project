// Deep Research on a prospect.
//
// Scrapes the prospect's own site (Firecrawl /map → /scrape on the high-value
// pages) plus a handful of targeted web searches (Firecrawl /search), assembles
// a numbered, source-tagged "dossier", and has Gemini turn it into sales-
// opportunity points mapped to THIS tenant's product portfolio & objectives.
//
// Fire-and-forget: `start(tenantId, companyId)` inserts a RUNNING row and runs
// the work in the background; the row flips to DONE / FAILED. `latest()` /
// `listForTenant()` read it back. Stale RUNNING rows (process restarted mid-run)
// are reaped to FAILED on read so the UI doesn't spin forever.

const db = require('../db');
const gemini = require('../gemini');
const web = require('./web');
const keypoints = require('./keypoints');

const MODEL =
  process.env.GEMINI_RESEARCH_MODEL ||
  process.env.GEMINI_ANALYSIS_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-2.5-flash';
const SITE_MAP_LIMIT    = parseInt(process.env.RESEARCH_SITE_MAP_LIMIT || '40', 10);
const SITE_SCRAPE_LIMIT = parseInt(process.env.RESEARCH_SITE_SCRAPE_LIMIT || '5', 10);
const SEARCH_PER_QUERY  = parseInt(process.env.RESEARCH_SEARCH_PER_QUERY || '4', 10);
const SEARCH_SCRAPE_TOP = parseInt(process.env.RESEARCH_SEARCH_SCRAPE_TOP || '2', 10);
const SOURCE_TEXT_CAP   = parseInt(process.env.RESEARCH_SOURCE_TEXT_CAP || '3500', 10);
const DOSSIER_CAP       = parseInt(process.env.RESEARCH_DOSSIER_CAP || '40000', 10);
const STALE_RUNNING_MS  = parseInt(process.env.RESEARCH_STALE_MS || '600000', 10); // 10 min

// High-value path patterns on a prospect's own site, in priority order.
const PRIORITY_PATHS = [
  /\/(news|press|media|newsroom|press-releases?)\b/i,
  /\/(investor|investor-relations|ir)\b/i,
  /\/(about|about-us|company|who-we-are|our-(story|organisation|organization))\b/i,
  /\/(products?|solutions?|platform|services?)\b/i,
  /\/(careers?|jobs|work-with-us)\b/i,
  /\/(pricing|plans)\b/i,
  /\/(blog|insights)\b/i,
];

function normalizeOrigin(domain) {
  if (!domain) return null;
  let d = String(domain).trim();
  if (!d) return null;
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
  try { return new URL(d).origin; } catch { return null; }
}

// Signal-targeted search queries — no LLM needed to compose these.
function searchQueries(name) {
  const q = `"${name}"`;
  return [
    `${q} news 2025 2026`,
    `${q} appoints OR appointed OR "new CEO" OR "new executive" OR leadership change`,
    `${q} raises OR funding OR investment OR acquires OR acquisition OR merger`,
    `${q} earnings OR results OR revenue OR profit OR "annual report"`,
    `${q} regulation OR mandate OR "central bank" OR policy OR compliance OR ruling OR directive`,
    `${q} strategy OR "strategic plan" OR transformation OR digital OR modernization OR roadmap`,
    `${q} launches OR partnership OR expansion OR "new product" OR hiring OR careers`,
  ];
}

function dedupeKey(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, ''); }
  catch { return String(url); }
}

// ── source gathering ──────────────────────────────────────────────────────
// → { sources: [{n,url,title,date,snippet,scraped,text}], queryCount }
async function gatherSources(name, origin) {
  const seen = new Set();
  const sources = [];
  let n = 0;
  const add = ({ url, title = null, date = null, snippet = null, text = null }) => {
    if (!url) return;
    const k = dedupeKey(url);
    if (seen.has(k)) return;
    seen.add(k);
    sources.push({ n: ++n, url, title, date, snippet, scraped: !!(text && text.length > 80), text: text && text.length > 80 ? text : null });
  };

  // 1. The prospect's own site: /map → pick the homepage + priority pages → scrape a few.
  if (origin) {
    const links = await web.mapSite(origin, { limit: SITE_MAP_LIMIT });
    const scored = links
      .map((u) => {
        let path = '';
        try { path = new URL(u).pathname; } catch { /* ignore */ }
        if (path === '' || path === '/') return { u, score: -1 };
        const idx = PRIORITY_PATHS.findIndex((re) => re.test(path));
        return { u, score: idx === -1 ? 99 : idx };
      })
      .sort((a, b) => a.score - b.score);
    const picks = [];
    const pushUnique = (u) => { if (u && !picks.some((p) => dedupeKey(p) === dedupeKey(u))) picks.push(u); };
    pushUnique(origin);
    for (const s of scored) { if (picks.length >= SITE_SCRAPE_LIMIT) break; if (s.score >= 0) pushUnique(s.u); }
    for (const u of picks.slice(0, SITE_SCRAPE_LIMIT)) {
      const md = await web.scrapeMarkdown(u);
      if (md && md.markdown) {
        add({ url: md.url, title: md.title, date: md.publishedTime, text: keypoints.stripBoilerplate(md.markdown).slice(0, SOURCE_TEXT_CAP) });
      } else {
        add({ url: u });
      }
    }
  }

  // 2. Targeted web searches (parallel); scrape the top few result URLs per
  //    query, snippet the rest.
  const queries = searchQueries(name);
  const searchResults = await Promise.all(queries.map((qry) => web.search(qry, { limit: SEARCH_PER_QUERY })));
  for (const results of searchResults) {
    let scraped = 0;
    for (const r of results) {
      if (!r.url || seen.has(dedupeKey(r.url))) continue;
      let text = null;
      if (scraped < SEARCH_SCRAPE_TOP) {
        const md = await web.scrapeMarkdown(r.url);
        if (md && md.markdown) {
          const t = keypoints.stripBoilerplate(md.markdown).slice(0, SOURCE_TEXT_CAP);
          if (t.length > 80) { text = t; scraped++; }
        }
      }
      add({ url: r.url, title: r.title, date: r.publishedTime, snippet: r.description, text });
    }
  }

  return { sources, queryCount: queries.length };
}

function buildDossier(name, sources) {
  const blocks = [`# Research dossier: ${name}`];
  for (const s of sources) {
    const head = `## [${s.n}] ${s.title || s.url}\nURL: ${s.url}${s.date ? `\nDate: ${s.date}` : ''}`;
    const body = s.text && s.text.length > 40
      ? s.text
      : (s.snippet ? `(search snippet) ${s.snippet}` : '(no extractable content — title / URL only)');
    blocks.push(`${head}\n\n${body}`);
  }
  let dossier = blocks.join('\n\n---\n\n');
  if (dossier.length > DOSSIER_CAP) dossier = dossier.slice(0, DOSSIER_CAP) + '\n\n…(dossier truncated to fit)';
  return dossier;
}

// ── analysis ──────────────────────────────────────────────────────────────
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences: the single most important thing this research surfaced about the prospect, from a "can we sell to them, and how" angle. NEVER about cookies, consent, privacy policies, or website terms.' },
    opportunities: {
      type: 'array',
      description: 'Up to 8 opportunities, STRONGEST PLAY FIRST. Each connects a real signal in the dossier to a need it creates for the prospect, and to the specific products/capabilities of OURS that meet that need. Fewer beats padding — drop weak or speculative ones.',
      items: {
        type: 'object',
        properties: {
          title:    { type: 'string', description: 'A punchy headline in "Theme — Specific Angle" form. Example: "Branch Capacity Scaling — Formalised Remittance Volume Surge".' },
          analysis: { type: 'string', description: '2-4 sentences: name the signal precisely (with dates / figures / names from the dossier), reason through the operational/strategic/competitive consequence it creates FOR THE PROSPECT, and why our products fit. Concrete; no marketing voice; no fluff.' },
          products: { type: 'array', items: { type: 'string' }, description: 'The specific products/capabilities of OURS that address this need — named exactly as they appear in OUR portfolio above (often 1-3). If none of ours genuinely fits, give a capability category instead.' },
          strength: { type: 'string', enum: ['strong', 'medium', 'weak'] },
          sources:  { type: 'array', items: { type: 'integer' }, description: 'Dossier source numbers [n] this is based on.' },
        },
        required: ['title', 'analysis', 'products', 'strength', 'sources'],
      },
    },
  },
  required: ['summary', 'opportunities'],
};

const ANALYSIS_PROMPT =
  'You are a seasoned product strategist / solutions consultant. Below is OUR company\'s product portfolio and objectives, then a RESEARCH DOSSIER about a PROSPECT — assembled from their website and recent public web sources, each numbered [n]. ' +
  'Your job: find the highest-leverage ways OUR portfolio can address a real NEED of the prospect, and lay them out like an analyst would. Mine the dossier for material signals — regulatory changes / mandates, market shifts, competitive moves, M&A or expansion, leadership changes, financial results, stated strategic priorities, technology / modernisation programmes, operational pressures, hiring patterns. For each one that matters, reason in three steps and put the result in `analysis`: ' +
  '(1) THE SIGNAL — what is happening, precisely, with dates / figures / names from the dossier. ' +
  '(2) THE CONSEQUENCE FOR THE PROSPECT — the operational, strategic, or competitive pressure this creates for THEM (e.g. "this mandate routes X transaction volume through their branch and ATM network → throughput strain, risk of service degradation"). ' +
  '(3) THE FIT — which SPECIFIC products / capabilities of OURS address that consequence; name them exactly as they appear in our portfolio and list all that apply. ' +
  'Each opportunity also gets a `title` (a "Theme — Specific Angle" headline like "Branch Capacity Scaling — Formalised Remittance Volume Surge"), a `strength`, and the `sources`. Lead with the strongest plays. ' +
  'Rules: use ONLY facts that are actually in the dossier — never invent a signal or extrapolate. Map to products that ACTUALLY EXIST in OUR portfolio above; if none of ours genuinely fits a signal, either skip it or put a capability category in `products` (do not claim we have something we do not). ' +
  'CRITICAL — completely ignore website boilerplate: cookie/consent banners, "we use cookies", "we value/take your privacy", "we process your personal information in accordance with regulations", "by continuing to use this site", privacy policies, terms of use, navigation, footers, copyright lines. None of that is a signal — never quote, paraphrase, or build a point on it. ' +
  'If the dossier (minus boilerplate) is thin, return few or no opportunities. Do not pass off a generic company description as an "opportunity".';

// Retry a Gemini call on transient errors: 503 / UNAVAILABLE / "high demand" /
// overloaded / deadline-exceeded, and per-MINUTE 429s (rate, not daily quota).
// A per-DAY quota 429 ("…PerDay…") is NOT retried — it won't clear in seconds.
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
      console.warn(`[research] transient Gemini error (attempt ${i + 1}/${tries}), retrying in ${waitMs}ms: ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function analyze(tenantId, name, dossier) {
  const context = await keypoints.tenantContextText(tenantId);
  const ai = gemini.getClient();
  const prompt =
    `${ANALYSIS_PROMPT}\n\n` +
    (context
      ? `===OUR COMPANY (product portfolio & objectives)===\n${context}\n\n`
      : '===OUR COMPANY===\n(No product portfolio on file. Frame `products` as capability categories — e.g. "AI Wait Predictions", "Branch Orchestration" — and note in the summary that mapping to the actual catalogue requires the company\'s product lines to be added.)\n\n') +
    `===RESEARCH DOSSIER — ${name}===\n${dossier}`;
  const resp = await withRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.3, maxOutputTokens: 2600, responseMimeType: 'application/json', responseSchema: ANALYSIS_SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
  }));
  const parsed = JSON.parse(resp.text);
  const opportunities = (Array.isArray(parsed.opportunities) ? parsed.opportunities : [])
    .map((o) => ({
      title: String(o.title || '').trim() || null,
      analysis: String(o.analysis || o.point || '').trim(),
      products: (Array.isArray(o.products) ? o.products : (o.product ? [o.product] : []))
        .map((p) => String(p || '').trim())
        .filter((p) => p && p !== '—'),
      strength: ['strong', 'medium', 'weak'].includes(o.strength) ? o.strength : 'medium',
      sources: Array.isArray(o.sources) ? o.sources.filter((x) => Number.isInteger(x)) : [],
    }))
    .filter((o) => o.analysis)
    .slice(0, 8);
  return { summary: String(parsed.summary || '').trim() || null, opportunities, hadPortfolio: !!context, usage: resp.usageMetadata || null };
}

// ── orchestration ─────────────────────────────────────────────────────────
async function run(researchId, tenantId, companyId) {
  try {
    const c = await db.query(`SELECT name, domain FROM companies WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
    if (!c.rows[0]) throw new Error('prospect not found');
    if (!web.isConfigured()) throw new Error('Firecrawl not configured (FIRECRAWL_API_KEY) — web research unavailable');
    const name = c.rows[0].name;
    const origin = normalizeOrigin(c.rows[0].domain);

    const { sources, queryCount } = await gatherSources(name, origin);
    if (sources.length === 0) throw new Error('no public sources found for this prospect');
    const dossier = buildDossier(name, sources);
    const slimSources = sources.map((s) => ({ n: s.n, url: s.url, title: s.title, date: s.date, snippet: s.snippet, scraped: s.scraped }));

    const { summary, opportunities, hadPortfolio, usage } = await analyze(tenantId, name, dossier);

    await db.query(
      `UPDATE prospect_research
          SET status = 'DONE', query_count = $1, source_count = $2, sources = $3,
              dossier_md = $4, summary = $5, opportunities = $6,
              models = $7, error = NULL, updated_at = now()
        WHERE id = $8`,
      [queryCount, slimSources.length, JSON.stringify(slimSources), dossier, summary,
       JSON.stringify(opportunities), JSON.stringify({ analysis: MODEL, hadPortfolio, usage }), researchId]
    );
  } catch (err) {
    console.warn(`[research] run ${researchId} failed:`, err.message);
    await db.query(`UPDATE prospect_research SET status = 'FAILED', error = $1, updated_at = now() WHERE id = $2`,
      [String(err && err.message || err).slice(0, 1000), researchId]).catch(() => {});
  }
}

// start(tenantId, companyId) → the RUNNING row (work proceeds in the background).
// If a non-stale RUNNING run already exists for this company, returns it instead
// of starting another.
async function start(tenantId, companyId) {
  const c = await db.query(`SELECT id FROM companies WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
  if (!c.rows[0]) { const e = new Error('prospect not found'); e.status = 404; throw e; }
  const existing = await db.query(
    `SELECT * FROM prospect_research
      WHERE company_id = $1 AND status = 'RUNNING'
        AND updated_at > now() - ($2::int || ' milliseconds')::interval
      ORDER BY created_at DESC LIMIT 1`,
    [companyId, STALE_RUNNING_MS]
  );
  if (existing.rows[0]) return existing.rows[0];
  const ins = await db.query(`INSERT INTO prospect_research (tenant_id, company_id) VALUES ($1, $2) RETURNING *`, [tenantId, companyId]);
  const row = ins.rows[0];
  run(row.id, tenantId, companyId).catch((e) => console.error('[research] background run threw:', e));
  return row;
}

async function reapStale(tenantId) {
  await db.query(
    `UPDATE prospect_research SET status = 'FAILED', error = 'timed out — try again', updated_at = now()
      WHERE tenant_id = $1 AND status = 'RUNNING' AND updated_at < now() - ($2::int || ' milliseconds')::interval`,
    [tenantId, STALE_RUNNING_MS]
  ).catch(() => {});
}

async function latest(tenantId, companyId) {
  await reapStale(tenantId);
  const r = await db.query(`SELECT * FROM prospect_research WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1`, [tenantId, companyId]);
  return r.rows[0] || null;
}

// Latest run per company for this tenant — drives the Library's prospect panels.
async function listForTenant(tenantId) {
  await reapStale(tenantId);
  const r = await db.query(
    `SELECT DISTINCT ON (company_id) * FROM prospect_research WHERE tenant_id = $1 ORDER BY company_id, created_at DESC`,
    [tenantId]
  );
  return r.rows;
}

module.exports = { start, latest, listForTenant };
