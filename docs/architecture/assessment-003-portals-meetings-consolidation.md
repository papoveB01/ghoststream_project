# Assessment-003: Admin Portals + Meetings Consolidation

Status: Proposed
Date: 2026-05-15
Author: System Architect Agent
Scope: read-only review of `papoveB01/ghoststream_project` @ `f564d9ae`

## TL;DR

`Portals` and `Meetings` aren't two surfaces — they're two filtered views of the **same row** (a pipeline run), separated by lifecycle status. H4/H9 enrichment made the duplication visible. Collapse both into a single `Calls` page with status-tab navigation plus a superadmin-gated `Calls (operations)` link. Ship `GET /admin/calls` beside the existing endpoints, swap the UI, retire the old endpoints.

---

## 1. Information-architecture diagnosis

Every successful pipeline run produces one meeting record (`meeting:m_…`, Redis, `store.js` `createMeeting` L35–53) and one portal record (`portal:p_…`, `createPortal` L89–96), linked by `portal.meetingId`. The two admin endpoints (`api/src/index.js` `/admin/portals` L578, `/admin/meetings` L596) each list ONE table.

**What each row represents**

| Surface | Identity | Statuses present | Heavy fields |
|---|---|---|---|
| `/admin/meetings` (`listMeetings`) | Recall.ai bot lifecycle | `creating`/`pending`/`recording`/`analyzing`/`done`/`failed`/`analysis_failed` | `transcript`, `analysis`, `analysisError` |
| `/admin/portals` (`listPortals` + `meetingRefFromRecord`) | AI deliverable | only `done` (portal exists iff analysis succeeded) | `moments`, `email`, `sowSummary`, `grounding`, `objectionClip` |

**Duplicated in the rendered tables** (`web/admin/admin.js`)

- `portalRow` (L214–227): `id`, `title`, `meeting{id, source, meetingUrl, botId, missionId}`, `durationSeconds`, `objection.quote`, `createdAt`, `Open ↗`.
- `meetingRow` (L264–276): `id`, `source`, `status`, `portalId`, `createdAt`.

Overlap: `id`, `source`, `createdAt`. After H4/H9 the Portals row also shows `meetingUrl`, `missionId`, `botId` via `meetingRefFromRecord` (`api/src/index.js` L563–576), so Meetings now shows almost nothing Portals doesn't, except `status` and the existence of failures. **The meaningful separation is one axis: status.** Meetings = all-statuses superset; Portals = `status='done'` subset.

**Diagnosis.** Accidentally two views of one surface, separated by an implicit `WHERE status='done'`. The post-H4/H9 column overlap is the symptom: the UX has carried a denormalised done/not-done partition as a separate page since before enrichment made it visible.

---

## 2. Recommended structure

**One canonical surface: `Calls`, with status tabs.** Replace `#section-portals` and `#section-meetings` (`web/admin/index.html` L519, L535) with `#section-calls`. Tab order, lifecycle left-to-right: `All · Pending · Analysing · Ready · Failed`. Default = `Ready` for the manager view; sidebar exposes a secondary `Calls (operations)` link, gated to superadmin, landing on `Failed`.

Defended:

- The 1:1 meeting↔portal invariant is already enforced (`api/src/index.js` L298–316, L360–379). One logical entity; a `Call` is "one pipeline run in some lifecycle state."
- Status is the dominant axis. Tabs are right for a small finite enum; chips would let users combine incoherent states like "Ready + Failed."
- Generalises forward: manual uploads and sample runs are still calls; `source` becomes a filter, not a separate page.

**Why not (b) Meetings-as-ops + Portals-as-manager.** Two URLs for one entity; H4/H9 enrichment becomes vestigial.

**Why not (c) Mission → Meeting → Portal tree.** Many meetings have no mission — a `(no mission)` node is messier than a flat list. Mission detail UI already exists at `#missions`.

---

## 3. Filtering

### 3.1 Backend contract — `GET /api/admin/calls`

Query params (all optional):

