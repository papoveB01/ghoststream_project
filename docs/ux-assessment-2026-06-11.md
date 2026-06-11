# DealScope Tenant Experience — UX & Architecture Assessment

*2026-06-11 · Method: full product walk (onboarding → every admin section, populated and empty states, staging + prod), plus code-level review of the flows behind each screen. Trigger: user feedback that "it's difficult to figure out the flow."*

---

## 1. The core diagnosis

DealScope has a **strong, opinionated methodology** baked into its engine:

> **Ground** (company foundation) → **Find** (discover prospects/competitors) → **Research** (signals, contacts, battlecards) → **Engage** (AI-joined calls) → **Learn** (analysis, market watch) → **Close** (proposals, follow-ups)

…but the UI presents a **flat catalog of nouns**: Overview, Company, Prospects, Competitors, Market Map, Market signals, Engagements, Calendar, Arena Practice, Integrations, Billing, Settings. The pipeline lives in the architecture and in the founder's head — not on the screen. A new user has to already know the methodology to operate the tool. That is the root cause of "can't figure out the flow." Everything below is a consequence or an amplifier of it.

## 2. Journey map with friction points

| Stage | What exists | Friction observed |
|---|---|---|
| **Signup** | Clean 4-step wizard (Company → About you → Account → Verify), work-email + domain claim, optional paid opt-in, auto-login, welcome email (new) | Good. Best part of the journey. Industry/size collected but never visibly used again — feels like a dead question. |
| **First login** | Lands on Company → Intel `welcome=1` (bootstrap pull), 8-step driver.js tour fires once | Tour is **passive narration over an empty product** — it points at pages with nothing in them, then never returns. Dismiss = gone forever (localStorage). The single most valuable action (Enrich from web) is one of many buttons rather than *the* step. |
| **Foundation** | Foundation health score (90/100 banner), Enrich from web, prose-view foundation (new), products/personas | Health score is excellent but its consequence is invisible: users don't learn that *discovery quality depends on it* until discovery returns junk. Nothing routes a sparse-foundation user back here. |
| **Find** | Discover online (prospects), Find competitors (now with prospect/product focus), green CTAs (new) | Discovery results are strong, but after "Add" the trail goes cold — no "now research them" or "now find contacts" continuation. Each added entity is a dead end the user must re-find in the list. |
| **Research** | Per-prospect research (~60s async), signals tab, battlecards, threat scores | **The async gap**: "research started — refresh to watch progress." No toast/notification when done, no jobs surface. Users start something, navigate away, and never see the payoff. |
| **Contacts** | Find contacts (Apollo, 2-stage), product-fit pills (new), manual add | Two-stage teaser/reveal is economically smart but conceptually invisible — users don't know reveals cost research credits until blocked (now messaged, but only at the wall). |
| **Engage** | Engagements (schedule, briefs, AI joins, analysis), Calendar import, prefill flows | "Engagements" ↔ URL `#missions` mismatch. Calendar is a separate nav noun that is 100% dependent on Integrations — a dead page until connected. Brief generation timing (24h before) is stated only in a hint. |
| **Learn** | Market Watch per-entity, Market signals review queue, bell (new), Market Map | **Worst naming collision in the product** (see §4). Watch must be enabled per-entity with a schedule — there is no "watch all my hot accounts" affordance. |
| **Close** | Proposal tab per prospect, AI email composer w/ product focus (new), BCC capture | Buried as the 4th tab of a prospect. Nothing on Overview ever says "this account is ready for a proposal." |
| **Pay** | Free→Starter/Pro, credit packs, gauges (now version-correct), activation emails (new) | Costs are visible *after* hitting walls, not *at the point of action*. "1 research credit" is never shown on the buttons that spend it. |

## 3. Heuristic findings (severity-ordered)

**S1 — No visible pipeline.** Nav groups (Intelligence / Pipeline / Workspace) are org-chart categories, not a journey. Nothing answers "what do I do first, second, third?" after the tour dies.

**S1 — Activation guidance is ephemeral.** The dashboard "Finish setting up" nudge only covers 4 binary gaps and disappears; the tour fires once over an empty product. There is no durable, progress-aware checklist.

**S1 — Async work has no home.** Research, enrichment, watch runs, proposal generation all run in background with per-page, polling-ish status. No global "what's running / what finished" — the new bell handles market signals only.

**S2 — Terminology collisions** (§4) force users to hold a glossary in their head.

**S2 — Dead-end dependency chains.** Calendar→Integrations, Arena→call portals, Proposal→research+intel, brief quality→foundation. Each is discovered by hitting a wall (empty states do link onward, but one wall at a time).

**S2 — Costed actions are unlabeled.** Buttons that consume research/engagement units look identical to free ones. The Free plan's 5-lifetime-unit sample evaporates in one session (observed twice this week: Wibmo, Avoxi) with no foreshadowing.

