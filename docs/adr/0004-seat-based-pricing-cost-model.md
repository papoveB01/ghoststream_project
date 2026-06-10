# ADR-0004: Seat-scaled pricing & the unit-cost model behind it

- **Status:** Proposed (2026-06-10 — not yet implemented; supersedes the cost
  assumptions in ADR-0003 §4)
- **Date:** 2026-06-10
- **Authors:** Builder (pricing review)
- **Affects (when implemented):** `api/src/plans.js`, `api/src/billing.js`,
  `api/src/usage.js`, `api/src/credits.js`, `api/src/entitlements.js`,
  `api/src/subaccounts.js`, `api/src/knowledge/apollo.js`,
  `web/admin/admin.js` (Billing UI), Stripe price catalog.

## 1. Context

ADR-0003 packaged features into tiers and set caps using a cost model whose
dominant input was **~$1.20 per engagement** (Recall bot dispatch), with the
other four meters treated as near-zero. Two things have changed since:

1. **Recall.ai cut prices** (early 2026): Pay-As-You-Go dropped from $0.70 to
   **$0.50 per recording-hour**, transcription is **$0.15/hr**, and the
   platform fee is gone. Our true engagement COGS is now ~$0.80–0.95, not
   $1.20. Every margin number in ADR-0003 §4 — and the "~38% margin, a knowing
   trade" note on credit packs in `credits.js` — is stale (credits actually
   earn ~55%).
2. **A market review (2026-06-10)** found our structural gap is not COGS but
   the missing **seat dimension**. Every comparable prices per seat (Gong
   ~$1,520–1,600/user/yr + $5k base; Apollo $49–119/seat/mo; Fireflies
   $10–39/user/mo) or per credit volume (Clay $134–720/mo; ZoomInfo
   $15k–60k/yr). We price **per tenant**: a 10-rep team pays the same $149 as
   a solo founder, and Pro's 5 *free* sub-tenants compound the leak (five
   workspaces on one subscription).

Two further model risks surfaced in the same review:

- **Apollo person-reveals are the one "cheap meter" cost a user can multiply
  with clicks.** A reveal is 1 Apollo credit (5 for mobile); at Apollo's
  overage rate of **$0.20/credit** an Apollo-heavy research run costs $0.50+,
  not the modeled ~$0.12 — enough to sink the $0.38 research credit.
- **ADR-0003's cap table drifted from code**: it documents Trial at 15/15/5
  with Arena 5, but `plans.js` ships Free at 5/5/1 with Arena 0. This ADR's
  tables are normative going forward.

### Margin policy change

ADR-0003 targeted **≥55% margin at *expected* usage**. This ADR adopts a
stronger, simpler floor: **≥35% gross margin at 100% cap utilization** on
every revenue line (worst case, including Stripe fees), which works out to
~70%+ blended at realistic utilization — i.e. the same place ADR-0003 landed,
but guaranteed instead of modeled.

## 2. Decision drivers

- **Revenue must scale with value delivered.** Value scales with reps (calls
  covered, prospects researched); price must too. Flat per-tenant pricing
  caps our revenue per account at $149 regardless of team size.
- **A hard margin floor, not a modeled one.** No tier may go underwater even
  if a tenant maxes every cap every month. Engagements are the only unit
  expensive enough to threaten this, so engagement allowances are the
  variable that scales with seats.
- **The tail becomes expansion revenue, not risk.** ADR-0003 deferred
  per-engagement overage; with COGS at ~$1.00 a $2.50 metered overage earns
  57% and removes the only reason to keep engagement caps tight.
- **Stay the value play.** Every price point must remain obviously cheap
  against what the bundle replaces (Gong + Apollo/Clay + monitoring).
- **Close the sub-tenant leak without killing the agency story.**

## 3. The unit-cost model (full COGS derivation)

Market rates as of 2026-06-10. All units include a deliberate buffer; round
up, never down.

### 3.1 Vendor rates

