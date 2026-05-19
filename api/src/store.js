// Redis-backed entity store. Postgres comes later; for the First Loop
// milestone Redis is enough and means zero migration ceremony.

const crypto = require('crypto');
const redis = require('./redis');

const NS = {
  meeting: 'meeting:',
  portal: 'portal:',
  session: 'session:',
};

const SESSION_TTL_SEC = 3600; // 1h — Arena sessions are short-lived practice loops

function newId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

async function saveJson(key, obj, ttlSec) {
  const payload = JSON.stringify(obj);
  if (ttlSec) {
    await redis.set(key, payload, 'EX', ttlSec);
  } else {
    await redis.set(key, payload);
  }
}

async function getJson(key) {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

// Meetings -----------------------------------------------------------------

async function createMeeting({ source, meetingUrl, botId, status = 'created', meta = {} }) {
  const id = newId('m_');
  const record = {
    id,
    source,         // 'recall' | 'first-loop'
    meetingUrl,
    botId: botId || null,
    status,         // created | recording | done | failed
    portalId: null,
    transcript: null,
    analysis: null,
    meta,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveJson(NS.meeting + id, record);
  return record;
}

async function updateMeeting(id, patch) {
  const existing = await getJson(NS.meeting + id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await saveJson(NS.meeting + id, merged);
  return merged;
}

async function getMeeting(id) {
  return getJson(NS.meeting + id);
}

async function findMeetingByBotId(botId) {
  // Scan is fine at this scale; if it grows we'll add an index.
  const keys = await redis.keys(NS.meeting + '*');
  for (const k of keys) {
    const m = await getJson(k);
    if (m && m.botId === botId) return m;
  }
  return null;
}

// Batched MGET for enriching portal rows with their parent meeting reference
// in /admin/portals and /portals/:id. Returns a Map(meetingId → meeting); a
// missing id maps to null so callers can render a placeholder.
async function getMeetingsByIds(ids) {
  const unique = Array.from(new Set((ids || []).filter(Boolean)));
  const out = new Map();
  if (unique.length === 0) return out;
  const values = await redis.mget(unique.map((id) => NS.meeting + id));
  unique.forEach((id, i) => {
    const raw = values[i];
    let parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch { /* corrupt blob — treat as missing */ } }
    out.set(id, parsed);
  });
  return out;
}

// Portals ------------------------------------------------------------------

async function createPortal(data) {
  const id = newId('p_');
  const record = {
    id,
    ...data,
    createdAt: new Date().toISOString(),
  };
  await saveJson(NS.portal + id, record);
  return record;
}

async function getPortal(id) {
  return getJson(NS.portal + id);
}

// Sessions ----------------------------------------------------------------

async function createSession(data) {
  const id = newId('s_');
  const record = {
    id,
    ...data,
    turns: data.turns || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveJson(NS.session + id, record, SESSION_TTL_SEC);
  return record;
}

async function getSession(id) {
  return getJson(NS.session + id);
}

async function appendSessionTurns(id, newTurns) {
  const existing = await getJson(NS.session + id);
  if (!existing) return null;
  existing.turns = [...(existing.turns || []), ...newTurns];
  existing.updatedAt = new Date().toISOString();
  await saveJson(NS.session + id, existing, SESSION_TTL_SEC);
  return existing;
}

// Admin listing helpers ---------------------------------------------------
//
// SCAN would be more correct than KEYS at large scale, but for the current
// scope (hundreds of entities, single instance) KEYS is fine and simpler.

async function _listByPrefix(prefix, limit) {
  const keys = await redis.keys(prefix + '*');
  if (keys.length === 0) return [];
  const values = await redis.mget(keys);
  return values
    .filter(Boolean)
    .map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit || 50);
}

async function listPortals(limit) { return _listByPrefix(NS.portal, limit); }
async function listSessions(limit) { return _listByPrefix(NS.session, limit); }
async function listMeetings(limit) { return _listByPrefix(NS.meeting, limit); }

async function getCounts() {
  const [pk, sk, mk] = await Promise.all([
    redis.keys(NS.portal + '*'),
    redis.keys(NS.session + '*'),
    redis.keys(NS.meeting + '*'),
  ]);
  return { portals: pk.length, sessions: sk.length, meetings: mk.length };
}

// Calls (unified view) — assessment-003 Phase 1 ---------------------------
//
// Status bucket → raw meeting.status mapping (§3.1).
const _PENDING_STATUSES = new Set([
  'creating', 'pending', 'joining_call', 'in_waiting_room', 'in_call_not_recording',
]);
const _ANALYSING_STATUSES = new Set([
  'in_call_recording', 'call_ended', 'recording_done', 'analyzing',
]);

function _bucketStatus(rawStatus, hasPortal) {
  if (_PENDING_STATUSES.has(rawStatus)) return 'pending';
  if (_ANALYSING_STATUSES.has(rawStatus)) return 'analysing';
  if (rawStatus === 'done' && hasPortal) return 'ready';
  // Covers: 'failed', 'analysis_failed', and 'done' with no portal (orphan).
  return 'failed';
}

// Safe portal projection for list responses — never includes transcript,
// analysis, or grounding (all potentially kilobytes in size).
// Matches the portalRefFromRecord shape specified in assessment-003 §3.1.
function portalRefFromRecord(p) {
  if (!p) return null;
  const allGaps = (p.moments && Array.isArray(p.moments.knowledgeGaps))
    ? p.moments.knowledgeGaps : [];
  const audit = {
    gapCount: allGaps.length,
    hasHighSeverity: allGaps.some(
      (g) => String(g.severity || '').toUpperCase() === 'HIGH'
    ),
  };
  return {
    id: p.id,
    title: p.title || null,
    participants: p.participants || [],
    objectionQuote: (p.moments && p.moments.objection && p.moments.objection.quote) || null,
    audit,
    reanalyzedAt: p.reanalyzedAt || null,
  };
}

// Compact meeting projection for call rows. Sibling to meetingRefFromRecord
// in index.js; adds missionCompanyId and analysisError that the ops/failed
// view needs, without shipping transcript or analysis blobs.
function _meetingRefForCall(m) {
  if (!m) return null;
  return {
    id: m.id,
    source: m.source || null,
    meetingUrl: m.meetingUrl || null,
    botId: m.botId || null,
    durationSeconds: (m.transcript && m.transcript.durationSeconds) || null,
    missionId: (m.meta && m.meta.missionId) || null,
    missionCompanyId: (m.meta && m.meta.missionCompanyId) || null,
    tenantId: (m.meta && m.meta.tenantId) || null,
    analysisError: m.analysisError || null,
    createdAt: m.createdAt || null,
  };
}

// Split a CSV query-param value (or an already-an-array value) into a Set.
// Returns null when the param is absent or empty so callers can short-circuit.
function _csvToSet(v) {
  if (!v) return null;
  const arr = Array.isArray(v)
    ? v.filter(Boolean)
    : v.split(',').map((s) => s.trim()).filter(Boolean);
  return arr.length > 0 ? new Set(arr) : null;
}

// Validate and parse a date query-param string. Returns a UTC timestamp (ms)
// or null when the param is absent. Throws a 400-status error when the value
// is present but not parseable as a date, so callers get an explicit error
// rather than a silent NaN no-op in the filter (finding B from PR #9 review).
function _parseDateParam(name, value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (isNaN(t)) {
    const err = new Error(`invalid \`${name}\` date — expected ISO 8601 (e.g. 2024-01-15T00:00:00Z)`);
    err.status = 400;
    throw err;
  }
  return t;
}

// buildCallsList — unified store query backing GET /api/admin/calls.
//
// Reads both prefix scans (meetings + portals), joins on portal.meetingId,
// derives the bucketed status, applies filters and pagination, returns
// { calls[], pageInfo, facets }.
//
// Facets are computed over the tenant-scoped full set — before other filters
// — so the UI can display how many calls exist in each bucket regardless of
// the active status/source/etc filter.
//
// Pagination: cursor is a base64-encoded integer offset into the sorted,
// filtered array. The 50/100-row ceiling in _listByPrefix is intentionally
// bypassed here; pagination lives at this layer per the ADR.
async function buildCallsList(filters = {}) {
  const {
    status: statusFilter,
    source: sourceFilter,
    // `tenant` is pre-resolved by the route handler:
    //   superadmin → req.query.tenant (CSV of tenant ids, or absent = all)
    //   non-superadmin → req.tenantId (forced; query param ignored)
    tenant: tenantFilter,
    mission_id,
    company_id,
    has_gaps,
    has_portal,
    from: fromParam,
    to: toParam,
    q,
    cursor,
    limit: limitParam,
  } = filters;

  const limit = Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200);

  // ── 1. Load portals → build meetingId → portal map ──────────────────────
  const pKeys = await redis.keys(NS.portal + '*');
  const pRaws = pKeys.length > 0 ? await redis.mget(pKeys) : [];
  const portalByMeeting = new Map();
  for (const raw of pRaws) {
    if (!raw) continue;
    try {
      const p = JSON.parse(raw);
      if (p && p.meetingId) portalByMeeting.set(p.meetingId, p);
    } catch { /* corrupt blob — skip */ }
  }

  // ── 2. Load all meetings ─────────────────────────────────────────────────
  const mKeys = await redis.keys(NS.meeting + '*');
  const mRaws = mKeys.length > 0 ? await redis.mget(mKeys) : [];
  const allMeetings = mRaws
    .filter(Boolean)
    .map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);

  // ── 3. Build unified call rows ───────────────────────────────────────────
  let calls = allMeetings.map((m) => {
    const portal = portalByMeeting.get(m.id) || null;
    const bucket = _bucketStatus(m.status || '', !!portal);
    return {
      id: m.id,
      status: bucket,
      rawStatus: m.status || null,
      source: m.source || null,
      createdAt: m.createdAt || null,
      meeting: _meetingRefForCall(m),
      portal: portalRefFromRecord(portal),
    };
  });

  // ── 4. Tenant scope — security boundary, applied before facets ───────────
  // A non-null tenantFilter means the caller is either non-superadmin
  // (forced to their own tenantId) or a superadmin who passed tenant= param.
  // Absent tenantFilter (superadmin, no param) → all tenants visible.
  const tenantSet = _csvToSet(tenantFilter);
  if (tenantSet) {
    calls = calls.filter((c) => c.meeting && tenantSet.has(c.meeting.tenantId));
  }

  // ── 4.5. Sample hiding — per ADR-003 §6 Decision #6 ──────────────────────
  // Default queries exclude source='sample' rows. Opt-in by either:
  //   - ?include_samples=1 (general flag)
  //   - ?source=...,sample (explicit inclusion in the source CSV)
  // Applied before facets so the facet counts reflect what the caller will
  // actually see — toggling "Show samples" on the UI reveals both the rows
  // AND their facet contribution.
  const includeSamples = filters.include_samples === '1' ||
                         filters.include_samples === 'true' ||
                         filters.include_samples === true;
  const explicitlyRequestSamples = sourceFilter &&
    String(sourceFilter).split(',').map((s) => s.trim()).includes('sample');
  if (!includeSamples && !explicitlyRequestSamples) {
    calls = calls.filter((c) => c.source !== 'sample');
  }

  // ── 5. Compute facets over the full tenant-scoped set ────────────────────
  const facets = {
    status:  { pending: 0, analysing: 0, ready: 0, failed: 0 },
    source:  {},
    tenants: {},
  };
  for (const c of calls) {
    if (c.status in facets.status) facets.status[c.status]++;
    if (c.source) facets.source[c.source] = (facets.source[c.source] || 0) + 1;
    const tid = c.meeting && c.meeting.tenantId;
    if (tid) facets.tenants[tid] = (facets.tenants[tid] || 0) + 1;
  }

  // ── 6. Apply remaining filters ───────────────────────────────────────────
  const statusSet  = _csvToSet(statusFilter);
  const sourceSet  = _csvToSet(sourceFilter);
  const missionSet = _csvToSet(mission_id);
  const companySet = _csvToSet(company_id);
  // _parseDateParam throws a 400-status error for present-but-unparseable
  // values; absent params return null. No more silent NaN no-ops.
  const fromTs     = _parseDateParam('from', fromParam);
  const toTs       = _parseDateParam('to',   toParam);
  const qLower     = q ? q.toLowerCase() : null;

  const needsFilter = statusSet || sourceSet || missionSet || companySet ||
                      fromTs !== null || toTs !== null || has_gaps || has_portal || qLower;

  if (needsFilter) {
    calls = calls.filter((c) => {
      if (statusSet && !statusSet.has(c.status)) return false;
      if (sourceSet && !sourceSet.has(c.source)) return false;
      if (missionSet && !(c.meeting && missionSet.has(c.meeting.missionId))) return false;
      if (companySet && !(c.meeting && companySet.has(c.meeting.missionCompanyId))) return false;

      if (fromTs !== null || toTs !== null) {
        const ts = c.createdAt ? new Date(c.createdAt).getTime() : 0;
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs   !== null && ts > toTs)   return false;
      }

      if (has_gaps) {
        const audit = c.portal && c.portal.audit;
        if (has_gaps === 'none' && (!audit || audit.gapCount > 0)) return false;
        if (has_gaps === 'any'  && (!audit || audit.gapCount === 0)) return false;
        if (has_gaps === 'high' && (!audit || !audit.hasHighSeverity)) return false;
      }

      if (has_portal === 'true' && !c.portal) return false;
      if (has_portal === 'false' && c.portal) return false;

      if (qLower) {
        const candidates = [
          c.id,
          c.portal && c.portal.title,
          c.meeting && c.meeting.meetingUrl,
        ];
        const participants = (c.portal && c.portal.participants) || [];
        for (const p of participants) {
          if (p && p.name) candidates.push(p.name);
        }
        if (!candidates.some((f) => f && f.toLowerCase().includes(qLower))) return false;
      }

      return true;
    });
  }

  // ── 7. Sort by createdAt DESC ─────────────────────────────────────────────
  calls.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  // ── 8. Cursor-based pagination ────────────────────────────────────────────
  // Cursor is an opaque base64-encoded integer offset. Rebuilt fresh on every
  // request so drift from concurrent writes is bounded to one page.
  let offset = 0;
  if (cursor) {
    try {
      offset = Math.max(
        parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10) || 0,
        0
      );
    } catch { offset = 0; }
  }

  const page       = calls.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore    = nextOffset < calls.length;
  const nextCursor = hasMore
    ? Buffer.from(String(nextOffset)).toString('base64')
    : null;

  return {
    calls: page,
    pageInfo: { cursor: nextCursor, hasMore, total: calls.length },
    facets,
  };
}

module.exports = {
  newId,
  createMeeting,
  updateMeeting,
  getMeeting,
  findMeetingByBotId,
  getMeetingsByIds,
  createPortal,
  getPortal,
  createSession,
  getSession,
  appendSessionTurns,
  listPortals,
  listSessions,
  listMeetings,
  getCounts,
  portalRefFromRecord,
  buildCallsList,
};
