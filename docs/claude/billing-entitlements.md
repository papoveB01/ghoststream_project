# Billing & entitlements — the core cross-cutting system

This is the most load-bearing subsystem; changes here need care and usually an ADR. Governed by **ADR-0003** (feature packaging) and **ADR-0004** (seat-based cost model) in `docs/adr/` — read them before touching pricing.

- **`plans.js`** — the plan catalog and single source of truth for tiers, features, monthly caps, and Stripe price linkage. Two catalogs coexist: `PLANS` (v1) and `PLANS_V2` (v2); a tenant's `plan_version` selects which. **Grandfathering depends on v1 and v2 Stripe price ids staying distinct — never repoint a v1 `STRIPE_PRICE_*` at a v2 price.** Every cap number must clear a ≥35% gross margin (ADR-0004 §4.3) — check before editing.
- **`entitlements.js`** — pure function combining two orthogonal axes on the tenant: `subscription_status` (lifecycle: TRIAL/ACTIVE/PAST_DUE/…) × `plan` (tier). Returns what a tenant may do *now*: `features`, `caps`, `lifetimeMeters` (which meters use the never-reset bucket), `seats`, `overage`. Sub-tenants inherit and mask from the parent.
- **`usage.js`** — per-tenant, per-meter counters in Postgres `usage_counters`, bucketed by period (`'lifetime'` vs the current month). `consume()` atomically pre-charges under a cap and falls through **allowance → prepaid credits → (metered overage, if wired)**; exhaustion throws `402 USAGE_LIMIT`.
- **`credits.js`** — prepaid PAYG credit packs (Stripe one-time payments), the overflow valve past plan caps.
- **`gating.js`** — the request-middleware layer that charges `usage` against `entitlements.caps` per meter, mapping v1↔v2 meter keys.
- **`billing.js`** — Stripe subscriptions, Checkout, Billing Portal, and the signature-verified webhook that syncs `subscription_status`/`plan`/period onto the tenant.

The one genuinely expensive meter is **engagements** (each is a ~$1 Recall.ai bot); the cheap meters (research/arena/market-watch) are metered generously. **Keep that asymmetry when changing caps.**
