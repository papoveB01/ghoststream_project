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

const MODEL = require('./models').modelFor('marketWatch');
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net').replace(/\/+$/, '');
const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30 };

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

async function extractDevelopments({ name, scope, tctx, known, priorTitles, findingsText }) {
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
  try { devs = await extractDevelopments({ name, scope, tctx, known, priorTitles, findingsText: findings.text }); }
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

// Next run timestamp for a cadence + chosen day, landing at RUN_HOUR UTC:
//   daily   → tomorrow
//   weekly  → next occurrence of day-of-week `day` (0=Sun … 6=Sat)
//   monthly → next occurrence of day-of-month `day` (1..28)
const RUN_HOUR_UTC = 8;
function nextRunISO(frequency, day) {
  const freq = String(frequency || 'weekly').toLowerCase();
  const now = new Date();
  if (freq === 'daily') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
    return d.toISOString();
  }
  if (freq === 'monthly') {
    const dom = Math.max(1, Math.min(28, parseInt(day, 10) || 1));
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dom, RUN_HOUR_UTC, 0, 0, 0));
    if (d <= now) d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString();
  }
  // weekly
  let dow = parseInt(day, 10); if (!Number.isInteger(dow)) dow = 1; // default Monday
  dow = Math.max(0, Math.min(6, dow));
  const d = new Date(now);
  d.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  let delta = (dow - d.getUTCDay() + 7) % 7;
  if (delta === 0 && d <= now) delta = 7; // today's slot already passed → next week
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString();
}

// Run the watch for every watched entity of a tenant. `tenant` is a row with at
// least { id, plan, watch_enabled, watch_frequency, watch_email_digest }.
async function runTenant(tenant) {
  const ent = entitlements.entitlementsFor(tenant);
  const advance = async () => db.query(
    `UPDATE tenant_profiles SET watch_last_run_at = now(), watch_next_run_at = $2 WHERE tenant_id = $1`,
    [tenant.id, nextRunISO(tenant.watch_frequency, tenant.watch_day)]
  ).catch(() => {});

  if (!ent.active || !entitlements.hasFeature(ent, plans.FEATURES.MARKET_MONITORING)) { await advance(); return { skipped: 'not_entitled' }; }
  if (!tenant.watch_enabled) { await advance(); return { skipped: 'disabled' }; }

  const cap = plans.planFor(tenant.plan).caps.market_monitoring ?? 0;
  const prospects = (await db.query(`SELECT id::text AS id, name FROM companies   WHERE tenant_id = $1 AND watch_enabled`, [tenant.id])).rows;
  const competitors = (await db.query(`SELECT id, name FROM competitors WHERE tenant_id = $1 AND watch_enabled`, [tenant.id])).rows;
  const entities = [
    ...prospects.map((p) => ({ scope: 'PROSPECT', subject: p })),
    ...competitors.map((c) => ({ scope: 'COMPETITOR', subject: c })),
  ];

  const allNew = [];
  let cappedAt = 0;
  for (const e of entities) {
    try { await usage.consume(tenant.id, 'market_monitoring', cap); }
    catch (err) { if (err && err.code === 'USAGE_LIMIT') { cappedAt++; continue; } throw err; }
    try { allNew.push(...await runEntity(tenant.id, e.scope, e.subject)); }
    catch (err) { console.warn(`[watch] entity ${e.scope}/${e.subject.id} failed: ${(err && err.message) || err}`); }
  }
  await advance();
  if (cappedAt) console.warn(`[watch] tenant ${tenant.id}: ${cappedAt} watched entit(ies) skipped — monthly cap (${cap}) reached`);
  if (tenant.watch_email_digest && allNew.length) {
    try { await sendDigest(tenant, allNew); } catch (err) { console.warn(`[watch] digest failed for ${tenant.id}: ${err.message}`); }
  }
  console.log(`[watch] tenant ${tenant.id}: ${allNew.length} new finding(s) across ${entities.length} watched entit(ies)`);
  return { newCount: allNew.length, entities: entities.length, cappedAt };
}

