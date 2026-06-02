// Tenant erasure (GDPR/CCPA right-to-be-forgotten + offboarding). Purges a
// tenant's data across ALL stores — Postgres (cascade), Cloudflare R2 (KB files
// + raw recordings), Cloudflare Stream (clips), and Redis — since none of those
// are linked to the Postgres FK cascade.
//
// Order matters: we read the handles we need (KB object keys, Recall bot ids,
// Stream uids, portal/meeting blobs) BEFORE the Postgres cascade removes the
// rows that point at them. The audit_log row is written by the caller and is
// intentionally retained (it has no tenant FK).
//
// Supports { dryRun } — enumerate and return the manifest WITHOUT deleting.

const db = require('./db');
const redis = require('./redis');
const r2 = require('./knowledge/r2');
const stream = require('./stream');
const tenants = require('./tenants');

const FOUNDERS_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// Non-blocking key scan (SCAN, not KEYS) — safe on a shared production Redis.
function scanKeys(match) {
  return new Promise((resolve, reject) => {
    const keys = [];
    const s = redis.scanStream({ match, count: 250 });
    s.on('data', (batch) => { for (const k of batch) keys.push(k); });
    s.on('end', () => resolve(keys));
    s.on('error', reject);
  });
}

// Collect every value-keyed Redis blob belonging to a tenant. Meetings carry the
// tenant in meta.tenantId; portals link to a meeting by meetingId; calendly
// route tokens carry tenantId. Returns the keys to delete + the external handles
// (Recall bot ids → R2 recordings, Stream uids → clips) found along the way.
async function collectRedis(tenantId) {
  const meetingKeys = await scanKeys('meeting:*');
  const tenantMeetingKeys = [];
  const tenantMeetingIds = new Set();
  const botIds = new Set();
  for (const k of meetingKeys) {
    const raw = await redis.get(k); if (!raw) continue;
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m && m.meta && m.meta.tenantId === tenantId) {
      tenantMeetingKeys.push(k);
      tenantMeetingIds.add(k.slice('meeting:'.length)); // id == key suffix
      if (m.botId) botIds.add(m.botId);
    }
  }

  const portalKeys = await scanKeys('portal:*');
  const tenantPortalKeys = [];
  const streamUids = new Set();
  for (const k of portalKeys) {
    const raw = await redis.get(k); if (!raw) continue;
    let p; try { p = JSON.parse(raw); } catch { continue; }
    if (p && p.meetingId && tenantMeetingIds.has(p.meetingId)) {
      tenantPortalKeys.push(k);
      if (p.videoUid) streamUids.add(p.videoUid);
      if (p.objectionClip && p.objectionClip.uid) streamUids.add(p.objectionClip.uid);
    }
  }

  const tenantRouteKeys = [];
  for (const k of await scanKeys('caly_route:*')) {
    const raw = await redis.get(k); if (!raw) continue;
    let v; try { v = JSON.parse(raw); } catch { continue; }
    if (v && v.tenantId === tenantId) tenantRouteKeys.push(k);
  }

  // tenant-id-prefixed families — sweepable directly.
  const prefixKeys = [];
  for (const pat of [
    `ms_grant:${tenantId}:*`, `cal_grant:${tenantId}:*`, `caly_token:${tenantId}:*`,
    `apollo_cache:${tenantId}:*`, `apollo_cap:${tenantId}:*`, `company:bootstrap:${tenantId}`,
  ]) {
    prefixKeys.push(...await scanKeys(pat));
  }

  return { tenantMeetingKeys, tenantPortalKeys, tenantRouteKeys, prefixKeys, botIds, streamUids };
}

