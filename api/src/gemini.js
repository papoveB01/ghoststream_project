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

async function listCachedRecords() {
  const keys = await redis.keys(REGISTRY_PREFIX + '*');
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
  const skipKeys = await redis.keys(SKIP_PREFIX + name + ':*');
  if (skipKeys.length) await redis.del(...skipKeys);
  return true;
}

// One-shot generation that auto-handles cached vs. inline based on the record shape.
async function generateForRecord({
  record,
  message,
  temperature = 0.8,
  maxOutputTokens = 1024,
}) {
  if (!record) throw new Error('generateForRecord: record required');
  if (!message) throw new Error('generateForRecord: message required');

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
