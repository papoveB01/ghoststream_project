// The normalised-title guard that backs up watch_findings' dedup_key.
//
// dedup_key hashes `scope|subject|url` — or the raw lowercased title when there
// is no url. So the SAME headline syndicated to a second outlet gets a different
// url, hence a different key, and lands again as a "new" development. The guard
// in runEntity compares semantics.normalizeForMatch(title) against the recent
// window before inserting.
//
// This locks the boundary of that guard in BOTH directions, because a
// title-dedupe that is too eager silently swallows real developments — which
// would be worse than the duplicate it prevents. Genuine rewordings are
// deliberately NOT caught here; that is the model's job, which is why the prompt
// now sees a 180-day window instead of a flat 40 titles.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeForMatch } = require('../src/semantics');

const sameKey = (a, b) => normalizeForMatch(a) === normalizeForMatch(b);

test('catches the syndication variants dedup_key misses', () => {
  const original = 'Northwind Pay raises $40m Series C';
  assert.ok(sameKey(original, 'NORTHWIND PAY RAISES $40M SERIES C'), 'case');
  assert.ok(sameKey(original, 'Northwind Pay raises $40m, Series C'), 'punctuation');
  assert.ok(sameKey(original, 'Northwind  Pay   raises $40m Series C'), 'collapsed whitespace');
  assert.ok(sameKey(original, 'Northwind Pay raises $40m — Series C'), 'em dash');
  assert.ok(sameKey(original, '“Northwind Pay raises $40m Series C”'), 'smart quotes');
});

test('does NOT collapse genuinely different developments', () => {
  const funding = 'Northwind Pay raises $40m Series C';
  assert.ok(!sameKey(funding, 'Northwind Pay raises $12m Series B'),
    'a different round is a different development — the amounts must keep them apart');
  assert.ok(!sameKey(funding, 'Northwind Pay appoints Dana Reed as CTO'),
    'a leadership change is not a funding round');
  assert.ok(!sameKey('Northwind Pay enters Kenya', 'Northwind Pay enters Nigeria'),
    'different market entries stay distinct');
});

test('a genuine reword is knowingly NOT caught — that is the model\'s job', () => {
  // Documenting the limit rather than pretending the guard is smarter than it
  // is. Catching this needs embeddings on watch_findings and a migration.
  assert.ok(!sameKey('Northwind appoints Dana Reed as CTO',
                     'Northwind names Dana Reed chief technology officer'),
    'string normalisation cannot see synonymy; the widened prompt window is what addresses this');
});

test('empty and whitespace-only titles produce no key, so they cannot false-match', () => {
  // runEntity guards on a falsy key before consulting the set — otherwise every
  // untitled finding would collide with every other one.
  assert.strictEqual(normalizeForMatch(''), '');
  assert.strictEqual(normalizeForMatch('   '), '');
  assert.strictEqual(normalizeForMatch('!!! ---'), '', 'punctuation-only normalises to nothing');
});
