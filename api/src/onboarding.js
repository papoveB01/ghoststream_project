// Free-trial onboarding — the "Intelligence Hook".
//
// Public (no-auth) flow that turns a website + a corporate email into a new
// tenant. The "magic moment": while the user finishes signing up, Firecrawl
// scrapes their homepage and Gemini Flash summarises it into a 3-bullet
// Company Intelligence Brief — proof that GhostStream already understands
// their business before they've even set a password.
//
//   POST /onboarding/start            → validate, create an onboarding
//                                        session (Redis, 30-min TTL), kick
//                                        off the scrape in the background
//   GET  /onboarding/:id/status       → poll the scrape + brief
//   POST /onboarding/:id/finalize     → set password → create tenant + owner
//                                        user → ingest the scrape as the
//                                        Tier-1 "Basis" doc → send the
//                                        SendGrid verification email → log in
//   GET  /onboarding/verify?token=…   → mark the owner's email verified
//   GET  /onboarding/industries       → the curated vertical list for the
//                                        signup dropdown
//
// Tenant + user are created at finalize, not at start — an abandoned signup
// leaves only a Redis key that expires on its own, never an orphan tenant.

const crypto = require('crypto');
const express = require('express');
const redis = require('./redis');
const db = require('./db');
const users = require('./users');
const auth = require('./auth');
const email = require('./email');
const gemini = require('./gemini');
const web = require('./knowledge/web');
const kbService = require('./knowledge/service');

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net').replace(/\/+$/, '');
const SESSION_TTL_SEC = parseInt(process.env.ONBOARDING_SESSION_TTL_SEC || '1800', 10); // 30 min
const SCRAPE_STALE_SEC = parseInt(process.env.ONBOARDING_SCRAPE_STALE_SEC || '120', 10); // PENDING→FAILED after this
const TRIAL_DAYS = parseInt(process.env.ONBOARDING_TRIAL_DAYS || '14', 10);
const MIN_PASSWORD_LEN = parseInt(process.env.ONBOARDING_MIN_PASSWORD_LEN || '12', 10);
const BRIEF_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Public email providers — corporate-email gate. Not exhaustive but covers
// the long tail of consumer mailboxes that show up in B2B signups.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com',
  'rocketmail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me', 'tutanota.com', 'tuta.io',
  'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'email.com', 'usa.com',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'fastmail.com',
  'hey.com', 'hushmail.com', 'qq.com', '163.com', '126.com', 'sina.com',
  'web.de', 'aol.co.uk', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
]);

// Curated verticals for the signup dropdown. Order = how they appear.
const INDUSTRIES = [
  'Financial Services / FinTech',
  'Banking',
  'Insurance',
  'SaaS / Software',
  'IT Services & Consulting',
  'Cybersecurity',
  'Healthcare & Life Sciences',
  'Pharmaceuticals & Biotech',
  'Manufacturing',
  'Industrial & Engineering',
  'Mining & Metals',
  'Energy & Utilities',
  'Telecommunications',
  'Media & Entertainment',
  'Retail & E-commerce',
  'Consumer Goods',
  'Logistics & Supply Chain',
  'Real Estate & PropTech',
  'Construction',
  'Education & EdTech',
  'Government & Public Sector',
  'Professional Services',
  'Travel & Hospitality',
  'Automotive',
  'Agriculture & AgTech',
  'Non-profit',
  'Other',
];

// ---------------------------------------------------------------- helpers

function sessionKey(id)       { return `onboarding:${id}`; }
function emailIndexKey(email) { return `onboarding:email:${email.toLowerCase()}`; }

