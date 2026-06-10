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
const watchSchedule = require('./watchSchedule');
const foundation = require('./foundation');

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
    `SELECT id, name, domain, primary_contact, notes, country, city, address, phone, email,
            watch_enabled, watch_frequency, watch_day, watch_timezone, watch_email_digest,
            watch_next_run_at, watch_last_run_at, created_at,
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
  // No name match. Before creating, try matching by domain — a calendar event's
  // company-name heuristic (derived from an attendee's email domain) often
  // differs from how the prospect was originally saved (e.g. "Acme Corp" vs
  // "Acme"). Matching on domain here prevents a duplicate prospect per meeting.
  // Callers (mission scheduling) already strip public-mail domains before
  // passing one in, so this only ever matches real company domains.
  if (domain) {
    const byDomain = await findByDomain(tenantId, domain);
    if (byDomain) return byDomain;
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

async function update(tenantId, id, patch) {
  const { name, domain, primaryContact, notes, country, city, address, phone, email } = patch;
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
  // Per-entity Market Watch schedule — merge over the current row (so changing
  // one field re-arms watch_next_run_at consistently).
  if (['watchEnabled', 'watchFrequency', 'watchDay', 'watchTimezone', 'watchEmailDigest'].some((k) => patch[k] !== undefined)) {
    const cur = await get(tenantId, id);
    if (!cur) return null;
    const wm = watchSchedule.mergeWatchSchedule(cur, patch);
    if (wm.error) { const e = new Error(wm.error); e.status = 400; throw e; }
    for (const [col, val] of Object.entries(wm.values)) { params.push(val); sets.push(`${col} = $${params.length}`); }
  }
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

// Manual "Add a prospect" (paste a name + website). FREE — unlike the online
// sweep (POST /discover), this runs no Gemini and no web search; it just creates
// a record, so it doesn't consume a metered `discovery` unit. Still feature-gated
// so it stays within plans that include prospecting.
router.post('/', gating.requireFeature('discovery'), async (req, res, next) => {
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
router.post('/discover', gating.requireFeature('discovery'), gating.requireCapacity('discovery'), async (req, res, next) => {
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
    // How many prospects to return this turn (max 100, clamped in discovery.js).
    const limit = parseInt((req.body && (req.body.limit ?? req.body.count)), 10) || undefined;
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
      region, industry, limit,
    });
    if (!result) {
      await gating.refundCapacity(req); // don't charge for a failed discovery
      return res.status(502).json({ error: 'discovery could not find prospects right now — try again' });
    }

    const existing = await db.query(`SELECT lower(name) AS n FROM companies WHERE tenant_id = $1`, [req.tenantId]);
    const have = new Set(existing.rows.map((r) => r.n));
    const prospects = result.prospects.map((p) => ({ ...p, exists: have.has(p.name.toLowerCase()) }));
    const dataHints = await foundation.dataHints(req.tenantId);
    res.json({ prospects, region, industry, dataHints });
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

// POST /companies/:id/find-contacts — STAGE 1 of the Apollo contact pull. Resolves
// a missing website from the company name (Apollo org search), autofills company
// HQ/phone (blanks only), and returns the decision-makers as cheap TEASER
// candidates (no email revealed yet → no credit spent per person). The rep then
// ticks who they want and calls add-contacts to reveal+save just those. Feature-
// gated on `discovery`; not capacity-metered (Apollo enforces its own credits).
router.post('/:id/find-contacts', gating.requireFeature('discovery'), async (req, res, next) => {
  try {
    const apollo = require('./knowledge/apollo');
    if (!apollo.isConfigured()) return res.status(503).json({ error: 'Apollo is not configured on this workspace' });
    const company = await get(req.tenantId, req.params.id);
    if (!company) return res.status(404).json({ error: 'prospect not found' });

    // Resolve a missing domain from the company name, then persist it so future
    // pulls (and discovery/watch) have it. 422 only if we truly can't find one.
    let domain = bareHost(company.domain || '');
    let resolvedDomain = false;
    if (!domain) {
      domain = await apollo.findDomainByName(req.tenantId, company.name);
      if (!domain) return res.status(422).json({ error: `couldn't auto-find a website for "${company.name}" — add one on the prospect, then try again`, code: 'NO_DOMAIN' });
      resolvedDomain = true;
      await update(req.tenantId, company.id, { domain });
    }
    const want = Math.max(1, Math.min(25, parseInt((req.body && req.body.limit), 10) || 12));

    // Company-level enrichment — fill ONLY blank fields (never overwrite the rep).
    let company2 = await get(req.tenantId, company.id);
    try {
      const org = await apollo.enrichOrganization(req.tenantId, domain);
      if (org) {
        const [oCity, oState, oCountry] = String(org.location || '').split(',').map((s) => s.trim());
        const patch = {};
        if (!company2.city && oCity) patch.city = oCity;
        if (!company2.country && (oCountry || oState)) patch.country = oCountry || oState;
        if (!company2.phone && org.phone) patch.phone = org.phone;
        if (Object.keys(patch).length) company2 = (await update(req.tenantId, company.id, patch)) || company2;
      }
    } catch (e) { console.warn('[find-contacts] org enrich failed:', (e && e.message) || e); }

    // Teaser candidates only — cheap (one search call, no per-person reveal).
    const candidates = await apollo.searchPeople(req.tenantId, domain, { limit: want, reveal: false });
    res.json({ ok: true, domain, resolvedDomain, company: company2, candidates });
  } catch (err) { next(err); }
});

