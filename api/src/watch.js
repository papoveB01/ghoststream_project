// Market Watch — agentic monitoring of watched prospects/competitors.
//
// On a schedule (or on demand), for each WATCHED entity it: web-researches recent
// activity, asks the model to extract NEW, material developments not already in
// our intel or prior alerts, dedups, and files them as `watch_findings` (the
// review queue / notifications) — SEPARATE from intel until a rep accepts one.
//
// Premium (plans.FEATURES.MARKET_MONITORING) + per-month usage cap. Reuses the
// discovery web engine, the Gemini structured-output + withRetry pattern, the
// tenant grounding (keypoints.tenantContextText), and knowledge.ingest to promote
// an accepted finding into kb_documents.

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const gemini = require('./gemini');
const email = require('./email');
const plans = require('./plans');
const usage = require('./usage');
const gating = require('./gating');
const entitlements = require('./entitlements');
const auth = require('./auth');
const discovery = require('./knowledge/discovery');
const keypoints = require('./knowledge/keypoints');
const knowledge = require('./knowledge/service');
const schedule = require('./watchSchedule');
const costs = require('./costs');

const MODEL = require('./models').modelFor('marketWatch');
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://dealscope.io').replace(/\/+$/, '');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// copy of the discovery/research retry helper (transient 503 / per-minute 429).
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      const perDay = /per[_\s-]?day|PerDay|free_tier_requests/i.test(msg);
      const transient = /503|UNAVAILABLE|overloaded|high demand|deadline|429|RESOURCE_EXHAUSTED/i.test(msg);
      if (perDay || !transient || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, Math.min(2000 * (i + 1), 8000)));
    }
  }
  throw lastErr;
}

const DEV_SCHEMA = {
  type: 'object',
  properties: {
    developments: {
      type: 'array',
      description: 'NEW, material developments about the entity supported by the findings and NOT already in our known intel or prior alerts. Empty if nothing new/material.',
      items: {
        type: 'object',
        properties: {
          category:    { type: 'string', description: 'One of: funding, product, leadership, partnership, m&a, regulatory, expansion, hiring, incident, other.' },
          title:       { type: 'string', description: 'Short headline of the development.' },
          summary:     { type: 'string', description: '1-2 sentences: what happened AND why it matters to US given OUR PRODUCTS.' },
          materiality: { type: 'integer', description: 'How material to our sales motion, 1 (minor) to 5 (major).' },
          sourceUrl:   { type: 'string', description: 'The single best source URL from the findings, else empty string.' },
          sourceTitle: { type: 'string', description: 'The source page/article title if evident, else empty string.' },
          publishedAt: { type: 'string', description: 'ISO date of the development if evident in the findings, else empty string.' },
        },
        required: ['category', 'title', 'summary', 'materiality', 'sourceUrl', 'sourceTitle', 'publishedAt'],
      },
    },
  },
  required: ['developments'],
};

// "Recent developments" angles — the watch is recency-oriented, so queries are
// dated + change-focused (web search APIs have no freshness param plumbed).
function buildWatchQueries(name) {
  const year = '2026';
  return [
    `${name} news ${year}`,
    `${name} announcement ${year}`,
    `${name} funding OR acquisition OR partnership ${year}`,
    `${name} new product OR launch ${year}`,
    `${name} leadership OR executive change ${year}`,
    `${name} expansion OR hiring ${year}`,
  ];
}

