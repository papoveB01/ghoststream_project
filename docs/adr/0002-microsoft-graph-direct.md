# ADR-0002: Direct Microsoft Graph integration for calendar + Teams

- **Status:** Amended (2026-05-29 — see §8)
- **Date:** 2026-05-29
- **Authors:** Builder (integration pass)
- **Affects:** `api/src/integrations.js`, `api/src/microsoft.js` (new),
  `api/src/recall.js`, `api/src/index.js`, `api/db/migrations/*`,
  `web/admin/admin.js`, `.env.example`.

> **Reader note.** Sections 1–7 below are the **original proposal**.
> The Piece B (Recall.ai Teams bot) shape described there is wrong on
> the underlying model — Recall does not expose a programmatic API for
> Teams signed-in bot credentials, and the credential is a Microsoft
> **user account** (email + password), not an Azure AD app. The actual
> shipped behaviour is documented in §8 *Correction*. When the two
> sections conflict, §8 is authoritative.

## 1. Context

GhostStream already reads reps' calendars through **Nylas v3** hosted
auth (`api/src/integrations.js`). The provider picker on the
Integrations page exposes Google, Microsoft 365 / Outlook, and
iCloud / IMAP — Nylas owns the OAuth dance and we hold a
per-`(tenant, user)` `grant_id` in Redis.

Recall.ai bots are dispatched off the meeting URL on a mission
(`api/src/missions/dispatch.js`). The `RECALL_HOSTS` regex already
includes `teams.microsoft.com` and `teams.live.com`, so any
Teams meeting URL pulled from a Nylas event flows end-to-end today —
**when the meeting allows anonymous join.** Many corporate Teams
tenants explicitly disable anonymous join; in that case the Recall bot
sits in the lobby and times out, and the call goes uncovered.

Two pressures motivate this ADR:

1. **Cost & latency.** Nylas charges per connected mailbox and adds a
   proxy hop on every event-list call. For Microsoft 365 users — the
   largest segment of B2B sales orgs — Microsoft Graph exposes the
   same data natively at no incremental cost.
2. **Locked-down Teams meetings.** Recall.ai supports an authenticated
   "Teams bot" mode where the bot joins as an app identity, not as an
   anonymous guest. Lighting that up requires a Microsoft Azure AD
   app on **our** side whose application-permission credentials we
   register with Recall via their `/teams-bot-credentials/` endpoint,
   plus a one-time admin-consent grant from the customer's Microsoft
   tenant.

Both pressures share the same primitive — an Azure AD app — so we
ratify the decision in one ADR and ship the two pieces (calendar reads
+ Recall Teams bot) as separate, independently releasable PRs.

## 2. Decision drivers

| Driver                                                                              | Why it matters                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-tenant SaaS posture.** Every customer is a separate Microsoft tenant.       | Whatever shape we pick has to scale to N customers without N Azure registrations on our side or theirs.                                                         |
| **No regression for Google / iCloud reps.** Nylas covers them today.                | Replacing Nylas wholesale would force every existing connected rep to re-auth and would orphan iCloud users.                                                    |
| **Customer-admin friction.** IT admins approve apps reluctantly.                    | The admin-consent step should fire **at most once per customer tenant**, never per rep, and only when a customer actually wants the authenticated Teams bot.    |
| **Defence in depth at the credential boundary.** A leaked Recall API key shouldn't expose Microsoft creds. | Microsoft creds are the highest-value secret in this integration; we treat them like a database password, not like an API key in `.env`.                       |
| **Cleanly diagnosable failures.** "Bot joined the lobby and timed out" is a terrible failure mode. | When anonymous-join is disabled and admin consent hasn't been granted, the user-facing error has to say so, not "Recall.ai rejected the bot dispatch".          |
| **Forward path to native Teams Online Meetings.** Eventually we may want to *create* Teams meetings, not just join them. | The scope set on day one should not preclude `OnlineMeetings.ReadWrite` / `Calls.JoinGroupCall.All` in a later increment.                                       |

## 3. Alternatives considered (the Azure AD app shape)

### Option A — One single-tenant Azure AD app, in our Azure tenant

- **Pro:** Simplest registration; no customer-admin involvement.
- **Con:** Customers in other Microsoft tenants literally cannot sign
  in — the app's `signInAudience` rejects them. A non-starter for a
  multi-tenant SaaS. **Not chosen.**

### Option B — One multi-tenant Azure AD app, in our Azure tenant

(`signInAudience = AzureADMultipleOrgs`, authority `/common`.)

- **Pro:** One registration, every customer's user can authenticate
  against it. Delegated scopes (`Calendars.Read`,
  `OnlineMeetings.Read`, `offline_access`) need only **user consent**
  — no IT-admin involvement for the per-rep calendar connect.
  Standard SaaS pattern (Slack, Zoom, Notion, Linear all converged
  here). Application-permission scopes for the Recall Teams bot
  (`OnlineMeetings.Read.All`) need **one admin consent per
  customer tenant**, fired explicitly from a "Authorize Teams bot
  for organization" button by the customer's owner.
- **Con:** A bug in our app surface affects every customer. Mitigated
  by the same multi-tenant disciplines from ADR-0001: scope all
  tokens by `(tenantId, userId)` in Redis, no cross-tenant code paths,
  audit logging on the admin-consent action.

