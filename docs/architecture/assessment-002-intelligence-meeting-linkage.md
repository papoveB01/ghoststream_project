# Assessment-002: Pre-Call Intelligence ↔ Meeting Lifecycle Linkage

Status: Proposed
Date: 2026-05-15
Author: System Architect Agent
Scope: read-only review of `papoveB01/ghoststream_project` @ `1296c49`

## TL;DR

Linkage **mostly works** along the happy path (Mission → Brief → Mission BRIEFED → Mission detail UI renders brief). It breaks at three seams: (a) the `meetings` Redis record and the `scheduled_meetings` Postgres mission are linked by a soft `meta.missionId` string with no FK; (b) the post-call analysis never reads the brief — it re-retrieves from scratch; (c) several entry points create a meeting **without** ever creating a mission, so no brief is generated at all.

---

## 1. Data model

**What I found.** Two parallel "meeting" entities:

- `scheduled_meetings` (Postgres, `api/db/migrations/0005_missions.sql`) — the Mission. Owns `tenant_id`, `company_id`, scheduled_at, prospect_emails, recall_bot_id, portal_id, **and a denormalized `brief_id`** pointing at `pre_call_briefs.id`. Cascades on company delete via `ON DELETE SET NULL`.
- `pre_call_briefs` (same migration) — the Briefing. `scheduled_meeting_id UUID NOT NULL REFERENCES scheduled_meetings(id) ON DELETE CASCADE`. Schema is **1:many** (one brief row per (re-)generation), surfaced as **1:latest** via `missions/brief.js#getLatest` ordering `generated_at DESC`. `scheduled_meetings.brief_id` is a hot-path shortcut, set by `missions/service.js#setBrief`.
- `meetings` (Redis, `api/src/store.js`) — the Recall.ai bot lifecycle record. Carries `portalId`, `transcript`, `analysis`, and `meta` (free-form JSON). Linked to a mission only via `meta.missionId` (string, no FK, no constraint), populated by `missions/dispatch.js#dispatchBot`.

**Risk.** The Mission ↔ Notetaker Meeting link is a soft string in a JSON blob in a different database. Any path that creates a Recall meeting without a mission (see §6) silently produces an unlinked portal. `meetings:*` keys also lack a `missionId` index — `findMeetingByBotId` does a `KEYS` scan.

**Recommendation.** Add a Postgres `meetings` table (or a `recall_meetings.mission_id` column on a new table) that mirrors the Redis record's identity columns and FKs `mission_id → scheduled_meetings(id)`. Keep Redis as cache. ADR scope; defer to a separate follow-on doc.

---

## 2. Pre-call generation

**What I found.** Brief generation lives in `api/src/missions/brief.js#generate(missionId, tenantId)`. It (1) Firecrawl-scrapes `company_domain` into a transient `kb_documents` row tagged `transient_for_mission_id=missionId`, (2) builds a retrieval query from product/persona/competitor display names + company name, (3) calls `retrieval.retrieveContext` with `engagementProfile + currentMissionId + missionCompanyId`, (4) Gemini-Pro composes markdown + a deterministic tier-grouped appendix, (5) inserts the brief row and flips the mission to `BRIEFED` via `missions/service.js#setBrief`.

Triggers:
- **T-24h cron** (`api/src/scheduler.js#tick`, default expr `* * * * *`): selects `PENDING` missions where `scheduled_at BETWEEN now()+23h AND now()+25h` (LIMIT 5). 2h window is the only retry safety net.
- **On-demand** (`POST /api/missions/:id/brief`, `api/src/missions/index.js`): admin "Generate brief now" button.
- **NOT** triggered at mission creation. `missions/service.js#schedule` writes the row and returns; no synchronous or queued brief job is enqueued.

**Risk.** Same-day bookings are silently un-briefed. A Calendly `invitee.created` event for a meeting <23h away (`api/src/index.js` calendly webhook → `missionsService.schedule`) creates a `PENDING` mission whose `scheduled_at` is outside `findDueMissions`'s lookback. The cron never picks it up; the bot still dispatches at T-2min (`findMissionsDueForBot`); the call proceeds with `mission.status = PENDING` and no brief. There is no on-create "if scheduled_at < BRIEF_LOOKAHEAD_END_HOURS then enqueue immediately" branch.

