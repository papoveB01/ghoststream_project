// Platform Admin Console — superadmin-only, READ-ONLY cross-tenant observability.
// Mounted at /admin/platform with auth.authMiddleware + auth.requireSuperadmin
// (see index.js), so every route here is superadmin-gated. Superadmin requests
// carry no tenant context → db runs on the system pool (bypasses RLS), so the
// cross-tenant reads below work as intended.
//
// Hard rules: never serialize secret VALUES (tokens, keys, credentials) — only
// presence/metadata. Viewing a tenant's detail writes an audit event.

const express = require('express');
const db = require('./db');
const redis = require('./redis');
const audit = require('./audit');
const usage = require('./usage');
const entitlements = require('./entitlements');

const router = express.Router();

// Does at least one key match the pattern? (redis.exists has no wildcards.)
async function scanExists(pattern) {
  return new Promise((resolve, reject) => {
    const s = redis.scanStream({ match: pattern, count: 100 });
    let found = false;
    s.on('data', (keys) => { if (keys.length) { found = true; s.destroy(); } });
    s.on('end', () => resolve(found));
    s.on('close', () => resolve(found));
    s.on('error', reject);
  });
}

// ---- platform overview -----------------------------------------------------
router.get('/overview', async (_req, res, next) => {
  try {
    const [tenants, byStatus, byPlan, users, signups, active, usageTotals] = await Promise.all([
      db.query('SELECT count(*)::int AS n FROM tenants'),
      db.query('SELECT subscription_status AS k, count(*)::int AS n FROM tenants GROUP BY 1'),
      db.query('SELECT plan AS k, count(*)::int AS n FROM tenants GROUP BY 1'),
      db.query('SELECT count(*)::int AS n FROM users'),
      db.query(`SELECT count(*)::int AS n FROM tenants WHERE created_at >= now() - interval '30 days'`),
      db.query(`SELECT count(DISTINCT tenant_id)::int AS n FROM users WHERE last_login_at >= now() - interval '30 days'`),
      db.query(`SELECT meter AS k, sum(count)::int AS n FROM usage_counters WHERE period = $1 GROUP BY 1`, [usage.currentPeriod()]),
    ]);
    const tally = (rows) => Object.fromEntries(rows.map((r) => [r.k || 'unknown', r.n]));
    res.json({
      tenants: tenants.rows[0].n,
      tenantsByStatus: tally(byStatus.rows),
      tenantsByPlan: tally(byPlan.rows),
      users: users.rows[0].n,
      signups30d: signups.rows[0].n,
      activeTenants30d: active.rows[0].n,
      usageThisMonth: tally(usageTotals.rows),
      period: usage.currentPeriod(),
    });
  } catch (err) { next(err); }
});

