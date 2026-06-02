// Application-layer encryption for secrets at rest (third-party OAuth/API
// tokens stored in Redis/Postgres). AES-256-GCM with a per-value random IV.
//
// Envelope format (a self-describing string): `enc:v1:<iv>:<tag>:<ciphertext>`,
// each part base64. `open()` passes through anything that ISN'T an enc:v1
// envelope unchanged — so pre-existing plaintext values keep working and get
// re-encrypted the next time they're written (transparent, zero-downtime
// migration). The key comes from ENCRYPTION_KEY (any string; sha256-derived to
// 32 bytes). With no key set, seal() is a no-op passthrough and a warning is
// logged once — the app keeps working, just without at-rest encryption.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const RAW = process.env.ENCRYPTION_KEY || '';
const KEY = RAW ? crypto.createHash('sha256').update(RAW).digest() : null;

let _warned = false;
function warnOnce() {
  if (_warned) return;
  _warned = true;
  console.warn('[secretbox] ENCRYPTION_KEY not set — secrets are stored UNENCRYPTED at rest. Set ENCRYPTION_KEY to enable.');
}

function isEnabled() { return Boolean(KEY); }

// Encrypt a string. Returns an enc:v1 envelope, or the input unchanged when no
// key is configured / input isn't a non-empty string.
function seal(plaintext) {
  if (plaintext == null || typeof plaintext !== 'string' || plaintext === '') return plaintext;
  if (!KEY) { warnOnce(); return plaintext; }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}

// Decrypt an enc:v1 envelope. Non-envelope values (legacy plaintext, null) are
// returned unchanged. Throws only if an envelope is malformed or fails auth —
// i.e. real tampering or a wrong/rotated key.
function open(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  if (!KEY) throw new Error('[secretbox] encrypted value present but ENCRYPTION_KEY not set');
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('[secretbox] malformed envelope');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Convenience: encrypt/decrypt a JSON-serializable object as one sealed string.
function sealJson(obj) { return seal(JSON.stringify(obj)); }
function openJson(value) {
  const s = open(value);
  return typeof s === 'string' ? JSON.parse(s) : s;
}

module.exports = { isEnabled, seal, open, sealJson, openJson };