// What we already know about the entity — so the model only surfaces NET-NEW items.
async function knownContext(tenantId, scope, subject) {
  if (scope === 'PROSPECT') {
    const r = await db.query(
      `SELECT summary, opportunities FROM prospect_research WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenantId, subject.id]
    );
    const row = r.rows[0];
    if (!row) return '(no prior research on file)';
    const opps = Array.isArray(row.opportunities) ? row.opportunities.map((o) => `- ${o.title}`).join('\n') : '';
    return [String(row.summary || '').slice(0, 1200), opps].filter(Boolean).join('\n');
  }
  const r = await db.query(`SELECT description, battlecard FROM competitors WHERE tenant_id = $1 AND id = $2`, [tenantId, subject.id]);
  const row = r.rows[0];
  if (!row) return '(no prior intel on file)';
  let bc = '';
  try { bc = JSON.stringify(row.battlecard || {}).slice(0, 1500); } catch { bc = ''; }
  return [String(row.description || ''), bc].filter(Boolean).join('\n');
}

async function recentFindingTitles(tenantId, scope, subjectId) {
  const r = await db.query(
    `SELECT title FROM watch_findings WHERE tenant_id = $1 AND scope = $2 AND subject_id = $3 ORDER BY created_at DESC LIMIT 40`,
    [tenantId, scope, subjectId]
  );
  return r.rows.map((x) => x.title);
}

async function extractDevelopments({ tenantId, name, scope, tctx, known, priorTitles, findingsText }) {
  const prompt =
    `You monitor the market for OUR company. Track recent, material developments about ${scope === 'PROSPECT' ? 'our PROSPECT (a company we may sell to)' : 'our COMPETITOR'} "${name}". ` +
    'Using ONLY the web findings below, list developments that are BOTH (a) recent/new and (b) material to our sales motion. ' +
    'CRITICAL: EXCLUDE anything already covered by ===WHAT WE ALREADY KNOW=== or listed under ===PRIOR ALERTS===. ' +
    'Only items the findings actually support — do not invent. If nothing new and material, return an empty list.\n' +
    'For each: category, a short title, a 1-2 sentence summary that says why it matters to US given OUR PRODUCTS, materiality 1-5, and the best source url/title/date if evident.\n\n' +
    `===OUR COMPANY (what we sell)===\n${String(tctx || '').slice(0, 1500)}\n\n` +
    `===WHAT WE ALREADY KNOW ABOUT ${name}===\n${known}\n\n` +
    `===PRIOR ALERTS (already surfaced — do NOT repeat)===\n${priorTitles.length ? priorTitles.map((t) => `- ${t}`).join('\n') : '(none)'}\n\n` +
    `===WEB FINDINGS===\n${findingsText}`;
  const ai = gemini.getClient();
  const resp = await withRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.3, maxOutputTokens: 2200, responseMimeType: 'application/json', responseSchema: DEV_SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
  }));
  costs.recordGemini(tenantId, 'watch.extract', MODEL, resp.usageMetadata);
  const parsed = JSON.parse(resp.text);
  return Array.isArray(parsed.developments) ? parsed.developments : [];
}

// Research one entity and insert any NET-NEW findings. Returns the inserted rows.
async function runEntity(tenantId, scope, subject) {
  const name = String(subject.name || '').trim();
  if (!name) return [];
  const findings = await discovery.gatherFromQueries(buildWatchQueries(name), { maxHits: 14, scrapeTop: 3, searchLimit: 5 });
  if (!findings.text || findings.text.length < 60) return [];

  const [tctx, known, priorTitles] = await Promise.all([
    keypoints.tenantContextText(tenantId).catch(() => ''),
    knownContext(tenantId, scope, subject),
    recentFindingTitles(tenantId, scope, subject.id),
  ]);

  let devs;
  try { devs = await extractDevelopments({ tenantId, name, scope, tctx, known, priorTitles, findingsText: findings.text }); }
  catch (err) { console.warn(`[watch] extract failed for ${scope} ${subject.id}: ${err.message}`); return []; }

  const inserted = [];
  for (const d of devs) {
    const title = String(d.title || '').trim();
    if (!title) continue;
    const url = String(d.sourceUrl || '').trim();
    const dedup = sha256(`${scope}|${subject.id}|${url || title.toLowerCase()}`);
    const mat = Math.max(1, Math.min(5, Math.round(Number(d.materiality) || 3)));
    const publishedAt = /^\d{4}-\d{2}-\d{2}/.test(String(d.publishedAt || '')) ? d.publishedAt : null;
    const r = await db.query(
      `INSERT INTO watch_findings (tenant_id, scope, subject_id, subject_name, category, title, summary, materiality, source_url, source_title, published_at, dedup_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING
       RETURNING id`,
      [tenantId, scope, subject.id, name, String(d.category || 'other').slice(0, 40), title.slice(0, 300),
       String(d.summary || '').slice(0, 2000), mat, url || null, String(d.sourceTitle || '').slice(0, 300) || null, publishedAt, dedup]
    );
    if (r.rowCount) inserted.push({ id: r.rows[0].id, scope, subjectName: name, category: d.category, title, summary: d.summary, materiality: mat, sourceUrl: url, publishedAt });
  }
  return inserted;
}

// ── Per-entity scheduling ────────────────────────────────────────────────
// Each watched prospect/competitor carries its OWN schedule (watch_frequency,
// watch_day, watch_timezone, watch_email_digest, watch_next_run_at) on its own
// row. The scheduler scans both tables for entities whose next_run is due and
// calls runEntityScheduled() for each.

const TBL = { PROSPECT: 'companies', COMPETITOR: 'competitors' };

// Advance one entity's schedule: stamp last_run + compute the next slot.
// `e` is the entity row (snake_case watch_* schedule fields).
async function advanceEntity(scope, id, tenantId, e) {
  const next = schedule.nextRunISO(e.watch_frequency, e.watch_day, e.watch_timezone);
  await db.query(
    `UPDATE ${TBL[scope]} SET watch_last_run_at = now(), watch_next_run_at = $3 WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, next]
  ).catch(() => {});
  return next;
}

// Run the watch for ONE entity. `e` carries the entity + its schedule + the
// tenant fields needed to check entitlement/cap:
//   { scope, id, name, tenant_id, plan, subscription_status, trial_ends_at,
//     current_period_end, watch_frequency, watch_day, watch_timezone, watch_email_digest }
// `opts.advance` (default true) re-arms the cadence; manual "run now" passes false.
async function runEntityScheduled(e, opts = {}) {
  const advance = opts.advance !== false;
  const ent = entitlements.entitlementsFor({
    plan: e.plan, plan_version: e.plan_version, subscription_status: e.subscription_status,
    trial_ends_at: e.trial_ends_at, current_period_end: e.current_period_end,
  });
  const reArm = async () => { if (advance) await advanceEntity(e.scope, e.id, e.tenant_id, e); };

  if (!ent.active || !entitlements.hasFeature(ent, plans.FEATURES.MARKET_MONITORING)) {
    await reArm();
    return { skipped: 'not_entitled', newCount: 0 };
  }

  // market_monitoring keeps the same meter key in both catalog versions; the
  // CAP differs (v1 Pro 500, v2 Pro 250) so read it off the entitlement.
  const cap = (ent.caps && ent.caps.market_monitoring) ?? 0;
  try { await usage.consume(e.tenant_id, 'market_monitoring', cap); }
  catch (err) {
    if (err && err.code === 'USAGE_LIMIT') {
      console.warn(`[watch] ${e.scope}/${e.id}: monthly cap (${cap}) reached — skipped`);
      await reArm();
      return { skipped: 'capped', newCount: 0 };
    }
    throw err;
  }

  let found = [];
  try { found = await runEntity(e.tenant_id, e.scope, { id: e.id, name: e.name }); }
  catch (err) { console.warn(`[watch] ${e.scope}/${e.id} failed: ${(err && err.message) || err}`); }

  await reArm();
  if (e.watch_email_digest && found.length) {
    try { await sendDigest(e.tenant_id, e.name, found); }
    catch (err) { console.warn(`[watch] digest failed for ${e.tenant_id}: ${err.message}`); }
  }
  console.log(`[watch] ${e.scope}/${e.id} (${e.name}): ${found.length} new finding(s)`);
  return { newCount: found.length };
}

// Email digest of one entity's new findings to the tenant's owner(s)/admins.
async function sendDigest(tenantId, entityName, findings) {
  if (!email.isConfigured() || !findings.length) return false;
  const owners = (await db.query(
    `SELECT email FROM users WHERE tenant_id = $1 AND (role = 'owner' OR is_admin) AND email IS NOT NULL`, [tenantId]
  )).rows.map((r) => r.email);
  if (!owners.length) return false;
  const items = findings.map((f) => `<li style="margin-bottom:6px"><strong>${f.title}</strong> <span style="color:#6b7280">· ${f.category} · ${f.materiality}/5</span><br>${f.summary || ''}${f.sourceUrl ? ` <a href="${f.sourceUrl}">source</a>` : ''}</li>`).join('');
  await email.send({
    to: owners,
    subject: `Market Watch — ${findings.length} new signal${findings.length === 1 ? '' : 's'} for ${entityName}`,
    categories: ['market-watch'],
    html: `<p>New developments on <strong>${entityName}</strong>, which you're watching:</p><ul style="margin:0;padding-left:18px">${items}</ul><p style="margin-top:18px"><a href="${APP_BASE_URL}/admin/#market-signals">Review in DealScope →</a></p>`,
    text: findings.map((f) => `• ${f.title} (${f.category}, ${f.materiality}/5)`).join('\n') + `\n\nReview: ${APP_BASE_URL}/admin/#market-signals`,
  });
  return true;
}

// ──────────────────────────── HTTP routes ────────────────────────────
const router = express.Router();

router.get('/findings', async (req, res, next) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const where = ['tenant_id = $1']; const params = [req.tenantId];
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (req.query.scope) { params.push(req.query.scope); where.push(`scope = $${params.length}`); }
    params.push(lim);
    const r = await db.query(
      `SELECT * FROM watch_findings WHERE ${where.join(' AND ')} ORDER BY (status='NEW') DESC, materiality DESC, created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ findings: r.rows });
  } catch (err) { next(err); }
});

router.get('/findings/count', async (req, res, next) => {
  try {
    const r = await db.query(`SELECT count(*)::int AS n FROM watch_findings WHERE tenant_id = $1 AND status = 'NEW'`, [req.tenantId]);
    res.json({ count: r.rows[0].n });
  } catch (err) { next(err); }
});

router.patch('/findings/:id', async (req, res, next) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (!['REVIEWED', 'DISMISSED', 'NEW'].includes(status)) return res.status(400).json({ error: 'status must be REVIEWED, DISMISSED or NEW' });
    const r = await db.query(
      `UPDATE watch_findings SET status = $1, reviewed_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [status, req.params.id, req.tenantId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'finding not found' });
    res.json({ finding: r.rows[0] });
  } catch (err) { next(err); }
});

