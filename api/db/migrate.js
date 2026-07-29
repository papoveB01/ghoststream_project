// Idempotent SQL migration runner.
//
// Reads every *.sql file in api/db/migrations/, sorted lexically, and applies
// any not yet recorded in the `schema_migrations` table. Each migration runs
// inside its own transaction.
//
// Invoked at API startup (src/index.js) before the HTTP listener binds, so the
// schema is guaranteed to be at HEAD by the time the first request lands.
//
// Checksum verification (this is the enforcement mechanism for the
// non-negotiable rule in docs/claude/conventions.md: "Never edit an applied
// migration — add a new numbered one"):
//
// Every applied migration's sha256 (16 hex chars) is stored in
// schema_migrations.checksum at apply time — but until now nothing ever read
// it back. That means editing an already-applied .sql file in place applied
// silently: the live schema and the file on disk quietly diverge, with no
// signal anywhere, until someone is debugging a "works on my machine" schema
// mismatch months later. On every boot we now recompute the checksum of every
// *already-applied* migration from the file on disk and compare it to the
// stored value. A mismatch throws and refuses to boot — the schema's history
// must match the code's history, always.
//
// Two things are deliberately NOT treated as that violation, because neither
// one is "this file's content changed under an applied row":
//   - the file for an applied row no longer exists on disk (renamed/deleted/
//     squashed history, a sparse checkout, etc.) — there is nothing to
//     recompute against, so this is unverifiable, not proven-drifted. Given
//     this code runs on every boot including production, failing boot over a
//     condition that doesn't actually prove drift would be worse than the bug
//     it prevents. WARN loudly and continue.
//   - a recorded checksum that is NULL/empty (e.g. a row inserted by hand
//     outside applyMigration(), or future schema changes to this table) — again
//     nothing to compare against. WARN and skip.
// Both warnings are permanent, not escape-hatched — they're not the failure
// mode this check exists to catch, so there's nothing to "allow past".
//
// Escape hatch: MIGRATE_ALLOW_CHECKSUM_DRIFT=1 downgrades an actual drift
// (checksum mismatch on a file that DOES exist) from a thrown error to a loud
// console.warn, so a real incident can boot past this without editing code
// under pressure. It is not silent — every drifted file is still printed.
// This must never be set in normal operation; it exists for the minutes
// between "prod won't boot" and "we understand why and have reconciled it".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationTable() {
  // pgvector is also ensured here so brownfield deploys (existing data volume
  // that never ran db/init/001_extension.sql) still get the extension.
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function appliedSet() {
  const r = await db.query('SELECT filename FROM schema_migrations');
  return new Set(r.rows.map((row) => row.filename));
}

// Same algorithm used both when a migration is first applied and whenever we
// later re-verify it — pulled into one function so the two can never quietly
// diverge (which would either false-positive every row as "drifted" or make
// the check a no-op).
function computeChecksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

// Pure decision logic for the checksum check: given what's recorded as
// applied and what checksum (if any) is computable from the file currently on
// disk for each, classify every recorded row into exactly one bucket. No I/O
// here — this is what api/test/migrateChecksum.test.js exercises directly,
// since there's no Postgres in CI to run the real thing against.
//
//   recordedRows:     [{ filename, checksum }, ...]        (from schema_migrations)
//   onDiskChecksums:  { [filename]: checksum }              (only for files that still exist)
function checkMigrationIntegrity(recordedRows, onDiskChecksums) {
  const drift = [];
  const missing = [];
  const unknown = [];

  for (const row of recordedRows) {
    const { filename, checksum: recordedChecksum } = row;
    const fileExists = Object.prototype.hasOwnProperty.call(onDiskChecksums, filename);

    if (!fileExists) {
      missing.push({ filename, recordedChecksum });
      continue;
    }

    const onDiskChecksum = onDiskChecksums[filename];

    if (!recordedChecksum) {
      unknown.push({ filename, onDiskChecksum });
      continue;
    }

    if (recordedChecksum !== onDiskChecksum) {
      drift.push({ filename, recordedChecksum, onDiskChecksum });
    }
  }

  return { drift, missing, unknown };
}

