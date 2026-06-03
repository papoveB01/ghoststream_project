// Billing — Stripe self-serve subscriptions.
//
//   GET  /billing            current plan/status/usage + the plan catalog
//   POST /billing/checkout   { plan } → Stripe Checkout Session URL
//   POST /billing/portal     → Stripe Billing Portal URL (manage card / cancel)
//   POST /billing/webhook    Stripe events (no auth; signature-verified) → sync
//                            subscription_status / plan / period end onto tenant
//
// Works without Stripe configured: GET still returns the catalog + state, and
// checkout/portal return 503 so the UI can show "billing not set up yet".

const express = require('express');
const db = require('./db');
const email = require('./email');
const tenants = require('./tenants');
const plans = require('./plans');
const usage = require('./usage');
const entitlements = require('./entitlements');

// Where Enterprise "Contact sales" inquiries are emailed. Falls back to the
// public sales alias if unset. ENTERPRISE_INQUIRY_NOTIFY is an optional
// comma-separated list of extra recipients copied on every inquiry.
const SALES_INQUIRY_EMAIL = process.env.SALES_INQUIRY_EMAIL || 'sales@ghoststream.exact-it.net';
const EXTRA_INQUIRY_NOTIFY = (process.env.ENTERPRISE_INQUIRY_NOTIFY || 'pbombando@gmail.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net').replace(/\/+$/, '');

let _stripe; // undefined = not yet resolved, null = unconfigured
function stripe() {
  if (_stripe !== undefined) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  _stripe = key ? require('stripe')(key) : null;
  return _stripe;
}
function isConfigured() { return !!process.env.STRIPE_SECRET_KEY; }

const router = express.Router();

// GET /billing — everything the Billing page needs.
router.get('/', async (req, res, next) => {
  try {
    const tenant = await tenants.get(req.tenantId, { fresh: true });
    const ent = entitlements.entitlementsFor(tenant);
    const used = await usage.summary(req.tenantId);
    res.json({
      billing: {
        ...entitlements.toJson(ent),
        usage: {
          discovery: used.discovery || 0,
          competitor_research: used.competitor_research || 0,
          engagements: used.engagements || 0,
          market_monitoring: used.market_monitoring || 0,
          arena: used.arena || 0,
        },
        stripeConfigured: isConfigured(),
        manageable: !!(tenant && tenant.stripe_subscription_id),
      },
      plans: plans.catalog(),
    });
  } catch (err) { next(err); }
});


// Ensure a Stripe customer for an arbitrary tenant (used by onboarding too).
async function ensureCustomerFor(tenantId, email) {
  const tenant = await tenants.get(tenantId, { fresh: true });
  if (tenant.stripe_customer_id) return tenant.stripe_customer_id;
  const customer = await stripe().customers.create({
    name: tenant.name || undefined,
    email: email || undefined,
    metadata: { tenantId: tenant.id },
  });
  await tenants.update(tenant.id, { stripe_customer_id: customer.id });
  return customer.id;
}

// Build a Checkout Session for a tenant. `trial` adds the plan's $0 trial that
// auto-converts (card collected up front; cancels if no card). Throws with a
// .status on bad plan / missing price. Exported so onboarding can start the
// trial right after account creation.
async function createCheckout({ tenantId, email, plan, trial = false, successUrl, cancelUrl }) {
  const planDef = plans.PLANS[plan];
  if (!planDef || !planDef.selfServe) { const e = new Error('That plan is not available for self-serve checkout.'); e.status = 400; throw e; }
  const price = plans.priceIdFor(plan);
  if (!price) { const e = new Error(`No Stripe price configured for the ${planDef.name} plan.`); e.status = 503; e.code = 'PRICE_NOT_CONFIGURED'; throw e; }

  const customerId = await ensureCustomerFor(tenantId, email);
  const subData = { metadata: { tenantId, plan } };
  if (trial && plans.trialDaysFor(plan) > 0) {
    subData.trial_period_days = plans.trialDaysFor(plan);
    // Card required up front; if somehow missing at trial end, cancel (no charge).
    subData.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } };
  }
  return stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    payment_method_collection: 'always', // collect a card even for the $0 trial
    metadata: { tenantId, plan },
    subscription_data: subData,
  });
}

