// User model — the per-individual login record. A user belongs to exactly one
// tenant (the organization). Passwords are bcrypt-hashed. The Founders tenant's
// admin is bootstrapped at app boot from ADMIN_EMAIL / ADMIN_PASSWORD so the
// pre-multitenancy .env credentials keep working as a platform superadmin.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Fixed UUID of the Founders tenant (seeded by migration 0007). Application
// code references this as a constant rather than re-querying by name.
const FOUNDERS_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

async function hashPassword(plain) {
  if (!plain || typeof plain !== 'string' || plain.length < 8) {
    const err = new Error('password must be at least 8 characters');
    err.status = 400; throw err;
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try { return await bcrypt.compare(plain, hash); }
  catch { return false; }
}

const PUBLIC_COLUMNS = `
  id, tenant_id, email, name, first_name, last_name, role, job_title, is_admin, email_verified,
  email_verified_at, last_login_at, created_at, updated_at
`;

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    jobTitle: row.job_title,
    isAdmin: row.is_admin,
    emailVerified: row.email_verified,
    emailVerifiedAt: row.email_verified_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findByEmail(email) {
  if (!email) return null;
  const r = await db.query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [String(email).trim()]
  );
  if (!r.rows[0]) return null;
  const u = rowToUser(r.rows[0]);
  u.passwordHash = r.rows[0].password_hash; // internal — never serialize
  return u;
}

async function findById(id) {
  if (!id) return null;
  const r = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rowToUser(r.rows[0]);
}

async function findByVerificationToken(token) {
  if (!token) return null;
  const r = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE email_verification_token = $1 LIMIT 1`,
    [token]
  );
  return rowToUser(r.rows[0]);
}

// Create a user. `passwordHash` must already be bcrypt-hashed (callers go
// through hashPassword first). Generates an email-verification token unless
// emailVerified is explicitly true.
async function create({ tenantId, email, passwordHash, name = null, firstName = null, lastName = null, role = 'owner', jobTitle = null, isAdmin = false, emailVerified = false }) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  if (!email)    { const e = new Error('email required');    e.status = 400; throw e; }
  if (!passwordHash) { const e = new Error('passwordHash required'); e.status = 400; throw e; }

  // Derive the display `name` from the parts when not given explicitly, so
  // existing consumers (sidebar, JWT) keep working off a single field.
  const first = firstName ? String(firstName).trim() : null;
  const last = lastName ? String(lastName).trim() : null;
  const displayName = name || [first, last].filter(Boolean).join(' ') || null;
  // job_title is the GTM role from onboarding (allow-list value), NOT the
  // tenancy `role` above.
  const job = jobTitle ? String(jobTitle).trim() : null;

  const token = emailVerified ? null : crypto.randomBytes(24).toString('hex');
  const r = await db.query(
    `INSERT INTO users
       (tenant_id, email, password_hash, name, first_name, last_name, role, job_title, is_admin, email_verified, email_verification_token, email_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $10 THEN now() ELSE NULL END)
     RETURNING ${PUBLIC_COLUMNS}, email_verification_token`,
    [tenantId, String(email).trim(), passwordHash, displayName, first, last, role, job, isAdmin, emailVerified, token]
  );
  const u = rowToUser(r.rows[0]);
  u.emailVerificationToken = r.rows[0].email_verification_token; // returned to caller for the email link
  return u;
}

async function touchLogin(id) {
  await db.query(`UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

async function markEmailVerified(id) {
  const r = await db.query(
    `UPDATE users
        SET email_verified = true, email_verified_at = now(),
            email_verification_token = NULL, updated_at = now()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [id]
  );
  return rowToUser(r.rows[0]);
}

async function setPassword(id, passwordHash) {
  await db.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [passwordHash, id]);
}

// Update a user's name. Keeps the derived display `name` ("First Last") in sync
// with the structured parts. Returns the updated public user.
async function updateProfile(id, { firstName, lastName }) {
  const first = firstName != null ? String(firstName).trim() : null;
  const last = lastName != null ? String(lastName).trim() : null;
  const name = [first, last].filter(Boolean).join(' ') || null;
  const r = await db.query(
    `UPDATE users SET first_name = $1, last_name = $2, name = $3, updated_at = now()
      WHERE id = $4
      RETURNING ${PUBLIC_COLUMNS}`,
    [first, last, name, id]
  );
  return rowToUser(r.rows[0]);
}

// Idempotent boot step: ensure the Founders tenant has an admin user matching
// ADMIN_EMAIL with ADMIN_PASSWORD's bcrypt hash. Runs after migrations, before
// the HTTP listener binds. If the row already exists we re-sync the password
// hash (so rotating ADMIN_PASSWORD in .env takes effect on restart) but leave
// everything else alone.
async function bootstrapFoundersAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('[users] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping Founders admin bootstrap');
    return null;
  }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const existing = await db.query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
  if (existing.rows[0]) {
    await db.query(
      `UPDATE users SET password_hash = $1, is_admin = true, email_verified = true,
                        email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
        WHERE id = $2`,
      [hash, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  const inserted = await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, is_admin, email_verified, email_verified_at)
     VALUES ($1,$2,$3,$4,'owner',true,true,now())
     RETURNING id`,
    [FOUNDERS_TENANT_ID, email, hash, 'Founders Admin']
  );
  console.log(`[users] bootstrapped Founders admin ${email}`);
  return inserted.rows[0].id;
}

module.exports = {
  FOUNDERS_TENANT_ID,
  hashPassword,
  verifyPassword,
  findByEmail,
  findById,
  findByVerificationToken,
  create,
  touchLogin,
  markEmailVerified,
  setPassword,
  updateProfile,
  bootstrapFoundersAdmin,
};
