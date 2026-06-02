// Security audit log writer (SOC 2 CC7.2). Best-effort, append-only inserts into
// the audit_log table (migration 0026). A logging failure is swallowed (logged
// to stderr) so it can never block the action being audited.
//
// Usage:
//   audit.log({ req, action: 'auth.login.success', actorUserId, actorEmail, tenantId });
//   audit.log({ req, action: 'auth.login.failure', result: 'failure', actorEmail, meta:{reason} });

const db = require('./db');
const devices = require('./devices');

// Pull ip + user-agent off the request (same client-IP logic as device trust).
function reqMeta(req) {
  if (!req) return { ip: null, ua: null };
  let ip = null;
  try { ip = devices.clientIp(req); } catch { ip = null; }
  const ua = req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null;
  return { ip, ua };
}

async function log(entry = {}) {
  try {
    const { ip, ua } = reqMeta(entry.req);
    await db.query(
      `INSERT INTO audit_log (action, result, actor_user_id, actor_email, tenant_id, target, ip, user_agent, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        entry.action,
        entry.result || null,
        entry.actorUserId || null,
        entry.actorEmail || null,
        entry.tenantId || null,
        entry.target || null,
        entry.ip || ip,
        entry.userAgent || ua,
        JSON.stringify(entry.meta || {}),
      ]
    );
  } catch (err) {
    console.error('[audit] failed to write audit event', entry.action, '-', err.message);
  }
}

// Recent events, newest first, with optional filters (all AND-ed). Superadmin
// may pass tenantId=null to read across tenants — callers must enforce that
// authorization. `actor` matches actor_email (case-insensitive substring);
// `from`/`to` bound `at`; `action` matches exactly or by prefix when it ends '*'.
async function recent({ tenantId, action, actor, from, to, limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const where = [];
  const params = [];
  if (tenantId) { params.push(tenantId); where.push(`tenant_id = $${params.length}`); }
  if (action) {
    if (String(action).endsWith('*')) { params.push(String(action).slice(0, -1) + '%'); where.push(`action LIKE $${params.length}`); }
    else { params.push(action); where.push(`action = $${params.length}`); }
  }
  if (actor) { params.push(`%${String(actor).toLowerCase()}%`); where.push(`lower(actor_email) LIKE $${params.length}`); }
  if (from) { params.push(from); where.push(`at >= $${params.length}`); }
  if (to)   { params.push(to);   where.push(`at <= $${params.length}`); }
  params.push(lim); const limIdx = params.length;
  params.push(off); const offIdx = params.length;
  const r = await db.query(
    `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY at DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );
  return r.rows;
}

module.exports = { log, recent };