async function loadSession(id) {
  const raw = await redis.get(sessionKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveSession(s, ttlSec = SESSION_TTL_SEC) {
  await redis.set(sessionKey(s.id), JSON.stringify(s), 'EX', ttlSec);
}

// Strip protocol / www / path → registrable-ish host. "https://www.acme.com/x"
// → "acme.com". Not a full public-suffix parse, but good enough for the gate.
function hostFromWebsite(website) {
  let h = String(website || '').trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/^www\./, '');
  h = h.split('/')[0].split('?')[0].split('#')[0];
  return h;
}

function domainFromEmail(addr) {
  const m = String(addr || '').trim().toLowerCase().match(/^[^@\s]+@([^@\s]+)$/);
  return m ? m[1] : null;
}

// True when the two hosts share a registrable domain (one is the other or a
// subdomain of it). Handles website acme.com + email @mail.acme.com and vice
// versa without dragging in a public-suffix list.
function domainsRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('.' + b) || b.endsWith('.' + a);
}

function normalizeWebsiteUrl(website) {
  let w = String(website || '').trim();
  if (!w) return null;
  if (!/^https?:\/\//i.test(w)) w = 'https://' + w;
  try { return new URL(w).toString(); }
  catch { return null; }
}

// ---------------------------------------------------------------- the scrape + brief job

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    missionStatement: { type: 'string', description: 'One sentence describing what the company does and for whom.' },
    keyProducts:      { type: 'array', items: { type: 'string' }, description: 'Named product lines or core offerings.' },
    primaryAudience:  { type: 'string', description: 'Who buys from / uses this company.' },
    valuePropCount:   { type: 'integer', description: 'Roughly how many distinct value propositions / benefit claims the site makes.' },
  },
  required: ['missionStatement', 'keyProducts', 'primaryAudience', 'valuePropCount'],
};

const BRIEF_PROMPT =
  "You are GhostStream's onboarding assistant. You're given the markdown of a " +
  "company's website. Summarize it for the user to CONFIRM we indexed their " +
  "business correctly. Be concrete — quote real product names from the page. " +
  "Return: missionStatement (1 sentence), keyProducts (array of named offerings " +
  "found on the page), primaryAudience (who they sell to), valuePropCount " +
  "(rough count of distinct benefit/value claims on the page).";