// ---- tenant directory ------------------------------------------------------
router.get('/tenants', async (req, res, next) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const off = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [];
    let filter = '';
    if (req.query.q && req.query.q.trim()) {
      params.push(`%${req.query.q.trim().toLowerCase()}%`);
      filter = `WHERE lower(t.name) LIKE $${params.length} OR lower(t.domain) LIKE $${params.length}`;
    }
    params.push(lim); const limIdx = params.length;
    params.push(off); const offIdx = params.length;
    const r = await db.query(
      `SELECT t.id, t.name, t.domain, t.plan, t.subscription_status, t.trial_ends_at,
              t.current_period_end, t.created_at,
              count(u.id)::int AS user_count, max(u.last_login_at) AS last_active
         FROM tenants t LEFT JOIN users u ON u.tenant_id = t.id
         ${filter}
         GROUP BY t.id
         ORDER BY max(u.last_login_at) DESC NULLS LAST, t.created_at DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );
    res.json({ tenants: r.rows });
  } catch (err) { next(err); }
});

// ---- tenant detail (audited read) ------------------------------------------
router.get('/tenants/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'tenant not found' });

    const tRes = await db.query(
      `SELECT id, name, domain, plan, subscription_status, trial_ends_at, current_period_end,
              stripe_customer_id, created_at, updated_at
         FROM tenants WHERE id = $1`,
      [id]
    );
    const tenant = tRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });

    const [usersR, tokensR, crmR, c1, c2, c3, c4, c5, ms, caly, cal, usageSummary] = await Promise.all([
      db.query(`SELECT id, email, name, role, is_admin, email_verified, last_login_at, created_at
                  FROM users WHERE tenant_id = $1 ORDER BY created_at`, [id]),
      db.query(`SELECT label, prefix, created_at, last_used_at, expires_at, revoked_at
                  FROM api_tokens WHERE tenant_id = $1 ORDER BY created_at DESC`, [id]),
      db.query(`SELECT provider, status, last_sync_at FROM crm_connections WHERE tenant_id = $1`, [id]),
      db.query('SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1', [id]),
      db.query('SELECT count(*)::int AS n FROM prospect_contacts WHERE tenant_id = $1', [id]),
      db.query('SELECT count(*)::int AS n FROM kb_documents WHERE tenant_id = $1', [id]),
      db.query('SELECT count(*)::int AS n FROM scheduled_meetings WHERE tenant_id = $1', [id]),
      db.query('SELECT count(*)::int AS n FROM arena_sessions WHERE tenant_id = $1', [id]),
      scanExists(`ms_grant:${id}:*`),
      scanExists(`caly_token:${id}:*`),
      scanExists(`cal_grant:${id}:*`),
      usage.summary(id),
    ]);

    // Audit the cross-tenant access itself.
    audit.log({ req, action: 'admin.tenant.viewed', result: 'success', actorUserId: req.user.sub, actorEmail: req.user.email, target: id });

    res.json({
      tenant,
      entitlements: entitlements.toJson(entitlements.entitlementsFor(tenant)),
      users: usersR.rows,
      apiTokens: tokensR.rows, // NB: no token_hash selected
      usage: usageSummary,
      integrations: {
        microsoft: ms,
        calendly: caly,
        calendar: cal,
        crm: crmR.rows,
      },
      counts: {
        companies: c1.rows[0].n,
        contacts: c2.rows[0].n,
        kbDocuments: c3.rows[0].n,
        engagements: c4.rows[0].n,
        arenaSessions: c5.rows[0].n,
      },
      recentActivity: await audit.recent({ tenantId: id, limit: 25 }),
    });
  } catch (err) { next(err); }
});

// ---- global audit feed (filtered) ------------------------------------------
router.get('/audit', async (req, res, next) => {
  try {
    res.json({ events: await audit.recent({
      tenantId: req.query.tenant || null,
      action: req.query.action || null,
      actor: req.query.actor || null,
      from: req.query.from || null,
      to: req.query.to || null,
      limit: req.query.limit,
      offset: req.query.offset,
    }) });
  } catch (err) { next(err); }
});

// ---- cross-tenant API tokens (no secrets) ----------------------------------
router.get('/tokens', async (req, res, next) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true';
    const r = await db.query(
      `SELECT t.label, t.prefix, t.created_at, t.last_used_at, t.expires_at, t.revoked_at,
              tn.name AS tenant_name, tn.id AS tenant_id, u.email AS owner_email
         FROM api_tokens t
         JOIN tenants tn ON tn.id = t.tenant_id
         LEFT JOIN users u ON u.id = t.user_id
        ${all ? '' : 'WHERE t.revoked_at IS NULL'}
        ORDER BY t.created_at DESC LIMIT 500`
    );
    res.json({ tokens: r.rows });
  } catch (err) { next(err); }
});

// ---- platform secrets posture (presence only, NEVER values) ----------------
const SECRET_GROUPS = {
  Billing: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_PRO', 'STRIPE_PORTAL_CONFIG_ID'],
  Email: ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'],
  Recording: ['RECALL_AI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_STREAM_API_TOKEN'],
  AI: ['GEMINI_API_KEY'],
  Storage: ['R2_BUCKET', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
  Calendar: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'CALENDLY_CLIENT_ID', 'CALENDLY_CLIENT_SECRET', 'CALENDLY_WEBHOOK_SIGNING_KEY', 'NYLAS_API_KEY'],
  Security: ['JWT_SECRET', 'ENCRYPTION_KEY', 'DATABASE_APP_PASSWORD'],
};
router.get('/secrets', async (_req, res, next) => {
  try {
    const groups = {};
    for (const [g, names] of Object.entries(SECRET_GROUPS)) {
      groups[g] = names.map((name) => ({ name, configured: Boolean(process.env[name]) }));
    }
    res.json({ groups, flags: { RLS_ENFORCE: String(process.env.RLS_ENFORCE || 'off') } });
  } catch (err) { next(err); }
});

module.exports = { router };
