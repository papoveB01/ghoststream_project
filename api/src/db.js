// Postgres pool — used for the Knowledge Base (kb_documents / kb_chunks /
// kb_global_cache). Redis remains the runtime store for meetings / portals /
// arena sessions; Postgres is durable storage for the RAG layer.

const { Pool } = require('pg');

let _pool;

function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    host: process.env.DATABASE_HOST || 'db',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  _pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  return _pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Run `fn(client)` inside a transaction. Rolls back on throw.
async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  const r = await query('SELECT 1 AS ok');
  return r.rows[0].ok === 1;
}

module.exports = { getPool, query, withTx, ping };
