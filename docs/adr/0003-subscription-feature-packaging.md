# ADR-0003: Subscription feature packaging — which feature belongs in which tier

- **Status:** Accepted (2026-06-03 — Batch 1 of the §7 hand-off shipped in the same PR)
- **Date:** 2026-06-03
- **Authors:** Builder (gating pass)
- **Affects:** `api/src/plans.js`, `api/src/entitlements.js`, `api/src/gating.js`,
  `api/src/billing.js`, `api/src/companies.js`, `api/src/portfolio.js`,
  `api/src/integrations.js`, `api/src/arena.js`, `web/admin/admin.js`.

## 1. Context

GhostStream gates on two orthogonal fields on the `tenants` table
(introduced in migration `0024`, see the [Subscription gating] notes):

- `subscription_status` — lifecycle (TRIAL / ACTIVE / PAST_DUE / CANCELLED /
  INTERNAL). Decides **whether** a tenant may act at all.
- `plan` — tier (trial / starter / pro / enterprise / internal). Decides
  **what** they may do (features + monthly caps).

Enforcement has two layers, both in `api/src/gating.js`:

1. **`billingGate`** — mounted app-wide (`index.js`). When the entitlement is
   inactive the app goes read-only: GET/HEAD/OPTIONS plus a small allowlist
   (`/billing`, `/onboarding`, `/auth/*`) pass; every other mutation gets `402
   SUBSCRIPTION_REQUIRED`. Suspended tenants get a hard `403`.
2. **Per-route guards** — `requireFeature(f)` (402 `FEATURE_NOT_IN_PLAN`),
   `requireCapacity(m)` (402 `USAGE_LIMIT`, atomically consumes one monthly
   unit), and `requireFeatureWrite(f)` (the former, writes only).

A feature is only truly tier-gated if a route opts into a layer-2 guard. An
audit on 2026-06-03 found the opt-in was inconsistent:

- **Calendly auto-booking** — `FEATURES.CALENDLY` was defined and bundled into
  Pro, but **no route ever enforced it**. Connect/verify and the webhook
  receivers only checked `isConfigured('calendly')`. Calendly was effectively
  free on every tier — a revenue leak.
- **Discovery** and **Competitor research** were capacity-capped but had **no
  `requireFeature` guard**. Harmless while both live in the CORE bundle (every
  paid plan), but fragile: a future repackaging that dropped them from a plan,
  or an `Infinity` cap, would leave them wide open.
- **Trial** and **Starter** shared **identical caps** (10 / 10 / 20), so there
  was no quantitative reason for a trial to convert to Starter.
- **Arena** was feature-gated but **unmetered** — unlimited on any plan that
  had the flag, with no way to offer a limited taste on a cheaper tier.
- **Pro** and **Enterprise** had **identical feature sets**; Enterprise only
  differed by `Infinity` caps and contact-sales.

## 2. Decision drivers

- **Plug the leak first.** Anything defined-but-unenforced is a billing bug, not
  a packaging preference — fix it regardless of the broader packaging debate.
- **Defence in depth.** A metered feature should *also* carry a feature gate, so
  packaging changes can't silently give it away.
- **A real upgrade ladder.** Each tier step must have one obvious reason to
  climb — caps for trial→Starter, premium features for Starter→Pro, scale +
  governance for Pro→Enterprise.
- **Minimal blast radius.** Prefer catalog/data changes in `plans.js` and
  middleware wiring over new tables or schema migrations.

## 3. The packaging model — four value layers

| Layer | Purpose | Lives in |
| --- | --- | --- |
| **Table stakes** | The data spine everyone needs to use the product at all | Every tier, ungated (auth + `billingGate` only) |
| **Core value** | The "why I bought this" workflows | Entry paid tier (Starter) |
| **Growth** | Productivity multipliers & integrations | Mid tier (Pro) |
| **Premium / agentic** | Autonomous, compute-heavy, high-margin | Top tier (Pro+ / Enterprise) |

