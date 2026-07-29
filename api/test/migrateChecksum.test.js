// Regression tests for the checksum-drift check added to api/db/migrate.js.
//
// The rule being enforced (docs/claude/conventions.md, "Migrations"): "Never
// edit an applied migration — add a new numbered one." migrate.js already
// computed and stored a sha256 (sliced to 16 hex chars) for every applied
// migration in schema_migrations.checksum, but nothing ever compared it back
// against the file on disk — so an edited-in-place migration applied
// silently and the schema quietly drifted from what the file said. This
// fills that gap by recomputing the on-disk checksum for every already-
// applied migration on every boot and comparing it to what was recorded.
//
// There is NO Postgres in CI (see docs/claude/commands.md), so nothing here
// touches a real DB or even requires api/src/db — that module is only
// exercised by migrate.js's async DB-calling functions (fetchAppliedRows,
// verifyChecksums, run), none of which this file calls. What's tested is the
// pure decision logic migrate.js was deliberately split out for this reason:
//
//   checkMigrationIntegrity(recordedRows, onDiskChecksums)
//     -> classifies every schema_migrations row into exactly one of
//        { drift, missing, unknown } given what's computable from disk.
//   buildDriftMessage(driftEntries)
//     -> the human-facing failure text for the one case that fails boot
//        by default (a real content drift).
//   computeChecksum(sql)
//     -> the same hashing migrate.js uses to produce checksums at apply
//        time, so fixtures below can be built the same way real ones are.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { checkMigrationIntegrity, buildDriftMessage, computeChecksum } = require('../db/migrate');

