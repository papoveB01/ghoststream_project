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

    // Companies we already track never come back as candidates: they're fed to
    // the model as a hard exclusion AND post-filtered (by name or domain) into
    // a separate `existing` list the UI offers re-analyze / update-intel on.
    const tracked = (await db.query(
      `SELECT id, name, domain, watch_enabled FROM companies WHERE tenant_id = $1`, [req.tenantId]
    )).rows;
    const byName = new Map(tracked.map((r) => [r.name.toLowerCase(), r]));
    const byDomain = new Map(tracked.filter((r) => r.domain).map((r) => [String(r.domain).toLowerCase().replace(/^www\./, ''), r]));

    const result = await discovery.discoverProspects({
      companyName: tenant.name, ourProducts,
      positioning: prof.positioning || '',
      objectives: prof.objectives || '',
      idealCustomerProfile: prof.ideal_customer_profile || '',
      region, industry, limit,
      excludeNames: tracked.map((r) => r.name),
    });
    if (!result) {
      await gating.refundCapacity(req); // don't charge for a failed discovery
      return res.status(502).json({ error: 'discovery could not find prospects right now — try again' });
    }

    const prospects = [];
    const existingHit = new Map();
    for (const p of result.prospects) {
      const dom = String(p.website || p.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      const match = byName.get(p.name.toLowerCase()) || (dom && byDomain.get(dom));
      if (match) existingHit.set(match.id, { id: match.id, name: match.name, domain: match.domain, watchEnabled: !!match.watch_enabled });
      else prospects.push(p);
    }
    const dataHints = await foundation.dataHints(req.tenantId);
    res.json({ prospects, existing: [...existingHit.values()], region, industry, dataHints });
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

    // No research allowance left → don't run the search at all. The teaser is
    // cheap for the tenant but reveals are credit-gated; surfacing the limit
    // BEFORE showing people they can't add (and before spending an Apollo
    // search) is the honest UX. Probe by charging one unit and refunding it.
    try {
      const usage = require('./usage');
      const probe = await gating.chargeUnit(req, 'discovery');
      await usage.refund(req.tenantId, probe.meter, probe.consumed, { lifetime: probe.lifetime });
    } catch (e) {
      if (e.code === 'USAGE_LIMIT' || e.code === 'SUBSCRIPTION_REQUIRED') {
        return res.status(402).json({ error: `${e.message} Contact reveals use research credits — add credits or upgrade on the Billing page to keep finding people.`, code: e.code });
      }
      throw e;
    }
    // Teaser candidates only — cheap (one search call, no per-person reveal).
    const candidates = await apollo.searchPeople(req.tenantId, domain, { limit: want, reveal: false });
    // Best-product-fit per person (one cheap structured AI call for the whole
    // batch, title/seniority vs our portfolio). Soft-fails to no annotation.
    try {
      const fits = await productFitForPeople(req.tenantId, candidates);
      for (const c of candidates) {
        const f = fits[c.id];
        if (f) { c.productFitId = f.id; c.productFitName = f.name; }
      }
    } catch (e) { console.warn('[find-contacts] product fit skipped:', (e && e.message) || e); }
    res.json({ ok: true, domain, resolvedDomain, company: company2, candidates });
  } catch (err) { next(err); }
});

// Which of OUR products is each discovered person most likely the buyer for?
// One structured call per batch; returns { [personId]: { id, name } }.
async function productFitForPeople(tenantId, people) {
  const list = (people || []).filter((p) => p && p.id);
  if (!list.length) return {};
  const products = (await db.query(
    `SELECT id, name, description FROM products WHERE tenant_id = $1 ORDER BY lower(name) LIMIT 20`, [tenantId]
  )).rows;
  if (!products.length) return {};
  const gemini = require('./gemini');
  const models = require('./models');
  const SCHEMA = {
    type: 'object',
    properties: {
      fits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            personId: { type: 'string' },
            productId: { type: 'string', description: 'One of OUR product ids, or empty string when no product clearly maps to this role.' },
          },
          required: ['personId', 'productId'],
        },
      },
    },
    required: ['fits'],
  };
  const prompt =
    'For each PERSON below (a role at a prospect company), pick which ONE of OUR PRODUCTS they are most ' +
    'likely the buyer/decision-maker for, judging purely from their title/seniority vs what each product does. ' +
    'Use an empty productId when no product clearly maps. Do not guess wildly — empty is better than wrong.\n\n' +
    `===OUR PRODUCTS===\n${products.map((p) => `${p.id}: ${p.name}${p.description ? ` — ${String(p.description).slice(0, 120)}` : ''}`).join('\n')}\n\n` +
    `===PEOPLE===\n${list.map((p) => `${p.id}: ${[p.title, p.seniority].filter(Boolean).join(' · ') || 'Unknown role'}`).join('\n')}`;
  const ai = gemini.getClient();
  const resp = await ai.models.generateContent({
    model: models.modelFor('content'),
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.1, maxOutputTokens: 2000, responseMimeType: 'application/json', responseSchema: SCHEMA, thinkingConfig: { thinkingBudget: 0 } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const out = {};
  for (const f of (JSON.parse(resp.text).fits || [])) {
    const pr = byId.get(String(f.productId || ''));
    if (pr && f.personId) out[f.personId] = { id: pr.id, name: pr.name };
  }
  return out;
}

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
    // Per-person product fit from the discovery step ({ apolloId: productId });
    // validated against the tenant's real product ids before persisting.
    const fitsIn = (req.body && typeof req.body.fits === 'object' && req.body.fits) || {};
    const validProducts = new Set((await db.query(`SELECT id FROM products WHERE tenant_id = $1`, [req.tenantId])).rows.map((r) => r.id));

    // Each reveal that actually hits Apollo (cache miss) books one research
    // unit against the plan — the ADR-0004 guardrail on the only "cheap meter"
    // cost a user can multiply with clicks. v1 tenants charge their discovery
    // meter (same credit pool); cached reveals are free. A 402 mid-batch stops
    // there and reports the partial result instead of failing the request.
    const usage = require('./usage');
    const revealOpts = {
      charge: () => gating.chargeUnit(req, 'discovery'),
      refund: (h) => usage.refund(req.tenantId, h.meter, h.consumed, { lifetime: h.lifetime }),
    };

    let created = 0, existing = 0, failed = 0, limited = null;
    const saved = [];
    for (const id of ids) {
      let p;
      try {
        p = await apollo.revealPerson(req.tenantId, id, revealOpts);
      } catch (e) {
        if (e.code === 'USAGE_LIMIT' || e.code === 'SUBSCRIPTION_REQUIRED') { limited = e.message; break; }
        throw e;
      }
      if (!p || !p.email) { failed++; continue; }
      try {
        const fit = String(fitsIn[id] || '').trim();
        const c = await contacts.create(req.tenantId, req.user && req.user.sub, {
          companyId: company.id, name: p.name, email: p.email,
          role: p.title || 'Unknown', title: p.title || null,
          likelyProductId: validProducts.has(fit) ? fit : null,
          location: p.location || null,
        });
        created++; saved.push(c);
      } catch (e) {
        if (e.code === 'EMAIL_TAKEN') existing++;
        else { failed++; console.warn('[add-contacts] save failed:', (e && e.message) || e); }
      }
    }
    res.json({ ok: true, requested: ids.length, created, existing, failed, limited, contacts: saved });
  } catch (err) { next(err); }
});