// Email digest of new findings to the tenant's owner(s).
async function sendDigest(tenant, findings) {
  if (!email.isConfigured() || !findings.length) return false;
  const owners = (await db.query(
    `SELECT email FROM users WHERE tenant_id = $1 AND (role = 'owner' OR is_admin) AND email IS NOT NULL`, [tenant.id]
  )).rows.map((r) => r.email);
  if (!owners.length) return false;
  const byEntity = {};
  for (const f of findings) (byEntity[f.subjectName] = byEntity[f.subjectName] || []).push(f);
  const sections = Object.entries(byEntity).map(([name, items]) => `
    <h3 style="margin:16px 0 6px">${name}</h3>
    <ul style="margin:0;padding-left:18px">${items.map((f) => `<li style="margin-bottom:6px"><strong>${f.title}</strong> <span style="color:#6b7280">· ${f.category} · ${f.materiality}/5</span><br>${f.summary || ''}${f.sourceUrl ? ` <a href="${f.sourceUrl}">source</a>` : ''}</li>`).join('')}</ul>`).join('');
  await email.send({
    to: owners,
    subject: `Market Watch — ${findings.length} new signal${findings.length === 1 ? '' : 's'}`,
    categories: ['market-watch'],
    html: `<p>New developments on the prospects/competitors you're watching:</p>${sections}<p style="margin-top:18px"><a href="${APP_BASE_URL}/admin/#market-signals">Review in GhostStream →</a></p>`,
    text: findings.map((f) => `• ${f.subjectName}: ${f.title} (${f.category}, ${f.materiality}/5)`).join('\n') + `\n\nReview: ${APP_BASE_URL}/admin/#market-signals`,
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

// Tenant watch config (read open; write owner + feature-gated).
router.get('/config', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT watch_enabled, watch_frequency, watch_day, watch_email_digest, watch_last_run_at, watch_next_run_at FROM tenant_profiles WHERE tenant_id = $1`,
      [req.tenantId]
    );
    const ent = req.entitlements;
    res.json({
      config: r.rows[0] || { watch_enabled: false, watch_frequency: 'weekly', watch_day: 1, watch_email_digest: true, watch_last_run_at: null, watch_next_run_at: null },
      featureAvailable: !!(ent && Array.isArray(ent.features) && ent.features.includes(plans.FEATURES.MARKET_MONITORING)),
    });
  } catch (err) { next(err); }
});

// Validate/normalize a watch_day for a given frequency. weekly → 0..6,
// monthly → 1..28, daily → 1 (ignored). Returns null if out of range.
function normalizeWatchDay(freq, day) {
  const n = parseInt(day, 10);
  if (!Number.isInteger(n)) return null;
  if (freq === 'weekly') return n >= 0 && n <= 6 ? n : null;
  if (freq === 'monthly') return n >= 1 && n <= 28 ? n : null;
  return 1; // daily — day is irrelevant
}

router.patch('/config', auth.requireRole('owner'), gating.requireFeature(plans.FEATURES.MARKET_MONITORING), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.frequency !== undefined && !FREQ_DAYS[String(b.frequency).toLowerCase()]) {
      return res.status(400).json({ error: 'frequency must be daily, weekly or monthly' });
    }
    // Merge incoming fields over the current row, then recompute the schedule
    // in one place — so changing the day/frequency re-schedules even when the
    // enable toggle isn't touched.
    const cur = (await db.query(
      `SELECT watch_enabled, watch_frequency, watch_day, watch_email_digest FROM tenant_profiles WHERE tenant_id = $1`,
      [req.tenantId]
    )).rows[0] || { watch_enabled: false, watch_frequency: 'weekly', watch_day: 1, watch_email_digest: true };

    const enabled = b.enabled !== undefined ? !!b.enabled : cur.watch_enabled;
    const freq = b.frequency !== undefined ? String(b.frequency).toLowerCase() : cur.watch_frequency;
    const digest = b.emailDigest !== undefined ? !!b.emailDigest : cur.watch_email_digest;
    let day = cur.watch_day;
    if (b.day !== undefined) {
      day = normalizeWatchDay(freq, b.day);
      if (day === null) return res.status(400).json({ error: freq === 'monthly' ? 'day must be 1–28 for monthly' : 'day must be 0 (Sun) – 6 (Sat) for weekly' });
    } else if (b.frequency !== undefined) {
      // frequency changed but no explicit day → keep current if valid for the
      // new cadence, else fall back to a sane default (Mon / 1st).
      const reuse = normalizeWatchDay(freq, cur.watch_day);
      day = reuse === null ? (freq === 'monthly' ? 1 : 1) : reuse;
    }
    const nextRun = enabled ? nextRunISO(freq, day) : null;
    const r = await db.query(
      `INSERT INTO tenant_profiles (tenant_id, watch_enabled, watch_frequency, watch_day, watch_email_digest, watch_next_run_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
            watch_enabled      = $2,
            watch_frequency    = $3,
            watch_day          = $4,
            watch_email_digest = $5,
            watch_next_run_at  = $6,
            updated_at = now()
       RETURNING watch_enabled, watch_frequency, watch_day, watch_email_digest, watch_last_run_at, watch_next_run_at`,
      [req.tenantId, enabled, freq, day, digest, nextRun]
    );
    res.json({ config: r.rows[0] });
  } catch (err) { next(err); }
});

// Manual "run now". Loads the tenant row + runs in the background (web/LLM heavy).
router.post('/run', auth.requireRole('owner'), gating.requireFeature(plans.FEATURES.MARKET_MONITORING), async (req, res, next) => {
  try {
    const t = (await db.query(
      `SELECT t.id, t.plan, t.subscription_status, t.trial_ends_at, t.current_period_end,
              COALESCE(p.watch_enabled,false) AS watch_enabled, COALESCE(p.watch_frequency,'weekly') AS watch_frequency,
              COALESCE(p.watch_day,1) AS watch_day, COALESCE(p.watch_email_digest,true) AS watch_email_digest
         FROM tenants t LEFT JOIN tenant_profiles p ON p.tenant_id = t.id WHERE t.id = $1`,
      [req.tenantId]
    )).rows[0];
    if (!t) return res.status(404).json({ error: 'tenant not found' });
    runTenant(t).catch((err) => console.warn(`[watch] manual run failed for ${t.id}: ${(err && err.message) || err}`));
    res.status(202).json({ started: true });
  } catch (err) { next(err); }
});

module.exports = { router, runTenant, runEntity, nextRunISO };
