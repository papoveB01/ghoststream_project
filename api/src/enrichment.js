// Multi-source company enrichment. The original onboarding bootstrap scraped only
// the homepage and produced product NAMES with description:null (and no ICP /
// objectives) — which starves discovery (brand-anchored queries → generic
// results). This pulls from several major sources, synthesizes a real company
// foundation, and applies it (auto-apply, flagged ai_enriched for review):
//
//   sources  : deep website crawl (homepage + product/solution/about pages),
//              Apollo org + leadership, recent web/news search.
//   output   : positioning, objectives, idealCustomerProfile (the BUYER profile),
//              products[{name,description}], personas[{title,description}].
//   apply    : fill empty profile fields (force = overwrite), backfill blank
//              product descriptions + create missing products/personas, all
//              marked ai_enriched / enriched_at so the UI can flag them.
//
// Best-effort throughout: any source can fail and enrichment still proceeds with
// whatever it gathered. Runs inside a tenant request context (db RLS scoping).

const db = require('./db');
const web = require('./knowledge/web');
const apollo = require('./knowledge/apollo');
const gemini = require('./gemini');
const MODEL = require('./models').modelFor('content');

const PAGE_CAP = 6000;          // chars of markdown kept per scraped page
const MAX_PAGES = 7;            // homepage + up to 6 deep pages
const MAX_PRODUCTS = 15;
const MAX_PERSONAS = 8;

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}
// Globally-unique, slug-shaped id (products.id is a global PK) — tenant-suffixed
// so two tenants enriching the same product name don't collide.
function entityId(name, tenantId) {
  return `${slugify(name)}-${String(tenantId).replace(/-/g, '').slice(0, 8)}`.slice(0, 64);
}

const FOUNDATION_SCHEMA = {
  type: 'object',
  properties: {
    positioning: { type: 'string', description: '2-4 sentences: what the company does, its market and core differentiator.' },
    objectives:  { type: 'string', description: 'A few short lines: the company\'s go-to-market / sales objectives and priorities, inferred from the material.' },
    idealCustomerProfile: { type: 'string', description: 'Who the company SELLS TO — the buyer firmographics (industry, size, region, buyer roles, the need they have). This is the BUYER profile, not the company itself.' },
    products: {
      type: 'array',
      description: 'The company\'s OWN product lines / offerings, each with a one-sentence description of what it does. Only ones the material supports.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'One sentence: what this product does / the problem it solves.' },
        },
        required: ['name', 'description'],
      },
    },
    personas: {
      type: 'array',
      description: 'The key BUYER personas — the roles/titles at the customer that buy or champion this company\'s products.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The buyer role/title (e.g. "Head of Payments", "CISO").' },
          description: { type: 'string', description: 'One sentence: what this persona cares about / why they buy.' },
        },
        required: ['title', 'description'],
      },
    },
  },
  required: ['positioning', 'objectives', 'idealCustomerProfile', 'products', 'personas'],
};

// ─────────────────────────────────────────────────────────── gather sources
async function gatherWebsite(domain) {
  const homepage = `https://${domain}`;
  const sourceUrls = [];
  let urls = [homepage];
  try {
    const mapped = await web.mapSite(homepage, { limit: 40 });
    const wanted = /(product|solution|platform|service|offering|pricing|about|company|what-we-do)/i;
    const picks = (mapped || []).filter((u) => wanted.test(u)).slice(0, MAX_PAGES - 1);
    urls = [...new Set([homepage, ...picks])].slice(0, MAX_PAGES);
  } catch { /* map best-effort; fall back to homepage only */ }

  const pages = [];
  for (const u of urls) {
    try {
      const md = await web.scrapeMarkdown(u);
      const text = md && md.markdown ? String(md.markdown).trim() : '';
      if (text.length > 80) { pages.push({ url: u, markdown: text.slice(0, PAGE_CAP) }); sourceUrls.push(u); }
    } catch { /* skip unreadable page */ }
  }
  return { pages, sourceUrls };
}