| Param | Type | Notes |
|---|---|---|
| `status` | CSV `pending`/`analysing`/`ready`/`failed` | Bucketed; server maps from raw `meeting.status` |
| `source` | CSV `recall`/`first-loop`/`sample` | |
| `tenant` | CSV uuid | Superadmin only; others force-scoped to `req.tenantId` |
| `mission_id`, `company_id` | CSV uuid | Joins via `meeting.meta.missionId` / `missionCompanyId` |
| `has_gaps` | `none`/`any`/`high` | Drives off `portal.moments.knowledgeGaps[].severity` |
| `from`, `to` | ISO-8601 | `createdAt` range |
| `q` | string | Case-insensitive substring over `id`, `portal.title`, `portal.participants[].name`, `meeting.meetingUrl` |
| `cursor`, `limit` | string + int | Replaces the 50/100 ceiling in `_listByPrefix` |

#### Status bucket → raw status mapping

| Bucket | Raw values |
|---|---|
| `pending` | `creating`, `pending`, `joining_call`, `in_waiting_room`, `in_call_not_recording` |
| `analysing` | `in_call_recording`, `call_ended`, `recording_done`, `analyzing` |
| `ready` | `done` (with `portalId` set) |
| `failed` | `failed`, `analysis_failed`, `done` with no `portalId` (orphan) |

> The Recall-side statuses (`joining_call`, `in_waiting_room`, etc.) are written via `bot.status_changes?.slice(-1)[0]?.code` in `api/src/index.js` L159 and the `bot.status_change` webhook in `capture/src/main.py`. The first-party statuses (`creating`, `analyzing`, `analysis_failed`, `done`) are set explicitly in `index.js`.

Response shape:

```json
{
  "calls": [{
    "id": "m_…",
    "status": "ready",
    "rawStatus": "done",
    "source": "recall",
    "createdAt": "…",
    "meeting": { "id", "meetingUrl", "botId", "durationSeconds",
                 "missionId", "missionCompanyId", "tenantId",
                 "analysisError": null },
    "portal":  { "id", "title", "participants",
                 "objectionQuote",
                 "audit": { "gapCount": 2, "hasHighSeverity": false },
                 "reanalyzedAt": null }
  }],
  "pageInfo": { "cursor": "…", "hasMore": true },
  "facets": {
    "status":  { "ready": 42, "failed": 3, "pending": 1, "analysing": 0 },
    "source":  { "recall": 35, "first-loop": 11 },
    "tenants": { "<uuid>": 38, "<uuid>": 8 }
  }
}
```

Row identity is the **meeting id** (stable across the lifecycle); `portal` is nullable — one stable detail URL regardless of whether analysis has finished, replacing the "portal id appears only after success" friction.

### 3.2 Frontend affordances

- **Top of page:** status tab row (`All · Pending · Analysing · Ready · Failed`) plus a search box bound to `q`.
- **Below tabs:** active-filter chips the user can dismiss individually (`source: recall ×`, `mission: m_42… ×`).
- **Right-rail facet panel (collapsed by default):** Source, Tenant (superadmin only), Mission / Company autocomplete, Date range, Has-gaps tri-state, Has-portal.
- **Per-row:** `Open ↗` (portal when `ready`, ops detail otherwise) plus overflow: `Replay` (for `failed`), `Reanalyze` (for `ready`).

---

## 4. Migration path

Schema → API → UI, every step additive until the final removal.

1. **Schema.** No change. The Redis 1:1 link already exists; the Postgres-meeting table from assessment-002 is a parallel ADR, not a dependency.
2. **API additive.** Add `GET /api/admin/calls` alongside the two existing endpoints. Server reads both prefix scans, left-joins on `portal.meetingId`, derives bucketed status, filters and facets in-process (under ~1000 rows; revisit when assessment-002 lands).
3. **UI cut-over.** Add `#section-calls` + `loadCalls`. Sidebar `Portals` / `Meetings` become `<a href="#calls?status=ready">` and `<a href="#calls?status=failed,analysing,pending">` — every existing deep link resolves.
4. **Sidebar cleanup.** Collapse to `Calls` + (superadmin-only) `Calls (operations)`. Delete the old section HTML and `loadPortals` / `loadMeetings` / `portalRow` / `meetingRow`.
5. **API retirement.** Tag `/admin/portals` and `/admin/meetings` `X-Deprecated: use /admin/calls`, remove after one release.