| Vendor | Rate (2026-06) | Notes |
| --- | --- | --- |
| Recall.ai | $0.50/recording-hr + $0.15/hr transcription | PAYG, no platform fee, prorated to the second |
| Gemini 2.5 Flash | $0.30 in / $2.50 out per 1M tokens | research synthesis, briefs, watch, arena |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 per 1M | relevance, keypoints, assessment |
| Gemini 2.5 Pro | ~$1.25 / $10.00 per 1M (≤200K ctx) | call analysis, proposals |
| Gemini embeddings | ~$0.00005/chunk | negligible |
| Apollo.io | plan credits ≈ $0.02/credit (Pro, 4k/mo); **overage $0.20/credit** | reveal = 1 credit, mobile = 5 |
| Firecrawl | ~$0.0008–0.003/page; **5× on bot-protected sites** | scrape/map/search |
| Brave Search | ~$0.001/query | preferred over Firecrawl search |
| NewsAPI / SendGrid / R2 / Stream | free tier or negligible | — |
| Stripe | 2.9% + $0.30/txn | applied to every revenue line |

### 3.2 Per-unit COGS (normative)

| Unit | COGS | Build-up |
| --- | --- | --- |
| **Engagement** (1 hr AI-joined call) | **$1.00** | Recall $0.65 + pre-call brief (Flash) ~$0.10 + call analysis (Pro) ~$0.15 + Stream/R2 + buffer |
| **Research run** (discovery *or* competitor) | **$0.12** | Firecrawl ~20 credits ≈ $0.02 + ~7 searches $0.01 + Flash synthesis $0.01 + Apollo org-enrich/teaser 2 credits $0.04 + buffer |
| **Market-watch unit** (one entity-tick) | **$0.06** | ~6 searches + Flash extraction |
| **Arena session** (≤24 turns, cached persona) | **$0.15** | cached Flash turns; estimates ranged $0.05–0.30 — **must be instrumented** (§8) |
| **Apollo person-reveal** | $0.02 on-plan / **$0.20 at overage** (×5 mobile) | the spike risk; metered per §6 step 2 |

These four units are the only material variable costs. Embeddings, email,
storage, calendar APIs, and webhook traffic are noise at any plausible scale.

### 3.3 Known COGS risks

- **Arena session cost is the least certain input** (cache hit rate, turns
  per session). At $0.40/session the Pro worst case drops below the floor;
  instrument before raising Arena caps.
- **Firecrawl enhanced mode** (Cloudflare-protected targets) is 5 credits per
  page — a scraping-heavy tenant profile can triple research-run cost.
- **Watch at full Pro cap** (250 units × $0.06 = $15/mo) is the second-biggest
  line after engagements; it is priced in below, but don't raise the cap
  without re-running the table.

## 4. Decision — the pricing structure

Two changes to the meter catalog, then the tiers:

- **`discovery` and `competitor_research` merge into one `research` pool.**
  Identical COGS, identical layer, and the credit system (`credits.js`)
  already treats them as one pool. Simpler to sell ("research runs") and to
  reason about.
- **Engagement allowances scale per seat.** Base allowance on the tier, plus
  a fixed increment per additional seat.

### 4.1 Tier table (normative)

| | Free | **Starter $49/mo** | **Pro $149/mo** | **Enterprise (custom)** |
| --- | :-: | :-: | :-: | :-: |
| Seats included | 1 | 1 | **2** | custom |
| Extra seat | — | $19/mo (max 3 total) | **$35/mo** | negotiated |
| Research runs / mo | 5 lifetime | 75 | 250 **(+25/extra seat)** | custom |
| Engagements / mo | 1 lifetime | 10 | **30 (+15/extra seat)** | volume-priced |
| Market monitoring / mo | 0 | 0 | 250 | custom |
| Arena sessions / mo | 0 | 25 | 100 | custom |
| Sub-tenants | — | — | 1 included, **+$29/mo each** (max 5) | custom |
| Engagement overage | — | credit packs only | **$2.50/engagement, metered** | $1.60–2.00 negotiated |
| Features | CORE | CORE + arena | PREMIUM | PREMIUM (+ SSO/audit when built, §9) |

Enterprise keeps ADR-0003's shape (uncapped in `plans.js`, "Custom" in the
UI, inquiry form collects volume signals) with one addition: the negotiated
price is **constructed from the unit rates** $1.60–2.00/engagement and
$0.30/research-run bundled, with a **$699/mo floor** — which keeps any
negotiated volume ≥40% worst-case by arithmetic rather than by hope.

### 4.2 Credit packs (revised note, same prices)

| Pack | Contents | Price | Per-credit | Worst-case margin |
| --- | --- | --- | --- | --- |
| `eng_50` / `eng_100` / `eng_200` | 25 / 50 / 100 engagement credits | $50 / $100 / $200 | $2.00 | **47%** |
| `research_50` | 50 research credits | $19 | $0.38 | **65%** |