### Option C — One Azure AD app per GhostStream customer (BYO app reg)

- **Pro:** Stronger isolation — a credential leak affects one
  customer, not all. Some regulated industries explicitly require
  this.
- **Con:** Onboarding cost balloons — every customer's IT admin
  registers an Azure app, copies client id + secret to us, manages
  rotation. Recall.ai's `/teams-bot-credentials/` is configured at
  *our* Recall org level, not per customer, so we'd need a credential
  mapping table on Recall's side — they don't currently surface a
  per-org-per-customer credential slot. **Defer to enterprise
  follow-up.** When an enterprise contract demands it, we add an
  override path that stores per-tenant Microsoft creds in Postgres
  (encrypted) and rotates the Recall credential at bot dispatch time.

### Option D — Replace Nylas entirely with direct Google + Microsoft

- **Pro:** No Nylas dependency, lower run cost, fewer hops.
- **Con:** Doubles the work today (Google OAuth is the same shape as
  Microsoft but in a separate provider with separate quirks), loses
  iCloud / IMAP support entirely, forces every currently-connected
  Nylas user to re-auth. **Not chosen for this ADR.** Revisit once
  the direct-Microsoft path has soaked for a release and we can see
  whether the Nylas-Microsoft fraction is large enough to justify
  also building direct-Google.

## 4. Decision

We adopt **Option B**: one multi-tenant Azure AD app in *our* Azure
tenant, sitting **alongside** the existing Nylas integration.

### 4.1 The Azure AD app

Registered once, in our own Azure tenant, with:

- `signInAudience = AzureADMultipleOrgs` (multi-tenant).
- Redirect URIs:
  - `${APP_BASE_URL}/api/integrations/microsoft/callback` —
    per-user delegated OAuth.
  - `${APP_BASE_URL}/api/integrations/microsoft/admin-consent-callback` —
    per-customer admin-consent return.
- **Delegated** API permissions (user consent, no admin needed):
  - `Calendars.Read` — list events on `/me/calendarView`.
  - `OnlineMeetings.Read` — read the `onlineMeeting.joinUrl` from
    events.
  - `User.Read` — read the rep's `userPrincipalName` for display.
  - `offline_access` — get a refresh token.
  - `openid`, `profile` — id-token plumbing.
- **Application** API permissions (admin consent required, for the
  Recall Teams bot):
  - `OnlineMeetings.Read.All` — the scope Recall.ai's Teams bot
    documents.
  - (Future, separate ADR) `Calls.JoinGroupCall.All`,
    `Calls.JoinGroupCallAsGuest.All` if/when we move to native
    Calls APIs instead of Recall.

The client secret lives in `.env` as `MS_CLIENT_SECRET`. It is **never
forwarded to the browser**, never logged at any level, and never
written to Postgres. The same secret is used (a) by our server for
the per-user OAuth token exchanges and (b) once at the time the
customer-admin authorizes the Teams bot, in a single server-to-server
POST to Recall's `/teams-bot-credentials/`. After that POST Recall
holds its own copy; we still re-send on rotation.

### 4.2 Per-user calendar OAuth (Piece A)

Mirrors the existing Calendly OAuth flow in `integrations.js`:

1. `GET /api/integrations/microsoft/connect` — authMiddleware'd. Mints
   a CSRF state (`crypto.randomBytes(24)`), stores
   `{ tenantId, userId, scope: 'calendar' }` in Redis under
   `ms_state:{state}` for 10 minutes, and 302-redirects to
   `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize`
   with `response_type=code`, `client_id=${MS_CLIENT_ID}`,
   `redirect_uri`, `scope`, `state`, `response_mode=query`,
   `prompt=select_account`.