---

## 5. What it costs us NOT to do this

- **Multi-tenant onboarding** doubles the surface area to teach: "Portals for ready calls, Meetings for everything else" vs. "Calls."
- **Analytics is blocked.** Overview can't show a success rate without joining the two stores; `facets.status` makes "94% last 7 days" trivial and unblocks an Overview tile.
- **Support load.** The most common "where's my call?" ticket (failed run in Meetings, manager only checks Portals) disappears under one page with a status pill.
- **H4/H9 enrichment looks redundant.** Side-by-side tables show the same data twice; consolidation makes it legible.
- **`reanalyze` ergonomics stay broken.** One page with `analysisError` next to a `Replay` button collapses the triage loop operators run today.

---

## 6. Open questions for human decision

**Decision #1 — Default tab** · **RESOLVED**
Default tab = `Ready`. Rationale: managers should land on actionable/completed calls; in-flight rows are noise.
Downstream commitments:
- `Calls (operations)` superadmin link is **mandatory** (not optional).
- Overview "success rate" tile sources from `Ready` count.
- `Failed` tab must surface a count badge visible from the `Ready` view so managers see failure pressure without leaving their default tab.

**Decision #2 — Failure triage owner** · **RESOLVED**
Sysadmin owns failure triage. Consistent with Decision #1: the `Calls (operations)` link lands sysadmins on `Failed`; managers stay on `Ready`.

3. **Is `POST /meetings` (paste-a-Zoom-link) being deprecated?** If so, "orphan (no-mission)" stops being a row state and the `has-mission` facet disappears.
4. **Retention for failed meetings?** Redis keys live forever — the Failed tab fills with stale `analysis_failed` rows without a policy.
5. **Tenant-scoped vs. platform-wide superadmin view?** Drives whether `tenant` is a facet or a top-of-page selector when multi-tenant lands.
6. **Should First-Loop and sample runs hide from `Ready` by default?** They clutter the manager view; engineers still want them visible somewhere.

---

## Implementation Notes — Builder hand-off

Repo: `papoveB01/ghoststream_project` only.

**Order**

1. **API additive.** New `GET /api/admin/calls` in `api/src/index.js`, beside `/admin/portals` and `/admin/meetings`. New `buildCallsList(filters)` in `api/src/store.js` that reads both prefixes via `_listByPrefix`, joins on `portal.meetingId`, buckets status, applies filters + facets. Reuse `meetingRefFromRecord`; add sibling `portalRefFromRecord` (`id`, `title`, `participants`, `objectionQuote`, `audit{gapCount, hasHighSeverity}`) — never ship `transcript`, `analysis`, `grounding` in a list response.
2. **UI additive.** New `#section-calls` in `web/admin/index.html`, `loadCalls` in `web/admin/admin.js`, status tabs + chips + right-rail facet panel. Sidebar `Portals` / `Meetings` become hash-prefilters into `#calls`.
3. **Cleanup.** Remove `#section-portals`, `#section-meetings`, `loadPortals`, `loadMeetings`, `portalRow`, `meetingRow`. Collapse the sidebar to `Calls` + (superadmin-only) `Calls (operations)`. Remove `GET /admin/portals` and `GET /admin/meetings`.

**Checks**

- No filters → row count equals `meetings.length`.
- `status=ready` row count equals `portals.length`.
- Failure smoke: `POST /first-loop` with Gemini stubbed to throw → call appears under `Failed` with `analysisError` and a `Replay` action.
- A `Ready` row opens `/portal/?id=<portalId>`; a `Failed` row opens the operations detail.

**Gotchas**

- Don't pre-render the full `portal` — `grounding` is kilobytes. The `portalRefFromRecord` projection is the contract.
- The 50/100-row ceiling in `_listByPrefix` is the wrong layer for pagination; paginate at `buildCallsList` (assessment-002 will replace this layer anyway).
- Tenant filter: superadmin passes `tenant=` freely; everyone else is force-scoped to `req.tenantId` (reuse the `GET /tenants` guard).
- `loaded[sec]` cache (`admin.js` L18, L95) — `loadCalls` must invalidate `loaded.calls` when filters or the status tab change, not just on `Refresh`.