Rule of thumb: a feature climbs a layer the more it (a) costs us in AI/compute,
(b) signals a maturing customer, or (c) creates a natural upgrade trigger.

## 4. Decision — the feature → tier matrix

| Feature | Key | Layer | Trial | Starter | Pro | Enterprise |
| --- | --- | --- | :-: | :-: | :-: | :-: |
| Company foundation (profile/products/personas) | — | Table stakes | ✅ | ✅ | ✅ | ✅ |
| Contacts & Companies CRUD | — | Table stakes | ✅ | ✅ | ✅ | ✅ |
| Knowledge base / RAG | — | Table stakes | ✅ | ✅ | ✅ | ✅ |
| Dashboard / Overview | — | Table stakes | ✅ | ✅ | ✅ | ✅ |
| Calendar integrations (Nylas / MS Graph) | — | Table stakes | ✅ | ✅ | ✅ | ✅ |
| Prospect discovery | `discovery` | Core | ✅ (cap) | ✅ | ✅ | ✅ |
| Competitor research | `competitor_research` | Core | ✅ (cap) | ✅ | ✅ | ✅ |
| Engagements (AI-joined calls) | `engagements` | Core | ✅ (cap) | ✅ | ✅ | ✅ |
| Arena practice + scorecard | `arena` | Growth | ✅ (cap) | ✅ **limited** | ✅ ∞ | ✅ ∞ |
| CRM integrations | `crm` | Growth | ✅ | ❌ | ✅ | ✅ |
| Calendly auto-booking | `calendly` | Growth | ✅ | ❌ | ✅ | ✅ |
| API / MCP tokens | `api_tokens` | Growth | ✅ | ❌ | ✅ | ✅ |
| Market Watch (agentic) | `market_monitoring` | Premium | ❌ | ❌ | ✅ | ✅ |

### Bundles (`plans.js`)

```
CORE     = discovery, competitor_research, engagements
ALL      = CORE + arena, crm, api_tokens, calendly
PREMIUM  = ALL + market_monitoring
```

- **Trial** → `ALL` (full Pro features minus Market Watch), small caps.
- **Starter** → `CORE + arena` (limited Arena allowance).
- **Pro / Enterprise / Internal** → `PREMIUM`.

### Adopted caps — "Option B" (shipped)