2. Microsoft redirects the browser to `/api/integrations/microsoft/callback?code&state` —
   mounted **un-authed** in `index.js` (same as the Nylas / Calendly
   callbacks; the browser carries no session cookie back from
   Microsoft's consent screen).
3. The callback consumes the state, exchanges the code at
   `/oauth2/v2.0/token` for an access + refresh token, and writes
   `{ accessToken, refreshToken, expiresAt, scope, msUserId,
     msTenantId, email, connectedAt }` to
   `ms_grant:{tenantId}:{userId}` in Redis with a 180-day TTL —
   matching `GRANT_TTL_SEC` in `integrations.js`.
4. The browser is 302'd back to `/admin/?ms=connected#integrations`.

Reads happen through a thin `microsoft.fetchUpcomingEvents(tenantId,
userId, { days })` that:

- Loads the grant from Redis. If expired or near-expiry (≤ 60 s),
  refreshes with the stored refresh token first.
- `GET /v1.0/me/calendarView?startDateTime=…&endDateTime=…&$top=…&$select=…&$expand=…`.
  We `$select` only the fields we need (id, subject, start, end,
  organizer, attendees, onlineMeeting, location) to keep the response
  small.
- Normalises each event to the same shape `integrations.normalizeEvent`
  emits, so the schedule-form picker is provider-agnostic on the
  frontend. The Teams join URL comes from `onlineMeeting.joinUrl`.
- Filters to upcoming, non-cancelled events; sorts by start.

The provider entry on the Integrations page surfaces:

- Configured / not configured (env vars present).
- Connected / not connected per-user, with the rep's
  `userPrincipalName`.
- A "Disconnect" action that deletes the Redis grant and revokes the
  refresh token at
  `/oauth2/v2.0/logout` (best-effort; failure is non-fatal because
  the token will expire anyway).

### 4.3 Customer-admin consent + Recall Teams bot registration (Piece B)

Per **customer tenant** — not per user — exactly once.

1. The customer's tenant **owner** (`req.user.role === 'owner'`)
   sees an "Authorize Teams bot for organization" button on the
   Microsoft card on the Integrations page. The button is hidden for
   non-owner users.
2. Clicking it hits `GET /api/integrations/microsoft/admin-consent`,
   which mints a state (different Redis key prefix
   `ms_admin_state:{state}` so it can't collide with per-user
   consents) and 302-redirects to
   `https://login.microsoftonline.com/${TENANT}/adminconsent?client_id=${MS_CLIENT_ID}&redirect_uri=${ADMIN_CONSENT_CALLBACK}&state=…`.
   `${TENANT}` is left as `organizations` so the admin signs into
   *their own* Microsoft tenant and consents on its behalf.
3. Microsoft redirects back to
   `/api/integrations/microsoft/admin-consent-callback` with
   `?tenant=<their-ms-tenant-id>&state=…&admin_consent=True`. The
   handler validates the state, stores the consent in Postgres
   (`tenant_microsoft_consent`, see §4.4), and immediately calls
   Recall.ai's `/teams-bot-credentials/` endpoint with
   `{ ms_tenant_id, client_id: MS_CLIENT_ID, client_secret:
     MS_CLIENT_SECRET }`. The returned credential id is stored on the
   same row.
4. On every subsequent Recall bot dispatch for that GhostStream tenant,
   `dispatch.js` passes the Recall credential id through to
   `recall.createBot({ teams_bot_credential_id })`. Recall then uses
   the stored credentials to authenticate against Microsoft for any
   Teams meeting in that customer's MS tenant. **No change to the
   `RECALL_HOSTS` regex is needed** — the join URL is still
   `teams.microsoft.com/...`; only the auth identity Recall uses to
   join changes.

If admin consent has **not** been granted, dispatch behaves exactly as
today: anonymous-join is attempted. The user-facing error on a Teams
lobby timeout (`recall.createBot` rejection or a downstream webhook
`bot.status_change → failed`) checks the absence of the consent row
and surfaces a clear message: *"This Teams meeting requires
authorization — ask an organization owner to authorize the GhostStream
Teams bot on the Integrations page."*

### 4.4 Schema

New migration `0012_microsoft_tenant_consent.sql`:

```sql
CREATE TABLE tenant_microsoft_consent (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ms_tenant_id         text NOT NULL,
  consented_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  consented_at         timestamptz NOT NULL DEFAULT now(),
  scopes               text[] NOT NULL DEFAULT '{}',
  recall_credential_id text,
  revoked_at           timestamptz
);
```

The row is created (or `ON CONFLICT (tenant_id) DO UPDATE`'d) by the
admin-consent callback and read by `dispatch.js` to decide whether to
pass `teams_bot_credential_id` to Recall. `revoked_at` is set when an
owner revokes — Recall keeps the credential live but our dispatcher
stops referencing it.

No per-user table is needed for the calendar grant; it stays in
Redis with the same TTL pattern as Nylas (180 days, rolling). If we
later want grants to survive Redis restarts, we promote them to a
`user_microsoft_grants` table; not blocking.

### 4.5 Multi-tenant invariants this preserves

1. **Per-user calendar grant is `(tenantId, userId)`-keyed in Redis.**
   A rep in Tenant A cannot read a rep in Tenant B's events. Same
   isolation guarantee as Nylas / Calendly today.
2. **Admin consent is `tenantId`-keyed in Postgres.** Tenant A's
   owner consenting does not authorize Tenant B's Teams meetings —
   the `ms_tenant_id` Recall stores is Tenant A's customer-side
   Microsoft tenant id, not ours.
3. **No tenant data crosses the Microsoft boundary.** We pull
   *from* Graph; we never push tenant-owned content out. The only
   data Microsoft sees about us is the OAuth dance (which user
   consented, which scopes).
4. **No customer creds leave our server.** The `MS_CLIENT_SECRET` is
   ours, and never per-customer. The Recall credential id is opaque
   to the customer and not exposed in any API response.

### 4.6 Threat model deltas

Beyond ADR-0001's table:

| # | Threat                                                                                         | Mechanism                                                                                                                                | Mitigation                                                                                                                                                                                                                                                                              |
| - | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 11 | **Misuse of admin-consent button.** A non-owner triggers the consent flow and authorizes the org without permission. | Bug in the role check, or a stolen owner session.                                                                                       | Server-side `req.user.role === 'owner'` check on `/microsoft/admin-consent`; UI hides the button for non-owners (cosmetic, not load-bearing); consented_by stamped on the row for audit; revoke action sets `revoked_at` and POSTs Recall a `DELETE`.                                       |
| 12 | **Replay of the admin-consent redirect.** A leaked admin-consent state code is replayed to register Microsoft creds against a different tenant. | A malicious party intercepts the state value before Microsoft fires the callback.                                                       | State is single-use, consumed atomically in Redis (`GET` then `DEL`), and binds `tenantId` server-side. Even a successful replay lands the consent on the same `tenantId` we wrote at issue time.                                                                                            |
| 13 | **Cross-customer Teams bot impersonation.** Recall uses Tenant A's credential id to join a meeting in Tenant B's Microsoft tenant. | Bug in `dispatch.js` that picks the wrong `tenant_microsoft_consent` row.                                                               | `dispatch.js` reads `tenant_microsoft_consent` `WHERE tenant_id = $1` with the dispatcher's `req.tenantId` (which is itself derived from the mission's `tenant_id`). RLS (ADR-0001 §M4) blocks cross-tenant SELECT once enabled.                                                              |
| 14 | **Client secret leak via logs.** A future debug branch logs the OAuth response body.            | Developer adds `console.log(tokenResponse)` while diagnosing a token-exchange bug.                                                       | Token-exchange and refresh helpers redact `access_token`, `refresh_token`, `id_token`, and any `client_secret` before any logging. A small `redactForLog(obj)` helper in `microsoft.js`, used at every error log site.                                                                       |
| 15 | **Stale Recall credential after secret rotation.** We rotate `MS_CLIENT_SECRET`; Recall still holds the old one; Teams bot joins start failing. | Operational drift between our `.env` and Recall's stored credential.                                                                     | Rotation runbook: change `MS_CLIENT_SECRET`, then re-POST to `/teams-bot-credentials/{id}` for every tenant with a non-null `recall_credential_id`. Cron sweep (`scheduler.js`) checks at boot that the Recall credential id is still resolvable; logs `ms.recall_credential_stale` on 404. |

## 5. Consequences

**What this makes easy:**

- Microsoft 365 reps connect a calendar with one fewer hop, no Nylas
  cost, and a `userPrincipalName` we can show in the UI.
- Customer IT admins authorize the Teams bot **once** for their whole
  org, then every rep's locked-down Teams meeting Just Works.
- Adding `OnlineMeetings.ReadWrite` later (to *create* Teams meetings
  from a portal) is a scope-extension on the same app reg.

**What this makes harder:**

- Two ways to connect Microsoft (Nylas-Microsoft and direct) ship
  side-by-side during the transition. The Integrations page has to
  clearly label which is which; we accept the short-term confusion
  for the no-breakage guarantee. Once direct-Microsoft soaks for a
  release, we hide the Nylas-Microsoft button and surface a "switch
  to direct" prompt for any user still connected via Nylas-Microsoft.
- The `MS_CLIENT_SECRET` is now an extra rotation target for the ops
  team. Documented in the rotation runbook (Phase-2 follow-up).

**Residual risk we explicitly accept:**

- An owner who leaves the company can still have stamped
  `consented_by` on the consent row; the row stays valid because the
  consent belongs to the *tenant*, not the user. We surface the
  consenter in the UI so a new owner can revoke and re-consent if
  they want a fresh audit trail.

## 6. Open questions

- **Token storage durability.** Refresh tokens live in Redis with a
  180-day TTL. If Redis is wiped, every rep reconnects. Acceptable
  for Phase-1 (matches Nylas); promote to Postgres if/when an
  enterprise customer asks for survivability.
- **Recall `/teams-bot-credentials/` exact path & shape.** Recall's
  current docs use this shape; verify against the API at build time
  and pin the version with a `RECALL_TEAMS_BOT_PATH` env override so
  we can adapt without a redeploy.
- **EU / Gov clouds.** `MS_TENANT_ID=common` covers global Azure
  AD; sovereign clouds (Azure Government, China 21Vianet) use
  different login hostnames. Out of scope; we'll add a
  `MS_AUTHORITY_HOST` override when a sovereign-cloud customer signs.

## 7. Builder hand-off

Two PRs, each independently shippable. PR A is the prerequisite for
PR B (the admin-consent flow needs the Azure app registered and the
OAuth helpers landed), but PR A is useful on its own — it gives
Microsoft 365 reps a direct calendar path without changing dispatch
at all.

### PR A — Direct Microsoft Graph calendar (Piece A)

**Files / modules touched:**

- `.env.example` — `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`
  (default `common`), `MS_REDIRECT_URI` (optional override). Document
  alongside the Calendly block.
- `api/src/microsoft.js` (new) — auth URL builder, code/refresh token
  exchange, per-(tenant, user) Redis grant storage, `fetchUpcomingEvents`,
  `connection(tenantId, userId)`, `redactForLog`.
- `api/src/integrations.js` — register a `microsoft` entry in
  `PROVIDERS`; mount `GET /microsoft/connect`,
  `GET /microsoft/events`, `DELETE /microsoft/connection`; extend
  `statusPayload` with the Microsoft connection. Export
  `handleMicrosoftCallback` for the unauthed mount in `index.js`.
- `api/src/index.js` — mount
  `app.get('/api/integrations/microsoft/callback',
    integrations.handleMicrosoftCallback);` **before** the
  authMiddleware'd integrations router.
- `web/admin/admin.js` — third provider card "Microsoft 365 (direct)";
  wire its "Connect" button to `/api/integrations/microsoft/connect`;
  wire its disconnect to `DELETE /api/integrations/microsoft/connection`;
  extend the schedule-form picker to also pull from
  `/api/integrations/microsoft/events`.

**Verification:**

- Walk a fresh dev tenant through Connect → see calendar events →
  see Teams `joinUrl` populated where the event has one.
- Confirm `dispatch.js` accepts the Graph-returned `joinUrl` (it
  should — the host is `teams.microsoft.com`, already in
  `RECALL_HOSTS`).

### PR B — Recall.ai Teams bot authentication (Piece B)

**Files / modules touched:**

- `api/db/migrations/0012_microsoft_tenant_consent.sql` (new) — the
  schema from §4.4.
- `api/src/microsoft.js` — `adminConsentUrl(state)`,
  `handleAdminConsentCallback`.
- `api/src/recall.js` — `registerTeamsBotCredentials({
   msTenantId, clientId, clientSecret })`; pin path via
  `RECALL_TEAMS_BOT_PATH` env override.
- `api/src/integrations.js` — mount `GET /microsoft/admin-consent`
  (owner-gated), extend `statusPayload` with admin-consent state,
  `DELETE /microsoft/admin-consent` revokes.
- `api/src/index.js` — mount
  `/api/integrations/microsoft/admin-consent-callback` unauthed.
- `api/src/missions/dispatch.js` — read
  `tenant_microsoft_consent.recall_credential_id` for the dispatcher's
  tenant and pass `teams_bot_credential_id` to `recall.createBot` when
  the meeting URL host is `teams.microsoft.com` / `teams.live.com`.
- `web/admin/admin.js` — "Authorize Teams bot for organization"
  button on the Microsoft card; shown only when
  `req.user.role === 'owner'`; surface consent state
  (`Authorized · since YYYY-MM-DD by alice@…` / `Not authorized — anonymous-join only`).

**Verification:**

- Owner triggers admin consent → consent row stored, Recall returns
  a credential id, displayed on the card.
- Dispatch a bot to a `teams.microsoft.com` URL; confirm the
  `teams_bot_credential_id` is present in the `createBot` payload
  by reading the Recall.ai bot record.
- Revoke → `revoked_at` set, dispatcher stops sending the credential
  id, next bot dispatch falls back to anonymous-join.

---

**Reviewers should pay extra attention to:**

1. PR A's `handleMicrosoftCallback` mounting position — it MUST sit
   before `app.use('/integrations', auth.authMiddleware, …)` or the
   browser's cookieless return from Microsoft will 401.
2. PR B's owner-gating of `/microsoft/admin-consent` — the UI hiding
   the button is cosmetic; the server check is load-bearing.
3. The `MS_CLIENT_SECRET` never appears in any log line, error
   message, or response body. Verify by greping the new module for
   `console` and checking `redactForLog` is called at every error
   site.

## 8. Correction (2026-05-29)

Building PR B turned up that the underlying premise — "Recall.ai
exposes a `/teams-bot-credentials/` endpoint to programmatically
register Azure AD application credentials" — does not match Recall's
current API. The 404 returned by Recall on the first end-to-end test
prompted a re-read of their docs:

- **Recall's signed-in Teams bot uses a Microsoft 365 *user account*
  credential** (email + password), not an Azure AD app's
  `client_id` / `client_secret`. ("Add the bot's email & password",
  per *Setting up Signed-in Bots for Microsoft Teams*.)
- **There is no REST endpoint to register or rotate Teams bot
  credentials.** Configuration is done once via the Recall dashboard
  (*Meeting Bot Setup → Microsoft Teams → Signed-in Microsoft Teams
  credentials*). The only programmatic credential endpoints in their
  llms.txt are for Zoom OAuth — Teams is dashboard-only.
- **The signed-in setting is per-Recall-organization, not per-customer-
  tenant.** The "Login Mandatory" toggle is org-wide; once enabled,
  every bot in the Recall org signs in before joining.
- **`POST /bot/` has no field to select credentials.** Recall picks the
  signed-in identity automatically when the meeting requires one (or
  always, with "Login Mandatory" on).

### 8.1 What this means for the original design

The architecture in §4.3–§4.4 was built around four claims that turn
out to be false:

| Original claim                                                            | Reality                                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Customer admins do an org-wide Microsoft admin-consent in their MS tenant | Not needed. We use no application-permission scopes — only delegated, which need user consent only. |
| Their admin-consent unlocks a Recall.ai Teams bot credential per customer | Recall stores **one** Microsoft credential per **our** Recall org, not per customer.                |
| `OnlineMeetings.Read.All` is the scope Recall uses                        | Recall doesn't use Graph API permissions at all — it uses a Microsoft user account password.        |
| Per-tenant `recall_credential_id` flows into `POST /bot/`                  | No such field on the bot create body.                                                                |

Piece A (per-user delegated Graph for calendar) is **unaffected** —
it's a normal user-OAuth flow that doesn't depend on Recall.

### 8.2 Corrected Piece B

Authenticated Teams meeting joining becomes an **operator runbook**,
not an in-app flow:

1. Operator creates one Microsoft 365 user in our own MS tenant
   (e.g. `ghoststream-bot@eel-global.com`). Mailbox is fine to leave
   un-licensed beyond what Teams requires.
2. Operator configures that user's email + password once on the
   Recall dashboard (per region).
3. Customer-side: when the bot joins a Teams meeting, it shows up as
   that external authenticated user. The customer's host either
   admits it from the lobby, the customer's Teams meeting policy
   allows authenticated external participants, or the customer's
   admin adds the bot user as a guest in their tenant.
4. **No per-tenant DB row, no admin-consent flow, no Recall API
   call.** The GhostStream admin Integrations card surfaces a one-
   line pointer to the Recall dashboard runbook; that's it.

### 8.3 Code & schema reversal

The following surfaces shipped in the original PR but are now removed
or reduced:

- `api/src/microsoft.js` — `adminConsentUrl`, `handleAdminConsentCallback`,
  and the `'admin'` branch of `makeOAuthState` / `consumeOAuthState`
  are removed. The module keeps only the per-user delegated OAuth
  + Graph calendar surface.
- `api/src/integrations.js` — `loadMicrosoftConsent`, `recordMicrosoftAdminConsent`,
  `revokeMicrosoftAdminConsent`, `handleMicrosoftAdminConsentCallback`,
  and the `/microsoft/admin-consent` GET + DELETE routes are removed.
  `microsoftConnection` returns only the per-user grant; the
  `connection.admin` sub-object is dropped from the status payload.
- `api/src/recall.js` — `registerTeamsBotCredentials` and
  `deleteTeamsBotCredentials` are removed. `createBot`'s
  `teamsBotCredentialId` parameter + `teams_bot_login` body field
  are removed; the call shape returns to the pre-amendment surface.
- `api/src/missions/dispatch.js` — the consent lookup + credential
  pass-through introduced for Piece B are removed. Dispatch reverts
  to the pre-amendment shape; Recall picks the dashboard-configured
  signed-in identity automatically when needed.
- `api/src/index.js` — the
  `/integrations/microsoft/admin-consent-callback` mount is removed.
- `web/admin/admin.js` + `web/admin/index.html` — the "Authorize
  Teams bot for organization" / revoke buttons + the `isOwner`
  gating + the `ms_admin` flash key are removed. The Microsoft 365
  card shows a short informational line about Recall dashboard
  configuration for authenticated Teams meetings, with a link to
  the runbook.
- `api/db/migrations/0013_drop_microsoft_tenant_consent.sql` (new)
  — `DROP TABLE IF EXISTS tenant_microsoft_consent;`. Migration 0012
  is kept in the history (we don't rewrite migrations) but is
  effectively superseded by 0013.
- `.env.example` — the `OnlineMeetings.Read.All` (application
  permissions) bullet is removed from the Azure registration
  instructions. `RECALL_TEAMS_BOT_PATH` is removed entirely.

### 8.4 What the Azure AD app needs (corrected)

Only the **delegated** permissions are required:

- `Calendars.Read`
- `OnlineMeetings.Read`
- `User.Read`
- `offline_access`
- `openid`
- `profile`

The `OnlineMeetings.Read.All` application permission can be removed
from the existing dev app registration — nothing in the code uses it.

### 8.5 Open question carried forward

If Recall.ai ships a real `/teams-bot-credentials/` (or per-bot
auth) API later, Piece B can be re-introduced **without changing the
Microsoft side** — the same Azure AD app already in production
(application-permission grants would just need a re-add). The shape
of the DB row in 0012 is also a reasonable starting point if it
returns.

### 8.6 Threat model deltas removed

ADR-0002 §4.6 entries #11 through #15 were specific to the
admin-consent + Recall registration flow. With Piece B removed
they don't apply; the operator-runbook replacement has its own much
smaller surface (a single Microsoft user account password held on
Recall's dashboard) which is governed by Recall's security posture,
not ours.

## 9. Scope expansion — meeting creation + contacts (2026-05-29)

After the dashboard-based unwind in §8, the next product increment is
**originating Teams meetings from GhostStream itself** (rep schedules
in our UI → we call Microsoft Graph → real Teams `joinUrl`, Outlook
sends the invite) plus a **contacts autocomplete** on the attendees
field. Both ride on the same Azure AD app — only the requested scopes
change.

### 9.1 New delegated scopes

| Scope                          | What it enables                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `Calendars.ReadWrite`          | Create / update / delete events on the rep's primary calendar (replaces `Calendars.Read`). |
| `OnlineMeetings.ReadWrite`     | Create the underlying Teams `onlineMeeting` record when the event has `isOnlineMeeting=true`. |
| `Contacts.Read`                | Read the rep's saved Outlook contacts (secondary signal for the autocomplete).        |
| `People.Read`                  | Relevance-scored "people I work with" — primary signal for the autocomplete; ranks recent + frequent contacts above stale ones. |

All four are **user-consent** scopes. No admin consent prompt; the rep
sees them on the next OAuth round-trip.

### 9.2 Why only Teams (not Google Meet / Zoom yet)

We picked Teams as the first creation provider because:

- The Azure AD app is already registered and proven; the delta is one
  Microsoft consent screen, not a new OAuth integration.
- The B2B sales prospects most commonly request Teams meetings in
  EMEA + regulated verticals (the segment the existing customer
  pipeline indexes on).
- Google Meet via Calendar's `conferenceData.createRequest` and Zoom
  via the marketplace OAuth app are tracked as follow-on increments
  in the next ADR (or sub-decision) once Teams creation soaks in
  production.

We rejected building our own video room (own SFU / LiveKit / etc.) at
this stage — it's an order-of-magnitude bigger surface and a sales
call is exactly the moment when a prospect doesn't want an unfamiliar
link, so the friction would land at the worst possible moment.

### 9.3 Operator action — existing connections need re-consent

Refresh tokens are bound to the scope set at issue time. Reps who
connected Microsoft before this change have a token that does **not**
include the four new scopes. The handling:

1. The Integrations card surfaces an amber banner ("Your Microsoft
   connection was made before meeting creation was added — disconnect
   and reconnect to enable it.") when we detect the new scopes are
   missing from the stored grant.
2. The detection signal is the `scope` field of the cached grant
   (saved verbatim from the token response in
   `microsoft.handleCalendarCallback`). If `Calendars.ReadWrite`
   isn't in the comma/space-delimited list, banner fires.
3. Server-side, if a meeting-creation request comes in against a
   stale token, Microsoft returns 403 with `Authorization_RequestDenied`
   or 401 — the route surfaces it as `code: GRAPH_FORBIDDEN` with a
   message instructing reconnection.

No data migration is required. The Redis grant is per-user and
short-lived (180-day TTL) anyway; reconnection just replaces it.

### 9.4 Code surface

- `api/src/microsoft.js` — `DELEGATED_SCOPES` extended; new
  `createTeamsMeeting(tenantId, userId, { subject, startISO, endISO,
  attendees, body })` and `searchPeople(tenantId, userId, query)`.
  `graphPost` helper added (mirrors `graphGet`).
- `api/src/integrations.js` — two new routes on the integrations
  router: `POST /microsoft/meetings` (create event + Teams meeting)
  and `GET /microsoft/contacts` (people search).
- `web/admin/index.html` + `web/admin/admin.js` —
  "🎥 Generate Teams meeting" button on the schedule form opens a
  modal with subject / start / duration / attendees (chip list +
  autocomplete) / agenda. Submit writes the returned `joinUrl` into
  the existing meeting URL field. The mission save flow is unchanged.
- `web/admin/admin.css` — modal + chip + autocomplete styles.
- `.env.example` — scope list updated.

### 9.5 Failure modes the UI must handle

| Code returned                                  | Cause                                                                                          | UX                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NOT_CONNECTED` (409)                          | No MS grant in Redis for `(tenantId, userId)`.                                                  | Modal result line: "Connect Microsoft 365 in Integrations first" + an inline link.                                          |
| `GRAPH_FORBIDDEN` (403)                        | Tenant policy blocks external attendees OR online meeting creation, OR stale-scope grant.       | Surface Graph's own message verbatim. If `Authorization_RequestDenied`, add "Try disconnecting + reconnecting to grant the new permissions." hint. |
| `NOT_CONFIGURED` (503)                         | `MS_CLIENT_ID` / `MS_CLIENT_SECRET` not set on the server.                                      | Generic: "Microsoft 365 isn't configured on this deployment."                                                               |
| Any 4xx with `Graph created the event but returned no joinUrl` | Graph regression or a wildly unexpected tenant policy.                              | "We created the event but Microsoft didn't return a join URL. Try again or use Outlook directly."                            |

### 9.6 Out of scope (deferred)

- Google Meet + Zoom creation providers — separate increment.
- GhostStream-branded shortlink (`meet.ghoststream.com/<slug>` →
  redirect to the real `joinUrl`) — separate increment; a 1-day add
  on top of this PR but unnecessary for the first cut.
- Editing / rescheduling existing Outlook events from GhostStream —
  scoped out; the rep edits in Outlook for now.
- Cancellation flow (the rep cancels a mission → we PATCH
  `isCancelled=true` on the Outlook event) — sensible follow-on,
  not blocking today.

## 10. Branded invite sender — decoupling deliverability from the rep's mailbox (2026-05-29)

### 10.1 Why this had to change

Within hours of §9 going live, the first end-to-end test surfaced the
Microsoft outbound spam wall: invites sent from the rep's M365 mailbox
to `iammrpwinner01@gmail.com` and `papove01@hotmail.com` were both
bounced by Microsoft's own outbound transport with `550 5.7.708
Service unavailable. Access denied, traffic not accepted from this IP`
— at *identical* timestamps from a single outbound IP
(`BN0PR13MB4759.namprd13.prod.outlook.com`), meaning the messages
never left Microsoft's network. The rep's tenant landed on
Microsoft's High Risk Delivery Pool (HRDP), an automated quarantine
that fires on new tenants, low domain reputation, or any outbound
spam-score trip.

The architectural read on this is uncomfortable but clear: **if any
part of GhostStream's product depends on every rep's M365 mailbox
being healthy enough to send invites to external prospects, we will
miss invites for years.** Outbound deliverability is a moving target
controlled by Microsoft, the customer's IT, and the customer's domain
reputation — three things outside our control and three things
fragile in exactly the moment that matters (the rep is trying to
schedule with a new prospect).

Sending invites from our own authenticated domain via SendGrid sidesteps
the entire surface. The rep's M365 mailbox is no longer in the
delivery path; we get a single sender we can warm, monitor, and rotate.

### 10.2 What the corrected flow looks like

Microsoft Graph keeps doing one job — own the meeting object:

1. `POST /me/events` with `isOnlineMeeting=true`, `onlineMeetingProvider=teamsForBusiness`, and **`attendees: []`**. Graph creates the rep's Outlook calendar event AND the backing `onlineMeeting`. Because the attendee list is empty, **Outlook does not attempt to send any invite** — the 5.7.708 path is never taken.
2. The response carries `onlineMeeting.joinUrl` (a real `teams.microsoft.com/l/meetup-join/...` URL) and `iCalUId` (a stable, globally-unique calendar identifier).

GhostStream then sends the invite via SendGrid:

3. Build an RFC 5545 `.ics` (METHOD=REQUEST) with the event UID derived from Graph's `iCalUId`, the Teams `joinUrl` as `LOCATION` + `URL`, and one `ATTENDEE` line per recipient with `PARTSTAT=NEEDS-ACTION` + `RSVP=TRUE` so Outlook surfaces Accept/Decline.
4. Send one email per attendee through `email.send()` with:
   - `From: <MEETINGS_FROM_NAME> <MEETINGS_FROM_EMAIL>` — branded GhostStream sender on the SPF/DKIM-authenticated `eel-global.com` domain.
   - `Reply-To: <rep's MS email>` — prospects' replies route to the rep naturally.
   - HTML + text bodies (preview surface in inbox lists).
   - The `.ics` as a `text/calendar; method=REQUEST` attachment (the part that actually populates the prospect's calendar).

### 10.3 Why this is a *better* outcome than fixing the M365 path

Even if we got `eel-global.com` off the HRDP and configured SPF/DKIM/DMARC perfectly today, the SaaS shape of the system would still want centralized sending:

| Property                                          | M365 from rep's mailbox                                                  | SendGrid from branded sender                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Deliverability owner                              | The rep's IT / Microsoft / customer tenant                              | Us (single domain, single SPF/DKIM stack, we warm it)                                   |
| Failure mode when reputation dips                | Silent bounce (5.7.708, etc.)                                            | Visible per-recipient status from SendGrid; we surface in the modal                     |
| Sender consistency across customers              | One sender per rep — every prospect sees a different domain             | One sender per platform — prospects associate the address with GhostStream             |
| Reply path                                        | Inbound to rep — fine                                                    | Reply-To = rep — same outcome                                                          |
| Onboarding friction for a new customer           | Requires the customer's IT to whitelist + verify their domain            | Zero — they connect Microsoft, we handle delivery                                       |
| Rotating the brand later (`meetings.ghoststream.com`) | Each rep has to migrate                                                  | One env var (`MEETINGS_FROM_EMAIL`) + DNS for the new domain                            |
| Multi-tenant per-customer override                | Implicit (every rep has their own mailbox)                              | Explicit (`MEETINGS_FROM_EMAIL` can be per-tenant when an enterprise demands it)        |

### 10.4 Code surface

- `api/src/ics.js` (new) — RFC 5545 builder. CRLF line endings, 75-octet line folding, METHOD=REQUEST, ORGANIZER/ATTENDEE/STATUS/SEQUENCE properties. Targets Microsoft Outlook as the strictest consumer (Gmail and Apple Calendar are more forgiving).
- `api/src/email.js` — `send()` extended with `from` (per-call override of `SENDGRID_FROM_EMAIL`) and `attachments` (passed through to the SDK).
- `api/src/microsoft.js` `createTeamsMeeting` — always sends Graph's `attendees: []`. Returns `iCalUId`, `organizerEmail`, `attendees` (kept for the SendGrid step), `joinUrl`.
- `api/src/integrations.js` — `POST /microsoft/meetings` calls `sendBrandedInvite()` after Graph success. Returns per-attendee status under `invite.sent[]` so the modal can render partial failures.
- `web/admin/admin.js` — modal success path renders ✅ on full success, ⚠️ with per-recipient errors on partial / total invite failure. Mention of the branded sender ("from meetings@eel-global.com") makes the architectural shift visible in the UI.
- `.env.example` + `docker-compose.yml` — new `MEETINGS_FROM_EMAIL`, `MEETINGS_FROM_NAME`, `MEETINGS_REPLY_TO`.

### 10.5 Trade-offs we accept

- **Prospect sees `meetings@eel-global.com`, not the rep's email, in the `From:` field.** Mitigated by Reply-To = rep, and by the email body explicitly framing the meeting as the rep's. Acceptable; SaaS norm.
- **SendGrid daily send caps apply.** Current plan has plenty of headroom for trial-customer-scale invite volumes. Revisit when paid customers ramp.
- **No real-time delivery confirmation to the rep.** SendGrid returns "accepted" — the actual landing in the inbox is async. We could subscribe to SendGrid's Event Webhook for bounce + delivered events; deferred until a customer asks for it.
- **No native Outlook tracking ("Pavlina hasn't responded").** Microsoft's built-in invite-tracking UI doesn't fire because the Outlook event has no attendees on Graph's side. If a customer needs this, the workaround is a follow-on UI in GhostStream that reads SendGrid Event Webhook responses + the prospect's RSVP click in the .ics.

### 10.6 Forward path

- **Per-tenant branded sender (e.g. `meetings@customer.com`).** Add a `tenant_settings.meetings_from_email` column + per-tenant SendGrid sub-account or Domain Authentication. Not blocking today; light-touch enterprise feature.
- **Resend invite button on the mission detail page.** Same `sendBrandedInvite()` path; UI affordance only. Trivial to add when a customer asks.
- **Eventually point `MEETINGS_FROM_EMAIL` at `meetings.ghoststream.<your-domain>` once DNS is set up.** One env-var change after authentication is done in SendGrid.
