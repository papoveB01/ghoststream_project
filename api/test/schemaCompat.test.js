// Gemini-dialect → Anthropic-strict schema translation (ADR-0006).
//
// The two incompatibilities this pins were both established against the live
// API on 2026-08-05 (claude-haiku-4-5); the constants are documented in
// src/schemaCompat.js. Only one of them is loud. The other — `nullable` on a
// non-object node — is accepted and ignored, so nothing fails and the model
// simply stops being able to say "there wasn't one". That is the case most of
// these tests are about.

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { toAnthropicSchema, inspect } = require('../src/schemaCompat.js');

// The last test builds the real production schemas, which transitively loads
// modules that open a Redis client. Without this the suite passes and then
// hangs on an open handle — same reason routeContract.test.js does it.
after(() => {
  try { require('../src/redis.js').disconnect(); } catch { /* best-effort */ }
});

// ── the 400: additionalProperties ───────────────────────────────────────────

test('every object node is sealed, at every depth', () => {
  const out = toAnthropicSchema({
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: { inner: { type: 'object', properties: { a: { type: 'string' } } } },
        },
      },
    },
  });
  assert.strictEqual(out.additionalProperties, false);
  assert.strictEqual(out.properties.rows.items.additionalProperties, false);
  assert.strictEqual(out.properties.rows.items.properties.inner.additionalProperties, false);
  assert.strictEqual(out.properties.rows.additionalProperties, undefined,
    'an array is not an object — sealing it would be a schema the validator rejects');
});

test('a node that declares properties but no type is still an object', () => {
  // Not hypothetical: this is the shape a hand-written sub-schema most often
  // takes, and the validator judges it an object regardless of our opinion.
  const out = toAnthropicSchema({ properties: { a: { type: 'string' } } });
  assert.strictEqual(out.additionalProperties, false);
});

test('an explicit additionalProperties is never overwritten', () => {
  const out = toAnthropicSchema({ type: 'object', additionalProperties: true, properties: {} });
  assert.strictEqual(out.additionalProperties, true,
    'the schema stated its intent; silently reversing it would be a different contract');
});

test('translation is idempotent', () => {
  const once = toAnthropicSchema({
    type: 'object',
    properties: { a: { type: 'string', nullable: true } },
    required: ['a'],
  });
  assert.deepStrictEqual(toAnthropicSchema(once), once,
    'a schema may pass through a wrapper more than once — the second pass must be a no-op');
});

// ── the silent one: nullable ────────────────────────────────────────────────

test('nullable becomes a null union, for every node type', () => {
  const out = toAnthropicSchema({
    type: 'object',
    properties: {
      obj: { type: 'object', nullable: true, properties: { q: { type: 'string' } } },
      arr: { type: 'array', nullable: true, items: { type: 'integer' } },
      str: { type: 'string', nullable: true },
    },
    required: ['obj', 'arr', 'str'],
  });
  assert.deepStrictEqual(out.properties.obj.type, ['object', 'null']);
  assert.deepStrictEqual(out.properties.arr.type, ['array', 'null']);
  assert.deepStrictEqual(out.properties.str.type, ['string', 'null']);
  for (const k of ['obj', 'arr', 'str']) {
    assert.strictEqual(out.properties[k].nullable, undefined,
      'nullable must not survive: on an object node it is a 400, elsewhere it is ignored');
  }
});

test('a nullable enum becomes anyOf, not a union type', () => {
  // companies.js buildProductFitSchema — productId is one of OUR ids or null,
  // and "or null" is the branch that stops the model guessing a product.
  //
  // The union spelling is a 400 for an enum ("Enum value 'a' does not match
  // declared type '['string','null']'"), and so is adding null to the enum
  // list. Not hypothetical: the live smoke check rejected three real schemas on
  // exactly this the first time it ran. See schemaCompat.js for all four probed
  // spellings.
  const out = toAnthropicSchema({
    type: 'object',
    properties: {
      productId: { type: 'string', enum: ['a', 'b'], nullable: true, description: 'null when none maps' },
    },
    required: ['productId'],
  });
  const p = out.properties.productId;
  assert.deepStrictEqual(p.anyOf, [{ enum: ['a', 'b'], type: 'string' }, { type: 'null' }]);
  assert.strictEqual(p.type, undefined);
  assert.strictEqual(p.enum, undefined);
  assert.strictEqual(p.description, 'null when none maps',
    'the description must stay on the outer node — it is where the model reads why null is allowed');
});

test('a nullable enum stays stable across a second pass', () => {
  const once = toAnthropicSchema({ type: 'string', enum: ['a'], nullable: true });
  assert.deepStrictEqual(toAnthropicSchema(once), once);
});

