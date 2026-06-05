# Design: Proposal Engine — Intelligence Synthesis & Recommendation

Status: **Design approved (2026-06-05)** · Scope: v1 · Owner: TBD

> Product boundary: DealScope is **market-intelligence + suggestion** software, **not a CRM**.
> The Proposal Engine produces an *intelligence-driven recommendation*, never a deal pipeline.
> No opportunities, no sales stages, no win/loss, no quoting. (CRM may come later.)

---

## 1. What it is

A per-**prospect** synthesis that consolidates everything DealScope knows and formulates an
**outcome-based recommendation** — what to propose, how to position, what to preempt. The rep
decides; we suggest. Output is an **in-app recommendation view** that can **export to a shareable
doc**. It supersedes the thin per-call `sowSummary` (4 fields) described in
`docs/ops/2026-06-05-production-seo-and-integrations.md` §… and `api/src/analysis.js`.

### Proposal vs SOW (for the record)
- **Proposal** = persuade / position (pre-sale, intelligence-driven). **This feature.**
- **SOW** = define delivery (deliverables, acceptance, payment, signatures — contractual). Not
  built; the existing "SOW" export is really a scope summary and is being reframed.

---

## 2. Scope & spine

- Scoped to the **prospect (company)** — the existing intel aggregation point. **No opportunity
  entity.** A company can be worked continuously; the "ongoing engagement" is simply the running
  stream of touchpoints (calls, BCC'd emails, research, signals) about that prospect.
- A `proposals` record is **versioned**; regenerating creates a new version. Status is only
  `DRAFT | FINAL` — we never track "sent" (that's CRM).

---

## 3. Inputs it consolidates (all already in the stack)

| Layer | Meaning | Source |
|---|---|---|
| **Us** | strengths, weaknesses, positioning, products | `tenant_profiles` + BASIS/TENANT `kb_documents` |
| **Them** | inclinations, needs, signals | `prospect_research` + PROSPECT `kb_documents` |
| **The field** | differentiation, where we win/lose | COMPETITOR `kb_documents` / battlecards |
| **The engagement** | what they actually said | call `moments` (Redis portals) + **BCC'd emails** (Phase 2) |

Retrieval + citations reuse `api/src/knowledge/retrieval.js` (`retrieveContext`), so every claim
is grounded to a `kb_chunk` citation token — same provenance model as the existing
"verified against" footer.

---

## 4. The recommendation (output structure)

Positioning/outcomes only — **no pricing**, no deal mechanics.

1. **Headline recommendation** — the core angle in 1–2 lines
2. **Their situation** — pain, goals, triggers
3. **Recommended positioning** — how to frame us given their inclinations
4. **Outcomes to emphasize** — the value/metrics to lead with
5. **Our edge vs. alternatives** — competitive differentiation relevant to *this* prospect
6. **Proof points** — matched case studies / evidence from KB
7. **Objections to preempt** — likely pushback + suggested responses
8. **Recommended next move**
9. **Intelligence basis** — coverage/confidence + citations (provenance footer)

---

## 5. Intelligence coverage / confidence (NOT a deal gate)

A transparency signal, not a pipeline stage: each section gets a confidence derived from how much
intel backed it. Thin areas are **flagged as assumptions** (default) or **withheld**, governed by a
tenant setting `proposal_mode = DRAFT_WITH_ASSUMPTIONS (default) | BLOCK`. The model **never invents**
facts; thin = explicitly flagged.

---

## 6. Data model (minimal — no CRM entities)

**Reuse:** `companies`, `kb_documents`/`kb_chunks`, `prospect_research`, `tenant_profiles`,
`knowledge/retrieval.js`, the Gemini structured-output pattern.

**New (migration `0044_proposal_engine.sql`):**
- `proposals` — `id UUID PK, tenant_id, company_id, version INT, status TEXT(DRAFT|FINAL),
  content_json JSONB, coverage_json JSONB, citations_json JSONB, created_by, created_at`.
  Index `(company_id, version DESC)`.
- `prospect_engagement_inputs` (append-only touchpoint log; populated Phase 1 for calls, Phase 2
  for emails) — `id, tenant_id, company_id, type TEXT(CALL|EMAIL|RESEARCH|MANUAL), ref TEXT,
  extraction_json JSONB, created_at`.
- (Phase 2) per-prospect **BCC forward token** + inbound emails → PROSPECT_MEMORY `kb_documents`.
- (Phase 3) `proposal_mode` tenant setting.

Stored in **Postgres** (RLS-scoped by `tenant_id`), unlike the ephemeral Redis portal.

---

## 7. Phasing

- **Phase 1 — Synthesis from existing intel → recommendation view.** No email, no export. Ships
  value immediately. *(Detailed plan below.)*
- **Phase 2 — BCC email ingestion** (SendGrid Inbound Parse) → engagement intel feeding synthesis.
- **Phase 3 — Export to shareable doc** (tenant-branded PDF — *to confirm*) + coverage/confidence
  UI + `proposal_mode` settings toggle.

---

## 8. Decisions log
- Market-intelligence + suggestion, **not CRM** (no opportunities/stages/win-loss/quoting).
- Scope = **per prospect/company**; no opportunity spine.
- Email ingestion v1 = **BCC/forward** (Phase 2), feeds *ongoing-engagement* intel, not a pipeline.
- Strictness = tenant setting, **default draft-with-assumptions** + coverage meter (Phase 3).
- **Pricing out** of v1.
- Output = recommendation view **+ export** to shareable doc (Phase 3).

### Open (non-blocking for Phase 1)
- Export branding/format (lean: tenant-branded PDF) — Phase 3.
- Final confirmation of the §4 section list.

---

# Phase 1 — Implementation Plan

**Goal:** from a prospect with existing intelligence, the rep clicks **Generate recommendation**
and gets a cited, sectioned, persisted recommendation viewable in-app. Regenerate → new version.

**Out of scope (Phase 1):** BCC email ingestion (P2), export to doc (P3), settings toggle UI (P3).
Default behavior = draft-with-assumptions (thin sections flagged inline).

### 1. Database — `api/db/migrations/0044_proposal_engine.sql`
- Create `proposals` and `prospect_engagement_inputs` (per §6). RLS policies mirroring existing
  tenant-scoped tables (see `0027`/RLS pattern). Migrations run on api boot.

### 2. Backend — new `api/src/proposals.js`
- `gatherIntel(tenantId, companyId)` — assemble the 4 input layers:
  - Us: `tenant_profiles` (positioning/objectives/strengths) + TENANT kb.
  - Them: latest `prospect_research` (dossier_md, opportunities) + PROSPECT kb.
  - Field: COMPETITOR kb / battlecards for this prospect's competitive set.
  - Engagement: recent call `portals` for the company (Redis) → `moments`.
- `retrieveGrounding(...)` — call `knowledge/retrieval.js` `retrieveContext()` to pull top-K chunks
  + citation tokens for the synthesis.
- `PROPOSAL_SCHEMA` — Gemini `responseSchema` mirroring §4 (each section: `text`, `confidence`,
  `assumptions[]`, `citations[]`). Follows the `FOLLOWUP_SCHEMA` pattern in `analysis.js:257`.
- `synthesize(intel, grounding)` — one Gemini call on the **analysis/pro tier**
  (`GEMINI_ANALYSIS_MODEL`, see `api/src/models.js`; cf. `knowledge/research.js` dossier synthesis)
  → `content_json` + `coverage_json` + `citations_json`. Model never invents; thin → flagged.
- `createVersion(...)` — insert a `proposals` row (next `version` for the company), status `DRAFT`.
- **Router** (mounted `app.use('/proposals', auth.authMiddleware, …)` in `index.js`, ~line 1130,
  gated behind a `plans.FEATURES` flag via `gating.requireFeature`):
  - `POST /proposals/:companyId/generate` → gather → retrieve → synthesize → persist → return.
  - `GET  /proposals/:companyId` → list versions (latest first).
  - `GET  /proposals/version/:id` → one version.
  - `PATCH /proposals/version/:id` → status `DRAFT→FINAL` (and rep text edits to `content_json`,
    edits scoped to the version; facts untouched).

### 3. Frontend — prospect page (`web/admin/index.html` + `web/admin/admin.js`)
- Add a **Recommendation** tab/section to the prospect view (alongside Signals/People/Intel).
- "Generate recommendation" button → `POST …/generate` with a loading state.
- Render the §4 sections; show per-section **confidence chips** and inline **assumption flags**;
  render the **Intelligence basis** citations footer (reuse the portal citation rendering style).
- Version switcher (latest first); "Mark final" action.

### 4. Gating / models / config
- Feature flag in `api/src/plans.js` (e.g. `FEATURES.PROPOSALS`); decide plan tiers.
- Synthesis model = analysis/pro tier; cap `maxOutputTokens`; structured JSON mode.
- Usage/token accounting consistent with `analysis.js` (store `models`/`usage` on the row).

### 5. Acceptance criteria
- For a prospect with research + ≥1 completed call, **Generate** returns all §4 sections, each with
  ≥1 citation where intel exists and an explicit assumption flag where it doesn't.
- Result persists as `proposals` v1; a second Generate creates v2; both viewable.
- Tenant isolation enforced (RLS) — no cross-tenant data in the synthesis.
- No pricing, no deal-stage fields anywhere in the output.

### 6. Task checklist
- [ ] `0044_proposal_engine.sql` (+ RLS)
- [ ] `api/src/proposals.js` (gather, retrieve, schema, synthesize, persist, router)
- [ ] Mount router + feature flag in `index.js` / `plans.js`
- [ ] Prospect-page Recommendation tab (HTML + admin.js + styles)
- [ ] Citation/confidence rendering
- [ ] Tests: gather/synthesis shape, RLS scoping, versioning
- [ ] (Bonus, unrelated) fix stale "VERIFIED BY GHOSTSTREAM" → DealScope in the current SOW export

---

# Phase 2 — BCC email ingestion (built 2026-06-05)

Forward/BCC a prospect's emails to a per-prospect address; they're filed as
PROSPECT intel and automatically feed research re-analysis + the proposal
synthesis (no separate extraction — `gatherEvidence` already reads PROSPECT KB).

**Code (done):**
- `0045_prospect_inbound_tokens.sql` — one stable token per company (RLS).
- `api/src/inboundEmail.js` — `getOrCreateToken`/`inboxInfo`/`addressFor`;
  `handleInbound()` resolves token → cleans quoted/sig text → `service.ingest`
  as PROSPECT `kb_documents` + logs `prospect_engagement_inputs` (type EMAIL);
  `webhookRouter` (multer multipart) guarded by a secret in the path.
- `index.js`: `app.use('/webhooks/inbound-email', …)` (unauthenticated).
- `proposals.js`: `GET /proposals/:companyId/inbox` → `{configured,address}`.
- `docker-compose.yml`: `INBOUND_PARSE_DOMAIN` / `INBOUND_PARSE_SECRET` passthrough.
- `proxy/nginx.conf`: `location /webhooks/inbound-email/` → api (beats the
  `/webhooks/` capture catch-all).
- Frontend: Proposal tab shows the forward address (copy button) when configured.

Verified end-to-end on staging: simulated SendGrid POST → filed READY PROSPECT
doc + EMAIL engagement input → PROSPECT_INTEL evidence 1→2 → regenerated
recommendation reflected the new email signal.

**Ops to activate (per environment):**
1. Pick an inbound subdomain, e.g. `parse.dealscope.io`. Add a DNS **MX** record
   → `mx.sendgrid.net` (priority 10).
2. SendGrid → Settings → **Inbound Parse** → Add Host & URL:
   host `parse.dealscope.io`, destination
   `https://<host>/webhooks/inbound-email/<INBOUND_PARSE_SECRET>`. (Leave "POST
   the raw, full MIME message" OFF — we consume the parsed fields.)
3. Set `INBOUND_PARSE_DOMAIN` + `INBOUND_PARSE_SECRET` in the env file, redeploy
   api, and (if nginx changed) recreate the proxy.
Until configured, the inbox endpoint reports `configured:false` (UI hides the
card) and the webhook returns 503 — safe no-op.
