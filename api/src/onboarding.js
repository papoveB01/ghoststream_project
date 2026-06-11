// Free-trial onboarding — verification-gated signup.
//
// Public (no-auth) flow that turns a website + a corporate email into a new
// tenant — but only after the email is confirmed. Nothing (tenant, user, or
// scrape) comes into existence until the link is clicked.
//
//   POST /onboarding/start            → validate (corporate email matching the
//                                        website domain) + password → store a
//                                        PENDING_VERIFY session (Redis, 24h,
//                                        bcrypt hash only) → email a verify link.
//                                        NOTHING is created or scraped yet.
//   GET  /onboarding/:id/status       → poll PENDING_VERIFY → FINALIZED so the
//                                        original tab can redirect once confirmed
//   GET  /onboarding/verify?token=…   → confirm interstitial (button POSTs)
//   POST /onboarding/verify { token } → on confirm: create tenant + owner
//                                        (email-verified) → log in → land on the
//                                        Company → Intel tab (welcome mode), where
//                                        the company data is pulled from their
//                                        website and confirmed before being filed.
//   GET  /onboarding/industries       → the curated vertical list for the dropdown
//
// An abandoned signup leaves only a Redis key that expires.

const crypto = require('crypto');
const express = require('express');
const redis = require('./redis');
const db = require('./db');
const users = require('./users');
const auth = require('./auth');
const email = require('./email');
const billing = require('./billing');
const plans = require('./plans');
const enrichment = require('./enrichment');

// Paid plans a new signup can opt straight into from the public funnel (an
// immediate upsell). Everyone starts on the free tier regardless; picking one of
// these just routes them to Checkout after the account is created. (Enterprise =
// contact sales, not here.)
const SIGNUP_PLANS = new Set(['starter', 'pro']);

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://dealscope.io').replace(/\/+$/, '');
const SESSION_TTL_SEC = parseInt(process.env.ONBOARDING_SESSION_TTL_SEC || '1800', 10); // 30 min
const VERIFY_TTL_SEC = parseInt(process.env.ONBOARDING_VERIFY_TTL_SEC || '86400', 10); // 24h to click the email link
const MIN_PASSWORD_LEN = parseInt(process.env.ONBOARDING_MIN_PASSWORD_LEN || '12', 10);

// Where a freshly-verified owner lands: the Company → Intel tab in "welcome"
// mode, which auto-runs the pull-from-website + confirm bootstrap.
const WELCOME_REDIRECT = '/admin/#company?tab=intel&welcome=1';

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

// Curated verticals for the signup dropdown. Alphabetical, with the "Other"
// catch-all pinned last.
const INDUSTRIES = [
  'Agriculture & AgTech',
  'AI & ML',
  'AI Applications and Services',
  'AI Business and Consulting',
  'AI Infrastructure',
  'Automotive',
  'Banking',
  'Construction',
  'Consumer Goods',
  'Cybersecurity',
  'Education & EdTech',
  'Energy & Utilities',
  'Financial Services / FinTech',
  'Government & Public Sector',
  'Healthcare & Life Sciences',
  'Industrial & Engineering',
  'Insurance',
  'IT Services & Consulting',
  'Logistics & Supply Chain',
  'Manufacturing',
  'Media & Entertainment',
  'Mining & Metals',
  'Non-profit',
  'Pharmaceuticals & Biotech',
  'Professional Services',
  'Real Estate & PropTech',
  'Retail & E-commerce',
  'SaaS / Software',
  'Telecommunications',
  'Travel & Hospitality',
  'Other',
];

// GTM role of the person signing up (onboarding step 2). Stored on
// users.job_title as the stable `value` — distinct from the tenancy role
// (owner/manager/rep). Labels live in the frontend; the server validates the
// value against this allow-list.
const JOB_ROLES = [
  'founder',           // Founder / CEO / Owner
  'sales_leader',      // Sales / Revenue leader (VP, CRO, Head of Sales)
  'sales_manager',     // Sales Manager / Team Lead
  'account_executive', // Account Executive (AE)
  'sdr_bdr',           // SDR / BDR
  'rev_ops',           // Sales / Revenue Operations (RevOps)
  'enablement',        // Sales Enablement
  'sales_engineer',    // Solutions / Sales Engineer
  'customer_success',  // Customer Success / Account Management
  'marketing',         // Marketing
  'consultant',        // Consultant / Agency
  'other',             // Other
];

// Company employee-count buckets (onboarding step 1) → tenants.company_size.
const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '500+'];

