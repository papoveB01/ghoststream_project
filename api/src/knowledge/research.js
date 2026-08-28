// Deep Research on a prospect.
//
// Scrapes the prospect's own site (Firecrawl /map → /scrape on the high-value
// pages) plus a handful of targeted web searches (Firecrawl /search), assembles
// a numbered, source-tagged "dossier", and has a model turn it into sales-
// opportunity points mapped to THIS tenant's product portfolio & objectives.
//
// Fire-and-forget: `start(tenantId, companyId)` inserts a RUNNING row and runs
// the work in the background; the row flips to DONE / FAILED. `latest()` /
// `listForTenant()` read it back. Stale RUNNING rows (process restarted mid-run)
// are reaped to FAILED on read so the UI doesn't spin forever.

const db = require('../db');
const semantics = require('../semantics');
const web = require('./web');
const keypoints = require('./keypoints');
const apollo = require('./apollo');

// One-shot provider seam (ADR-0006 §9 item 5, cutover group 3).
//
// ONE call site, one task key: analyze() below is the only model call in this
// file, and `research` is the only key it resolves. That makes the migration
// itself small — the interesting part of this group is not the swap, it is the
// two ROUTES the one function serves (see the note above analyze()).
//
// The require-time `modelFor('research')` constant that used to sit here is
// GONE, not moved. It froze the model at boot behind a routing decision — the
// personas.js hazard §9 item 4 fixed, and the same freeze group 2 removed from
// keypoints.js and assessment.js — so the id could outlive the provider choice
// that produced it and the two could disagree. aiCall resolves provider and
// model per call as a matched pair, fail-closed fallback included. The model
// that SERVED the call now comes back out of the seam and is what gets stamped
// into `prospect_research.models`, instead of a boot-time constant.
//
// GROUP 3 WAS SPLIT: this PR is the `research` half only. ADR-0006 §9 item 5
// lists the group as `research` + `ocr`, but knowledge/ocr.js has no task key at
// all, pins its Gemini tier deliberately, is free-text rather than structured
// output (so the live schema harness structurally cannot cover it), and reaches
// Gemini through the Files API, which this wrapper has no equivalent for. It is
// its own decision PR — see the ADR entry.
const aiCall = require('../aiCall');

// Shared retry helper (ADR-0006 §7). Bound here with this module's label so
// every call site below is unchanged; the classification that used to live in
// a local copy of this function now happens once, in aiRetry.classify().
//
// KEPT, and re-decided rather than inherited: the seam does not retry (§9 item
// 5 — every forLabel() binding lives in a caller), so moving the call site onto
// it made the wrapper a live choice again. The per-ROUTE attempt budget that
// choice produced is argued at analyze(), which is where both routes meet.
const aiRetry = require('../aiRetry');
const withRetry = aiRetry.forLabel('research');

const SITE_MAP_LIMIT    = parseInt(process.env.RESEARCH_SITE_MAP_LIMIT || '40', 10);
const SITE_SCRAPE_LIMIT = parseInt(process.env.RESEARCH_SITE_SCRAPE_LIMIT || '5', 10);
const SEARCH_PER_QUERY  = parseInt(process.env.RESEARCH_SEARCH_PER_QUERY || '4', 10);
const SEARCH_SCRAPE_TOP = parseInt(process.env.RESEARCH_SEARCH_SCRAPE_TOP || '2', 10);
const NEWS_LIMIT        = parseInt(process.env.RESEARCH_NEWS_LIMIT || '8', 10);
const NEWS_DAYS         = parseInt(process.env.RESEARCH_NEWS_DAYS  || '30', 10);
const SOURCE_TEXT_CAP   = parseInt(process.env.RESEARCH_SOURCE_TEXT_CAP || '3500', 10);
const DOSSIER_CAP       = parseInt(process.env.RESEARCH_DOSSIER_CAP || '40000', 10);
const STALE_RUNNING_MS  = parseInt(process.env.RESEARCH_STALE_MS || '600000', 10); // 10 min

const NEWSAPI_BASE = (process.env.NEWSAPI_BASE_URL || 'https://newsapi.org/v2').replace(/\/+$/, '');
function isNewsApiConfigured() { return Boolean(process.env.NEWSAPI_KEY); }