**Recommendation.** In `missions/service.js#schedule`, after the row is committed, if `scheduled_at - now() < LOOKAHEAD_END_HOURS`, fire-and-forget `brief.generate(missionId, tenantId)` (already async-safe — it manages its own status flips). One conditional, no redesign.

---

## 3. Availability during the call

**What I found.** Two surfaces:

- **Rep-facing**: `GET /api/missions/:id` returns `{ mission, brief: latestBrief }` (`missions/index.js`). The admin UI renders `brief.content_md` as markdown in the mission detail panel (`web/admin/admin.js:765–806`). This is the rep's "5-min-before-the-call" view.
- **Bot-facing**: NONE. `missions/dispatch.js#dispatchBot` constructs `recall.createBot({ metadata: { meetingId, missionId, missionCompanyId, tenantId, app: 'ghoststream' } })` — only identifiers, never `content_md`. `api/src/recall.js#createBot` has no parameter for context injection. The Notetaker is a passive transcriber.

**Risk.** No live in-call surface for the brief — the rep must open the admin UI in a parallel tab. The product spec implies "the bot prepared a briefing" but the Notetaker has zero awareness of it. No "live arena" / in-call copilot view exists in `web/`.

**Recommendation.** Out of scope to add an in-call copilot. Minimum fix: include a short-lived signed brief URL in the calendar invite and the Recall bot's join message. (Not implemented today.)

---

## 4. Post-call linkage

**What I found.** `POST /_internal/meetings/:id/process` (`api/src/index.js`) is the entry point. It reads `meeting.meta.missionId` and `meeting.meta.tenantId`, looks up the mission via `missionsService.get`, derives `engagementProfile` from the mission's tags, then calls `analysis.runPipeline(transcript, { tenantId, engagementProfile, currentMissionId, missionCompanyId })`. `analysis.js#runPipeline` does its **own** entity extraction (Stage 0, Flash) and its **own** `retrieval.retrieveContext` call against the same KB.

The `pre_call_briefs` row for the mission is **never read** during analysis. `grep -r 'pre_call_briefs|brief\.content\|getLatest' api/src/analysis.js` → zero matches. The brief's `retrieved_citations` (a JSONB snapshot of what the AI saw pre-call) and its predicted objections are not threaded into the analysis prompt.

**Risk.** "Did the rep handle the objections we predicted?" cannot be answered — the post-call pipeline doesn't know what was predicted. Two AI consultations of the same KB scope, both billable, no shared state.

**Recommendation.** In `analysis.runPipeline`, when `currentMissionId` is set, fetch the latest brief via `brief.getLatest(tenantId, currentMissionId)` and pass its `content_md` (truncated) into the Stage-1 prompt as a `## Pre-Call Brief (what we expected)` block. No schema change; one new read; existing `MOMENTS_SCHEMA.knowledgeGaps` already carries the right shape for "rep contradicted the brief."

---

## 5. Tenant knowledge grounding

**What I found.** Real and tenant-scoped. `api/src/knowledge/retrieval.js#retrieveContext` requires a `tenantId` (throws 400 otherwise) and injects `AND d.tenant_id = $N` into every chunk query. Engagement scope (`engagementClause`) applies a hard-filter-with-global-fallback over `kb_document_products / _personas / _competitors`. `brief.js` calls it with the mission's `tenant_id` (line 184). The Tri-Tiered tier (`deriveTier`) labels chunks LIVE_PULSE / PROSPECT_MEMORY / BASIS based on `transient_for_mission_id` and `company_id`.

Live-pulse grounding: `web.syncUrl` (`api/src/knowledge/web.js`, called from `brief.js:147`) Firecrawl-scrapes `company_domain` into a transient `kb_documents` row scoped to `scope='PROSPECT'`, `company_id=mission.company_id`, `transient_for_mission_id=missionId`.

**Risk.** The Calendly webhook handler hardcodes `FOUNDERS_TENANT_ID` (`api/src/index.js` ~390: `missionsService.schedule(userModel.FOUNDERS_TENANT_ID, fields)`). Comment acknowledges this as Phase-1 punt. Any non-Founders tenant connecting Calendly will see its inbound bookings land in the Founders tenant and ground against the Founders KB — cross-tenant data leak, not just a bug.