**S3 — State fragility.** Selection/tab state is in-memory or session-scoped (improved this week); hash-routing back-button semantics are loose; `#missions` vs "Engagements" leaks internals.

**S3 — Code architecture as UX bottleneck.** `admin.js` is a single ~11k-line IIFE; every UX iteration risks regressions elsewhere (we hit several this week: tab resets, `me` scope bug, red link-buttons). This is the engineering reason journey polish has lagged feature delivery.

## 4. Terminology audit

| Current | Problem | Recommendation |
|---|---|---|
| Market **signals** / Market **Watch** / Market **Map** | Three near-identical names; "signals" also = prospect research signals AND the "Open signals" KPI | **Alerts** (review queue, pairs with the bell) · keep **Market Watch** as the monitoring feature name · keep **Market Map** |
| Engagements (`#missions`) | Internal name leaks into URLs/support | Alias the route; retire "missions" from user-visible surfaces |
| Arena Practice | Meaningless to a new user | "**Call practice**" (subtitle: spar with an AI buyer) |
| Signals (prospect tab) | Collides with the above | "**Why now**" or "Buying signals" |
| Research / Discovery / Intel | Used interchangeably; v2 billing merged them into "research" | Pick one spine: **Research** (billing already did) and use it everywhere |

## 5. Recommendations

### P0 — Make the journey visible (highest impact / 1–2 weeks)

1. **Persistent "Get set up" checklist** replacing the fragile nudge: 6 steps (Enrich foundation → Discover 5 prospects → Research one → Find contacts → Schedule first AI call → Turn on Market Watch), server-computed (the data for every checkmark already exists: foundation health, counts, watch flags), shown on Overview until complete, collapsible afterwards. This single artifact answers "what's the flow?" forever.
2. **Reorder + rename nav into the journey**: e.g. `Foundation` (Company), `Find` (Prospects, Competitors, Market Map), `Engage` (Engagements w/ Calendar folded in as a tab), `Learn` (Alerts, Call practice). Numbered group headers ("1 · Foundation") cost nothing and teach the methodology on every glance.
3. **Interactive first-run instead of narrated tour**: 3 *doing* steps (click Enrich for them → run one discovery with their ICP → open one result), each completing a checklist item. Kill the 8-step passive popover walk.
4. **Terminology pass** per §4 — half a day of renames, permanent comprehension gain.

### P1 — Connect the stages (2–4 weeks)

5. **Next-best-action hero on Overview**: one computed sentence + button above the KPIs — "Wave has 2 strong signals and no contacts → Find decision-makers." All inputs (heat, contacts count, watch state, proposal existence) are already in the dashboard payload. This converts the cockpit from a mirror into a copilot.
6. **Unify async into the bell**: job completions (research done, enrichment done, proposal ready) post into the existing notification bell with deep links. One mental model: "the bell tells me when DealScope finished thinking."
7. **Continuation CTAs after every add**: discovery "Added ✓" → "Research now · Find contacts"; research-complete view → "Schedule engagement"; battlecard → "Practice this matchup."
8. **Cost transparency at point of action**: append live microcopy to spending buttons — "Run research · 1 credit (72 left this month)". The entitlements payload already rides on `/auth/me`.
9. **Activation drip emails** (infra now exists): day-1 welcome (done), day-2 "your foundation is at 60 — one click to enrich," day-7 "3 prospects have unworked strong signals."

### P2 — Structural (1–2 months, schedule alongside features)

10. **Fold Calendar into Engagements** as an "Import" tab; one less dead noun.
11. **Global command palette** (⌘K: entities + actions) — disproportionate power-user payoff in a hash-routed SPA.
12. **Server-side UI state** (selected tabs/entities per user) replacing sessionStorage patches.
13. **Split `admin.js`** into per-section ES modules (no framework needed; the `loaders` registry is already the seam). This is the enabling investment for every item above.
14. **Role-aware simplification** once teams arrive: reps see Find/Engage; owners additionally see Foundation/Billing/Team.

### Quick wins shippable this week
- Numbered nav groups (1·2·3·4) — 1 hour.
- Rename Market signals→Alerts, Arena→Call practice, alias `#missions` — half day.
- "✓ Added — Research now?" continuation buttons in both discovery result tables — half day.
- Credit microcopy on Run research / Find contacts / Discover buttons — half day.
- Bell entries for research/enrichment completion — 1 day.

## 6. What's already strong (keep)

Signup wizard quality; foundation health score concept; two-stage contact reveal economics; the new scoped competitor intelligence; threat-scored Market Map; prefill flows (opportunity → schedule); empty states that link onward; the night-island visual system separating reading from instrumentation; honest gating with billing links (after this week's fixes).

---

*Bottom line: the engine is a pipeline, the UI is a filing cabinet. Make the pipeline visible (P0.1–P0.3) and the "can't figure out the flow" feedback should largely disappear — everything else compounds from there.*