// ---------------------------------------------------------------- helpers

function sessionKey(id)       { return `onboarding:${id}`; }
function emailIndexKey(email) { return `onboarding:email:${email.toLowerCase()}`; }
function verifyIndexKey(tok)  { return `onboarding:verify:${tok}`; }

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
    const { firstName: rawFirst, lastName: rawLast, companyName, industry, website, email: rawEmail, password, jobTitle: rawJobTitle, companySize: rawCompanySize } = req.body || {};
    // Only an explicit paid choice routes to Checkout; everything else is FREE.
    // (Previously defaulted to 'starter', which sent standard "Start free"
    // signups to Stripe — wrong, especially once live keys are configured.)
    const plan = SIGNUP_PLANS.has(String((req.body && req.body.plan) || '')) ? req.body.plan : 'free';
    const jobTitle = String(rawJobTitle || '').trim();
    const companySize = String(rawCompanySize || '').trim();
    const firstName = String(rawFirst || '').trim();
    const lastName = String(rawLast || '').trim();
    if (!firstName || firstName.length > 100) {
      return res.status(400).json({ error: 'first name required' });
    }
    if (!lastName || lastName.length > 100) {
      return res.status(400).json({ error: 'last name required' });
    }
    if (!companyName || typeof companyName !== 'string' || companyName.trim().length < 2) {
      return res.status(400).json({ error: 'companyName required' });
    }
    if (!industry || !INDUSTRIES.includes(industry)) {
      return res.status(400).json({ error: 'industry required (must be one of the provided options)' });
    }
    if (!companySize || !COMPANY_SIZES.includes(companySize)) {
      return res.status(400).json({ error: 'company size required (must be one of the provided options)' });
    }
    if (!jobTitle || !JOB_ROLES.includes(jobTitle)) {
      return res.status(400).json({ error: 'role required (must be one of the provided options)' });
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
        error: 'Please use your corporate email to unlock DealScope\'s enterprise intelligence — public mailboxes (Gmail, Outlook, Yahoo, …) aren\'t supported.',
        code: 'PUBLIC_EMAIL',
      });
    }
    if (!domainsRelated(emailDomain, websiteDomain)) {
      return res.status(422).json({
        error: `Your email domain (${emailDomain}) doesn't match your company website (${websiteDomain}). Use your work email at ${websiteDomain}.`,
        code: 'EMAIL_DOMAIN_MISMATCH',
      });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.`, code: 'WEAK_PASSWORD' });
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
        error: `${existingTenant.rows[0].name} already has a DealScope workspace. Ask a teammate to invite you.`,
        code: 'TENANT_EXISTS',
        tenant: { id: existingTenant.rows[0].id, name: existingTenant.rows[0].name },
      });
    }

    const passwordHash = await users.hashPassword(password);

    // Re-use an in-flight (unverified) session for the same email — refresh the
    // details + re-send the link rather than erroring (covers retries/resends).
    let session = null;
    const existingSessionId = await redis.get(emailIndexKey(emailAddr));
    if (existingSessionId) {
      const existing = await loadSession(existingSessionId);
      if (existing && existing.status === 'PENDING_VERIFY') session = existing;
    }
    if (session) {
      session.firstName = firstName;
      session.lastName = lastName;
      session.jobTitle = jobTitle;
      session.plan = plan;
      session.companyName = companyName.trim();
      session.industry = industry;
      session.companySize = companySize;
      session.website = websiteUrl;
      session.websiteDomain = websiteDomain;
      session.passwordHash = passwordHash; // they may have re-typed a new one
    } else {
      session = {
        id: crypto.randomUUID(),
        firstName,
        lastName,
        jobTitle,
        plan,
        companyName: companyName.trim(),
        industry,
        companySize,
        website: websiteUrl,
        websiteDomain,
        email: emailAddr,
        emailDomain,
        passwordHash,
        verifyToken: crypto.randomBytes(24).toString('hex'),
        status: 'PENDING_VERIFY',
        createdAt: new Date().toISOString(),
      };
    }
    await saveSession(session, VERIFY_TTL_SEC);
    await redis.set(emailIndexKey(emailAddr), session.id, 'EX', VERIFY_TTL_SEC);
    await redis.set(verifyIndexKey(session.verifyToken), session.id, 'EX', VERIFY_TTL_SEC);

    // Send the verification link. The account + the company-data pull come into
    // being ONLY when this link is confirmed — nothing is created here.
    const verifyUrl = `${APP_BASE_URL}/api/onboarding/verify?token=${encodeURIComponent(session.verifyToken)}`;
    let emailSent = false;
    if (email.isConfigured()) {
      try {
        await email.send({
          to: emailAddr,
          subject: 'Confirm your email to set up DealScope',
          categories: ['onboarding-verify'],
          html:
            `<p>You're almost there — confirm this email to create your <strong>${escapeHtml(session.companyName)}</strong> workspace.</p>` +
            `<p><a href="${verifyUrl}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Confirm &amp; set up workspace</a></p>` +
            `<p style="color:#6b7280;font-size:13px">Or paste this link into your browser:<br>${verifyUrl}</p>` +
            `<p style="color:#6b7280;font-size:13px">This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>`,
          text: `Confirm your email to set up DealScope: ${verifyUrl}`,
        });
        emailSent = true;
      } catch (err) {
        console.warn('[onboarding] verification email failed:', err.message);
      }
    }

    res.status(201).json({
      sessionId: session.id,
      status: 'PENDING_VERIFY',
      email: emailAddr,
      emailSent,
      // Dev fallback (no SendGrid): surface the link so signup is testable.
      ...(email.isConfigured() ? {} : { verifyUrl }),
    });
  } catch (err) { next(err); }
});