**Recommendation.** Block Calendly OAuth connect for non-Founders tenants until multi-tenant routing is wired (key off `tok.organization` in `integrations.js#handleCalendlyCallback`, store a `tenant_id → calendly_org_uri` map, look it up on the inbound webhook). One-line guard at the handler entrypoint is the right interim move.

---

## 6. Orphans and gaps

**What I found.**

1. **Manual `POST /meetings`** (`api/src/index.js`, "paste a Zoom link") creates a Redis meeting with `meta: {}` and dispatches a bot. No mission. No brief. Post-call analysis runs against `FOUNDERS_TENANT_ID` fallback (line in `/_internal/.../process`) with empty engagement profile. **Orphan portal, every time.**
2. **Same-day mission** (any path, §2 above): mission exists, brief doesn't, bot still dispatches, portal is generated, `mission.status` stuck at `PENDING`.
3. **Failed brief**: `scheduler.js` comment explicitly says auto-retry is disabled — `findDueMissions` filters `status='PENDING'` only, so a one-time Gemini outage leaves the mission `FAILED` until manual re-run. Acceptable but unsurfaced outside the mission-detail panel.
4. **Calendly tenant routing** (§5 above): all bookings → Founders.

There are no orphan briefs (FK `ON DELETE CASCADE` on `scheduled_meeting_id` enforces it), and no path generates a brief without a mission.

**Risk.** Items 1 and 2 produce a portal that the spec implies should always carry a brief — silently failing the product promise rather than refusing.

**Recommendation.** Add a single guard in `/_internal/meetings/:id/process`: if `meeting.meta.missionId` is set but the mission has `status='PENDING'`, kick `brief.generate` synchronously before analysis. If `missionId` is unset, log a `WARN orphan-meeting` and proceed (the manual `/meetings` path is intentional; the warning makes it auditable).

---

## Builder hand-off

Repo: `papoveB01/ghoststream_project` only.

Order of operations:
1. **#2 fix** — `api/src/missions/service.js`: in `schedule()`, after `return get(...)`, if `scheduled_at - now() < BRIEF_LOOKAHEAD_END_HOURS`, fire `brief.generate(missionId, tenantId).catch(logger.warn)` without awaiting.
2. **#4 fix** — `api/src/analysis.js`: in `runPipeline`, when `currentMissionId` is set, call `require('./missions/brief').getLatest(tenantId, currentMissionId)` and thread `latest?.content_md` (truncate to ~2000 chars) into the Stage-1 prompt as a new `## Pre-Call Brief` block. Update `MOMENTS_SCHEMA` description for `knowledgeGaps` to include "rep contradicted the brief" cases. No schema migration.
3. **#5 fix** — `api/src/integrations.js#handleCalendlyCallback`: refuse the OAuth if `st.tenantId !== FOUNDERS_TENANT_ID`, redirect with `cal_error=Calendly is Founders-only in Phase 1`.
4. **#6 fix** — `api/src/index.js` `/_internal/meetings/:id/process`: after `tenantId` is resolved, if `meeting.meta.missionId` exists, fetch the mission; if `status='PENDING'`, await `brief.generate(missionId, tenantId)` before `analysis.runPipeline`. If the mission has no missionId, log `[process] orphan-meeting` with the meetingId.

Checks to run:
- `node api/db/migrate.js` (no migrations expected — verify nothing new is pending).
- Smoke: `POST /api/missions` with `scheduled_at = now()+1h`, then `POST /api/missions/:id/dispatch-bot?force=1` with a Recall-ready URL, then simulate `bot.done` via `POST /_internal/meetings/:id/process` with a fixture transcript. Assert `mission.brief_id` is set and `portal.grounding.citations` is non-empty.
- Re-run the smoke against the same flow but with `scheduled_at = now()+5min` to confirm the in-line brief fires.

Gotchas:
- `brief.generate` is async-safe but takes 10–30s. Don't await in #1; do await in #6 (the bot.done webhook is already long-running and we need the brief in the prompt).
- The mission detail UI re-renders from `GET /missions/:id`; no UI changes needed.
- Don't touch the Redis `meetings` shape — §1's Postgres-meeting refactor is a separate ADR.