test('nullable:false is removed without touching the type', () => {
  const out = toAnthropicSchema({ type: 'object', properties: { a: { type: 'string', nullable: false } } });
  assert.strictEqual(out.properties.a.nullable, undefined);
  assert.strictEqual(out.properties.a.type, 'string');
});

test('an already-union type is not double-unioned', () => {
  const out = toAnthropicSchema({ type: ['string', 'null'], nullable: true });
  assert.deepStrictEqual(out.type, ['string', 'null']);
});

test('nullable with no type is reported, not silently dropped', () => {
  const { warnings } = inspect({ type: 'object', properties: { a: { nullable: true, description: 'x' } } });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /\$\.a/);
  assert.match(warnings[0], /cannot be null/,
    'dropping nullable here is exactly the silent semantic loss this module exists to prevent');
});

// ── not mutating the caller's constant ──────────────────────────────────────

test('the input schema is never modified', () => {
  // Load-bearing: every call site passes a module-level constant that the
  // Gemini path still sends. Mutating it in place would rewrite the Gemini
  // contract from an Anthropic call site, in a way no test on either side
  // would catch.
  const original = {
    type: 'object',
    properties: { a: { type: 'string', nullable: true } },
    required: ['a'],
  };
  const snapshot = JSON.parse(JSON.stringify(original));
  const out = toAnthropicSchema(original);
  assert.deepStrictEqual(original, snapshot);
  assert.notStrictEqual(out, original);
  assert.notStrictEqual(out.properties.a, original.properties.a, 'nested nodes must be copies too');
});

// ── everything else passes through ──────────────────────────────────────────

test('unrecognised keywords are carried through, not dropped', () => {
  const out = toAnthropicSchema({
    type: 'object',
    properties: { a: { type: 'string', minLength: 2, pattern: '^x', description: 'keep me' } },
    required: ['a'],
    title: 'T',
  });
  assert.strictEqual(out.properties.a.minLength, 2);
  assert.strictEqual(out.properties.a.pattern, '^x');
  assert.strictEqual(out.properties.a.description, 'keep me');
  assert.strictEqual(out.title, 'T');
  assert.deepStrictEqual(out.required, ['a']);
});

test('subschemas under combinators are converted too', () => {
  const out = toAnthropicSchema({
    anyOf: [
      { type: 'object', properties: { a: { type: 'string', nullable: true } } },
      { type: 'string' },
    ],
  });
  assert.strictEqual(out.anyOf[0].additionalProperties, false);
  assert.deepStrictEqual(out.anyOf[0].properties.a.type, ['string', 'null']);
});

test('a non-schema argument comes back untouched', () => {
  assert.strictEqual(toAnthropicSchema(null), null);
  assert.strictEqual(toAnthropicSchema(undefined), undefined);
});

// ── the real schemas ────────────────────────────────────────────────────────

test('every registered production schema translates without losing meaning', () => {
  const { ENTRIES } = require('./live/schemas.js');
  const problems = [];
  for (const entry of ENTRIES) {
    const { schema, warnings } = inspect(entry.schema());
    if (warnings.length) problems.push(`${entry.site}: ${warnings.join('; ')}`);
    // The 400 condition, checked structurally so it does not need the network.
    const unsealed = [];
    (function walk(node, p) {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${p}[${i}]`));
      if (!node || typeof node !== 'object') return;
      const isObj = node.type === 'object'
        || (Array.isArray(node.type) && node.type.includes('object'))
        || (node.type === undefined && node.properties !== undefined);
      if (isObj && node.additionalProperties === undefined) unsealed.push(p);
      if (node.nullable !== undefined) problems.push(`${entry.site}: nullable survived at ${p}`);
      for (const [k, v] of Object.entries(node)) {
        if (k === 'properties' || k === '$defs') for (const [n, sub] of Object.entries(v)) walk(sub, `${p}.${n}`);
        else if (k === 'items' || k === 'not') walk(v, `${p}.${k}`);
        else if (Array.isArray(v) && ['anyOf', 'oneOf', 'allOf'].includes(k)) v.forEach((sub, i) => walk(sub, `${p}.${k}[${i}]`));
      }
    })(schema, '$');
    if (unsealed.length) problems.push(`${entry.site}: unsealed object at ${unsealed.join(', ')}`);
  }
  assert.deepStrictEqual(problems, [],
    'each of these would be a 400 or a silent semantics change on the first request after ' +
    'that task is flipped to Anthropic:\n  ' + problems.join('\n  '));
});