// GET /onboarding/:id/status
// Polled by the "check your email" screen so the original tab can redirect once
// the link has been confirmed in this browser (PENDING_VERIFY → FINALIZED).
router.get('/:id/status', async (req, res, next) => {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'onboarding session not found or expired' });
    res.json({
      sessionId: s.id,
      status: s.status, // PENDING_VERIFY | FINALIZED
      companyName: s.companyName,
      email: s.email,
      redirectTo: s.status === 'FINALIZED' ? (s.checkoutUrl || WELCOME_REDIRECT) : null,
    });
  } catch (err) { next(err); }
});

// GET /onboarding/verify?token=… — the email link lands here. It renders a
// confirm page whose button POSTs to /verify. Side effects live on the POST so
// that email-scanner / prefetch GETs never create an account.
router.get('/verify', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).type('html').send(verifyPage('Missing verification token.', false));
    const sid = await redis.get(verifyIndexKey(token));
    const s = sid ? await loadSession(sid) : null;
    if (!s) return res.status(404).type('html').send(verifyPage('This link is invalid or has expired. Please sign up again.', false));
    if (s.status === 'FINALIZED') return res.redirect('/admin/');
    res.type('html').send(confirmPage(token, s.companyName));
  } catch (err) { next(err); }
});

// POST /onboarding/verify { token } — the actual provisioning, only after the
// user confirms. Creates the tenant + owner (verified) and logs in; the
// company-data pull happens on the Company → Intel tab they land on.
// Getting-started welcome to the brand-new owner. Plan facts come from the
// catalog (free tier, v2) so the copy never drifts from real entitlements.
async function sendWelcomeEmail({ to, firstName, companyName }) {
  const email = require('./email');
  if (!email.isConfigured() || !to) return;
  const plans = require('./plans');
  const free = plans.planFor('trial', 2) || { caps: {} };
  const researchCap = free.caps.research || 5;
  const engCap = free.caps.engagements || 1;
  const base = (APP_BASE_URL || 'https://dealscope.io').replace(/\/$/, '');
  const hi = firstName ? `Welcome to DealScope, ${firstName}!` : 'Welcome to DealScope!';
  const ws = companyName ? `the <strong>${companyName}</strong> workspace` : 'your workspace';
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#15181b">
    <div style="padding:22px 0 14px"><span style="display:inline-block;background:#1e7d45;color:#fff;font-weight:800;border-radius:7px;padding:6px 11px">D</span>
      <span style="font-size:18px;font-weight:700;margin-left:8px">DealScope</span></div>
    <h1 style="font-size:21px;margin:6px 0 4px">${hi}</h1>
    <p style="font-size:14.5px;line-height:1.6;color:#54595f;margin:0 0 16px">
      Thanks for setting up ${ws}. DealScope is your AI sales-intelligence cockpit — it learns your
      business, finds the buyers most likely to need you, sits in on your sales calls, and turns every
      conversation into a ready-to-send follow-up.
    </p>
    <div style="border:1px solid #e3e5e0;border-radius:8px;padding:14px 18px;margin:0 0 16px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1e7d45;margin-bottom:6px">Get the most from your first session</div>
      <ol style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">
        <li><strong>Ground your workspace</strong> — on the Company page, hit “Enrich from web” and we'll build your positioning, products and buyer personas from your own website.</li>
        <li><strong>Discover prospects &amp; competitors</strong> — the green “Discover” buttons run AI web research matched to who <em>you</em> sell to.</li>
        <li><strong>Put the AI in a call</strong> — schedule an engagement and DealScope joins, briefs you beforehand, and analyses how it went.</li>
      </ol>
    </div>
    <p style="font-size:14px;line-height:1.6;color:#54595f;margin:0 0 18px">
      Your Free plan includes a one-time sample of <strong>${researchCap} AI research runs</strong> and
      <strong>${engCap} AI-joined call${engCap === 1 ? '' : 's'}</strong> — everything else (battlecards, the Market Map, proposals) is yours to explore.
    </p>
    <a href="${base}/admin/" style="display:inline-block;background:#1e7d45;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:6px;padding:10px 18px">Open your workspace</a>
    <p style="font-size:12px;color:#8c9197;margin:22px 0 8px">Stuck or curious about anything? Just reply — a human reads these.</p>
  </div>`;
  const text = `${firstName ? `Welcome to DealScope, ${firstName}!` : 'Welcome to DealScope!'}\n\n` +
    `Thanks for setting up ${companyName ? `the ${companyName} workspace` : 'your workspace'}.\n\n` +
    `Get the most from your first session:\n` +
    `1. Ground your workspace — on the Company page, hit "Enrich from web".\n` +
    `2. Discover prospects & competitors — the green "Discover" buttons run AI web research matched to who YOU sell to.\n` +
    `3. Put the AI in a call — schedule an engagement and DealScope joins, briefs you, and analyses how it went.\n\n` +
    `Your Free plan includes a one-time sample of ${researchCap} AI research runs and ${engCap} AI-joined call${engCap === 1 ? '' : 's'}.\n\n` +
    `Open your workspace: ${base}/admin/\n\nStuck or curious? Just reply — a human reads these.`;
  await email.send({ to, subject: 'Welcome to DealScope — your sales intelligence cockpit is ready', html, text, categories: ['welcome'] });
  console.log(`[onboarding] welcome email sent to ${to}`);
}

router.post('/verify', async (req, res, next) => {
  try {
    const token = String((req.body && req.body.token) || '');
    const sid = token ? await redis.get(verifyIndexKey(token)) : null;
    const s = sid ? await loadSession(sid) : null;
    if (!s) return res.status(404).json({ error: 'This verification link is invalid or has expired.' });
    if (s.status === 'FINALIZED') return res.json({ ok: true, redirectTo: s.checkoutUrl || WELCOME_REDIRECT });

    // Race gate: someone may have claimed the email/domain since /start.
    if (await users.findByEmail(s.email)) {
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.', code: 'EMAIL_EXISTS' });
    }
    const dup = await db.query(`SELECT id FROM tenants WHERE lower(domain) = $1 LIMIT 1`, [s.websiteDomain]);
    if (dup.rows[0]) {
      return res.status(409).json({ error: 'A workspace for this company domain already exists. Ask a teammate to invite you.', code: 'TENANT_EXISTS' });
    }

    // Everyone starts on the free tier: an active TRIAL tenant with NO end date
    // (perpetual, no card — see entitlements.accessState). If they opted into a
    // paid plan we still create them free, then route to Checkout below as an
    // immediate upsell; the webhook upgrades them on success. Abandoning Checkout
    // simply leaves them on the free tier — never accidental paid access.
    const paidChoice = SIGNUP_PLANS.has(s.plan) ? s.plan : null;

    const tenantRow = (await db.query(
      `INSERT INTO tenants (name, domain, subscription_status, plan, trial_ends_at, company_size, plan_version)
       VALUES ($1, $2, 'TRIAL', 'trial', NULL, $3, 2)
       RETURNING id, name, domain, subscription_status, plan, trial_ends_at`,
      [s.companyName, s.websiteDomain, s.companySize || null]
    )).rows[0];
    const owner = await users.create({
      tenantId: tenantRow.id,
      email: s.email,
      passwordHash: s.passwordHash,
      firstName: s.firstName || null,
      lastName: s.lastName || null,
      role: 'owner',
      jobTitle: s.jobTitle || null,
      isAdmin: false,
      emailVerified: true,
    });

    // Welcome email — fire-and-forget so it never delays the signup redirect.
    sendWelcomeEmail({ to: s.email, firstName: s.firstName, companyName: s.companyName })
      .catch((e) => console.warn(`[onboarding] welcome email failed for ${s.email}: ${(e && e.message) || e}`));

    // Free signups land straight in the in-app welcome setup (no card). A paid
    // opt-in goes to Stripe Checkout (paid immediately, no trial); on success it
    // lands in the same welcome setup and the webhook upgrades the plan.
    let redirectTo = WELCOME_REDIRECT;
    if (paidChoice && billing.isConfigured()) {
      try {
        const checkout = await billing.createCheckout({
          tenantId: tenantRow.id,
          email: s.email,
          plan: paidChoice,
          trial: false, // no trial on paid plans anymore
          successUrl: `${APP_BASE_URL}/admin/?cs={CHECKOUT_SESSION_ID}#company?tab=intel&welcome=1`,
          cancelUrl: `${APP_BASE_URL}/admin/#billing?checkout=cancel`,
        });
        redirectTo = checkout.url;
      } catch (e) {
        console.warn('[onboarding] checkout creation failed:', e.message);
        redirectTo = '/admin/#billing'; // land on Billing so they can upgrade manually
      }
    }

    // Close out the session + lookup indexes (short grace TTL for double-clicks).
    // Stash the redirect so the original (polling) tab also lands on Checkout.
    s.status = 'FINALIZED';
    s.tenantId = tenantRow.id;
    s.checkoutUrl = redirectTo;
    await saveSession(s, 300);
    await redis.del(emailIndexKey(s.email));
    if (s.verifyToken) await redis.del(verifyIndexKey(s.verifyToken));

    // Auto-login (so the post-checkout return is authenticated and /billing/confirm works).
    res.cookie(auth.COOKIE_NAME, auth.signToken({
      id: owner.id, tenantId: owner.tenantId, email: owner.email,
      name: owner.name, role: owner.role, isAdmin: owner.isAdmin,
    }), auth.cookieOptions());

    // Auto-enrich the brand-new tenant's foundation from multiple sources
    // (website + Apollo + news) in the background, so by the time the owner looks
    // around their products have descriptions and their ICP/positioning are
    // drafted. Fire-and-forget: never blocks (or fails) onboarding.
    setImmediate(() => {
      db.runWithTenant(tenantRow.id, () => enrichment.enrichCompany(tenantRow.id, { force: false }))
        .then((r) => console.log(`[onboarding] auto-enriched ${tenantRow.id}: ${JSON.stringify(r.summary)}`))
        .catch((e) => console.warn(`[onboarding] auto-enrich failed for ${tenantRow.id}: ${(e && e.message) || e}`));
    });

    res.status(201).json({ ok: true, redirectTo });
  } catch (err) { next(err); }
});