// POST /billing/checkout { plan } — in-app upgrade (paid immediately, no trial).
router.post('/checkout', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Billing is not configured yet.', code: 'BILLING_NOT_CONFIGURED' });
    const session = await createCheckout({
      tenantId: req.tenantId,
      email: req.user && req.user.email,
      plan: String((req.body && req.body.plan) || ''),
      trial: false,
      successUrl: `${APP_BASE_URL}/admin/?cs={CHECKOUT_SESSION_ID}#billing?checkout=success`,
      cancelUrl: `${APP_BASE_URL}/admin/#billing?checkout=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// POST /billing/confirm { sessionId } — apply a completed Checkout Session's
// subscription immediately so the app reflects the new plan without waiting for
// the webhook. Tenant-scoped.
router.post('/confirm', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Billing is not configured yet.', code: 'BILLING_NOT_CONFIGURED' });
    const sessionId = String((req.body && req.body.sessionId) || '');
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    const sessTenant = session && session.metadata && session.metadata.tenantId;
    if (!session || (sessTenant && sessTenant !== req.tenantId)) {
      return res.status(404).json({ error: 'checkout session not found' });
    }
    if (session.subscription) {
      const sub = await stripe().subscriptions.retrieve(session.subscription);
      if (session.metadata && session.metadata.tenantId) sub.metadata = { ...(sub.metadata || {}), ...session.metadata };
      await applySubscription(sub);
    }
    const tenant = await tenants.get(req.tenantId, { fresh: true });
    res.json({ ok: true, entitlements: entitlements.toJson(entitlements.entitlementsFor(tenant)) });
  } catch (err) { next(err); }
});

// POST /billing/portal
router.post('/portal', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Billing is not configured yet.', code: 'BILLING_NOT_CONFIGURED' });
    const tenant = await tenants.get(req.tenantId, { fresh: true });
    if (!tenant.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet — choose a plan first.' });
    const portal = await stripe().billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: `${APP_BASE_URL}/admin/#billing`,
      ...(process.env.STRIPE_PORTAL_CONFIG_ID ? { configuration: process.env.STRIPE_PORTAL_CONFIG_ID } : {}),
    });
    res.json({ url: portal.url });
  } catch (err) { next(err); }
});

// POST /billing/enterprise-inquiry — capture a "Contact sales" lead from the
// Enterprise plan card. Persists the pricing signals (rep count, expected call
// volume, monitored entities, CRM) and best-effort emails sales. The lead is
// stored first so a failed/unconfigured email never loses it.
router.post('/enterprise-inquiry', async (req, res, next) => {
  try {
    const b = req.body || {};
    const contactEmail = String(b.contactEmail || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
      return res.status(400).json({ error: 'A valid work email is required.' });
    }
    // Coerce the numeric pricing signals; blanks become null, negatives clamp to 0.
    const num = (v) => {
      if (v === '' || v == null) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? Math.max(0, n) : null;
    };
    const str = (v, max) => { const s = String(v || '').trim(); return s ? s.slice(0, max) : null; };

    const row = {
      tenant_id: req.tenantId,
      user_id: (req.user && req.user.sub) || null,
      contact_name: str(b.contactName, 200),
      contact_email: contactEmail.slice(0, 320),
      company_name: str(b.companyName, 200),
      sales_reps: num(b.salesReps),
      monthly_engagements: num(b.monthlyEngagements),
      watched_entities: num(b.watchedEntities),
      monthly_research_runs: num(b.monthlyResearchRuns),
      crm: str(b.crm, 120),
      notes: str(b.notes, 4000),
    };

    const ins = await db.query(
      `INSERT INTO enterprise_inquiries
         (tenant_id, user_id, contact_name, contact_email, company_name,
          sales_reps, monthly_engagements, watched_entities, monthly_research_runs, crm, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, created_at`,
      [row.tenant_id, row.user_id, row.contact_name, row.contact_email, row.company_name,
       row.sales_reps, row.monthly_engagements, row.watched_entities, row.monthly_research_runs, row.crm, row.notes]
    );
    const inquiryId = ins.rows[0].id;

    // Best-effort notification to sales — never block the lead on email.
    if (email.isConfigured()) {
      const tenant = await tenants.get(req.tenantId).catch(() => null);
      const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const fmt = (v) => (v == null ? '—' : String(v));
      const companyName = row.company_name || (tenant && tenant.name) || '—';

      // Pricing signals → the table rows. Numbers are the cost/price drivers.
      const lines = [
        ['Company',               companyName],
        ['Contact',               `${row.contact_name || '—'} <${row.contact_email}>`],
        ['Sales reps (seats)',    fmt(row.sales_reps)],
        ['Expected calls / mo',   fmt(row.monthly_engagements)],
        ['Watched entities',      fmt(row.watched_entities)],
        ['Research runs / mo',    fmt(row.monthly_research_runs)],
        ['CRM',                   row.crm || '—'],
        ['Tenant id',             row.tenant_id],
      ];

      // Branded HTML email — table-based + inline styles so it renders in every
      // mail client (Gmail/Outlook strip <style> and flex/grid).
      const rowsHtml = lines.map(([k, v], i) => `
        <tr style="background:${i % 2 ? '#ffffff' : '#f8fafc'}">
          <td style="padding:10px 16px;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td>
          <td style="padding:10px 16px;color:#0f172a;font-size:14px;font-weight:600">${esc(v)}</td>
        </tr>`).join('');
      const notesHtml = row.notes ? `
        <tr><td colspan="2" style="padding:16px">
          <div style="color:#64748b;font-size:13px;margin-bottom:4px">Notes</div>
          <div style="color:#0f172a;font-size:14px;line-height:1.5">${esc(row.notes).replace(/\n/g, '<br>')}</div>
        </td></tr>` : '';

      const html = `
<div style="background:#f1f5f9;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px 28px">
        <div style="color:#c7d2fe;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700">GhostStream · Sales</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px">New Enterprise inquiry</div>
        <div style="color:#e0e7ff;font-size:14px;margin-top:2px">${esc(companyName)} · inquiry #${inquiryId}</div>
      </td></tr>
      <tr><td style="padding:8px 28px 20px">
        <p style="color:#334155;font-size:14px;line-height:1.5">A prospect asked to talk to sales about an Enterprise plan. The volume signals below are what you need to scope a quote.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
          ${rowsHtml}
          ${notesHtml}
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr><td style="border-radius:8px;background:#4f46e5">
          <a href="mailto:${esc(row.contact_email)}?subject=${encodeURIComponent('Re: GhostStream Enterprise — ' + companyName)}" style="display:inline-block;padding:11px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">Reply to ${esc(row.contact_name || row.contact_email)} →</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #f1f5f9;color:#94a3b8;font-size:12px">
        Sent automatically by GhostStream when the Enterprise “Contact sales” form was submitted. Reply directly to reach the prospect.
      </td></tr>
    </table>
  </td></tr></table>
</div>`;
      const text = `New Enterprise inquiry (#${inquiryId})\n\n`
        + lines.map(([k, v]) => `${k}: ${v}`).join('\n')
        + (row.notes ? `\n\nNotes:\n${row.notes}` : '')
        + `\n\nReply to: ${row.contact_email}`;

      const recipients = [...new Set([SALES_INQUIRY_EMAIL, ...EXTRA_INQUIRY_NOTIFY])];
      try {
        await email.send({
          to: recipients,
          replyTo: row.contact_email,
          subject: `Enterprise inquiry — ${companyName === '—' ? row.contact_email : companyName}`,
          html, text,
          categories: ['enterprise-inquiry'],
        });
      } catch (e) {
        console.warn('[enterprise-inquiry] sales email failed (lead stored):', e.message);
      }
    }

    res.status(201).json({ ok: true, id: inquiryId });
  } catch (err) { next(err); }
});

