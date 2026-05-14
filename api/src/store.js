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
};