// Generate the 3-bullet brief from scraped markdown. Falls back to a minimal
// brief built from the page metadata if Gemini is unavailable or errors.
async function generateBrief(markdown, meta) {
  const fallback = () => ({
    missionStatement: (meta && (meta.description || meta.title)) || 'We indexed your homepage.',
    keyProducts: [],
    primaryAudience: '',
    valuePropCount: 0,
    headline: meta && meta.title ? `Indexed: ${meta.title}` : 'We scanned your homepage.',
    source: 'metadata',
  });
  try {
    const ai = gemini.getClient();
    const resp = await ai.models.generateContent({
      model: BRIEF_MODEL,
      contents: [{ role: 'user', parts: [{ text: `${BRIEF_PROMPT}\n\n---WEBSITE CONTENT---\n${String(markdown).slice(0, 20000)}` }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 700,
        responseMimeType: 'application/json',
        responseSchema: BRIEF_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const parsed = JSON.parse(resp.text);
    const productCount = Array.isArray(parsed.keyProducts) ? parsed.keyProducts.length : 0;
    const vpCount = Number.isFinite(parsed.valuePropCount) ? parsed.valuePropCount : 0;
    const headline = productCount || vpCount
      ? `We've identified ${productCount} product line${productCount === 1 ? '' : 's'} and ${vpCount} core value proposition${vpCount === 1 ? '' : 's'} from your site.`
      : `We've indexed your site. Does this look right?`;
    return { ...parsed, keyProducts: parsed.keyProducts || [], headline, source: 'gemini' };
  } catch (err) {
    console.warn('[onboarding] brief generation failed, using metadata fallback:', err.message);
    return fallback();
  }
}

// Background job: scrape the company website, build the brief, write both back
// onto the session. Never throws — failures land as status SCRAPE_FAILED.
async function runScrapeJob(sessionId) {
  let s;
  try {
    s = await loadSession(sessionId);
    if (!s || s.status !== 'PENDING_SCRAPE') return;

    if (!web.isConfigured()) {
      s.status = 'SCRAPE_FAILED';
      s.error = 'website research is temporarily unavailable — you can continue and add details later';
      await saveSession(s);
      return;
    }

    const data = await web.scrape(s.website);
    const markdown = String(data.markdown || '').trim();
    if (markdown.length < 50) {
      s.status = 'SCRAPE_FAILED';
      s.error = "we couldn't read your website (it may block crawlers or be JS-only) — you can continue and add details later";
      await saveSession(s);
      return;
    }
    const meta = data.metadata || {};
    s.scrape = {
      markdown,
      title: meta.title || null,
      description: meta.description || null,
      sourceUrl: meta.sourceURL || meta.url || s.website,
      publishedTime: meta.publishedTime || meta.modifiedTime || null,
    };
    s.brief = await generateBrief(markdown, meta);
    s.status = 'SCRAPE_READY';
    s.error = null;
    await saveSession(s);
  } catch (err) {
    console.warn(`[onboarding] scrape job failed for ${sessionId}: ${err.message}`);
    try {
      if (s) {
        s.status = 'SCRAPE_FAILED';
        s.error = "we couldn't research your website right now — you can continue and add details later";
        await saveSession(s);
      }
    } catch { /* swallow */ }
  }
}

// ---------------------------------------------------------------- router

const router = express.Router();
router.use(express.json());

router.get('/industries', (_req, res) => {
  res.json({ industries: INDUSTRIES });
});

// POST /onboarding/start
// Body: { companyName, industry, website, email }
router.post('/start', async (req, res, next) => {
  try {
    const { companyName, industry, website, email: rawEmail } = req.body || {};
    if (!companyName || typeof companyName !== 'string' || companyName.trim().length < 2) {
      return res.status(400).json({ error: 'companyName required' });
    }
    if (!industry || !INDUSTRIES.includes(industry)) {
      return res.status(400).json({ error: 'industry required (must be one of the provided options)' });
    }
    const websiteUrl = normalizeWebsiteUrl(website);
    if (!websiteUrl) return res.status(400).json({ error: 'a valid company website is required' });
    const websiteDomain = hostFromWebsite(websiteUrl);
    if (!websiteDomain || !websiteDomain.includes('.')) {
      return res.status(400).json({ error: 'a valid company website is required' });
    }

    const emailAddr = String(rawEmail || '').trim().toLowerCase();
    const emailDomain = domainFromEmail(emailAddr);
    if (!emailDomain) return res.status(400).json({ error: 'a valid work email is required' });
    if (PUBLIC_EMAIL_DOMAINS.has(emailDomain)) {
      return res.status(422).json({
        error: 'Please use your corporate email to unlock GhostStream\'s enterprise intelligence — public mailboxes (Gmail, Outlook, Yahoo, …) aren\'t supported.',
        code: 'PUBLIC_EMAIL',
      });
    }
    if (!domainsRelated(emailDomain, websiteDomain)) {
      return res.status(422).json({
        error: `Your email domain (${emailDomain}) doesn't match your company website (${websiteDomain}). Use your work email at ${websiteDomain}.`,
        code: 'EMAIL_DOMAIN_MISMATCH',
      });
    }

    // Already-registered email → tell them, don't create a duplicate.
    const existingUser = await users.findByEmail(emailAddr);
    if (existingUser) {
      return res.status(409).json({
        error: 'An account with this email already exists. Sign in instead.',
        code: 'EMAIL_EXISTS',
      });
    }
    // Already-registered company domain → ask them to get invited.
    const existingTenant = await db.query(
      `SELECT id, name FROM tenants WHERE lower(domain) = $1 LIMIT 1`,
      [websiteDomain]
    );
    if (existingTenant.rows[0]) {
      return res.status(409).json({
        error: `${existingTenant.rows[0].name} already has a GhostStream workspace. Ask a teammate to invite you.`,
        code: 'TENANT_EXISTS',
        tenant: { id: existingTenant.rows[0].id, name: existingTenant.rows[0].name },
      });
    }

    // Re-use an in-flight session for the same email (page refresh, retry).
    const existingSessionId = await redis.get(emailIndexKey(emailAddr));
    if (existingSessionId) {
      const existing = await loadSession(existingSessionId);
      if (existing && existing.status !== 'FINALIZED') {
        return res.status(200).json({ sessionId: existing.id, status: existing.status });
      }
    }

    const session = {
      id: crypto.randomUUID(),
      companyName: companyName.trim(),
      industry,
      website: websiteUrl,
      websiteDomain,
      email: emailAddr,
      emailDomain,
      status: 'PENDING_SCRAPE',
      createdAt: new Date().toISOString(),
      scrape: null,
      brief: null,
      error: null,
    };
    await saveSession(session);
    await redis.set(emailIndexKey(emailAddr), session.id, 'EX', SESSION_TTL_SEC);

    // Fire the scrape in the background — don't block the response.
    runScrapeJob(session.id);

    res.status(201).json({ sessionId: session.id, status: session.status });
  } catch (err) { next(err); }
});

// GET /onboarding/:id/status
router.get('/:id/status', async (req, res, next) => {
  try {
    let s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'onboarding session not found or expired' });

    // Watchdog: a PENDING scrape that's been running too long is dead (process
    // restart, hung fetch). Flip it so the UI stops spinning.
    if (s.status === 'PENDING_SCRAPE') {
      const ageSec = (Date.now() - new Date(s.createdAt).getTime()) / 1000;
      if (ageSec > SCRAPE_STALE_SEC) {
        s.status = 'SCRAPE_FAILED';
        s.error = "researching your website is taking too long — you can continue and add details later";
        await saveSession(s);
      }
    }

    res.json({
      sessionId: s.id,
      status: s.status,
      companyName: s.companyName,
      industry: s.industry,
      website: s.website,
      email: s.email,
      brief: s.brief || null,
      scrapeTitle: s.scrape ? s.scrape.title : null,
      error: s.error || null,
    });
  } catch (err) { next(err); }
});

// POST /onboarding/:id/finalize
// Body: { password }
router.post('/:id/finalize', async (req, res, next) => {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'onboarding session not found or expired' });
    if (s.status === 'FINALIZED') return res.status(409).json({ error: 'this onboarding has already been completed' });

    const password = (req.body && req.body.password) || '';
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
    }

    // Re-check the email/domain race (someone could have signed up in the gap).
    if (await users.findByEmail(s.email)) {
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.', code: 'EMAIL_EXISTS' });
    }
    const dup = await db.query(`SELECT id FROM tenants WHERE lower(domain) = $1 LIMIT 1`, [s.websiteDomain]);
    if (dup.rows[0]) {
      return res.status(409).json({ error: 'A workspace for this company domain already exists. Ask a teammate to invite you.', code: 'TENANT_EXISTS' });
    }

    // Create the tenant + owner user.
    const tenantRow = (await db.query(
      `INSERT INTO tenants (name, domain, subscription_status, trial_ends_at)
       VALUES ($1, $2, 'TRIAL', now() + ($3 || ' days')::interval)
       RETURNING id, name, domain, subscription_status, trial_ends_at`,
      [s.companyName, s.websiteDomain, String(TRIAL_DAYS)]
    )).rows[0];

    const passwordHash = await users.hashPassword(password);
    const owner = await users.create({
      tenantId: tenantRow.id,
      email: s.email,
      passwordHash,
      name: null,
      role: 'owner',
      isAdmin: false,
      emailVerified: false,
    });

    // Best-effort: ingest the scraped homepage as the Tier-1 "Basis" doc for
    // the new tenant. A failure here must not block the signup.
    let basisDocId = null;
    if (s.scrape && s.scrape.markdown) {
      try {
        const doc = await kbService.ingest({
          tenantId: tenantRow.id,
          file: {
            buffer: Buffer.from(s.scrape.markdown, 'utf8'),
            mimetype: 'text/markdown',
            originalname: 'company-homepage.md',
          },
          category: 'PRODUCT_INTEL',
          title: `${s.companyName} — homepage`,
          streamType: 'WEB',
          scope: 'TENANT', // the customer's own company → Basis
          sourceUrl: s.scrape.sourceUrl || s.website,
          effectiveDate: s.scrape.publishedTime || null,
          metadata: { onboarding: true, industry: s.industry, scrapedTitle: s.scrape.title || null },
        });
        basisDocId = doc && doc.id;
      } catch (err) {
        console.warn('[onboarding] basis ingest failed (non-fatal):', err.message);
      }
    }

    // Best-effort: send the email-verification link.
    let emailSent = false;
    const verifyUrl = `${APP_BASE_URL}/api/onboarding/verify?token=${encodeURIComponent(owner.emailVerificationToken)}`;
    if (email.isConfigured()) {
      try {
        await email.send({
          to: s.email,
          subject: 'Verify your GhostStream email',
          categories: ['onboarding-verify'],
          html:
            `<p>Welcome to GhostStream — your <strong>${escapeHtml(s.companyName)}</strong> workspace is live.</p>` +
            `<p>Confirm this email address to finish setting up your account:</p>` +
            `<p><a href="${verifyUrl}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Verify email</a></p>` +
            `<p style="color:#6b7280;font-size:13px">Or paste this link into your browser:<br>${verifyUrl}</p>`,
          text: `Welcome to GhostStream. Verify your email: ${verifyUrl}`,
        });
        emailSent = true;
      } catch (err) {
        console.warn('[onboarding] verification email failed (non-fatal):', err.message);
      }
    }

    // Mark the session done (short grace TTL so a double-submit gets the 409).
    s.status = 'FINALIZED';
    s.tenantId = tenantRow.id;
    await saveSession(s, 300);
    await redis.del(emailIndexKey(s.email));

    // Auto-login: issue the session cookie.
    const publicUser = {
      id: owner.id, tenantId: owner.tenantId, email: owner.email,
      name: owner.name, role: owner.role, isAdmin: owner.isAdmin,
    };
    res.cookie(auth.COOKIE_NAME, auth.signToken(publicUser), auth.cookieOptions());

    res.status(201).json({
      ok: true,
      tenant: { id: tenantRow.id, name: tenantRow.name, domain: tenantRow.domain, trialEndsAt: tenantRow.trial_ends_at },
      user: { id: owner.id, email: owner.email, role: owner.role, emailVerified: false },
      basisIndexed: !!basisDocId,
      emailSent,
      redirectTo: '/admin/',
    });
  } catch (err) { next(err); }
});

// GET /onboarding/verify?token=…  — tiny HTML page, linked from the email.
router.get('/verify', async (req, res, next) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).type('html').send(verifyPage('Missing verification token.', false));
    const user = await users.findByVerificationToken(String(token));
    if (!user) return res.status(404).type('html').send(verifyPage('This verification link is invalid or has already been used.', false));
    await users.markEmailVerified(user.id);
    res.type('html').send(verifyPage('Your email is verified. You can close this tab and head back to GhostStream.', true));
  } catch (err) { next(err); }
});

function verifyPage(message, ok) {
  return `<!doctype html><meta charset="utf-8"><title>GhostStream — Email verification</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111">` +
    `<h1 style="font-size:20px">${ok ? '✓ Verified' : 'Verification failed'}</h1>` +
    `<p style="color:#374151">${escapeHtml(message)}</p>` +
    `<p><a href="${APP_BASE_URL}/admin/" style="color:#4f46e5;font-weight:600">Go to GhostStream →</a></p></body>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { router, INDUSTRIES };
