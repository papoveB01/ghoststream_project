// Companies — per-tenant prospect lookup for mission scheduling. Every query
// is scoped by tenant_id (the "Data Firewall"): a company id from another
// tenant is invisible (returns 404), and name uniqueness is per-tenant.
//
// All service fns take `tenantId` as the first arg; the router passes
// `req.tenantId` (set by authMiddleware from the JWT).

const express = require('express');
const db = require('./db');
const web = require('./knowledge/web');
const discovery = require('./knowledge/discovery');
const gating = require('./gating');
const auth = require('./auth');

// Strip protocol / www / path → bare host, for comparing a prospect domain
// against the tenant's own domain.
function bareHost(d) {
  return String(d || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .split('/')[0].split('?')[0].split('#')[0];
}

// Refuse to register a "prospect" that's actually the tenant's own company —
// the tenant's company lives in the tenants row, not the companies (prospect)
// table. Only checked when a domain is supplied on both sides.
async function assertNotOwnCompany(tenantId, domain) {
  const host = bareHost(domain);
  if (!host) return;
  const r = await db.query(`SELECT domain FROM tenants WHERE id = $1`, [tenantId]);
  const ownHost = bareHost(r.rows[0] && r.rows[0].domain);
  if (ownHost && host === ownHost) {
    const e = new Error("that's your own company — it belongs in your workspace profile, not your prospect list");
    e.status = 422; e.code = 'OWN_COMPANY';
    throw e;
  }
}

async function list(tenantId) {
  const r = await db.query(
    `SELECT id, name, domain, primary_contact, notes, country, city, address, phone, email, watch_enabled, created_at,
            (SELECT COUNT(*)::int FROM scheduled_meetings
              WHERE company_id = c.id AND tenant_id = $1) AS meeting_count
       FROM companies c
      WHERE c.tenant_id = $1
      ORDER BY lower(c.name)`,
    [tenantId]
  );
  return r.rows;
}

async function get(tenantId, id) {
  const r = await db.query(
    `SELECT * FROM companies WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return r.rows[0] || null;
}

async function create(tenantId, { name, domain, primaryContact, notes, country, city, address, phone, email }) {
  await assertNotOwnCompany(tenantId, domain);
  const r = await db.query(
    `INSERT INTO companies (tenant_id, name, domain, primary_contact, notes, country, city, address, phone, email)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tenantId, name, domain || null, primaryContact || null, notes || null,
     country || null, city || null, address || null, phone || null, email || null]
  );
  return r.rows[0];
}