// POST /companies/:id/add-contacts { ids:[apolloPersonId,...] } — STAGE 2. Reveals
// each selected Apollo person (people/match → real name + verified email; one
// credit each) and saves them into prospect_contacts (dedupe by email).
router.post('/:id/add-contacts', gating.requireFeature('discovery'), async (req, res, next) => {
  try {
    const apollo = require('./knowledge/apollo');
    const contacts = require('./contacts');
    if (!apollo.isConfigured()) return res.status(503).json({ error: 'Apollo is not configured on this workspace' });
    const company = await get(req.tenantId, req.params.id);
    if (!company) return res.status(404).json({ error: 'prospect not found' });
    const ids = [...new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 25);
    if (!ids.length) return res.status(400).json({ error: 'select at least one contact to add' });

    let created = 0, existing = 0, failed = 0;
    const saved = [];
    for (const id of ids) {
      const p = await apollo.revealPerson(req.tenantId, id);
      if (!p || !p.email) { failed++; continue; }
      try {
        const c = await contacts.create(req.tenantId, req.user && req.user.sub, {
          companyId: company.id, name: p.name, email: p.email,
          role: p.title || 'Unknown', title: p.title || null,
        });
        created++; saved.push(c);
      } catch (e) {
        if (e.code === 'EMAIL_TAKEN') existing++;
        else { failed++; console.warn('[add-contacts] save failed:', (e && e.message) || e); }
      }
    }
    res.json({ ok: true, requested: ids.length, created, existing, failed, contacts: saved });
  } catch (err) { next(err); }
});

// GET /companies/:id/engagements — past (completed) engagements for this prospect,
// each labelled with its call title/summary (from the portal). Powers the email
// composer's "based on engagement" picker for follow-up / post-call drafts.
router.get('/:id/engagements', async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT id, scheduled_at, notes, portal_id FROM scheduled_meetings
        WHERE tenant_id = $1 AND company_id = $2 AND status = 'COMPLETED'
        ORDER BY scheduled_at DESC LIMIT 20`,
      [req.tenantId, req.params.id]
    )).rows;
    const store = require('./store');
    const engagements = [];
    for (const r of rows) {
      let title = null, hasSummary = false;
      if (r.portal_id) {
        try { const p = await store.getPortal(r.portal_id); if (p) { title = p.title || null; hasSummary = Boolean(p.sowSummary); } } catch { /* portal gone — fall back to date */ }
      }
      engagements.push({ id: r.id, scheduledAt: r.scheduled_at, notes: r.notes || null, portalId: r.portal_id || null, title, hasSummary });
    }
    res.json({ engagements });
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
