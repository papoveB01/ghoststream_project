// Apollo.io — B2B company + people enrichment provider.
//
// Used by:
//   - knowledge/research.js  → company snapshot + leadership team as two
//                              extra numbered sources in every dossier
//   - contacts.js (router)   → autofill name/role on a freshly-typed email
//   - integrations.js Teams modal → optional autocomplete source
//
// Disciplines this module enforces:
//
//   1. Per-(tenant, domain) Redis cache with TTL = APOLLO_CACHE_TTL_DAYS so
//      re-running research on the same prospect inside the window costs zero
//      credits.
//   2. Per-tenant daily counter with hard cap APOLLO_DAILY_CAP_PER_TENANT.
//      Once tripped, every Apollo call short-circuits to null until UTC
//      midnight rolls the counter. Guards against runaway dev scripts.
//   3. Fail-closed but non-fatal: a 401 / 402 / 403 (bad key, no plan, out
//      of credits) returns null without throwing — the dossier still runs,
//      it just doesn't get an Apollo block. Other errors bubble up so the
//      caller can log them.
//   4. Never logs the key. The `x-api-key` header is the only place it
//      appears, and error messages strip the header out.

const redis = require('../redis');

const BASE = (process.env.APOLLO_BASE_URL || 'https://api.apollo.io').replace(/\/+$/, '');
const CACHE_TTL_SEC = Math.max(60, parseInt(process.env.APOLLO_CACHE_TTL_DAYS || '7', 10) * 86400);
const DAILY_CAP     = Math.max(0,  parseInt(process.env.APOLLO_DAILY_CAP_PER_TENANT || '50', 10));
const HTTP_TIMEOUT  = parseInt(process.env.APOLLO_TIMEOUT_MS || '10000', 10);

// Job-title filters we use when looking up "leadership team" for the
// dossier. Apollo's `person_titles` is a fuzzy partial-match — these cover
// the c-suite, VPs, heads-of, and senior directors.
const DEFAULT_LEADERSHIP_TITLES = [
  'CEO', 'COO', 'CFO', 'CTO', 'CIO', 'CMO', 'CRO',
  'Chief',
  'President', 'VP', 'Vice President',
  'Head of', 'Director',
];

function isConfigured() {
  return Boolean(process.env.APOLLO_API_KEY);
}

function apiKey() {
  return process.env.APOLLO_API_KEY || '';
}

// ── Redis: cache + daily counter ─────────────────────────────────────────

function cacheKey(tenantId, kind, target) {
  // tenant-scoped so two tenants don't share each other's enrichment (some
  // Apollo data depends on the caller's view-mask, esp. for people).
  return `apollo_cache:${tenantId || 'shared'}:${kind}:${String(target).toLowerCase()}`;
}

function dayBucket() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function counterKey(tenantId) {
  return `apollo_cap:${tenantId || 'shared'}:${dayBucket()}`;
}