describe('computeChecksum', () => {
  test('is deterministic and 16 hex chars (matches what migrate.js stores)', () => {
    const a = computeChecksum('CREATE TABLE foo (id text);');
    const b = computeChecksum('CREATE TABLE foo (id text);');
    assert.strictEqual(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test('differs for different content', () => {
    const a = computeChecksum('CREATE TABLE foo (id text);');
    const b = computeChecksum('CREATE TABLE foo (id text, name text);');
    assert.notStrictEqual(a, b);
  });
});

describe('checkMigrationIntegrity', () => {
  test('matching checksums for every recorded migration produce no findings at all', () => {
    const sqlA = 'CREATE TABLE a (id text);';
    const sqlB = 'CREATE TABLE b (id text);';
    const recorded = [
      { filename: '0001_a.sql', checksum: computeChecksum(sqlA) },
      { filename: '0002_b.sql', checksum: computeChecksum(sqlB) },
    ];
    const onDisk = {
      '0001_a.sql': computeChecksum(sqlA),
      '0002_b.sql': computeChecksum(sqlB),
    };

    const result = checkMigrationIntegrity(recorded, onDisk);
    assert.deepStrictEqual(result, { drift: [], missing: [], unknown: [] });
  });

  test('a checksum mismatch (edited-in-place migration) is reported as drift, with both checksums', () => {
    const originalSql = 'CREATE TABLE users (id text);';
    const editedSql = 'CREATE TABLE users (id text, email text);'; // edited after being applied
    const recorded = [{ filename: '0010_users.sql', checksum: computeChecksum(originalSql) }];
    const onDisk = { '0010_users.sql': computeChecksum(editedSql) };

    const result = checkMigrationIntegrity(recorded, onDisk);
    assert.strictEqual(result.missing.length, 0);
    assert.strictEqual(result.unknown.length, 0);
    assert.strictEqual(result.drift.length, 1);
    assert.deepStrictEqual(result.drift[0], {
      filename: '0010_users.sql',
      recordedChecksum: computeChecksum(originalSql),
      onDiskChecksum: computeChecksum(editedSql),
    });
  });

  test('a recorded migration whose file no longer exists on disk is classified as missing, not drift', () => {
    // onDiskChecksums simply has no entry for this filename — same as
    // verifyChecksums() would produce when fs.existsSync() is false for it.
    const recorded = [{ filename: '0005_deleted.sql', checksum: 'abc123abc123abcd' }];
    const onDisk = {};

    const result = checkMigrationIntegrity(recorded, onDisk);
    assert.strictEqual(result.drift.length, 0, 'a missing file must never be reported as drift (nothing to hard-fail boot over)');
    assert.strictEqual(result.unknown.length, 0);
    assert.deepStrictEqual(result.missing, [{ filename: '0005_deleted.sql', recordedChecksum: 'abc123abc123abcd' }]);
  });

  test('a NULL recorded checksum is classified as unknown, not drift, even though the file still exists', () => {
    const sql = 'CREATE TABLE legacy (id text);';
    const recorded = [{ filename: '0002_legacy.sql', checksum: null }];
    const onDisk = { '0002_legacy.sql': computeChecksum(sql) };

    const result = checkMigrationIntegrity(recorded, onDisk);
    assert.strictEqual(result.drift.length, 0, 'an unverifiable historical row must never be reported as drift');
    assert.strictEqual(result.missing.length, 0);
    assert.deepStrictEqual(result.unknown, [{ filename: '0002_legacy.sql', onDiskChecksum: computeChecksum(sql) }]);
  });

  test('an empty-string recorded checksum is treated the same as NULL (unknown)', () => {
    const sql = 'CREATE TABLE legacy2 (id text);';
    const recorded = [{ filename: '0003_legacy2.sql', checksum: '' }];
    const onDisk = { '0003_legacy2.sql': computeChecksum(sql) };

    const result = checkMigrationIntegrity(recorded, onDisk);
    assert.strictEqual(result.drift.length, 0);
    assert.strictEqual(result.unknown.length, 1);
    assert.strictEqual(result.unknown[0].filename, '0003_legacy2.sql');
  });

  test('a realistic mixed batch sorts every row into exactly the right bucket, independently', () => {
    const okSql = 'CREATE TABLE ok (id text);';
    const driftedOriginal = 'CREATE TABLE drifted (id text);';
    const driftedEdited = 'CREATE TABLE drifted (id text, extra text);';

    const recorded = [
      { filename: '0001_ok.sql', checksum: computeChecksum(okSql) },
      { filename: '0002_drifted.sql', checksum: computeChecksum(driftedOriginal) },
      { filename: '0003_gone.sql', checksum: 'deadbeefdeadbeef' },
      { filename: '0004_null_checksum.sql', checksum: null },
    ];
    const onDisk = {
      '0001_ok.sql': computeChecksum(okSql),
      '0002_drifted.sql': computeChecksum(driftedEdited),
      // 0003_gone.sql intentionally absent — deleted/renamed file
      '0004_null_checksum.sql': computeChecksum('CREATE TABLE whatever (id text);'),
    };

    const result = checkMigrationIntegrity(recorded, onDisk);
    assert.deepStrictEqual(result.drift.map((d) => d.filename), ['0002_drifted.sql']);
    assert.deepStrictEqual(result.missing.map((m) => m.filename), ['0003_gone.sql']);
    assert.deepStrictEqual(result.unknown.map((u) => u.filename), ['0004_null_checksum.sql']);
  });

  test('an empty recorded set (fresh/pristine inputs) produces no findings', () => {
    const result = checkMigrationIntegrity([], {});
    assert.deepStrictEqual(result, { drift: [], missing: [], unknown: [] });
  });
});

describe('buildDriftMessage', () => {
  test('names the file and both checksums, and tells the operator what to do instead', () => {
    const msg = buildDriftMessage([
      { filename: '0010_users.sql', recordedChecksum: 'aaaaaaaaaaaaaaaa', onDiskChecksum: 'bbbbbbbbbbbbbbbb' },
    ]);
    assert.match(msg, /0010_users\.sql/);
    assert.match(msg, /aaaaaaaaaaaaaaaa/);
    assert.match(msg, /bbbbbbbbbbbbbbbb/);
    assert.match(msg, /new numbered migration/i);
    assert.match(msg, /MIGRATE_ALLOW_CHECKSUM_DRIFT/);
  });

  test('lists every drifted file when there is more than one', () => {
    const msg = buildDriftMessage([
      { filename: '0001_a.sql', recordedChecksum: '1111111111111111', onDiskChecksum: '2222222222222222' },
      { filename: '0002_b.sql', recordedChecksum: '3333333333333333', onDiskChecksum: '4444444444444444' },
    ]);
    assert.match(msg, /0001_a\.sql/);
    assert.match(msg, /0002_b\.sql/);
    assert.match(msg, /2 applied migration/);
  });
});
