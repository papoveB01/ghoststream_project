// Thin HTTP wrapper around the GhostStream API.
// Sole responsibility: inject auth + X-Client header, enforce a per-call
// timeout, and surface HTTP errors with their status code attached.
//
// State lives entirely in env vars (read once at module load); no
// module-level caches, no persistent connections, no retry logic — the
// caller decides retry policy.

const PKG = require('../package.json');

const API_URL = (process.env.GHOSTSTREAM_API_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.GHOSTSTREAM_API_TOKEN || '';
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.GHOSTSTREAM_TIMEOUT_MS || '15000', 10));
const CLIENT_NAME = (process.env.GHOSTSTREAM_CLIENT_NAME || `${PKG.name}/${PKG.version}`).slice(0, 100);

async function postJson(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Client': CLIENT_NAME,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const err = new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error(`request timeout after ${TIMEOUT_MS}ms`);
      e.status = 0;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { postJson, API_URL, CLIENT_NAME, TIMEOUT_MS };
