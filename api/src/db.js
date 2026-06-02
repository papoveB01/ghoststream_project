// Postgres access layer with optional Row-Level Security (RLS) enforcement.
//
// Two roles / two pools:
//   - sysPool: the superuser/owner role (POSTGRES_USER). Owns the schema, so it
//     BYPASSES RLS. Used for migrations, boot, the scheduler, all public/system
//     paths, and superadmin (cross-tenant) requests.
//   - appPool: a restricted, non-owner role (DATABASE_APP_USER). Subject to RLS.
//     Used ONLY when RLS_ENFORCE=on AND a per-request tenant context is set.
//
// Per-request tenant context rides on AsyncLocalStorage (set by auth middleware
// via runWithTenant). When enforcing, each query runs inside its own short
// transaction that sets the `app.tenant_id` GUC the RLS policies read — the
// connection is released right after, so a slow handler never pins a txn.
//
// RLS_ENFORCE=off (default) → everything uses sysPool, behaviour identical to
// before RLS existed. Flipping the flag is the only cutover; rollback = off.

const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

const RLS_ENFORCE = String(process.env.RLS_ENFORCE || 'off').toLowerCase() === 'on';
const als = new AsyncLocalStorage();

let _sysPool;
let _appPool;

function poolConfig(user, password) {
  return {
    host: process.env.DATABASE_HOST || 'db',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    database: process.env.DATABASE_NAME,
    user,
    password,
    max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

function sysPool() {
  if (_sysPool) return _sysPool;
  _sysPool = new Pool(poolConfig(process.env.DATABASE_USER, process.env.DATABASE_PASSWORD));
  _sysPool.on('error', (err) => console.error('[pg:sys] idle client error:', err.message));
  return _sysPool;
}

function appPool() {
  if (_appPool) return _appPool;
  const user = process.env.DATABASE_APP_USER || 'ghoststream_app';
  const password = process.env.DATABASE_APP_PASSWORD || '';
  _appPool = new Pool(poolConfig(user, password));
  _appPool.on('error', (err) => console.error('[pg:app] idle client error:', err.message));
  return _appPool;
}

// Back-compat: legacy callers used getPool(); it's the system pool.
function getPool() { return sysPool(); }

// Run `fn` with a per-request tenant context (consumed by query/withTx when
// RLS is enforced). Set by auth middleware for non-superadmin tenant requests.
function runWithTenant(tenantId, fn) { return als.run({ tenantId }, fn); }
function currentTenant() { const s = als.getStore(); return s ? s.tenantId : null; }

// True when this query must go through the RLS-enforced appPool.
function enforcing() {
  if (!RLS_ENFORCE) return false;
  const s = als.getStore();
  return Boolean(s && s.tenantId);
}

async function query(text, params) {
  if (!enforcing()) return sysPool().query(text, params);
  const tenantId = als.getStore().tenantId;
  const client = await appPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await client.query(text, params);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

// Run `fn(client)` inside a transaction. Honors the RLS context (sets the GUC on
// the transaction when enforcing) so multi-statement units are tenant-scoped too.
async function withTx(fn) {
  const useApp = enforcing();
  const tenantId = useApp ? als.getStore().tenantId : null;
  const client = await (useApp ? appPool() : sysPool()).connect();
  try {
    await client.query('BEGIN');
    if (useApp) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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
  const r = await sysPool().query('SELECT 1 AS ok');
  return r.rows[0].ok === 1;
}

// Idempotently provision the restricted RLS role + grants (runs as superuser on
// sysPool, before migrations). Static SQL migrations can't read the password, so
// the role's credentials are synced here from the environment. Safe to call on
// every boot. The password is alphanumeric (generated) — inlined since ALTER
// ROLE ... PASSWORD is a utility statement that can't be parameterized.
async function ensureAppRole() {
  const user = process.env.DATABASE_APP_USER || 'ghoststream_app';
  const password = process.env.DATABASE_APP_PASSWORD || '';
  if (RLS_ENFORCE && !password) {
    throw new Error('RLS_ENFORCE=on but DATABASE_APP_PASSWORD is empty — set it or turn RLS_ENFORCE off.');
  }
  if (!password) {
    console.warn(`[rls] DATABASE_APP_PASSWORD not set — skipping restricted role '${user}' provisioning (RLS can't be enforced until set).`);
    return;
  }
  if (!/^[A-Za-z0-9]+$/.test(password)) {
    throw new Error('DATABASE_APP_PASSWORD must be alphanumeric (it is inlined into an ALTER ROLE statement).');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(user)) {
    throw new Error('DATABASE_APP_USER must be a plain identifier.');
  }
  const p = sysPool();
  await p.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN
      CREATE ROLE ${user} LOGIN;
    END IF;
  END $$;`);
  await p.query(`ALTER ROLE ${user} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
  await p.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
  await p.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${user}`);
  await p.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${user}`);
  await p.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${user}`);
  await p.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${user}`);
  console.log(`[rls] restricted role '${user}' ensured; enforcement is ${RLS_ENFORCE ? 'ON' : 'off'}.`);
}

module.exports = { getPool, query, withTx, ping, runWithTenant, currentTenant, ensureAppRole, RLS_ENFORCE };