// NewsAPI /everything — dated articles for "<name>" in the last NEWS_DAYS days.
// Free tier returns 100 req/day; one prospect research = one request here.
// Returns the standard source row shape so gatherSources can dedupe + push.
async function fetchNewsApi(name) {
  if (!isNewsApiConfigured() || !name) return [];
  const from = new Date(Date.now() - NEWS_DAYS * 86400000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    q: `"${name}"`,
    from,
    language: 'en',
    sortBy: 'relevancy',
    pageSize: String(Math.min(100, NEWS_LIMIT)),
  });
  try {
    const res = await fetch(`${NEWSAPI_BASE}/everything?${params}`, {
      headers: { 'X-Api-Key': process.env.NEWSAPI_KEY, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    const rows = Array.isArray(json.articles) ? json.articles : [];
    return rows.map((a) => ({
      url: a.url || null,
      title: a.title || null,
      description: a.description || null,
      markdown: null,
      publishedTime: a.publishedAt || null,
      author: a.author || (a.source && a.source.name) || null,
    })).filter((r) => r.url);
  } catch {
    return [];
  }
}

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
async function gatherSources(name, origin, { tenantId, domain } = {}) {
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

  // 3. NewsAPI — dated news for the last NEWS_DAYS days. These come with
  //    proper publishedAt dates which improves the dossier's chronological
  //    signal (Gemini ranks recent material higher). Snippet-only by
  //    default; scrape the top 2 for richer text.
  const newsRows = await fetchNewsApi(name);
  let newsScraped = 0;
  for (const r of newsRows) {
    if (!r.url || seen.has(dedupeKey(r.url))) continue;
    let text = null;
    if (newsScraped < SEARCH_SCRAPE_TOP) {
      const md = await web.scrapeMarkdown(r.url);
      if (md && md.markdown) {
        const t = keypoints.stripBoilerplate(md.markdown).slice(0, SOURCE_TEXT_CAP);
        if (t.length > 80) { text = t; newsScraped++; }
      }
    }
    add({ url: r.url, title: r.title, date: r.publishedTime, snippet: r.description, text });
  }

  // 4. Apollo — structured B2B data (company snapshot + leadership team).
  //    Two sources only, both authored by Apollo's API, so the dossier picks
  //    up named decision makers + verified counts that Gemini can cite. Both
  //    are no-ops when APOLLO_API_KEY is unset or the daily cap is tripped.
  if (apollo.isConfigured() && domain) {
    let apolloAdded = 0;
    try {
      const org = await apollo.enrichOrganization(tenantId, domain);
      if (org) {
        add({
          url: org.linkedinUrl || null,
          title: `Company snapshot (Apollo) — ${org.name || name}`,
          date: null,
          text: formatApolloOrgBlock(org).slice(0, SOURCE_TEXT_CAP),
        });
        apolloAdded++;
      }
    } catch (e) { console.warn('[research] Apollo org enrich failed:', e.message); }
    try {
      const people = await apollo.searchPeople(tenantId, domain, { limit: 10 });
      if (Array.isArray(people) && people.length) {
        add({
          url: null,
          title: `Leadership team (Apollo) — ${name}`,
          date: null,
          text: formatApolloPeopleBlock(people).slice(0, SOURCE_TEXT_CAP),
        });
        apolloAdded++;
      }
    } catch (e) { console.warn('[research] Apollo people search failed:', e.message); }
    if (apolloAdded > 0) console.log(`[research] Apollo added ${apolloAdded} source(s) for ${domain}`);
  }

  return { sources, queryCount: queries.length + (newsRows.length ? 1 : 0) };
}

// Render Apollo's enrichment payload as a human + Gemini-readable block.
// Anything missing is skipped — we don't render "Industry: null" lines.
function formatApolloOrgBlock(org) {
  const lines = [];
  if (org.name)             lines.push(`Name: ${org.name}`);
  if (org.domain)           lines.push(`Domain: ${org.domain}`);
  if (org.industry)         lines.push(`Industry: ${org.industry}`);
  if (org.employeeCount != null) lines.push(`Employees (Apollo estimate): ${org.employeeCount}`);
  if (org.revenueRange)     lines.push(`Revenue: ${org.revenueRange}`);
  if (org.foundedYear)      lines.push(`Founded: ${org.foundedYear}`);
  if (org.location)         lines.push(`HQ: ${org.location}`);
  if (org.fundingTotal)     lines.push(`Total funding: ${org.fundingTotal}${org.latestFundingRound ? ` (latest round: ${org.latestFundingRound}${org.latestFundingAt ? ` ${org.latestFundingAt}` : ''})` : ''}`);
  if (org.technologies && org.technologies.length) lines.push(`Tech stack signals: ${org.technologies.join(', ')}`);
  if (org.keywords && org.keywords.length) lines.push(`Keywords: ${org.keywords.join(', ')}`);
  if (org.linkedinUrl)      lines.push(`LinkedIn: ${org.linkedinUrl}`);
  if (org.description)      lines.push('', org.description);
  return lines.join('\n');
}

function formatApolloPeopleBlock(people) {
  const lines = ['Top decision-makers + senior leaders matched at this org (verified emails marked ✓):'];
  for (const p of people) {
    const head = `- ${p.name || 'Unknown'} — ${p.title || 'Unknown role'}`;
    const meta = [];
    if (p.email) meta.push(`${p.email}${p.emailStatus === 'verified' ? ' ✓' : ''}`);
    if (p.linkedinUrl) meta.push(p.linkedinUrl);
    if (p.location) meta.push(p.location);
    lines.push(head + (meta.length ? '\n    ' + meta.join(' · ') : ''));
  }
  return lines.join('\n');
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

// ONE FUNCTION, TWO ROUTES WITH OPPOSITE LATENCY CONTRACTS. Both reach this one
// call site, and one aiRetry label covers both, so the retry answer here is not
// the same question group 2 answered per call site — it is one policy against
// two contracts, and the tighter one is what it has to fit.
//
//   POST /research/:companyId            (knowledge/index.js) — FIRE-AND-FORGET.
//     202 immediately; run() works in the background and flips the row to DONE /
//     FAILED. Nobody holds a socket, and the research unit is PRE-CHARGED on
//     admission — so a transient failure that is NOT retried costs the tenant a
//     metered unit and leaves a FAILED row. Backoff is free; retry is valuable.
//
//   POST /research/:companyId/reanalyze  — SYNCHRONOUS and rep-facing. The
//     request holds open until the model answers, behind nginx's 180s
//     proxy_read_timeout (proxy/nginx.conf, the /api/ location). Past that bound
//     nginx 504s while the handler runs on to completion: the row IS updated and
//     the next page load shows it, but the rep sees an error for work that
//     succeeded. This is the shape PR #51 found on proposals.js — a synchronous
//     route inheriting a backoff bound nobody had sized for it.
//
// DECISION: KEEP THE DEFAULT POLICY (3 attempts, 30s backoff cap) FOR BOTH, and
// it is a measurement rather than an inheritance. Measured 2026-08-28 by driving
// this call site end to end against both live providers on all four real
// dossiers in the estate (staging + production; ADR-0006 §9 item 5, group 3):
//
//   gemini-2.5-flash   p50 5.6s, max 6.0s per attempt (n=10)
//   claude-sonnet-5    p50 8-22s, max 27.1s per attempt (n=141)
//
// THE ~78s FIGURE BELOW IS THE **GEMINI** BOUND, and only that. It is stated
// first because Gemini serves 100% of this traffic today; it is NOT the bound
// after a flip, and an earlier version of this note let it read as though it
// were. The synchronous route's worst case on Gemini is 3 × 6s of generation
// plus the sleeps. The sleeps are 2s + 4s normally and reach the 30s cap only
// when Gemini's own error body suggests a delay that long (aiRetry's retryDelay
// parser) — 3 × 6 + 60 = ~78s, inside the 180s window with room. Lowering the
// cap the way proposals.js did would bound this route AND take the background
// route's ability to honour a quota hint it has every reason to honour, for a
// bound that is not being exceeded.
//
// WHAT WOULD CHANGE THE GEMINI BOUND: a single attempt averaging more than ~40s
// stops fitting at 3 tries with the cap reached twice. Note the input side is
// NOT what bounds it — `DOSSIER_CAP` (40,000 chars) is applied once inside
// buildDossier, but appendSource concatenates onto dossier_md with no total cap
// and effectiveDossier then appends up to 20 filed docs × 3,500 chars AFTER it.
// A fresh run's ceiling is therefore ~111,000 chars, and a rep-augmented one has
// none at all, against the 45,747-50,939 the 141 live calls actually sampled. An
// earlier version of this comment said "the input side is bounded"; it is not,
// and capping it is a follow-up rather than this PR's, because a .slice() here
// changes what Gemini receives and breaks the parity property.
//
// THE CLAUDE BOUND IS DIFFERENT AND IS CONDITIONAL. classify()'s Anthropic
// branch is `transient: !perDay && !sdkRetried && status === 429`, so a
// truncation or a malformed answer takes ONE attempt — that part is
// unconditional, and the test for this file asserts it rather than quoting it.
// But a 429 is transient here whenever the SDK did not retry it, and there are
// two ways for that to be true:
//
//   ANTHROPIC_MAX_RETRIES=0. anthropic.js gates its `sdkRetried` stamp on
//     SDK_RETRIES_AT_ALL (= DEFAULT_MAX_RETRIES > 0) — deliberately, so a client
//     told never to retry does not claim it did. Zero is a permitted value and
//     anthropic.js's own DEFAULT_TIMEOUT_MS note RECOMMENDS it for user-facing
//     routes. At 0, every 429 stamps sdkRetried:false, this wrapper takes 3
//     attempts, and the synchronous route becomes 3 × ANTHROPIC_TIMEOUT_MS
//     (120s) + 2s + 4s ≈ 366s against nginx's 180s. Measured: unset ⇒ 1 upstream
//     attempt, =0 ⇒ 3.
//   A 429 carrying `x-should-retry: false`, at DEFAULT settings. sdkRetriesStatus
//     subtracts exactly that case from the SDK's retryable set, correctly — so
//     aiRetry's "the SDK's retryable set is a superset of ours" is false for it,
//     and it reaches this wrapper as transient.
//
// AND THE PER-ATTEMPT BOUND IS NOT 120s EITHER. The SDK's inter-retry sleep
// takes no signal and parses `retry-after` unclamped, so the composed deadline
// is only observed at the top of the next attempt: the real bound is
// `ANTHROPIC_TIMEOUT_MS + maxRetries × retry-after`, unbounded above. Measured
// on this branch: a 3s budget took 20.059s on a `retry-after: 20`.
//
// SO reanalyze IS THE SECOND ROUTE IN THE proposals.js CLASS, not an escapee
// from it — a synchronous, rep-facing handler that nginx can 504 while it keeps
// running, billing and writing. It is safe TODAY because Gemini serves it and
// the Gemini arithmetic above holds. **ANTHROPIC_MAX_RETRIES >= 1 is therefore
// part of the flip checklist for this task**, alongside AI_PROVIDER_RESEARCH —
// .env.example and ADR-0006 §9 item 5 say the same, and cutoverGroup3.test.js
// pins the upstream count at both settings so the precondition is asserted
// rather than remembered.
//
// The retry now also covers the JSON PARSE, because the seam parses inside
// generateStructured and the wrapper is outside it. That is the same deliberate
// trade relevance.js made when it moved its parse inside withRetry: on Gemini a
// malformed answer can now cost up to three metered generations instead of one,
// and in exchange a re-generation can fix malformed JSON — the failure mode that
// actually happens. The exposure is narrow: V8's SyntaxError quotes the WHOLE
// input below a length threshold and only the first ten characters above it (the
// "always exactly ten" rule this comment used to state is not what V8 does), and
// of GEMINI_TRANSIENT_RE's alternatives only `503` and `overloaded` fit in a
// ten-character excerpt. On Claude it changes nothing: aiCall stamps the
// SyntaxError `provider: 'anthropic'`, and a parse error carries no 429.
async function analyze(tenantId, name, dossier) {
  const context = await keypoints.tenantContextText(tenantId);
  const prompt =
    `${ANALYSIS_PROMPT}\n\n` +
    (context
      ? `===OUR COMPANY (product portfolio & objectives)===\n${context}\n\n`
      : '===OUR COMPANY===\n(No product portfolio on file. Frame `products` as capability categories — e.g. "AI Wait Predictions", "Branch Orchestration" — and note in the summary that mapping to the actual catalogue requires the company\'s product lines to be added.)\n\n') +
    `===RESEARCH DOSSIER — ${name}===\n${dossier}`;
  // maxTokens 2600 IS A GEMINI-SIZED BUDGET, and a Gemini-sized budget is what
  // put `keypoints` into models.FLIP_BLOCKED. So it was measured rather than
  // assumed, at this exact call site, before this key shipped:
  //
  //   claude-sonnet-5, effort 'medium', thinking off, all four real dossiers in
  //   the estate (staging Wibmo; production Ecobank / Justpalm / Papss card),
  //   n = 141 → 0 truncations. Every response stop_reason 'end_turn'; 95% CI
  //   (Clopper-Pearson) on 0/141 is 0% - 2.58%.
  //
  // THE HEADROOM IS THIN AND THAT IS THE PART WORTH CARRYING FORWARD, not the
  // zero: output length is driven by how many opportunities the dossier
  // supports, and it varies 2.8x across four prompts of near-identical size
  // (peak output 861 / 2,041 / 1,138 / 2,406 tokens against the 2,600 budget —
  // 2,406 / 861 = 2.79, and the largest is 92.5% of the budget. This said "~20x",
  // which the four numbers printed beside it refute; the spread is real and the
  // multiplier was not). A dossier richer than any we have today is the way
  // this starts truncating, and on Claude a truncation THROWS (allowTruncation
  // is unset, deliberately), so it is a FAILED run on the background route and a
  // 502 on the synchronous one, not a silently short answer.
  //
  // Do NOT "fix" a future truncation by raising this number: it is
  // provider-agnostic here, so raising it changes what Gemini receives and
  // breaks the parity property groups 2 and 3 shipped on. Sizing per provider is
  // the flip PR's problem, exactly as models.js says for `keypoints`.
  const { parsed, usage, model } = await withRetry(() => aiCall.generateStructured({
    task: 'research',
    prompt,
    responseSchema: ANALYSIS_SCHEMA,
    maxTokens: 2600,
    // Dropped on claude-sonnet-5 (anthropic.js's NO_TEMPERATURE), with the
    // once-per-model+site warning — `research` is tier `flash`, which resolves
    // to Sonnet 5 on Claude with no anthropicTier override needed. Kept because
    // it is live on Gemini, which serves 100% of this traffic.
    temperature: 0.3,
    tenantId,
    site: 'research.analyze',
  }));
  // Which [n] the model was actually shown. Read back off the dossier string
  // rather than the source array, because DOSSIER_CAP truncation can cut a
  // source's head off — one that was never visible can't legitimately be cited.
  const citable = semantics.citableNumbers(dossier);
  const opportunities = (Array.isArray(parsed.opportunities) ? parsed.opportunities : [])
    .map((o) => ({
      title: String(o.title || '').trim() || null,
      analysis: String(o.analysis || o.point || '').trim(),
      products: (Array.isArray(o.products) ? o.products : (o.product ? [o.product] : []))
        .map((p) => String(p || '').trim())
        .filter((p) => p && p !== '—'),
      strength: ['strong', 'medium', 'weak'].includes(o.strength) ? o.strength : 'medium',
      sources: semantics.keepCitations(o.sources, citable),
    }))
    .filter((o) => o.analysis)
    .slice(0, 8);
  // `model` is the model that SERVED this call, handed back by the seam. It is
  // what run() and reanalyze() stamp into prospect_research.models — the value
  // the deleted require-time constant used to supply, and the reason that
  // constant could disagree with the provider after a flip.
  return { summary: String(parsed.summary || '').trim() || null, opportunities, hadPortfolio: !!context, usage: usage || null, model };
}

// ── orchestration ─────────────────────────────────────────────────────────
async function run(researchId, tenantId, companyId) {
  try {
    const c = await db.query(`SELECT name, domain FROM companies WHERE id = $1 AND tenant_id = $2`, [companyId, tenantId]);
    if (!c.rows[0]) throw new Error('prospect not found');
    if (!web.isConfigured()) throw new Error('Firecrawl not configured (FIRECRAWL_API_KEY) — web research unavailable');
    const name = c.rows[0].name;
    const origin = normalizeOrigin(c.rows[0].domain);

    const { sources, queryCount } = await gatherSources(name, origin, { tenantId, domain: c.rows[0].domain });
    if (sources.length === 0) throw new Error('no public sources found for this prospect');
    const dossier = buildDossier(name, sources);
    const slimSources = sources.map((s) => ({ n: s.n, url: s.url, title: s.title, date: s.date, snippet: s.snippet, scraped: s.scraped }));

    // Synthesize against the auto-gathered dossier PLUS any filed prospect intel
    // (so the intel library feeds research). dossier_md keeps the auto sources
    // only — effectiveDossier re-merges current filed intel on each (re)analyze.
    const fullDossier = await effectiveDossier(tenantId, companyId, dossier);
    // THE FIRE-AND-FORGET ROUTE — the other half of the contract pair argued
    // over analyze(). Nobody is on the socket here; the failure surfaces as a
    // FAILED row, and the research unit was already charged on admission.
    const { summary, opportunities, hadPortfolio, usage, model } = await analyze(tenantId, name, fullDossier);
    const opps = applyPins(opportunities, await pinnedTitlesForCompany(tenantId, companyId));

    await db.query(
      `UPDATE prospect_research
          SET status = 'DONE', query_count = $1, source_count = $2, sources = $3,
              dossier_md = $4, summary = $5, opportunities = $6,
              models = $7, error = NULL, updated_at = now()
        WHERE id = $8`,
      [queryCount, slimSources.length, JSON.stringify(slimSources), dossier, summary,
       JSON.stringify(opps), JSON.stringify({ analysis: model, hadPortfolio, usage }), researchId]
    );
    await persistSynthesisDoc(tenantId, companyId, name, summary, opps, researchId);
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

// ── Manual additions: append a source (URL or freeform note) to an existing
// research row, and an explicit re-analyze that re-runs the model against the
// current dossier (auto sources + any manual additions). Keeps re-analysis
// cheap and explicit so the rep can stack several adds and click once.

async function findRunForCompany(tenantId, companyId) {
  const r = await db.query(
    `SELECT id, sources, dossier_md, source_count
       FROM prospect_research
      WHERE tenant_id = $1 AND company_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, companyId]
  );
  return r.rows[0] || null;
}

function nextSourceN(existingSources) {
  const arr = Array.isArray(existingSources) ? existingSources : [];
  let max = 0;
  for (const s of arr) if (Number.isInteger(s.n) && s.n > max) max = s.n;
  return max + 1;
}

// Append one source. type: 'url' | 'note'. For 'url' we scrape via Firecrawl
// (best-effort — if scrape fails we still record the URL + title as a
// snippet-only source). For 'note' we just store the text.
//
// Persistence: append to sources jsonb AND to dossier_md so the next
// re-analyze sees it without needing to re-fetch anything.
async function appendSource(tenantId, companyId, addedBy, { type, url, title, text }) {
  if (!type || !['url', 'note'].includes(type)) {
    const e = new Error("type must be 'url' or 'note'"); e.status = 400; throw e;
  }
  const run = await findRunForCompany(tenantId, companyId);
  if (!run) {
    const e = new Error('no research run exists for this prospect — start one first'); e.status = 404; throw e;
  }

  let block = '';
  let slimSource;

  if (type === 'url') {
    if (!url || !/^https?:\/\//i.test(url)) {
      const e = new Error('valid URL required'); e.status = 400; throw e;
    }
    let scrapedTitle = title || null, body = null, date = null;
    try {
      const md = await web.scrapeMarkdown(url);
      if (md) {
        scrapedTitle = scrapedTitle || md.title || url;
        date = md.publishedTime || null;
        if (md.markdown) body = keypoints.stripBoilerplate(md.markdown).slice(0, SOURCE_TEXT_CAP);
      }
    } catch (e) { /* swallow — non-fatal */ }
    if (!scrapedTitle) scrapedTitle = url;
    const n = nextSourceN(run.sources);
    slimSource = {
      n, url, title: scrapedTitle, date,
      snippet: (text && String(text).trim()) || null,
      scraped: !!(body && body.length > 80),
      addedManually: true,
      addedBy: addedBy || null,
      addedAt: new Date().toISOString(),
    };
    block = `## [${n}] ${scrapedTitle}\nURL: ${url}` +
            (date ? `\nDate: ${date}` : '') +
            '\n\n' +
            (body && body.length > 40 ? body : (text && text.trim()) || '(no extractable content — title + URL only)');
  } else {
    if (!text || !String(text).trim()) {
      const e = new Error('text required for a note source'); e.status = 400; throw e;
    }
    const n = nextSourceN(run.sources);
    const noteTitle = (title && title.trim()) || 'Manual note';
    slimSource = {
      n, url: null, title: noteTitle, date: null,
      snippet: null, scraped: false,
      addedManually: true,
      addedBy: addedBy || null,
      addedAt: new Date().toISOString(),
    };
    block = `## [${n}] ${noteTitle}\n\n${String(text).trim().slice(0, SOURCE_TEXT_CAP)}`;
  }

  // jsonb || jsonb appends; '\n\n---\n\n' separator matches buildDossier's.
  const separator = '\n\n---\n\n';
  await db.query(
    `UPDATE prospect_research
        SET sources       = sources || $2::jsonb,
            dossier_md    = COALESCE(dossier_md, '') || $3,
            source_count  = source_count + 1,
            updated_at    = now()
      WHERE id = $1`,
    [run.id, JSON.stringify([slimSource]), separator + block]
  );
  return { source: slimSource, researchId: run.id };
}

// Re-run analysis only — does NOT re-fetch any sources. Uses the current
// dossier_md (which the rep may have augmented via appendSource).
async function reanalyze(tenantId, companyId) {
  const c = await db.query(
    `SELECT id AS company_id, name FROM companies WHERE id = $1 AND tenant_id = $2`,
    [companyId, tenantId]
  );
  if (!c.rows[0]) { const e = new Error('prospect not found'); e.status = 404; throw e; }
  const run = await findRunForCompany(tenantId, companyId);
  if (!run) { const e = new Error('no research run to re-analyze — start one first'); e.status = 404; throw e; }
  const r = await db.query(`SELECT dossier_md, opportunities FROM prospect_research WHERE id = $1`, [run.id]);
  const dossier = r.rows[0] && r.rows[0].dossier_md;
  if (!dossier || dossier.length < 100) {
    const e = new Error('dossier is empty — re-run a full research first'); e.status = 422; throw e;
  }
  // Re-analyze picks up newly filed intel (no web refetch) by re-merging it.
  const fullDossier = await effectiveDossier(tenantId, companyId, dossier);
  // THE SYNCHRONOUS ROUTE. This one holds the rep's request open behind nginx's
  // 180s proxy_read_timeout, where run() above answers 202 and works in the
  // background — one call site, two contracts. The retry budget is deliberately
  // the same for both and the arithmetic that says it fits is over analyze().
  const { summary, opportunities, hadPortfolio, usage, model } = await analyze(tenantId, c.rows[0].name, fullDossier);
  const prevPinned = new Set((((r.rows[0] && r.rows[0].opportunities) || []).filter((o) => o && o.pinned)).map((o) => o.title));
  const opps = applyPins(opportunities, prevPinned);
  await db.query(
    `UPDATE prospect_research
        SET summary       = $2,
            opportunities = $3,
            models        = $4,
            updated_at    = now()
      WHERE id = $1`,
    [run.id, summary, JSON.stringify(opps),
     JSON.stringify({ analysis: model, hadPortfolio, usage, reanalyzed: true })]
  );
  await persistSynthesisDoc(tenantId, companyId, c.rows[0].name, summary, opps, run.id);
  return latest(tenantId, companyId);
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

// ── Unified inputs + retrievable synthesis ────────────────────────────────
// service is required lazily to avoid the service↔web↔research import cycle.

// The dossier the model analyzes = auto-gathered sources + the text of any filed
// prospect intel (kb_documents scope=PROSPECT), EXCLUDING prior synthesis docs so
// the synthesis never feeds itself. Best-effort: falls back to the plain dossier.
async function effectiveDossier(tenantId, companyId, dossierMd) {
  try {
    const service = require('./service');
    const docs = await service.listDocuments({ tenantId, scope: 'PROSPECT', companyId, status: 'READY', limit: 20 });
    const usable = (docs || []).filter((d) => !((d.metadata || {}).isResearchSynthesis));
    const blocks = [];
    for (const d of usable) {
      try {
        const t = await service.getDocumentText(tenantId, d.id);
        const text = t && (typeof t === 'string' ? t : t.text);
        if (text && String(text).length > 40) blocks.push(`## (Filed intel) ${d.title}\n${String(text).slice(0, 3500)}`);
      } catch { /* skip a bad doc */ }
    }
    if (!blocks.length) return dossierMd;
    return `${dossierMd}\n\n# Filed prospect intel\n\n${blocks.join('\n\n---\n\n')}`;
  } catch {
    return dossierMd;
  }
}

// Persist the synthesis (summary + opportunities) as a retrievable prospect KB
// doc so it flows into the pre-call brief retrieval loop. Stable title → ingest
// replaces the prior synthesis on each run. Best-effort (never fails the run).
async function persistSynthesisDoc(tenantId, companyId, name, summary, opportunities, researchId) {
  try {
    const service = require('./service');
    const L = [`# Research synthesis: ${name}`, ''];
    if (summary) L.push(`**Summary:** ${summary}`, '');
    (opportunities || []).forEach((o, i) => {
      L.push(`## ${i + 1}. ${o.title || 'Opportunity'}${o.strength ? ` (${o.strength})` : ''}`);
      if (o.analysis) L.push(o.analysis);
      if (Array.isArray(o.products) && o.products.length) L.push(`Fit: ${o.products.join(', ')}`);
      L.push('');
    });
    await service.ingest({
      tenantId,
      file: { buffer: Buffer.from(L.join('\n'), 'utf8'), mimetype: 'text/markdown', originalname: 'research-synthesis.md' },
      category: 'ORG_INTELLIGENCE',
      title: `Research synthesis: ${name}`,
      metadata: { isResearchSynthesis: true, researchId },
      streamType: 'WEB',
      scope: 'PROSPECT',
      companyId,
    });
  } catch (err) {
    console.warn(`[research] synthesis ingest failed for ${companyId}:`, (err && err.message) || err);
  }
}

// Pinned opportunities survive (re)analysis by exact-title carry-over.
function applyPins(opps, pinnedTitles) {
  if (!pinnedTitles || !pinnedTitles.size) return opps || [];
  return (opps || []).map((o) => (o && pinnedTitles.has(o.title) ? { ...o, pinned: true } : o));
}
async function pinnedTitlesForCompany(tenantId, companyId) {
  const r = await db.query(
    `SELECT opportunities FROM prospect_research
      WHERE tenant_id = $1 AND company_id = $2 AND status = 'DONE'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, companyId]
  );
  const opps = (r.rows[0] && r.rows[0].opportunities) || [];
  return new Set(opps.filter((o) => o && o.pinned).map((o) => o.title));
}

// Toggle a single opportunity's pin on the latest run.
async function setOpportunityPin(tenantId, companyId, title, pinned) {
  const run = await findRunForCompany(tenantId, companyId);
  if (!run) { const e = new Error('no research run for this prospect'); e.status = 404; throw e; }
  const r = await db.query(`SELECT opportunities FROM prospect_research WHERE id = $1`, [run.id]);
  const opps = (r.rows[0] && r.rows[0].opportunities) || [];
  let found = false;
  const next = opps.map((o) => { if (o && o.title === title) { found = true; return { ...o, pinned: !!pinned }; } return o; });
  if (!found) { const e = new Error('opportunity not found'); e.status = 404; throw e; }
  await db.query(`UPDATE prospect_research SET opportunities = $2, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify(next)]);
  return latest(tenantId, companyId);
}

// ANALYSIS_SCHEMA is exported for the live-schema smoke check (test/live/) only.
module.exports = { start, latest, listForTenant, appendSource, reanalyze, setOpportunityPin, ANALYSIS_SCHEMA };
