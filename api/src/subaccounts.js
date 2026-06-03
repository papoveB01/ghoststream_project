// Sub-accounts — a parent (Pro/Enterprise) account provisions sub-tenant
// workspaces. Two routers:
//   router        — authed, parent-owner only, gated by the `sub_accounts`
//                   feature. List / invite / update / suspend children + revoke
//                   invites. Cross-tenant reads/writes go through the SYSTEM pool
//                   with a server-enforced `parent_tenant_id = <authed parent>`
//                   filter (the parent's RLS context can't see child rows).
//   publicRouter  — unauthenticated, token-scoped. The invitee fetches the
//                   invite and accepts it, which creates the child tenant + its
//                   owner user and logs them in.
//
// Billing/entitlements for a child are inherited from the parent — see
// entitlements.resolveEntitlementsFor. The parent never operates inside a
// child's workspace here; this is provisioning only (monitoring = Phase 3).

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const users = require('./users');
const tenants = require('./tenants');
const plans = require('./plans');
const email = require('./email');

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net').replace(/\/+$/, '');
const INVITE_TTL_DAYS = parseInt(process.env.SUBACCOUNT_INVITE_TTL_DAYS || '14', 10);
const MIN_PASSWORD_LEN = parseInt(process.env.ONBOARDING_MIN_PASSWORD_LEN || '12', 10);

// System pool — bypasses RLS. Every query below is explicitly scoped to the
// authed parent's tenant id, so a parent can only ever touch its own children.
const sys = () => db.getPool();

// ── small helpers ──────────────────────────────────────────────────────────
function domainFromEmail(addr) {
  const m = String(addr || '').trim().toLowerCase().match(/^[^@\s]+@([^@\s]+)$/);
  return m ? m[1] : null;
}
function domainsRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('.' + b) || b.endsWith('.' + a);
}
function normDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
}
// Features a parent may grant a child: the parent plan's features minus the
// non-nestable sub_accounts capability.
function allowedFeatures(parentTenant) {
  return plans.planFor(parentTenant.plan).features.filter((f) => f !== plans.FEATURES.SUB_ACCOUNTS);
}
function sanitizeFeatures(input, allowed) {
  const set = new Set(Array.isArray(input) ? input : []);
  return allowed.filter((f) => set.has(f));
}
// Per-meter cap allocation, clamped to the parent plan's pool (Infinity = no cap).
function sanitizeCaps(input, parentTenant) {
  const planCaps = plans.planFor(parentTenant.plan).caps;
  const out = {};
  for (const meter of plans.METERS) {
    const raw = input && input[meter];
    if (raw == null || raw === '') continue;
    let n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) continue;
    const ceil = planCaps[meter];
    if (Number.isFinite(ceil)) n = Math.min(n, ceil);
    out[meter] = n;
  }
  return out;
}

async function parentRow(req) {
  return req.tenantRecord || await tenants.get(req.tenantId, { fresh: true });
}
async function usedCount(parentId) {
  const c = await sys().query('SELECT count(*)::int AS n FROM tenants WHERE parent_tenant_id = $1', [parentId]);
  const i = await sys().query("SELECT count(*)::int AS n FROM subtenant_invites WHERE parent_tenant_id = $1 AND status = 'PENDING'", [parentId]);
  return c.rows[0].n + i.rows[0].n;
}
async function domainTaken(domain) {
  const r = await sys().query('SELECT 1 FROM tenants WHERE lower(domain) = lower($1) LIMIT 1', [domain]);
  return r.rowCount > 0;
}

// ── authed parent router ─────────────────────────────────────────────────────
const router = express.Router();
router.use(express.json());

// GET / — children + pending invites + limit, plus the grant options for the form.
router.get('/', async (req, res, next) => {
  try {
    const parent = await parentRow(req);
    const children = (await sys().query(
      `SELECT id, name, domain, subscription_status, suspended_at, feature_overrides, cap_overrides, created_at
         FROM tenants WHERE parent_tenant_id = $1 ORDER BY created_at`, [req.tenantId]
    )).rows;
    const invites = (await sys().query(
      `SELECT id, company_name, domain, email, features, cap_overrides, status, expires_at, created_at
         FROM subtenant_invites WHERE parent_tenant_id = $1 AND status = 'PENDING' ORDER BY created_at DESC`, [req.tenantId]
    )).rows;
    const limit = plans.subAccountLimitFor(parent);
    res.json({
      children: children.map((c) => ({
        id: c.id, name: c.name, domain: c.domain,
        status: c.suspended_at ? 'SUSPENDED' : c.subscription_status,
        suspended: !!c.suspended_at,
        features: c.feature_overrides || [], caps: c.cap_overrides || {},
        createdAt: c.created_at,
      })),
      invites,
      limit: Number.isFinite(limit) ? limit : null,
      used: await usedCount(req.tenantId),
      grantOptions: { features: allowedFeatures(parent), caps: plans.planFor(parent.plan).caps },
    });
  } catch (err) { next(err); }
});

