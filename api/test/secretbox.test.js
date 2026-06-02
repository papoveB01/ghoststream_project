// Unit tests for the at-rest encryption envelope (secretbox.js). Pure crypto —
// no external services. Key is set before require so the module picks it up.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-not-a-real-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const secretbox = require('../src/secretbox');

test('seal produces an enc:v1 envelope and open round-trips', () => {
  const sealed = secretbox.seal('hello world');
  assert.ok(sealed.startsWith('enc:v1:'), 'has envelope prefix');
  assert.strictEqual(secretbox.open(sealed), 'hello world');
});

test('sealJson/openJson round-trip an object', () => {
  const obj = { accessToken: 'abc.def', refreshToken: 'r-1', n: 42 };
  assert.deepStrictEqual(secretbox.openJson(secretbox.sealJson(obj)), obj);
});

test('open passes legacy plaintext through unchanged (backward compat)', () => {
  assert.strictEqual(secretbox.open('not-encrypted'), 'not-encrypted');
  assert.deepStrictEqual(secretbox.openJson('{"a":1}'), { a: 1 });
});

test('tampered ciphertext fails authentication (throws)', () => {
  const sealed = secretbox.seal('secret');
  const tampered = sealed.slice(0, -4) + 'AAAA';
  assert.throws(() => secretbox.open(tampered));
});

test('encryption is enabled and non-deterministic (random IV)', () => {
  assert.strictEqual(secretbox.isEnabled(), true);
  assert.notStrictEqual(secretbox.seal('x'), secretbox.seal('x'));
});

test('seal is a no-op for non-strings / empties', () => {
  assert.strictEqual(secretbox.seal(''), '');
  assert.strictEqual(secretbox.seal(null), null);
});