// Builds the message for the one case that fails boot by default: a migration
// whose file content no longer matches what was applied. Pure/testable so the
// wording (which file, both checksums, what to do instead) is locked down
// without needing a DB.
function buildDriftMessage(driftEntries) {
  const details = driftEntries
    .map((d) => `  - ${d.filename}: recorded=${d.recordedChecksum} onDisk=${d.onDiskChecksum}`)
    .join('\n');
  return (
    `[migrate] CHECKSUM DRIFT: ${driftEntries.length} applied migration(s) were edited on disk after being applied:\n${details}\n` +
    'This violates "never edit an applied migration — add a new numbered one" (docs/claude/conventions.md): ' +
    'the live schema no longer matches what this file says it does, silently.\n' +
    'Fix: revert the file(s) above and express the change as a NEW numbered migration instead.\n' +
    'If the edit was truly intentional and this exact content has already been applied identically on every ' +
    'environment that matters, reconcile the row deliberately (e.g. `UPDATE schema_migrations SET checksum = ' +
    "'<new checksum>' WHERE filename = '<file>'`) — do not do this to paper over an environment that is actually out of sync.\n" +
    'Escape hatch to unblock boot mid-incident (does not silence the warning, only stops it failing boot): set MIGRATE_ALLOW_CHECKSUM_DRIFT=1.'
  );
}

async function fetchAppliedRows() {
  const r = await db.query('SELECT filename, checksum FROM schema_migrations');
  return r.rows;
}

// Recomputes the on-disk checksum for every already-applied migration and
// compares it to what was recorded at apply time. See the module header for
// why "file missing" and "checksum unknown" are warnings, not failures, and
// what MIGRATE_ALLOW_CHECKSUM_DRIFT does.
async function verifyChecksums() {
  const recorded = await fetchAppliedRows();
  if (recorded.length === 0) return; // fresh DB, nothing applied yet to verify

  const onDiskChecksums = {};
  for (const row of recorded) {
    const filepath = path.join(MIGRATIONS_DIR, row.filename);
    if (fs.existsSync(filepath)) {
      onDiskChecksums[row.filename] = computeChecksum(fs.readFileSync(filepath, 'utf8'));
    }
  }

  const { drift, missing, unknown } = checkMigrationIntegrity(recorded, onDiskChecksums);

  for (const m of missing) {
    console.warn(
      `[migrate] WARNING: applied migration ${m.filename} (recorded checksum ${m.recordedChecksum || '(none)'}) ` +
      'no longer exists on disk — cannot verify it hasn\'t drifted. Not failing boot for this alone; ' +
      'if this is unexpected, restore the file or reconcile schema_migrations deliberately.'
    );
  }
  for (const u of unknown) {
    console.warn(
      `[migrate] WARNING: applied migration ${u.filename} has no recorded checksum (NULL/empty) — skipping ` +
      `drift verification for it (on-disk checksum is ${u.onDiskChecksum}, unverified against apply time).`
    );
  }

  if (drift.length > 0) {
    const message = buildDriftMessage(drift);
    if (String(process.env.MIGRATE_ALLOW_CHECKSUM_DRIFT || '') === '1') {
      console.warn(`${message}\n[migrate] MIGRATE_ALLOW_CHECKSUM_DRIFT=1 set — continuing boot despite drift.`);
    } else {
      throw new Error(message);
    }
  }
}

async function applyMigration(filename) {
  const filepath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filepath, 'utf8');
  const checksum = computeChecksum(sql);

  await db.withTx(async (client) => {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [filename, checksum]
    );
  });
  console.log(`[migrate] applied ${filename} (${checksum})`);
}

async function run() {
  await ensureMigrationTable();
  // Verify BEFORE applying anything new: if an already-applied file drifted,
  // we want to refuse to boot on that fact alone, not mask it by also having
  // applied new, unrelated migrations in the same run.
  await verifyChecksums();
  const applied = await appliedSet();
  const files = listMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`[migrate] up to date (${files.length} applied)`);
    return;
  }

  console.log(`[migrate] applying ${pending.length} pending migration(s)`);
  for (const f of pending) await applyMigration(f);
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err.message);
      process.exit(1);
    });
}

module.exports = { run, checkMigrationIntegrity, buildDriftMessage, computeChecksum };
