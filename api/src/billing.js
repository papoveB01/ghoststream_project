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
const tenants = require('./tenants');
const plans = require('./plans');
const usage = require('./usage');
const entitlements = require('./entitlements');

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
