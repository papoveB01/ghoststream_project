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

// Recent events for a tenant (admin view). Superadmin may pass tenantId=null to
// read across tenants — callers must enforce that authorization.
async function recent({ tenantId, limit = 100 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const r = tenantId
    ? await db.query(`SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY at DESC LIMIT $2`, [tenantId, lim])
    : await db.query(`SELECT * FROM audit_log ORDER BY at DESC LIMIT $1`, [lim]);
  return r.rows;
}

module.exports = { log, recent };