async function gatherApollo(tenantId, domain) {
  if (!apollo.isConfigured || !apollo.isConfigured()) return { org: null, leadership: [] };
  let org = null, leadership = [];
  try { org = await apollo.enrichOrganization(tenantId, domain); } catch { /* best-effort */ }
  try {
    const ppl = await apollo.searchPeople(tenantId, domain, {
      titles: ['CEO', 'Founder', 'Chief', 'President', 'VP', 'Head', 'Director'],
      limit: 8,
    });
    leadership = Array.isArray(ppl) ? ppl : (ppl && ppl.people) || [];
  } catch { /* best-effort */ }
  return { org, leadership };
}

async function gatherNews(name) {
  try {
    const rows = await web.search(`${name} company news`, { limit: 5 });
    return (rows || []).map((r) => `- ${r.title || ''}${r.description ? ` — ${r.description}` : ''}`).filter((s) => s.length > 3);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────── synthesize
async function synthesize(name, corpus, existingProducts = []) {
  if (!corpus || corpus.length < 80) return null;
  const existingBlock = existingProducts.length
    ? '\n\n===OUR EXISTING PRODUCTS (reuse these EXACT names where a found offering is the same thing, so we ' +
      'fill them in rather than duplicate; only add products that are genuinely different)===\n' +
      existingProducts.map((n) => `- ${n}`).join('\n')
    : '';
  const prompt =
    'You are a B2B go-to-market analyst. Using ONLY the SOURCE MATERIAL below about a company, ' +
    'build a concise, accurate company foundation. Do NOT invent facts the material does not support; ' +
    'if something is unknown, keep it brief or leave the array empty.\n' +
    'CRITICAL: idealCustomerProfile describes WHO THE COMPANY SELLS TO (their buyers: industry, size, ' +
    'region, buyer roles, the need) — NOT the company itself. products are the company\'s OWN offerings, ' +
    'each with a one-sentence description. personas are the buyer roles at the customer.\n' +
    'When a found offering matches one of OUR EXISTING PRODUCTS, return it under that product\'s EXACT ' +
    'existing name (we match by name) so its description is filled in instead of creating a duplicate.\n\n' +
    `===COMPANY===\n${name}${existingBlock}\n\n===SOURCE MATERIAL===\n${corpus}`;
  try {
    const ai = gemini.getClient();
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 8000,
        responseMimeType: 'application/json',
        responseSchema: FOUNDATION_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    return {
      positioning: String(parsed.positioning || '').trim(),
      objectives: String(parsed.objectives || '').trim(),
      idealCustomerProfile: String(parsed.idealCustomerProfile || '').trim(),
      products: (Array.isArray(parsed.products) ? parsed.products : [])
        .map((p) => ({ name: String(p.name || '').trim(), description: String(p.description || '').trim() }))
        .filter((p) => p.name).slice(0, MAX_PRODUCTS),
      personas: (Array.isArray(parsed.personas) ? parsed.personas : [])
        .map((p) => ({ title: String(p.title || '').trim(), description: String(p.description || '').trim() }))
        .filter((p) => p.title).slice(0, MAX_PERSONAS),
    };
  } catch (err) {
    console.warn(`[enrichment] synthesize failed: ${(err && err.message) || err}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────── apply
async function applyEnrichment(tenantId, synth, { force = false } = {}) {
  const summary = { profileFields: [], productsCreated: 0, productsBackfilled: 0, personasCreated: 0 };

  // 1. Profile: fill empty fields (force = overwrite non-empty too).
  const cur = (await db.query(
    `SELECT positioning, objectives, ideal_customer_profile FROM tenant_profiles WHERE tenant_id = $1`, [tenantId]
  )).rows[0] || {};
  const want = (col, curVal, newVal) => newVal && (force || !(curVal && String(curVal).trim())) ? newVal : null;
  const newPos = want('positioning', cur.positioning, synth.positioning);
  const newObj = want('objectives', cur.objectives, synth.objectives);
  const newIcp = want('ideal_customer_profile', cur.ideal_customer_profile, synth.idealCustomerProfile);
  if (newPos) summary.profileFields.push('positioning');
  if (newObj) summary.profileFields.push('objectives');
  if (newIcp) summary.profileFields.push('idealCustomerProfile');

  await db.query(
    `INSERT INTO tenant_profiles (tenant_id, positioning, objectives, ideal_customer_profile, enriched_at, enrichment_sources, updated_at)
          VALUES ($1, $2, $3, $4, now(), $5, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       positioning = COALESCE($2, tenant_profiles.positioning),
       objectives  = COALESCE($3, tenant_profiles.objectives),
       ideal_customer_profile = COALESCE($4, tenant_profiles.ideal_customer_profile),
       enriched_at = now(),
       enrichment_sources = $5,
       updated_at = now()`,
    [tenantId, newPos, newObj, newIcp, JSON.stringify({ fields: summary.profileFields })]
  );

  // 2. Products: backfill blank descriptions on existing (matched by name),
  //    create the rest. Marked ai_enriched for review.
  for (const p of synth.products) {
    const existing = (await db.query(
      `SELECT id, description FROM products WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [tenantId, p.name]
    )).rows[0];
    if (existing) {
      if (!(existing.description && existing.description.trim()) && p.description) {
        await db.query(
          `UPDATE products SET description = $1, ai_enriched = true WHERE id = $2 AND tenant_id = $3`,
          [p.description, existing.id, tenantId]
        );
        summary.productsBackfilled++;
      }
      continue;
    }
    try {
      await db.query(
        `INSERT INTO products (id, tenant_id, name, description, ai_enriched) VALUES ($1, $2, $3, $4, true)`,
        [entityId(p.name, tenantId), tenantId, p.name, p.description || null]
      );
      summary.productsCreated++;
    } catch (err) { if (err.code !== '23505') throw err; }
  }

  // 3. Personas: create missing buyer personas (no ai_enriched column — name/desc).
  for (const p of synth.personas) {
    const existing = (await db.query(
      `SELECT id FROM personas WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [tenantId, p.title]
    )).rows[0];
    if (existing) continue;
    try {
      await db.query(
        `INSERT INTO personas (id, tenant_id, name, description) VALUES ($1, $2, $3, $4)`,
        [entityId(p.title, tenantId), tenantId, p.title, p.description || null]
      );
      summary.personasCreated++;
    } catch (err) { if (err.code !== '23505') throw err; }
  }

  return summary;
}

// ───────────────────────────────────────────────────────────── orchestrate
// Pull from all sources, synthesize, apply. Returns a summary (or throws only on
// a truly unrecoverable error). `force` overwrites non-empty profile fields.
async function enrichCompany(tenantId, { force = false } = {}) {
  const t = (await db.query(`SELECT name, domain FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  if (!t || !t.name) { const e = new Error('set your company name first'); e.status = 422; throw e; }
  if (!t.domain) { const e = new Error('no company website on file to enrich from'); e.status = 422; throw e; }
  if (!web.isConfigured() && !web.isBraveConfigured()) { const e = new Error('AI search is not configured on this workspace'); e.status = 503; throw e; }

  const [{ pages, sourceUrls }, { org, leadership }, news] = await Promise.all([
    gatherWebsite(t.domain),
    gatherApollo(tenantId, t.domain),
    gatherNews(t.name),
  ]);

  const sources = [];
  if (pages.length) sources.push('website');
  if (org) sources.push('apollo');
  if (leadership.length) sources.push('apollo-people');
  if (news.length) sources.push('news');

  const corpus = [
    `COMPANY: ${t.name} (${t.domain})`,
    org ? `APOLLO ORG DATA:\n${JSON.stringify(org).slice(0, 2500)}` : '',
    leadership.length ? `LEADERSHIP:\n${leadership.map((p) => `- ${p.name || p.first_name || ''} — ${p.title || ''}`).join('\n')}` : '',
    news.length ? `RECENT NEWS:\n${news.join('\n')}` : '',
    ...pages.map((p) => `PAGE ${p.url}:\n${p.markdown}`),
  ].filter(Boolean).join('\n\n---\n\n');

  const existingProducts = (await db.query(
    `SELECT name FROM products WHERE tenant_id = $1 ORDER BY lower(name)`, [tenantId]
  )).rows.map((r) => r.name);
  const synth = await synthesize(t.name, corpus, existingProducts);
  if (!synth) { const e = new Error('could not read enough about your company to enrich right now — try again'); e.status = 502; throw e; }

  const summary = await applyEnrichment(tenantId, synth, { force });
  return { ok: true, summary: { ...summary, sources, pagesRead: pages.length, sourceUrls: sourceUrls.slice(0, 8) } };
}

module.exports = { enrichCompany, synthesize, applyEnrichment, _internals: { slugify, entityId } };