// The confirm interstitial: a button that POSTs the token (so prefetch GETs of
// the email link are inert).
function confirmPage(token, companyName) {
  const t = escapeHtml(token);
  return `<!doctype html><meta charset="utf-8"><title>DealScope — Confirm your email</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111">` +
    `<h1 style="font-size:20px">Confirm your email</h1>` +
    `<p style="color:#374151">Finish setting up your <strong>${escapeHtml(companyName)}</strong> workspace.</p>` +
    `<button id="go" style="padding:11px 22px;background:#4f46e5;color:#fff;border:0;border-radius:6px;font-weight:600;font-size:15px;cursor:pointer">Confirm &amp; open my workspace</button>` +
    `<p id="msg" style="color:#6b7280;margin-top:14px"></p>` +
    `<script>(function(){var b=document.getElementById('go'),m=document.getElementById('msg');b.addEventListener('click',function(){b.disabled=true;b.textContent='Setting up…';fetch('/api/onboarding/verify',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({token:'${t}'})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});}).then(function(x){if(x.ok&&x.j.redirectTo){location.href=x.j.redirectTo;}else{b.disabled=false;b.textContent='Confirm & open my workspace';m.textContent=(x.j&&x.j.error)||'Something went wrong — please try again.';}}).catch(function(){b.disabled=false;b.textContent='Confirm & open my workspace';m.textContent='Network error — please try again.';});});})();</script></body>`;
}

function verifyPage(message, ok) {
  return `<!doctype html><meta charset="utf-8"><title>DealScope — Email verification</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111">` +
    `<h1 style="font-size:20px">${ok ? '✓ Verified' : 'Verification failed'}</h1>` +
    `<p style="color:#374151">${escapeHtml(message)}</p>` +
    `<p><a href="${APP_BASE_URL}/admin/" style="color:#4f46e5;font-weight:600">Go to DealScope →</a></p></body>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { router, INDUSTRIES };