Cost analysis (see ADR-0003 addendum / cost model) found engagements are ~95% of
variable cost and **inelastic** (a rep can't fabricate real sales calls), while
the other four meters are near-zero cost. So: generous caps on the cheap meters
(marketable, ~free), disciplined caps on engagements.

| Meter | Trial | Starter | Pro | Enterprise |
| --- | :-: | :-: | :-: | :-: |
| `discovery` / mo | 15 | 75 | 250 | custom |
| `competitor_research` / mo | 15 | 75 | 250 | custom |
| `engagements` / mo | 5 | 15 | 75 | custom |
| `market_monitoring` / mo | 0 | 0 | 500 | custom |
| `arena` / mo | 5 | 40 | ∞ | custom |

Modeled at expected usage: Starter ~78%, Pro ~66%, Enterprise ~70% margin →
**weighted ≈ 70%** (≥ 55% target). Market Watch stays Pro-exclusive by both
bundle membership **and** a `0` cap on Trial/Starter.

**Enterprise is custom-priced, not "unlimited."** Caps stay uncapped in
`plans.js` (so a contracted account is never hard-blocked mid-month), but the
Billing UI never displays caps or the word "unlimited" on the Enterprise card —
it shows "Custom" + a **Contact-sales inquiry form** (`POST
/billing/enterprise-inquiry`, table `enterprise_inquiries`, migration `0035`)
that collects the pricing signals: sales reps, expected calls/month, monitored
entities, research runs/month, CRM. The negotiated volume sets the price, which
also neutralizes the engagement tail-risk on the highest-revenue tier.

**Engagement overage (deferred):** per-engagement overage beyond the cap (turns
the tail into expansion revenue) still needs the Stripe usage-record plumbing —
tracked as follow-up, not in this batch.

## 5. Alternatives considered

- **Leave Calendly ungated, gate only on `isConfigured`.** Pro: zero work. Con:
  it's a straight revenue leak — any tier gets a paid integration. Rejected.
- **Gate the whole `/integrations` router with `requireFeature(calendly)`.**
  Pro: one line. Con: it would also gate Calendar (Nylas/MS Graph), which is
  table-stakes. Rejected in favour of per-route guards on connect/verify only.
- **Keep discovery/competitor cap-only (no feature gate).** Pro: works today.
  Con: brittle under repackaging. Rejected — the feature gate is one cheap
  middleware and removes a future foot-gun.
- **Make Arena Pro-only (status quo).** Pro: simplest. Con: forfeits a cheap
  retention hook on Starter. Chosen instead: a small metered Arena allowance on
  Starter, unlimited on Pro+.
- **Add a true Enterprise feature layer (SSO / audit export / priority support)
  now.** Pro: real Pro→Enterprise differentiation. Con: SSO/audit aren't built;
  flagging them would be misleading. Deferred — see §8.

## 6. Consequences

**Easier:** packaging is now data-driven in `plans.js`; the Billing UI reflects
all five meters automatically; every paid capability has a consistent
feature + capacity guard pair.

**Harder / residual risk:**

- **Starter loses Calendly.** Any *existing* Starter tenant that connected
  Calendly while it was ungated will now get `402 FEATURE_NOT_IN_PLAN` on
  connect/verify. Inbound webhooks for already-registered subscriptions keep
  flowing (we don't gate the public receiver), and `DELETE /connection` stays
  open so they can disconnect. Communicate before deploy if any Starter tenant
  is live on Calendly.
- **Arena is now metered.** Anonymous portal-practice sessions consume the
  owning tenant's `arena` meter; a busy Starter could hit 10/mo. Caps are
  tunable in `plans.js` without a migration.
- **No schema change**, so the existing `usage_counters` table absorbs the new
  `arena` / `market_monitoring` meters with no migration.

## 7. Builder hand-off (what shipped in this PR — Batch 1)

- `api/src/plans.js` — add `arena` to `METERS`; add `arena` caps to every plan;
  Starter `features: [...CORE, FEATURES.ARENA]`; raise Starter caps to
  25/25/30; expose `market_monitoring` + `arena` in `catalog()` caps.
- `api/src/entitlements.js` — add `arena` to the client-safe `toJson` caps.
- `api/src/companies.js` — `POST /discover`: add `requireFeature('discovery')`
  ahead of `requireCapacity`.
- `api/src/portfolio.js` — `POST /competitors/discover`: add
  `requireFeature('competitor_research')` ahead of `requireCapacity`.
- `api/src/integrations.js` — import `gating`; add `requireFeature('calendly')`
  to `GET /calendly/connect` and `POST /calendly/verify`.
- `api/src/arena.js` — meter each session: `usage.consume(tenantId, 'arena',
  ent.caps.arena)` after the feature check.
- `api/src/billing.js` — include `market_monitoring` + `arena` in the `usage`
  payload.
- `web/admin/admin.js` — `FEATURE_LABELS.market_monitoring`; `METER_LABELS` for
  the two new meters; render all five meters on Billing (hide a meter capped at
  0 with no usage).

## 8. Open questions (deferred)

- **Enterprise differentiation.** Today Pro and Enterprise share `PREMIUM`;
  Enterprise is only ∞ caps + contact-sales. A future ADR should add a real
  governance layer (SSO, audit-log export, priority support) once those
  capabilities exist.
- **Calendly grandfathering.** Decide whether to grandfather any Starter tenant
  currently on Calendly, or migrate them to Pro, before this lands in prod.
- **Cap calibration.** The numbers in §4 are first-pass; revisit against real
  usage once a few tenants are on paid plans.

[Subscription gating]: ../../README.md