// POST /invite — invite a new sub-tenant by email (must be under its company domain).
router.post('/invite', async (req, res, next) => {
  try {
    const parent = await parentRow(req);
    const limit = plans.subAccountLimitFor(parent);
    if ((await usedCount(req.tenantId)) >= limit) {
      return res.status(400).json({ error: `You've reached your sub-account limit (${Number.isFinite(limit) ? limit : '—'}). Remove one or upgrade.`, code: 'SUBACCOUNT_LIMIT' });
    }
    const b = req.body || {};
    const inviteEmail = String(b.email || '').trim().toLowerCase().slice(0, 320);
    const domain = normDomain(b.domain);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail)) return res.status(400).json({ error: 'A valid owner email is required.' });
    if (!domain) return res.status(400).json({ error: 'A workspace domain is required.' });
    // Sub-accounts live under the parent's company, so we don't ask for a company
    // name — the workspace is identified by its domain (used as the display name).
    const companyName = String(b.companyName || '').trim().slice(0, 200) || domain;
    if (!domainsRelated(domainFromEmail(inviteEmail), domain)) {
      return res.status(400).json({ error: `The owner email must be on the ${domain} domain.` });
    }
    if (await domainTaken(domain)) return res.status(409).json({ error: 'A workspace already exists for that domain.' });
    const dupe = await sys().query(
      "SELECT 1 FROM subtenant_invites WHERE parent_tenant_id = $1 AND lower(email) = $2 AND status = 'PENDING' LIMIT 1",
      [req.tenantId, inviteEmail]
    );
    if (dupe.rowCount) return res.status(409).json({ error: 'A pending invite already exists for that email.' });

    const features = sanitizeFeatures(b.features, allowedFeatures(parent));
    const caps = sanitizeCaps(b.caps, parent);
    const token = crypto.randomBytes(24).toString('base64url');

    const ins = await sys().query(
      `INSERT INTO subtenant_invites (parent_tenant_id, company_name, domain, email, features, cap_overrides, token, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8, now() + ($9 || ' days')::interval)
       RETURNING id, company_name, email, status, expires_at`,
      [req.tenantId, companyName, domain, inviteEmail, JSON.stringify(features), JSON.stringify(caps), token, (req.user && req.user.sub) || null, String(INVITE_TTL_DAYS)]
    );

    const link = `${APP_BASE_URL}/join/?token=${encodeURIComponent(token)}`;
    if (email.isConfigured()) {
      const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f1f5f9;padding:24px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
      <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px 28px;color:#fff">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#c7d2fe;font-weight:700">GhostStream</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px">You've been invited to a workspace</div>
      </td></tr>
      <tr><td style="padding:24px 28px;color:#334155;font-size:14px;line-height:1.6">
        <p>${esc(parent.name || 'An organization')} set up a GhostStream workspace for <strong>${esc(companyName)}</strong> and invited you (${esc(inviteEmail)}) to run it.</p>
        <p>Set your password to get started — your account is ready.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="border-radius:8px;background:#4f46e5">
          <a href="${esc(link)}" style="display:inline-block;padding:12px 26px;color:#fff;font-weight:600;text-decoration:none">Accept &amp; set up →</a>
        </td></tr></table>
        <p style="color:#94a3b8;font-size:12px">This invite expires in ${INVITE_TTL_DAYS} days. If you weren't expecting it, ignore this email.</p>
      </td></tr>
    </table>
  </td></tr></table>
</div>`;
      try {
        await email.send({ to: inviteEmail, subject: `You're invited to the ${companyName} workspace on GhostStream`, html, text: `You've been invited to set up the ${companyName} workspace on GhostStream.\n\nAccept: ${link}\n\nExpires in ${INVITE_TTL_DAYS} days.`, categories: ['subaccount-invite'] });
      } catch (e) { console.warn('[subaccounts] invite email failed (invite stored):', e.message); }
    }
    res.status(201).json({ ok: true, invite: ins.rows[0], emailSent: email.isConfigured() });
  } catch (err) { next(err); }
});

// GET /monitor — activity roll-up across the parent's children: generated intel,
// completed call reports, and upcoming meetings. A SUMMARY only (counts + recent
// titles/dates) — the parent monitors activity without entering a child's
// workspace. Strictly scoped to the parent's own children (childIds are derived
// server-side from parent_tenant_id; never from the client).
router.get('/monitor', async (req, res, next) => {
  try {
    const childRows = (await sys().query(
      `SELECT id, name, domain, subscription_status, suspended_at
         FROM tenants WHERE parent_tenant_id = $1 ORDER BY name`, [req.tenantId]
    )).rows;
    if (!childRows.length) return res.json({ children: [] });
    const ids = childRows.map((c) => c.id);

    const [intelCnt, callCnt, upCnt, intelRecent, callRecent, upRecent] = await Promise.all([
      sys().query(`SELECT tenant_id, count(*)::int n FROM kb_documents WHERE tenant_id = ANY($1) AND scope='TENANT' AND status='READY' GROUP BY tenant_id`, [ids]),
      sys().query(`SELECT tenant_id, count(*)::int n FROM scheduled_meetings WHERE tenant_id = ANY($1) AND status='COMPLETED' GROUP BY tenant_id`, [ids]),
      sys().query(`SELECT tenant_id, count(*)::int n FROM scheduled_meetings WHERE tenant_id = ANY($1) AND scheduled_at >= now() AND status NOT IN ('CANCELLED','COMPLETED') GROUP BY tenant_id`, [ids]),
      sys().query(`SELECT tenant_id, title, category, created_at FROM (
                     SELECT tenant_id, title, category, created_at,
                            row_number() OVER (PARTITION BY tenant_id ORDER BY created_at DESC) rn
                       FROM kb_documents WHERE tenant_id = ANY($1) AND scope='TENANT' AND status='READY'
                   ) s WHERE rn <= 5`, [ids]),
      sys().query(`SELECT tenant_id, id, scheduled_at, company_name FROM (
                     SELECT sm.tenant_id, sm.id, sm.scheduled_at, c.name AS company_name,
                            row_number() OVER (PARTITION BY sm.tenant_id ORDER BY sm.scheduled_at DESC) rn
                       FROM scheduled_meetings sm LEFT JOIN companies c ON c.id = sm.company_id
                      WHERE sm.tenant_id = ANY($1) AND sm.status='COMPLETED'
                   ) s WHERE rn <= 5`, [ids]),
      sys().query(`SELECT tenant_id, id, scheduled_at, status, company_name FROM (
                     SELECT sm.tenant_id, sm.id, sm.scheduled_at, sm.status, c.name AS company_name,
                            row_number() OVER (PARTITION BY sm.tenant_id ORDER BY sm.scheduled_at ASC) rn
                       FROM scheduled_meetings sm LEFT JOIN companies c ON c.id = sm.company_id
                      WHERE sm.tenant_id = ANY($1) AND sm.scheduled_at >= now() AND sm.status NOT IN ('CANCELLED','COMPLETED')
                   ) s WHERE rn <= 5`, [ids]),
    ]);

    const byId = (rows) => { const m = {}; for (const r of rows) (m[r.tenant_id] = m[r.tenant_id] || []).push(r); return m; };
    const cnt = (rows) => { const m = {}; for (const r of rows) m[r.tenant_id] = r.n; return m; };
    const ic = cnt(intelCnt.rows), cc = cnt(callCnt.rows), uc = cnt(upCnt.rows);
    const ir = byId(intelRecent.rows), cr = byId(callRecent.rows), ur = byId(upRecent.rows);

    res.json({
      children: childRows.map((c) => ({
        id: c.id, name: c.name, domain: c.domain,
        status: c.suspended_at ? 'SUSPENDED' : c.subscription_status,
        intel: { count: ic[c.id] || 0, recent: (ir[c.id] || []).map((r) => ({ title: r.title, category: r.category, at: r.created_at })) },
        calls: { count: cc[c.id] || 0, recent: (cr[c.id] || []).map((r) => ({ company: r.company_name || 'Prospect', at: r.scheduled_at })) },
        upcoming: { count: uc[c.id] || 0, items: (ur[c.id] || []).map((r) => ({ company: r.company_name || 'Prospect', at: r.scheduled_at, status: r.status })) },
      })),
    });
  } catch (err) { next(err); }
});

// PATCH /:childId — update a child's feature mask / cap allocation.
router.patch('/:childId', async (req, res, next) => {
  try {
    const parent = await parentRow(req);
    const owned = await sys().query('SELECT id FROM tenants WHERE id = $1 AND parent_tenant_id = $2', [req.params.childId, req.tenantId]);
    if (!owned.rowCount) return res.status(404).json({ error: 'Sub-account not found.' });
    const b = req.body || {};
    const sets = []; const vals = []; let i = 1;
    if (Array.isArray(b.features)) { sets.push(`feature_overrides = $${i++}::jsonb`); vals.push(JSON.stringify(sanitizeFeatures(b.features, allowedFeatures(parent)))); }
    if (b.caps && typeof b.caps === 'object') { sets.push(`cap_overrides = $${i++}::jsonb`); vals.push(JSON.stringify(sanitizeCaps(b.caps, parent))); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
    vals.push(req.params.childId, req.tenantId);
    await sys().query(`UPDATE tenants SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i++} AND parent_tenant_id = $${i}`, vals);
    tenants.invalidate(req.params.childId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /:childId/suspend  &  /:childId/unsuspend — pause/resume a sub-account.
router.post('/:childId/:action(suspend|unsuspend)', async (req, res, next) => {
  try {
    const suspend = req.params.action === 'suspend';
    const r = await sys().query(
      `UPDATE tenants SET suspended_at = ${suspend ? 'now()' : 'NULL'}, updated_at = now()
        WHERE id = $1 AND parent_tenant_id = $2 RETURNING id`, [req.params.childId, req.tenantId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Sub-account not found.' });
    tenants.invalidate(req.params.childId);
    res.json({ ok: true, suspended: suspend });
  } catch (err) { next(err); }
});

// DELETE /invites/:id — revoke a pending invite.
router.delete('/invites/:id', async (req, res, next) => {
  try {
    const r = await sys().query(
      "UPDATE subtenant_invites SET status = 'REVOKED' WHERE id = $1 AND parent_tenant_id = $2 AND status = 'PENDING' RETURNING id",
      [req.params.id, req.tenantId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Invite not found.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── public token router (no auth) ───────────────────────────────────────────
const publicRouter = express.Router();
publicRouter.use(express.json());

async function liveInvite(token) {
  const r = await sys().query(
    "SELECT * FROM subtenant_invites WHERE token = $1 AND status = 'PENDING' AND expires_at > now() LIMIT 1", [token]
  );
  return r.rows[0] || null;
}

// GET /invite/:token — render data for the join page.
publicRouter.get('/invite/:token', async (req, res, next) => {
  try {
    const inv = await liveInvite(req.params.token);
    if (!inv) return res.status(404).json({ error: 'This invite is invalid or has expired.' });
    res.json({ companyName: inv.company_name, email: inv.email, domain: inv.domain, features: inv.features });
  } catch (err) { next(err); }
});

// POST /invite/:token/accept — create the child tenant + owner, then log them in.
publicRouter.post('/invite/:token/accept', async (req, res, next) => {
  try {
    const inv = await liveInvite(req.params.token);
    if (!inv) return res.status(404).json({ error: 'This invite is invalid or has expired.' });
    const b = req.body || {};
    const password = String(b.password || '');
    if (password.length < MIN_PASSWORD_LEN) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
    if (await domainTaken(inv.domain)) return res.status(409).json({ error: 'A workspace already exists for that domain.' });

    const parent = await tenants.get(inv.parent_tenant_id);
    if (!parent) return res.status(410).json({ error: 'The inviting account no longer exists.' });

    // Create the child tenant (billing inherited from parent) + its owner.
    const childRow = (await sys().query(
      `INSERT INTO tenants (name, domain, subscription_status, plan, parent_tenant_id, feature_overrides, cap_overrides)
       VALUES ($1,$2,'ACTIVE',$3,$4,$5::jsonb,$6::jsonb)
       RETURNING id, name`,
      [inv.company_name, inv.domain, parent.plan, inv.parent_tenant_id, JSON.stringify(inv.features || []), JSON.stringify(inv.cap_overrides || {})]
    )).rows[0];

    const owner = await users.create({
      tenantId: childRow.id,
      email: inv.email,
      passwordHash: await users.hashPassword(password),
      firstName: (b.firstName || '').trim() || null,
      lastName: (b.lastName || '').trim() || null,
      role: 'owner',
      isAdmin: false,
      emailVerified: true, // the invite was sent to this address
    });

    await sys().query(
      "UPDATE subtenant_invites SET status = 'ACCEPTED', child_tenant_id = $1, accepted_at = now() WHERE id = $2",
      [childRow.id, inv.id]
    );

    // Auto-login (mirror grantSession in index.js).
    const publicUser = { id: owner.id, tenantId: childRow.id, email: owner.email, name: owner.name || null, role: 'owner', isAdmin: false };
    res.cookie(auth.COOKIE_NAME, auth.signToken(publicUser), auth.cookieOptions());
    res.status(201).json({ ok: true, user: publicUser });
  } catch (err) { next(err); }
});

module.exports = { router, publicRouter };
