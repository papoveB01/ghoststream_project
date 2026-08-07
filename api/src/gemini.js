// Context-Caching-first Gemini integration.
//
// Every reusable context (persona character, product catalog, account history)
// is registered as a NAMED bundle. The first reference creates a Gemini
// cachedContent resource. Every subsequent reference reuses it, dropping the
// per-call cost to roughly 1/4 of the standard rate.
//
// If caching is unavailable (free-tier quota, content below the model's
// minimum cacheable tokens, transient API error), we degrade to inline content
// automatically. The caller's code path is identical — only the per-call cost
// changes.

const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const redis = require('./redis');
const costs = require('./costs');
const { providerOfModel } = require('./models');

const REGISTRY_PREFIX = 'gemini:cache:';
const SKIP_PREFIX = 'gemini:cache-skip:';
const DEFAULT_TTL_SEC = 3600;
const SAFETY_MARGIN_SEC = 60;
const SKIP_REFRESH_SEC = 300; // re-try a failing cache no more than once per 5 min

let _client;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

function hashContent(obj) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .slice(0, 16);
}

function toContents(contents) {
  if (!contents) return [];
  const arr = Array.isArray(contents) ? contents : [contents];
  return arr.map((item) => {
    if (typeof item === 'string') {
      return { role: 'user', parts: [{ text: item }] };
    }
    return item;
  });
}

// This module is the GOOGLE client. A model id belonging to another provider
// reaching it is not a bad request, it is a routing bug, and it has a specific
// live path: personas.js resolves modelFor('personas') and arena.js feeds that
// straight into caches.create(), so AI_PROVIDER_PERSONAS=anthropic aims a
// Claude id at Google's caches API (ADR-0006 §9 item 4). What prevents it today
// is that `personas` is not in models.DISPATCH_READY, so providerFor() warns and
// stays on Gemini — not that the set is empty, which it stopped being when group
// 1 landed.
//
// A CORRECT arena cutover never reaches this check. models.js states the rule on
// DISPATCH_READY itself — a task joins the set in the same PR that migrates its
// call site — and ADR-0006 §9 item 5 groups `personas` with `arena` and
// `arenaHistory` for exactly that reason: done right, arena.js's
// `getOrCreateCache({ model: seed.model })` no longer exists by the time
// `personas` is added, and the call-site migration is the gate. This guard is
// for the INCORRECT one — task key added to `DISPATCH_READY`, call site left on
// the Gemini SDK — so do not treat it as the thing that makes the flip safe.
// Google's own answer to that request is a 404 that mentions neither the
// provider nor the env var that caused it.
//
// Unknown ids pass — see models.providerOfModel for why this blocks rather than
// allow-lists.
function assertGeminiModel(model, fn) {
  const p = providerOfModel(model);
  if (p && p !== 'gemini') {
    const err = new Error(
      `gemini.${fn}: "${model}" is a ${p} model id, not a Gemini one. ` +
      'A task was routed to another provider while its call site still dispatches ' +
      'to the Gemini SDK — migrate the call site (ADR-0006 §4.5) or unset its ' +
      'AI_PROVIDER_* override.'
    );
    err.status = 500;
    throw err;
  }
}

function isUncacheableError(err) {
  // Two failure modes we treat as "permanent for the content as-is":
  //   - 400: content below the model's minimum cacheable tokens
  //   - 429: free-tier (or per-account) cache storage quota exhausted
  const msg = err.message || '';
  return msg.includes('too small') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('limit=0');
}