Prices unchanged; the `credits.js` comment claiming a "~38% margin trade"
must be updated — at $1.00 engagement COGS the packs clear the floor without
any trade-off. 90-day expiry and oldest-first consumption unchanged.

### 4.3 The full margin table

Worst case = 100% of every cap consumed in the month, including Stripe
(2.9% + $0.30). Expected = ~40% utilization (observed pattern ADR-0003
modeled against).

| Revenue line | Price | Full-utilization COGS | **Worst-case margin** | Expected margin |
| --- | --- | --- | :-: | :-: |
| Starter base | $49.00 | 75×.12 + 10×1.00 + 25×.15 + fee ≈ $24.50 | **50%** | ~79% |
| Starter extra seat | $19.00 | 5 eng + 25 research + fee ≈ $8.60 | **55%** | ~80% |
| Pro base (2 seats) | $149.00 | 250×.12 + 30×1.00 + 250×.06 + 100×.15 + fee ≈ $94.50 | **37%** | ~73% |
| Pro extra seat | $35.00 | 15 eng + 25 research + fee ≈ $19.30 | **45%** | ~76% |
| Sub-tenant add-on | $29.00 | mini-pool (25 research, 5 eng) + fee ≈ $8.90 | **69%** | ~85% |
| Engagement overage | $2.50 | $1.00 + fee | **57%** | 57% |
| Engagement packs | $2.00/cr | $1.00 + fee | **47%** | 47% |
| Research pack | $0.38/cr | $0.12 + fee | **65%** | 65% |
| Enterprise | ≥$699/mo | constructed from unit rates | **≥40%** | higher |

The floor binds only on Pro base — intentionally: it's the competitive tier,
its engagement tail is now capped at 30 + 15/seat, and the excess converts
to 57%-margin metered overage instead of free usage.

### 4.4 Market position check

- **Starter $49** = Apollo Basic's price for 75 researched prospects + 10
  AI-covered calls. Customer-side: **~$0.65 per researched lead vs ~$237
  blended B2B SaaS CPL** ($250–800 per *qualified* lead). This is the
  marketing anchor.
- **Pro, 5-rep team:** $149 + 3×$35 = **$254/mo (~$51/seat)** with 75
  engagements — under Apollo Professional ($79/seat), ~¼ of Gong's effective
  $200–250/user/mo with no $5k platform fee, in-band with Clay ($134–720/mo).
- **10-rep team:** ~$429/mo (vs $149 flat today) — revenue finally scales
  with team size while staying ~80% below Gong.
- **Agency / multi-brand:** 5 sub-tenants ≈ $265/mo total — the story
  survives, the leak doesn't.

## 5. Consequences

- **Easy now:** revenue scales with team size; every revenue line is
  provably ≥35% even against a max-utilization tenant; the engagement tail
  is expansion revenue instead of risk; the credit-pack "margin trade"
  language disappears.
- **Harder now:** two new billing dimensions (seats, sub-tenant add-ons)
  mean more Stripe price IDs, proration cases, and Billing-UI states; the
  meter merge needs a grandfathering story; invite flows must enforce seat
  counts.
- **Residual risk:** §3.2's arena and reveal inputs are estimates until the
  cost telemetry in §6 lands; vendor repricing (Recall in either direction,
  Apollo credit policy) can move the table — re-run §4.3 on any vendor
  change.

## 6. Builder hand-off (ordered)

1. **Sub-tenant billing** (`subaccounts.js`, `billing.js`): 1 included on
   Pro, $29/mo per additional via Stripe subscription quantity on a new
   add-on price. Closes the biggest leak first; smallest blast radius.
2. **Apollo reveal metering** (`knowledge/apollo.js`, `contacts.js`):
   `revealPerson` consumes 1 research unit (3 for mobile) through the
   existing `usage.consume(..., { useCredits: true })` path. Protects the
   research-pool margins; the plumbing already exists.
3. **Meter merge** (`plans.js`, `usage.js`, Billing UI): collapse
   `discovery` + `competitor_research` into `research` (sum the two caps for
   grandfathered tenants; new period rows use the new key, old rows are
   historical).
4. **Seat dimension** (`plans.js`, `billing.js`, `entitlements.js`): seat
   count on the tenant, enforced at user-invite time; Stripe per-seat
   quantity on new price IDs; engagement/research allowances computed as
   `base + perSeat × extraSeats` in `entitlements.js`.