async function eraseTenant(tenantId, { dryRun = false } = {}) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  if (tenantId === FOUNDERS_TENANT_ID) {
    const e = new Error('refusing to erase the Founders/platform tenant'); e.status = 400; throw e;
  }
  const t = await db.query('SELECT id, name FROM tenants WHERE id = $1', [tenantId]);
  if (t.rowCount === 0) { const e = new Error('tenant not found'); e.status = 404; throw e; }

  // ---- reads (before the cascade removes the pointers) ----
  const userIds = (await db.query('SELECT id FROM users WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.id);
  const kbKeys = (await db.query(
    'SELECT r2_key FROM kb_documents WHERE tenant_id = $1 AND r2_key IS NOT NULL', [tenantId]
  )).rows.map((r) => r.r2_key);
  const botFromPg = (await db.query(
    'SELECT recall_bot_id FROM scheduled_meetings WHERE tenant_id = $1 AND recall_bot_id IS NOT NULL', [tenantId]
  )).rows.map((r) => r.recall_bot_id);

  const rd = await collectRedis(tenantId);
  for (const b of botFromPg) rd.botIds.add(b);

  // recordings live at recordings/<botId>/… in R2 (not referenced from Postgres).
  const recordingKeys = [];
  if (r2.isConfigured()) {
    for (const bot of rd.botIds) {
      try { recordingKeys.push(...await r2.listObjects(`recordings/${bot}/`)); }
      catch (e) { console.error('[erasure] r2 list failed for bot', bot, '-', e.message); }
    }
  }

  const redisKeys = [
    ...rd.tenantMeetingKeys, ...rd.tenantPortalKeys, ...rd.tenantRouteKeys, ...rd.prefixKeys,
    ...userIds.flatMap((uid) => [`otp_send:${uid}`, `sess_valid_after:${uid}`]),
  ];

  const manifest = {
    tenantId, name: t.rows[0].name, dryRun,
    postgres: { users: userIds.length, kbDocuments: kbKeys.length, botIds: rd.botIds.size },
    r2: { kbObjects: kbKeys.length, recordingObjects: recordingKeys.length, configured: r2.isConfigured() },
    stream: { clips: rd.streamUids.size, configured: stream.isConfigured() },
    redis: {
      meetingBlobs: rd.tenantMeetingKeys.length, portalBlobs: rd.tenantPortalKeys.length,
      calendlyRoutes: rd.tenantRouteKeys.length, prefixKeys: rd.prefixKeys.length,
      userKeys: userIds.length * 2, total: redisKeys.length,
    },
  };

  if (dryRun) return manifest;

  // ---- deletes (best-effort per store; never abort the cascade on a side-store miss) ----
  if (r2.isConfigured()) {
    for (const key of [...kbKeys, ...recordingKeys]) {
      try { await r2.deleteObject(key); } catch (e) { console.error('[erasure] r2 delete failed', key, '-', e.message); }
    }
  }
  for (const uid of rd.streamUids) {
    try { await stream.deleteVideo(uid); } catch (e) { console.error('[erasure] stream delete failed', uid, '-', e.message); }
  }
  for (let i = 0; i < redisKeys.length; i += 500) {
    const chunk = redisKeys.slice(i, i + 500);
    try { if (chunk.length) await redis.del(...chunk); } catch (e) { console.error('[erasure] redis del failed', e.message); }
  }

  // ---- Postgres cascade (the authoritative purge) ----
  // Drop KB docs first: the kb_document_{products,personas,competitors} junctions
  // reference products/personas/competitors with ON DELETE RESTRICT, so the
  // tenant cascade would otherwise fail if any entity has tagged intel. Deleting
  // kb_documents cascades those junction rows away (via document_id), clearing
  // the RESTRICT references before the tenant cascade removes the entities.
  await db.query('DELETE FROM kb_documents WHERE tenant_id = $1', [tenantId]);
  const del = await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  manifest.postgres.tenantRowsDeleted = del.rowCount;
  try { tenants.invalidate(tenantId); } catch { /* cache miss is fine */ }

  return manifest;
}

module.exports = { eraseTenant, FOUNDERS_TENANT_ID };