// GET /companies/:id/engagements — past touchpoints for this prospect: completed
// CALLS (labelled by their portal title) and captured EMAIL threads (inbound-parse
// intel). Each carries a typed composite id (`call:<id>` / `email:<id>`). Powers
// the email composer's "based on engagement" picker for follow-up / post-call.
router.get('/:id/engagements', async (req, res, next) => {
  try {
    const store = require('./store');
    const engagements = [];
    // Completed calls.
    const calls = (await db.query(
      `SELECT id, scheduled_at, notes, portal_id FROM scheduled_meetings
        WHERE tenant_id = $1 AND company_id = $2 AND status = 'COMPLETED'
        ORDER BY scheduled_at DESC LIMIT 20`,
      [req.tenantId, req.params.id]
    )).rows;
    for (const r of calls) {
      let title = null;
      if (r.portal_id) { try { const p = await store.getPortal(r.portal_id); if (p) title = p.title || null; } catch { /* fall back to date */ } }
      engagements.push({ id: `call:${r.id}`, type: 'CALL', at: r.scheduled_at, title: title || (r.notes ? String(r.notes).slice(0, 60) : 'Call') });
    }
    // Captured email threads (inbound-parse intel filed as PROSPECT docs).
    const emails = (await db.query(
      `SELECT id, title, metadata, created_at FROM kb_documents
        WHERE tenant_id = $1 AND company_id = $2 AND scope = 'PROSPECT'
          AND metadata->>'source' = 'inbound-email' AND status = 'READY'
        ORDER BY created_at DESC LIMIT 20`,
      [req.tenantId, req.params.id]
    )).rows;
    for (const r of emails) {
      const md = r.metadata || {};
      engagements.push({ id: `email:${r.id}`, type: 'EMAIL', at: md.receivedAt || r.created_at, title: (r.title || 'Email').replace(/^Email:\s*/i, '') });
    }
    // Most recent first across both types.
    engagements.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    res.json({ engagements });
  } catch (err) { next(err); }
});

// GET /companies/:id/emails — captured email threads for this prospect (emails the
// rep sent via the composer's CC + prospect replies, filed by inbound-parse).
// Powers the "Emails" list on the prospect Intel tab.
router.get('/:id/emails', async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT id, title, metadata, created_at FROM kb_documents
        WHERE tenant_id = $1 AND company_id = $2 AND scope = 'PROSPECT'
          AND metadata->>'source' = 'inbound-email' AND status = 'READY'
        ORDER BY created_at DESC LIMIT 50`,
      [req.tenantId, req.params.id]
    )).rows;
    const emails = rows.map((r) => {
      const md = r.metadata || {};
      return { id: r.id, subject: String(r.title || 'Email').replace(/^Email:\s*/i, ''), from: md.from || null, receivedAt: md.receivedAt || r.created_at };
    });
    res.json({ emails });
  } catch (err) { next(err); }
});

// GET /companies/:id/emails/:docId/body — the full captured-email body, on demand.
router.get('/:id/emails/:docId/body', async (req, res, next) => {
  try {
    const own = (await db.query(
      `SELECT 1 FROM kb_documents WHERE id = $1 AND tenant_id = $2 AND company_id = $3 AND metadata->>'source' = 'inbound-email'`,
      [req.params.docId, req.tenantId, req.params.id]
    )).rows[0];
    if (!own) return res.status(404).json({ error: 'email not found' });
    const d = await require('./knowledge/service').getDocumentText(req.tenantId, req.params.docId);
    res.json({ text: (d && d.text) || '' });
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