async function readCache(tenantId, kind, target) {
  try {
    const raw = await redis.get(cacheKey(tenantId, kind, target));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function writeCache(tenantId, kind, target, value) {
  try {
    await redis.set(cacheKey(tenantId, kind, target), JSON.stringify(value || null), 'EX', CACHE_TTL_SEC);
  } catch { /* non-fatal */ }
}

// True when this tenant is over the daily cap. Increments the counter as a
// side-effect so the check-then-call pattern doesn't race.
async function tripDailyCap(tenantId) {
  if (DAILY_CAP <= 0) return false; // 0 = disabled
  try {
    const key = counterKey(tenantId);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 86400 + 60); // first call this day → set TTL
    return n > DAILY_CAP;
  } catch {
    return false; // redis hiccup — don't block the call
  }
}

async function dailyUsage(tenantId) {
  try {
    const v = await redis.get(counterKey(tenantId));
    return v ? parseInt(v, 10) : 0;
  } catch { return 0; }
}

// ── HTTP helper ──────────────────────────────────────────────────────────

async function apolloRequest(method, path, body) {
  const url = `${BASE}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        'x-api-key': apiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'GhostStream/1.0 (apollo-client)',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    // Soft-fail on common credit / auth errors — caller treats null as
    // "Apollo not available" and keeps building the dossier without it.
    if ([401, 402, 403, 429].includes(r.status)) {
      const j = await r.json().catch(() => ({}));
      const reason = j.error || j.message || `HTTP ${r.status}`;
      // Surface once at warn so the operator can see the cause without the
      // key. We don't include the key — it's not in the body — but we do
      // truncate the URL path to be safe.
      console.warn(`[apollo] ${method} ${path.split('?')[0]} → ${r.status}: ${String(reason).slice(0, 120)}`);
      return { ok: false, status: r.status, reason };
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(`Apollo ${method} ${path.split('?')[0]} → ${r.status}: ${(j.error || j.message || 'error')}`);
      e.status = r.status;
      throw e;
    }
    return { ok: true, status: r.status, data: j };
  } finally {
    clearTimeout(timer);
  }
}

// ── Public surface ────────────────────────────────────────────────────────

// One company snapshot keyed on domain. Returns null when not configured /
// over the daily cap / a soft API failure. Cached per (tenant, domain).
async function enrichOrganization(tenantId, domain) {
  if (!isConfigured() || !domain) return null;
  const cleaned = bareDomain(domain);
  if (!cleaned) return null;
  const cached = await readCache(tenantId, 'org', cleaned);
  if (cached !== null) return cached;
  if (await tripDailyCap(tenantId)) return null;
  const res = await apolloRequest('POST', '/v1/organizations/enrich', { domain: cleaned });
  if (!res.ok) { await writeCache(tenantId, 'org', cleaned, null); return null; }
  const o = (res.data && res.data.organization) || null;
  if (!o) { await writeCache(tenantId, 'org', cleaned, null); return null; }
  const slim = normalizeOrg(o);
  await writeCache(tenantId, 'org', cleaned, slim);
  return slim;
}

// People search at a company. `titles` overrides the leadership default;
// `name` lets the Teams modal autocomplete pass the partial name typed.
async function searchPeople(tenantId, domain, { titles, name, limit = 10 } = {}) {
  if (!isConfigured() || !domain) return [];
  const cleaned = bareDomain(domain);
  if (!cleaned) return [];
  const titleList = Array.isArray(titles) && titles.length ? titles : DEFAULT_LEADERSHIP_TITLES;
  // Cache key includes the title-set hash + the name query so different
  // filters don't collide.
  const variantKey = `${cleaned}:${titleList.join(',')}:${name || ''}:${limit}`;
  const cached = await readCache(tenantId, 'people', variantKey);
  if (cached !== null) return cached;
  if (await tripDailyCap(tenantId)) return [];
  const body = {
    q_organization_domains: cleaned,
    person_titles: titleList,
    per_page: Math.min(25, Math.max(1, limit)),
  };
  if (name) body.q_keywords = name;
  const res = await apolloRequest('POST', '/v1/mixed_people/search', body);
  if (!res.ok) { await writeCache(tenantId, 'people', variantKey, []); return []; }
  const raw = (res.data && (res.data.people || res.data.contacts)) || [];
  const slim = raw.slice(0, limit).map(normalizePerson).filter(Boolean);
  await writeCache(tenantId, 'people', variantKey, slim);
  return slim;
}

// Enrich one person by email — used when the rep adds a contact with
// only an email and lets us autofill name + title + LinkedIn.
async function enrichPerson(tenantId, email) {
  if (!isConfigured() || !email) return null;
  const cleaned = String(email).trim().toLowerCase();
  if (!/@/.test(cleaned)) return null;
  const cached = await readCache(tenantId, 'person', cleaned);
  if (cached !== null) return cached;
  if (await tripDailyCap(tenantId)) return null;
  const res = await apolloRequest('POST', '/v1/people/match', { email: cleaned });
  if (!res.ok) { await writeCache(tenantId, 'person', cleaned, null); return null; }
  const p = (res.data && res.data.person) || null;
  if (!p) { await writeCache(tenantId, 'person', cleaned, null); return null; }
  const slim = normalizePerson(p);
  await writeCache(tenantId, 'person', cleaned, slim);
  return slim;
}

// ── Normalizers — slim API objects to just what the dossier / UI needs ──

function bareDomain(d) {
  return String(d || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .split('/')[0].split('?')[0].split('#')[0];
}

function normalizeOrg(o) {
  if (!o) return null;
  const fmtRange = (lo, hi) => (lo && hi) ? `$${shortNum(lo)}-$${shortNum(hi)}` : (lo ? `$${shortNum(lo)}+` : null);
  return {
    name:        o.name || null,
    domain:      o.primary_domain || o.website_url || null,
    industry:    o.industry || null,
    employeeCount: o.estimated_num_employees || o.employee_count || null,
    revenueRange: fmtRange(o.annual_revenue_printed || o.organization_revenue_printed,
                           o.estimated_annual_revenue || null) || (o.annual_revenue_printed || null),
    foundedYear:  o.founded_year || null,
    description:  o.short_description || o.seo_description || null,
    technologies: Array.isArray(o.technology_names) ? o.technology_names.slice(0, 20) : null,
    keywords:     Array.isArray(o.keywords) ? o.keywords.slice(0, 15) : null,
    location:     [o.city, o.state, o.country].filter(Boolean).join(', ') || null,
    linkedinUrl:  o.linkedin_url || null,
    twitterUrl:   o.twitter_url || null,
    facebookUrl:  o.facebook_url || null,
    fundingTotal: o.total_funding_printed || (o.total_funding ? `$${shortNum(o.total_funding)}` : null),
    latestFundingRound: o.latest_funding_stage || null,
    latestFundingAt:    o.latest_funding_round_date || null,
  };
}

function normalizePerson(p) {
  if (!p) return null;
  return {
    id:          p.id || null,
    name:        p.name || ([p.first_name, p.last_name].filter(Boolean).join(' ')) || null,
    title:       p.title || null,
    seniority:   p.seniority || null,
    email:       p.email || null,
    emailStatus: p.email_status || null,        // 'verified' | 'guessed' | etc.
    linkedinUrl: p.linkedin_url || null,
    twitterUrl:  p.twitter_url || null,
    company:     (p.organization && p.organization.name) || null,
    location:    [p.city, p.state, p.country].filter(Boolean).join(', ') || null,
  };
}

function shortNum(n) {
  if (n == null) return '?';
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

module.exports = {
  isConfigured,
  enrichOrganization,
  searchPeople,
  enrichPerson,
  dailyUsage,
  // exposed for unit tests
  _internals: { bareDomain, normalizeOrg, normalizePerson, shortNum },
};