// ── Webhook ──────────────────────────────────────────────────────────────
function planKeyFromPrice(sub) {
  const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
  if (!priceId) return null;
  for (const key of ['starter', 'pro']) if (plans.priceIdFor(key) === priceId) return key;
  return null;
}
function mapStatus(s) {
  // Stripe 'trialing' → our TRIAL so the existing trial-countdown banner works;
  // entitlements treats TRIAL-with-future-trial_ends_at as active.
  if (s === 'trialing') return 'TRIAL';
  if (s === 'active') return 'ACTIVE';
  if (s === 'past_due' || s === 'unpaid') return 'PAST_DUE';
  if (s === 'canceled' || s === 'incomplete_expired') return 'CANCELLED';
  return null; // incomplete / paused — leave as-is
}
async function applySubscription(sub) {
  const tenantId = (sub.metadata && sub.metadata.tenantId) || await tenants.findIdByStripeCustomer(sub.customer);
  if (!tenantId) { console.warn('[billing] no tenant for subscription', sub.id); return; }
  const status = mapStatus(sub.status);
  const planKey = (sub.metadata && sub.metadata.plan) || planKeyFromPrice(sub);
  const patch = {
    stripe_subscription_id: sub.id,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  };
  if (status) patch.subscription_status = status;
  // Set the plan on both trial and paid states (the trial IS the Starter plan).
  if (planKey && (status === 'ACTIVE' || status === 'TRIAL')) patch.plan = planKey;
  // Drive the trial-end date from Stripe so the countdown banner is accurate.
  patch.trial_ends_at = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
  await tenants.update(tenantId, patch);
  console.log(`[billing] tenant ${tenantId} → ${status || '(unchanged)'} / ${planKey || '(unchanged)'} (sub ${sub.id})`);
}

async function webhook(req, res) {
  const s = stripe();
  if (!s) return res.status(503).end();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret
      ? s.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), secret)
      : req.body; // dev fallback when no signing secret is set
  } catch (err) {
    console.warn('[billing] webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.subscription) {
          const sub = await s.subscriptions.retrieve(session.subscription);
          if (session.metadata && session.metadata.tenantId) {
            sub.metadata = { ...(sub.metadata || {}), ...session.metadata };
          }
          await applySubscription(sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await applySubscription(event.data.object);
        break;
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const tenantId = (sub.metadata && sub.metadata.tenantId) || await tenants.findIdByStripeCustomer(sub.customer);
        if (tenantId) await tenants.update(tenantId, { subscription_status: 'CANCELLED' });
        break;
      }
      default: break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] webhook handler error:', err.stack || err.message);
    res.status(500).end();
  }
}

module.exports = { router, webhook, isConfigured, createCheckout, applySubscription };
