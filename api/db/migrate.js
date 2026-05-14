// Idempotent SQL migration runner.
//
// Reads every *.sql file in api/db/migrations/, sorted lexically, and applies
// any not yet recorded in the `schema_migrations` table. Each migration runs
// inside its own transaction.
//
// Invoked at API startup (src/index.js) before the HTTP listener binds, so the
// schema is guaranteed to be at HEAD by the time the first request lands.

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

async function applyMigration(filename) {
  const filepath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filepath, 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

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

module.exports = { run };