// Find by case-insensitive name within the tenant, OR create. First-write-wins
// on domain (fills it in if the existing row had none).
async function findOrCreate(tenantId, { name, domain, primaryContact, country, city, address, phone, email }) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  if (!name || typeof name !== 'string') {
    const err = new Error('company name required'); err.status = 400; throw err;
  }
  const existing = await db.query(
    `SELECT * FROM companies WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [tenantId, name.trim()]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (!row.domain && domain) {
      await db.query(
        `UPDATE companies SET domain = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3`,
        [domain, row.id, tenantId]
      );
      row.domain = domain;
    }
    return row;
  }
  return create(tenantId, { name: name.trim(), domain, primaryContact, country, city, address, phone, email });
}

// Find a tenant's company by website domain (host part). Used by onboarding +
// the Snap autofill. Returns null if none.
async function findByDomain(tenantId, domain) {
  if (!tenantId || !domain) return null;
  const host = String(domain).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  const r = await db.query(
    `SELECT * FROM companies WHERE tenant_id = $1 AND lower(domain) = $2 LIMIT 1`,
    [tenantId, host]
  );
  return r.rows[0] || null;
}

async function update(tenantId, id, { name, domain, primaryContact, notes, country, city, address, phone, email, watchEnabled }) {
  if (domain !== undefined) await assertNotOwnCompany(tenantId, domain);
  const sets = [];
  const params = [];
  if (name !== undefined)           { params.push(name);           sets.push(`name = $${params.length}`); }
  if (domain !== undefined)         { params.push(domain);         sets.push(`domain = $${params.length}`); }
  if (primaryContact !== undefined) { params.push(primaryContact); sets.push(`primary_contact = $${params.length}`); }
  if (notes !== undefined)          { params.push(notes);          sets.push(`notes = $${params.length}`); }
  if (country !== undefined)        { params.push(country);        sets.push(`country = $${params.length}`); }
  if (city !== undefined)           { params.push(city);           sets.push(`city = $${params.length}`); }
  if (address !== undefined)        { params.push(address);        sets.push(`address = $${params.length}`); }
  if (phone !== undefined)          { params.push(phone);          sets.push(`phone = $${params.length}`); }
  if (email !== undefined)          { params.push(email);          sets.push(`email = $${params.length}`); }
  if (watchEnabled !== undefined)   { params.push(!!watchEnabled);  sets.push(`watch_enabled = $${params.length}`); }
  if (sets.length === 0) return get(tenantId, id);
  sets.push(`updated_at = now()`);
  params.push(id);
  params.push(tenantId);
  const r = await db.query(
    `UPDATE companies SET ${sets.join(', ')}
      WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function remove(tenantId, id) {
  const r = await db.query(`DELETE FROM companies WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rowCount > 0;
}

// Engagement triplet from the most recent non-cancelled mission against a
// company (Snap autofill). Scoped to the tenant.
async function lastMissionTags(tenantId, companyId) {
  const r = await db.query(
    `SELECT m.id AS mission_id, m.scheduled_at, m.status,
            COALESCE((SELECT json_agg(product_id ORDER BY product_id)
                        FROM scheduled_meeting_products WHERE meeting_id = m.id), '[]') AS product_ids,
            COALESCE((SELECT json_agg(persona_id ORDER BY persona_id)
                        FROM scheduled_meeting_personas WHERE meeting_id = m.id), '[]') AS persona_ids,
            COALESCE((SELECT json_agg(competitor_id ORDER BY competitor_id)
                        FROM scheduled_meeting_competitors WHERE meeting_id = m.id), '[]') AS competitor_ids
       FROM scheduled_meetings m
      WHERE m.tenant_id = $1 AND m.company_id = $2 AND m.status <> 'CANCELLED'
      ORDER BY m.scheduled_at DESC
      LIMIT 1`,
    [tenantId, companyId]
  );
  return r.rows[0] || null;
}

const router = express.Router();
router.use(express.json());

router.get('/', async (req, res, next) => {
  try { res.json({ companies: await list(req.tenantId) }); }
  catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const c = await get(req.tenantId, req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ company: c });
  } catch (err) { next(err); }
});

router.get('/:id/last-mission-tags', async (req, res, next) => {
  try {
    const c = await get(req.tenantId, req.params.id);
    if (!c) return res.status(404).json({ error: 'company not found' });
    const lastMission = await lastMissionTags(req.tenantId, req.params.id);
    res.json({
      company: { id: c.id, name: c.name, domain: c.domain },
      lastMission,
      productIds:    lastMission ? lastMission.product_ids    : [],
      personaIds:    lastMission ? lastMission.persona_ids    : [],
      competitorIds: lastMission ? lastMission.competitor_ids : [],
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const c = await create(req.tenantId, req.body || {});
    res.status(201).json({ company: c });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'company with this name already exists' });
    next(err);
  }
});

// POST /companies/discover { region, industry } — web-search for potential
// prospects (companies showing a buying signal that fits OUR products), ranked by
// priority. Read-only research (no creation); the rep adds the relevant ones.
router.post('/discover', gating.requireCapacity('discovery'), async (req, res, next) => {
  try {
    if (!web.isConfigured() && !web.isBraveConfigured()) {
      return res.status(503).json({ error: 'web search is not configured on this workspace' });
    }
    const broadRegion = String((req.body && req.body.region) || '').trim();
    const country = String((req.body && req.body.country) || '').trim();
    const city = String((req.body && req.body.city) || '').trim();
    // Most specific location wins: "City, Country" > broad region. Discovery's
    // global/any detection handles the broad-region fallthrough.
    const region = [city, country].filter(Boolean).join(', ') || broadRegion;
    const industry = String((req.body && req.body.industry) || '').trim();
    const tenant = (await db.query(`SELECT name FROM tenants WHERE id = $1`, [req.tenantId])).rows[0];
    if (!tenant || !tenant.name) return res.status(422).json({ error: 'set your company name first (Company page) so we know who to prospect for' });
    const prof = (await db.query(`SELECT positioning, objectives, ideal_customer_profile FROM tenant_profiles WHERE tenant_id = $1`, [req.tenantId])).rows[0] || {};
    const ourProducts = (await db.query(
      `SELECT id, name, description FROM products WHERE tenant_id = $1 ORDER BY lower(name)`,
      [req.tenantId]
    )).rows;

    const result = await discovery.discoverProspects({
      companyName: tenant.name, ourProducts,
      positioning: prof.positioning || '',
      objectives: prof.objectives || '',
      idealCustomerProfile: prof.ideal_customer_profile || '',
      region, industry,
    });
    if (!result) return res.status(502).json({ error: 'discovery could not find prospects right now — try again' });

    const existing = await db.query(`SELECT lower(name) AS n FROM companies WHERE tenant_id = $1`, [req.tenantId]);
    const have = new Set(existing.rows.map((r) => r.n));
    const prospects = result.prospects.map((p) => ({ ...p, exists: have.has(p.name.toLowerCase()) }));
    res.json({ prospects, region, industry });
  } catch (err) { next(err); }
});

// POST /companies/discover/add — create the prospect AND persist its signal as an
// opportunity on a DONE prospect_research row (shows on the Signals tab).
router.post('/discover/add', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const domain = String(b.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || null;

    const contact = {
      country: String(b.country || '').trim() || null, city: String(b.city || '').trim() || null,
      address: String(b.address || '').trim() || null, phone: String(b.phone || '').trim() || null,
      email: String(b.email || '').trim() || null,
    };
    let company;
    try {
      company = await findOrCreate(req.tenantId, { name, domain, ...contact });
    } catch (err) {
      if (err.code === '23505') company = await findByDomain(req.tenantId, domain);
      if (!company) throw err;
    }

    // Build the opportunity (Signals-tab shape) from the discovery signal.
    const prio = Math.max(1, Math.min(5, Math.round(Number(b.priority) || 3)));
    const strength = prio >= 4 ? 'strong' : prio === 3 ? 'tie' : 'weak';
    const productNames = Array.isArray(b.matchedProductNames) ? b.matchedProductNames.filter(Boolean) : [];
    const PRIO = { 5: 'Critical', 4: 'High', 3: 'Medium', 2: 'Low', 1: 'Watch' };
    const title = `${PRIO[prio]} priority — ${String(b.signal || 'Opportunity').slice(0, 90)}`;
    const analysisParts = [];
    if (b.signal) analysisParts.push(`Signal: ${String(b.signal).trim()}`);
    if (b.fitReason) analysisParts.push(String(b.fitReason).trim());
    if (productNames.length) analysisParts.push(`Fits: ${productNames.join(', ')}.`);
    const opportunity = {
      title,
      analysis: analysisParts.join(' '),
      strength,
      products: productNames,
      sources: [],
      discovered: true,
    };
    const summary = b.signal ? `Discovered prospect — ${String(b.signal).trim()}` : 'Discovered prospect.';

    let signalSaved = false;
    try {
      await db.query(
        `INSERT INTO prospect_research (tenant_id, company_id, status, summary, opportunities)
              VALUES ($1, $2, 'DONE', $3, $4::jsonb)`,
        [req.tenantId, company.id, summary, JSON.stringify([opportunity])]
      );
      signalSaved = true;
    } catch (err) {
      console.warn(`[companies] discover/add signal persist failed for ${company.id}: ${err.message}`);
    }

    res.status(201).json({ company, signalSaved });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const c = await update(req.tenantId, req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ company: c });
  } catch (err) { next(err); }
});

router.delete('/:id', auth.requireRole('manager'), async (req, res, next) => {
  try {
    const ok = await remove(req.tenantId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { list, get, create, findOrCreate, findByDomain, update, remove, lastMissionTags, router };