// Accept → promote the finding into intel (a retrievable kb_documents row).
router.post('/findings/:id/accept', async (req, res, next) => {
  try {
    const f = (await db.query(`SELECT * FROM watch_findings WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.tenantId])).rows[0];
    if (!f) return res.status(404).json({ error: 'finding not found' });
    const md = `# ${f.title}\n\n${f.summary || ''}\n\n${f.source_url ? `Source: ${f.source_url}\n` : ''}_Filed from Market Watch (${f.category || 'update'})._`;
    const ingestArgs = {
      tenantId: req.tenantId,
      file: { buffer: Buffer.from(md, 'utf8'), mimetype: 'text/markdown', originalname: 'market-watch.md' },
      title: `[Watch] ${f.subject_name}: ${f.title}`.slice(0, 200),
      streamType: 'WEB',
      sourceUrl: f.source_url || null,
      effectiveDate: f.published_at || null,
      metadata: { marketWatch: true, findingId: f.id, category: f.category },
    };
    if (f.scope === 'PROSPECT') { ingestArgs.scope = 'PROSPECT'; ingestArgs.companyId = f.subject_id; ingestArgs.category = 'ORG_INTELLIGENCE'; }
    else { ingestArgs.scope = 'COMPETITOR'; ingestArgs.competitorIds = [f.subject_id]; ingestArgs.category = 'BATTLECARDS'; }
    const doc = await knowledge.ingest(ingestArgs);
    const r = await db.query(
      `UPDATE watch_findings SET status = 'ACCEPTED', reviewed_at = now(), promoted_doc_id = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [doc && doc.id ? doc.id : null, f.id, req.tenantId]
    );
    res.json({ finding: r.rows[0], promotedDocId: doc && doc.id });
  } catch (err) { next(err); }
});

// ── Market trends — manually fed intel ──────────────────────────────────────
// The rep pastes a news item / regulation / market development ("CBN mandates
// MFA on top of OTP for all banks"); the AI judges its impact on OUR company
// and products, derives engagement motives (reasons + openers to reach out to
// clients) and a prospecting angle, and the whole thing is filed as TENANT
// intel (metadata.isMarketTrend) so it feeds briefs/battlecards like any doc.
const TREND_SCHEMA = {
  type: 'object',
  properties: {
    headline:    { type: 'string', description: 'one-line restatement of the development' },
    summary:     { type: 'string', description: 'what happened, 2-3 neutral sentences' },
    materiality: { type: 'integer', description: '1-5 impact on OUR business (5 = existential/major opportunity)' },
    companyImpact: { type: 'string', description: 'how this impacts our company specifically, given our positioning and ICP' },
    productImpacts: { type: 'array', items: { type: 'object', properties: {
      product:     { type: 'string', description: 'one of OUR product names' },
      impact:      { type: 'string' },
      opportunity: { type: 'string', description: 'the sales opportunity this creates for that product, if any' },
    }, required: ['product', 'impact'] } },
    engagementMotives: { type: 'array', items: { type: 'object', properties: {
      who:    { type: 'string', description: 'which client/prospect type to engage' },
      motive: { type: 'string', description: 'the reason this development justifies reaching out NOW' },
      opener: { type: 'string', description: 'a line the rep can say or write verbatim to open the conversation' },
    }, required: ['motive'] } },
    prospectingAngle: { type: 'object', properties: {
      who:       { type: 'string', description: 'the kind of companies to go find' },
      industry:  { type: 'string', description: 'their industry/segment, one or two words' },
      region:    { type: 'string', description: 'geography this applies to, if any' },
      rationale: { type: 'string' },
    } },
    recommendedActions: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'summary', 'materiality', 'companyImpact'],
};

async function analyzeTrend(tenantId, text, title) {
  const tctx = await keypoints.tenantContextText(tenantId);
  const prods = await db.query(`SELECT name, description FROM products WHERE tenant_id = $1 ORDER BY name LIMIT 30`, [tenantId]);
  const productList = prods.rows.map((p) => `- ${p.name}${p.description ? `: ${String(p.description).slice(0, 200)}` : ''}`).join('\n') || '(no products on file)';
  const prompt =
    'You are the market-intelligence analyst for OUR company. A rep just fed in a market development ' +
    '(news, regulation, industry shift). Assess what it means FOR US — our company, each of our products — ' +
    'and how our sales team can USE it: concrete motives to engage existing clients (with an opener they can say verbatim) ' +
    'and a prospecting angle (who to go find because of this). Be specific and honest: if the development is ' +
    'irrelevant to our business, say so and score materiality 1 — never invent relevance. Ground every claim in ' +
    'the development text and our context below.\n\n' +
    `===OUR COMPANY===\n${String(tctx || '').slice(0, 2500)}\n\n` +
    `===OUR PRODUCTS===\n${productList}\n\n` +
    `===THE DEVELOPMENT${title ? ` — "${title}"` : ''}===\n${text.slice(0, 20000)}`;
  const ai = gemini.getClient();
  const resp = await withRetry(() => ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.3, maxOutputTokens: 2400, responseMimeType: 'application/json', responseSchema: TREND_SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
  }));
  costs.recordGemini(tenantId, 'watch.trend', MODEL, resp.usageMetadata);
  return JSON.parse(resp.text);
}

// File a trend (development text + its analysis) as retrievable TENANT intel.
async function fileTrendDoc(tenantId, { text, title, analysis, sourceUrl = null, retrieved = false }) {
  const heading = title || analysis.headline || 'Market trend';
  const md = [
    `# ${heading}`,
    text ? `\n## The development\n\n${text}` : (analysis.summary ? `\n## The development\n\n${analysis.summary}` : ''),
    `\n## Impact on us\n\n${analysis.companyImpact || ''}`,
    (analysis.productImpacts || []).length
      ? `\n## Product impact\n\n${analysis.productImpacts.map((p) => `- **${p.product}** — ${p.impact}${p.opportunity ? ` Opportunity: ${p.opportunity}` : ''}`).join('\n')}` : '',
    (analysis.engagementMotives || []).length
      ? `\n## Engagement motives\n\n${analysis.engagementMotives.map((m) => `- ${m.who ? `**${m.who}** — ` : ''}${m.motive}${m.opener ? ` Opener: "${m.opener}"` : ''}`).join('\n')}` : '',
    analysis.prospectingAngle && (analysis.prospectingAngle.who || analysis.prospectingAngle.rationale)
      ? `\n## Prospecting angle\n\n${[analysis.prospectingAngle.who, analysis.prospectingAngle.industry, analysis.prospectingAngle.region].filter(Boolean).join(' · ')}\n${analysis.prospectingAngle.rationale || ''}` : '',
    sourceUrl ? `\nSource: ${sourceUrl}` : '',
    `\n_Filed from Market trend & Alerts${retrieved ? ' (AI-retrieved)' : ''}._`,
  ].filter(Boolean).join('\n');
  return knowledge.ingest({
    tenantId,
    file: { buffer: Buffer.from(md, 'utf8'), mimetype: 'text/markdown', originalname: 'market-trend.md' },
    title: `[Trend] ${heading}`.slice(0, 200),
    category: 'ORG_INTELLIGENCE',
    scope: 'TENANT',
    streamType: sourceUrl ? 'WEB' : 'FILE',
    sourceUrl: sourceUrl || null,
    metadata: { isMarketTrend: true, retrieved, trendAnalysis: analysis, materiality: analysis.materiality || 3 },
  });
}

// POST /watch/trends { text, title? } — analyze + file as TENANT intel.
// User-initiated AI analysis → costs one research unit (credits-eligible).
router.post('/trends', async (req, res, next) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    const title = String((req.body && req.body.title) || '').trim().slice(0, 160);
    if (text.length < 40) return res.status(400).json({ error: 'Paste or type the development first (a few sentences minimum).' });

    const charge = await gating.chargeUnit(req, 'discovery');
    let analysis;
    try {
      analysis = await analyzeTrend(req.tenantId, text, title);
    } catch (err) {
      await usage.refund(req.tenantId, charge.meter, charge.consumed, { lifetime: charge.lifetime });
      throw err;
    }
    const doc = await fileTrendDoc(req.tenantId, { text, title, analysis });
    res.json({ analysis, documentId: doc && doc.id });
  } catch (err) {
    if (err.status === 402 || err.code === 'USAGE_LIMIT') return res.status(402).json({ error: err.message, code: err.code || 'USAGE_LIMIT' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /watch/trends/discover { industry?, region?, country? } — AI-retrieved
// market trends: web-search recent developments for the segment/geo, pick the
// material ones, and return each with the full impact analysis (NOT saved —
// the rep reviews and saves the ones that matter via /trends/save).
// Costs one research unit.
const TRENDS_DISCOVERED_SCHEMA = {
  type: 'object',
  properties: {
    trends: { type: 'array', items: { type: 'object', properties: {
      ...TREND_SCHEMA.properties,
      sourceUrl:   { type: 'string', description: 'best source url from the findings, if evident' },
      sourceTitle: { type: 'string' },
      sourceDate:  { type: 'string', description: 'source publication date, YYYY-MM-DD, if evident' },
    }, required: TREND_SCHEMA.required } },
  },
  required: ['trends'],
};
// Recency filter → search-engine freshness + a hard date window the results
// must fall inside. Anything older than 12 months is never returned.
const TREND_RECENCY = {
  latest: { days: 31,  freshness: () => 'pm' },
  '3m':   { days: 92,  freshness: (from, to) => `${from}to${to}` },
  '6m':   { days: 183, freshness: (from, to) => `${from}to${to}` },
  '12m':  { days: 366, freshness: () => 'py' },
};
router.post('/trends/discover', async (req, res, next) => {
  try {
    const web = require('./knowledge/web');
    if (!web.isConfigured() && !web.isBraveConfigured()) {
      return res.status(503).json({ error: 'AI search is not configured on this workspace' });
    }
    const industry = String((req.body && req.body.industry) || '').trim().slice(0, 80);
    const region   = String((req.body && req.body.region)   || '').trim().slice(0, 80);
    const country  = String((req.body && req.body.country)  || '').trim().slice(0, 80);
    // Industry + a concrete region are mandatory — they focus the scan.
    if (!industry) return res.status(400).json({ error: 'Pick an industry/segment — it focuses the scan.' });
    if (!region || /global|any/i.test(region)) return res.status(400).json({ error: 'Pick a specific region (not Global/Any) — it focuses the scan.' });
    const geo = country || region;
    const recencyKey = ['latest', '3m', '6m', '12m'].includes(req.body && req.body.recency) ? req.body.recency : 'latest';
    const recency = TREND_RECENCY[recencyKey];
    const cutoff = new Date(Date.now() - recency.days * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const freshness = recency.freshness(fmt(cutoff), fmt(new Date()));
    // Already-shown results (urls + headlines) from prior "Retrieve more" runs.
    const exclude = (Array.isArray(req.body && req.body.exclude) ? req.body.exclude : [])
      .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).slice(0, 200);
    const excludeSet = new Set(exclude);

    const charge = await gating.chargeUnit(req, 'discovery');
    try {
      const tctx = await keypoints.tenantContextText(req.tenantId);
      const queries = [
        `${industry} new regulation mandate ${geo}`,
        `${industry} market trends news ${geo}`,
        `${industry} industry developments ${geo}`,
      ];
      const seen = new Set();
      const hits = [];
      for (const q of queries) {
        let batch = [];
        try { batch = (await web.search(q, { limit: 10, freshness })) || []; } catch { /* engine hiccup — other queries may still land */ }
        for (const h of batch) {
          if (!h.url || seen.has(h.url)) continue;
          seen.add(h.url);
          // Drop already-shown sources and anything dated outside the window.
          if (excludeSet.has(h.url.toLowerCase())) continue;
          if (h.publishedTime) {
            const d = new Date(h.publishedTime);
            if (!Number.isNaN(d.getTime()) && d < cutoff) continue;
          }
          hits.push(h);
        }
      }
      if (!hits.length) {
        await usage.refund(req.tenantId, charge.meter, charge.consumed, { lifetime: charge.lifetime });
        return res.json({ trends: [], exhausted: true, note: `Nothing new within the selected window — you're up to date on ${industry} in ${geo}.` });
      }
      const findingsText = hits.slice(0, 30).map((h) => `- ${h.title || h.url}\n  ${h.url}${h.publishedTime ? `\n  dated: ${String(h.publishedTime).slice(0, 10)}` : ''}\n  ${String(h.description || '').slice(0, 280)}`).join('\n');
      const prods = await db.query(`SELECT name, description FROM products WHERE tenant_id = $1 ORDER BY name LIMIT 30`, [req.tenantId]);
      const productList = prods.rows.map((p) => `- ${p.name}${p.description ? `: ${String(p.description).slice(0, 200)}` : ''}`).join('\n') || '(no products on file)';
      const prompt =
        'You are the market-intelligence analyst for OUR company. Below are fresh web findings about ' +
        `${industry} in ${geo}. Pick up to 5 developments that are RECENT (source dated within the last ${recency.days} days — ` +
        'check the dated: lines; skip anything older or undatable beyond doubt), REAL (supported by the findings — never invented) ' +
        'and MATERIAL to our business. For each produce a BRIEF impact assessment — the rep opens the source link for depth: ' +
        'summary ≤2 sentences; companyImpact ≤2 sentences; at most 3 productImpacts (one sentence each); at most 2 engagementMotives ' +
        '(short motive + a one-line opener); a one-line prospecting angle; at most 3 recommendedActions. ' +
        'Always include the source url and its date (sourceDate, YYYY-MM-DD). ' +
        (exclude.length ? `DO NOT repeat developments already shown to the rep:\n${exclude.slice(0, 60).map((x) => `- ${x}`).join('\n')}\n` : '') +
        'If nothing new and material remains, return an empty list.\n\n' +
        `===OUR COMPANY===\n${String(tctx || '').slice(0, 2500)}\n\n` +
        `===OUR PRODUCTS===\n${productList}\n\n` +
        `===WEB FINDINGS===\n${findingsText}`;
      const ai = gemini.getClient();
      const resp = await withRetry(() => ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.3, maxOutputTokens: 6000, responseMimeType: 'application/json', responseSchema: TRENDS_DISCOVERED_SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
      }));
      costs.recordGemini(req.tenantId, 'watch.trendDiscover', MODEL, resp.usageMetadata);
      const parsed = JSON.parse(resp.text);
      let trends = Array.isArray(parsed.trends) ? parsed.trends.slice(0, 5) : [];
      // Hard guards the model can't bypass: no repeats, nothing dated outside
      // the window (and never older than 12 months).
      trends = trends.filter((t) => {
        const url = String(t.sourceUrl || '').trim().toLowerCase();
        const head = String(t.headline || '').trim().toLowerCase();
        if ((url && excludeSet.has(url)) || (head && excludeSet.has(head))) return false;
        if (t.sourceDate) {
          const d = new Date(t.sourceDate);
          if (!Number.isNaN(d.getTime()) && d < cutoff) return false;
        }
        return true;
      });
      res.json({ trends, exhausted: trends.length === 0, ...(trends.length === 0 ? { note: `Nothing new within the selected window — you're up to date on ${industry} in ${geo}.` } : {}) });
    } catch (err) {
      await usage.refund(req.tenantId, charge.meter, charge.consumed, { lifetime: charge.lifetime });
      throw err;
    }
  } catch (err) {
    if (err.status === 402 || err.code === 'USAGE_LIMIT') return res.status(402).json({ error: err.message, code: err.code || 'USAGE_LIMIT' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /watch/trends/save { analysis, title?, text?, sourceUrl? } — file an
// AI-retrieved trend the rep chose to keep. No AI call → free.
router.post('/trends/save', async (req, res, next) => {
  try {
    const analysis = (req.body && req.body.analysis) || null;
    if (!analysis || typeof analysis !== 'object' || !analysis.headline || !analysis.companyImpact) {
      return res.status(400).json({ error: 'analysis (with headline and companyImpact) required' });
    }
    const doc = await fileTrendDoc(req.tenantId, {
      text: String((req.body && req.body.text) || '').trim().slice(0, 20000),
      title: String((req.body && req.body.title) || '').trim().slice(0, 160),
      analysis,
      sourceUrl: String((req.body && req.body.sourceUrl) || '').trim().slice(0, 500) || null,
      retrieved: true,
    });
    res.json({ documentId: doc && doc.id });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /watch/trends — previously analyzed trends, newest first.
router.get('/trends', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, title, metadata, created_at FROM kb_documents
        WHERE tenant_id = $1 AND scope = 'TENANT' AND COALESCE(metadata->>'isMarketTrend', '') = 'true'
        ORDER BY created_at DESC LIMIT 50`,
      [req.tenantId]
    );
    res.json({ trends: r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      analysis: (row.metadata && row.metadata.trendAnalysis) || null,
    })) });
  } catch (err) { next(err); }
});

// Lightweight: does the caller's plan include Market Watch? The per-entity
// schedule UI keys off this (the schedule itself now lives on each entity, set
// via PATCH /companies/:id and /portfolio/competitors/:id).
router.get('/config', async (req, res, next) => {
  try {
    const ent = req.entitlements;
    res.json({
      featureAvailable: !!(ent && Array.isArray(ent.features) && ent.features.includes(plans.FEATURES.MARKET_MONITORING)),
    });
  } catch (err) { next(err); }
});

// Load one watched entity + the tenant fields needed to gate/run it.
async function loadEntityForRun(tenantId, scope, id) {
  const tbl = TBL[scope];
  if (!tbl) return null;
  const r = await db.query(
    `SELECT '${scope}'::text AS scope, e.id::text AS id, e.name,
            e.watch_frequency, e.watch_day, e.watch_timezone, e.watch_email_digest,
            t.id AS tenant_id, t.plan, t.plan_version, t.subscription_status, t.trial_ends_at, t.current_period_end
       FROM ${tbl} e JOIN tenants t ON t.id = e.tenant_id
      WHERE e.id = $1 AND e.tenant_id = $2`,
    [id, tenantId]
  );
  return r.rows[0] || null;
}

// Manual "run now" for ONE entity. Body: { scope: 'PROSPECT'|'COMPETITOR', id }.
// Does NOT re-arm the cadence (advance:false) — a manual run shouldn't shift the
// scheduled slot. Runs in the background (web/LLM heavy).
router.post('/run', auth.requireRole('owner'), gating.requireFeature(plans.FEATURES.MARKET_MONITORING), async (req, res, next) => {
  try {
    const scope = String((req.body && req.body.scope) || '').toUpperCase();
    const id = req.body && req.body.id;
    if (!TBL[scope] || !id) return res.status(400).json({ error: 'scope (PROSPECT|COMPETITOR) and id are required' });
    const e = await loadEntityForRun(req.tenantId, scope, String(id));
    if (!e) return res.status(404).json({ error: 'watched entity not found' });
    runEntityScheduled(e, { advance: false })
      .catch((err) => console.warn(`[watch] manual run failed for ${scope}/${id}: ${(err && err.message) || err}`));
    res.status(202).json({ started: true });
  } catch (err) { next(err); }
});

module.exports = { router, runEntityScheduled, runEntity };