5. **Metered engagement overage** (the ADR-0003 §4 deferred item): Stripe
   usage records at $2.50; fires only when the monthly allowance *and*
   engagement credits are exhausted — order: allowance → credits → metered.
6. **Cost telemetry** (new, small): log per-call-site Gemini token counts and
   Apollo/Firecrawl credit spend to a `usage_costs` table keyed by tenant +
   meter. The floor in §4.3 is only as good as §3.2's inputs; arena and
   reveals are the two to watch. Ship alongside or before step 5.

**Grandfathering:** existing tenants keep current caps and prices. New Stripe
price IDs (`STRIPE_PRICE_STARTER_V2`, `STRIPE_PRICE_PRO_V2`,
`STRIPE_PRICE_SEAT_*`, `STRIPE_PRICE_SUBTENANT`) — never mutate the live
`STRIPE_PRICE_STARTER/PRO`. A `plan_version` (or v2 plan keys) on `tenants`
selects the catalog row.

## 7. Alternatives considered

- **Keep per-tenant pricing, just raise Pro to $199–249.** Pro: trivial.
  Con: still flat in team size; a 10-rep team remains 5× underpriced vs a
  2-rep team, and the sub-tenant leak survives. Rejected — price level was
  never the structural problem.
- **Pure per-seat (Gong-style $X/user/mo, no base).** Pro: maximal market
  familiarity. Con: punishes the solo founder who is our entry motion, and
  our COGS is genuinely per-tenant for research/watch (shared pools), so
  pure per-seat misprices small teams in both directions. Rejected in favor
  of base + seat hybrid.
- **Usage-only pricing (pay per engagement/run, no subscription).** Pro:
  perfect margin control. Con: unpredictable bills are the #1 stated reason
  mid-market buyers avoid usage pricing; kills the simple "$49 to start"
  motion. Rejected; metered overage on top of allowances captures the same
  upside.
- **Hold the 55%-at-expected-usage policy from ADR-0003.** Pro: no change.
  Con: "expected" was modeled, not measured, and one maxed-out Pro tenant
  ran underwater at the old caps. The 35%-at-full-utilization floor is
  weaker-sounding but strictly stronger. Adopted instead.
- **Free sub-tenants stay (status quo).** Pro: agency-friendly. Con: five
  workspaces on one $149 subscription is the single largest leak found in
  the review. Rejected; $29/mo keeps the agency story cheap.

## 8. Open questions / follow-ups

- **Instrument arena session cost** before any Arena cap increase — the
  $0.15 input is the least certain number in §3.2.
- **Annual billing** (2 months free is the market default) — deferred until
  the v2 catalog is live; affects worst-case math only via Stripe fees.
- **Watch cap on Enterprise**: negotiated volumes above ~1,000 units/mo need
  a per-unit rate in the deal calculator ($0.15/unit keeps ≥40%).
- **Re-verify Recall pricing quarterly** — the $0.70→$0.50 cut is the kind of
  move that invalidates this table in our favor; the reverse is possible.

## 9. Relationship to other ADRs

- **Supersedes** ADR-0003 §4's cost assumptions and cap table (the feature →
  tier matrix and gating architecture in ADR-0003 §3–§4 remain in force).
  Also resolves the documented drift: ADR-0003's "Trial 15/15/5" table never
  matched the shipped `plans.js` Free tier (5/5/1, Arena 0).
- The ADR-0003 §8 idea of a true Enterprise feature layer (SSO / audit
  export) remains deferred and would slot into this catalog without
  changing the math.

## 10. Sources (market rates, retrieved 2026-06-10)

- Recall.ai 2026 pricing: https://www.recall.ai/blog/new-recall-ai-pricing-for-2026
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- Apollo.io plans & overage: https://salesmotion.io/blog/apollo-pricing ,
  https://www.smarte.pro/blog/apollo-io-pricing
- Firecrawl pricing: https://www.firecrawl.dev/pricing
- B2B SaaS CPL/CPQL benchmarks: https://sotrosinfotech.com/blog/cost-per-lead-benchmarks-by-channel-b2b-saas-2026/ ,
  https://www.saashero.net/google-ppc/b2b-cost-per-qualified-lead/
- Gong pricing: https://marketbetter.ai/blog/gong-pricing-breakdown-2026/
- Fireflies pricing: https://meetingcompare.com/pricing/fireflies-ai-pricing/
- Clay vs ZoomInfo pricing: https://www.cleanlist.ai/blog/2026-05-23-clay-vs-zoominfo