// Returns one of two shapes:
//
//   CACHED:   { mode: 'cached', name, cacheName, model, contentHash, expiresAt }
//   INLINE:   { mode: 'inline', name, model, systemInstruction, contents, reason }
//
// Either shape is accepted by generateForRecord() below — callers don't branch.
async function getOrCreateCache({
  name,
  model,
  systemInstruction,
  contents,
  ttlSec = DEFAULT_TTL_SEC,
}) {
  if (!name || !model) {
    throw new Error('getOrCreateCache: name and model required');
  }
  assertGeminiModel(model, 'getOrCreateCache');
  const normContents = toContents(contents);
  if (normContents.length === 0) {
    throw new Error('getOrCreateCache: contents required (caches.create rejects empty contents)');
  }

  const contentHash = hashContent({ model, systemInstruction, contents: normContents });
  const registryKey = REGISTRY_PREFIX + name;
  const skipKey = SKIP_PREFIX + name + ':' + contentHash;

  // Hit on cached registry?
  const existingRaw = await redis.get(registryKey);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    if (existing.contentHash === contentHash && existing.mode === 'cached') {
      return existing;
    }
    // Content changed — invalidate the stale Gemini cache.
    if (existing.mode === 'cached' && existing.cacheName) {
      try { await getClient().caches.delete({ name: existing.cacheName }); }
      catch (err) { console.warn('[gemini] stale cache delete failed:', err.message); }
    }
  }

  // Recent failure? Use inline without retrying the API.
  const skipMark = await redis.get(skipKey);
  if (skipMark) {
    return {
      mode: 'inline',
      name,
      model,
      systemInstruction: systemInstruction || null,
      contents: normContents,
      contentHash,
      reason: `cache-skip flag set: ${skipMark}`,
    };
  }

  // Try to create a real Gemini cache.
  try {
    const config = {
      contents: normContents,
      ttl: `${ttlSec}s`,
      displayName: name,
    };
    if (systemInstruction) config.systemInstruction = systemInstruction;
    const created = await getClient().caches.create({ model, config });

    const now = Date.now();
    const record = {
      mode: 'cached',
      name,
      cacheName: created.name,
      model,
      contentHash,
      ttlSec,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSec * 1000).toISOString(),
      displayName: created.displayName || name,
    };
    await redis.set(
      registryKey,
      JSON.stringify(record),
      'EX',
      Math.max(ttlSec - SAFETY_MARGIN_SEC, 60)
    );
    return record;
  } catch (err) {
    if (isUncacheableError(err)) {
      console.warn(`[gemini] cache "${name}" not creatable, falling back to inline:`, err.message);
      // Remember NOT to retry this content for SKIP_REFRESH_SEC.
      await redis.set(skipKey, err.message.slice(0, 200), 'EX', SKIP_REFRESH_SEC);
      const record = {
        mode: 'inline',
        name,
        model,
        systemInstruction: systemInstruction || null,
        contents: normContents,
        contentHash,
        reason: err.message,
      };
      await redis.set(registryKey, JSON.stringify(record), 'EX', SKIP_REFRESH_SEC);
      return record;
    }
    // Real, unexpected failure — bubble up.
    const e = new Error(`Gemini cache create failed for "${name}": ${err.message}`);
    e.cause = err;
    e.status = err.status || err.statusCode || 500;
    throw e;
  }
}

// SCAN, never KEYS. This Redis is shared with sessions, login-guard counters,
// device OTP challenges and onboarding state; KEYS walks the entire keyspace
// regardless of pattern and blocks the single-threaded server while it does, so
// at production key counts every cache invalidation stalled auth and rate-limit
// lookups for everyone. Same cursor pattern as platformAdmin.scanExists.
function scanKeys(pattern) {
  return new Promise((resolve, reject) => {
    const s = redis.scanStream({ match: pattern, count: 100 });
    const out = [];
    s.on('data', (keys) => { for (const k of keys) out.push(k); });
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
}

async function listCachedRecords() {
  const keys = await scanKeys(REGISTRY_PREFIX + '*');
  if (keys.length === 0) return [];
  const values = await redis.mget(keys);
  return values.filter(Boolean).map((v) => JSON.parse(v));
}

async function invalidate(name) {
  const registryKey = REGISTRY_PREFIX + name;
  const raw = await redis.get(registryKey);
  if (!raw) return false;
  const parsed = JSON.parse(raw);
  if (parsed.mode === 'cached' && parsed.cacheName) {
    try { await getClient().caches.delete({ name: parsed.cacheName }); }
    catch (err) { console.warn('[gemini] cache delete failed:', err.message); }
  }
  await redis.del(registryKey);
  // Also drop any skip flags for this name.
  const skipKeys = await scanKeys(SKIP_PREFIX + name + ':*');
  if (skipKeys.length) await redis.del(...skipKeys);
  return true;
}

// One-shot generation that auto-handles cached vs. inline based on the record shape.
async function generateForRecord({
  record,
  message,
  temperature = 0.8,
  maxOutputTokens = 1024,
  tenantId = null,
  site = 'gemini.forRecord',
}) {
  if (!record) throw new Error('generateForRecord: record required');
  if (!message) throw new Error('generateForRecord: message required');
  assertGeminiModel(record.model, 'generateForRecord');

  const client = getClient();
  const config = { temperature, maxOutputTokens };

  let contents;
  if (record.mode === 'cached') {
    config.cachedContent = record.cacheName;
    contents = message;
  } else {
    // Inline fallback: prepend the persona context, then the user turn.
    contents = [
      ...record.contents,
      { role: 'user', parts: [{ text: message }] },
    ];
    if (record.systemInstruction) config.systemInstruction = record.systemInstruction;
  }

  const response = await client.models.generateContent({
    model: record.model,
    contents,
    config,
  });
  costs.recordGemini(tenantId, site, record.model, response.usageMetadata);

  return {
    text: response.text,
    usage: response.usageMetadata || null,
    mode: record.mode,
    cacheName: record.mode === 'cached' ? record.cacheName : null,
    finishReason: response.candidates?.[0]?.finishReason || null,
  };
}

module.exports = {
  getClient,
  getOrCreateCache,
  listCachedRecords,
  invalidate,
  generateForRecord,
};
