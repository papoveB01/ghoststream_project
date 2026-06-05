# Production hardening: integrations fixes, SEO foundation, TLS & analytics — 2026-06-05

Runbook / change record for the work done on **production (`dealscope.io`)** on 2026-06-05.
Covers OAuth integration fixes, the SEO technical foundation, the `www` TLS fix, GA4
analytics, the social/OG image, and two prod-only UI changes. Ends with the still-open
items and the operational gotchas.

Environments (see `docs/` + memory): **prod** = `/home/admin/dealscope`, compose project
`dealscope-prod`, containers `dsp-*`, host vhosts in `/etc/nginx/conf.d/`, served at
`https://dealscope.io`. **staging** = `/home/admin/ghoststream` (`ghost-*`, `:8090`,
`staging.dealscope.io`). `web/` and `proxy/` are **live bind mounts** (edit → hard-refresh,
no rebuild). `api/` runs a **built image** (code/compose/env changes need
`docker compose --env-file .env.production up -d --build api` + a `proxy` restart).

---

## 1. Microsoft 365 sign-in broken — `AADSTS700016`

**Symptom:** prod Microsoft sign-in failed with
`AADSTS700016: Application with identifier '6f51ee65-…' was not found in the directory
'E&EL Global Inc.'`.

**Root cause:** `.env.production` had `MS_CLIENT_ID=6f51ee65-…`, an Azure app that was never
registered (a placeholder for a "separate prod app" that didn't get created). The working,
multi-tenant, admin-consented app is `993980bd-933a-45f2-896d-f350cf1f4353` (display name
**DealScope**, tenant `8de68f2b-…`, `signInAudience = AzureADMultipleOrgs`). The container was
also still running the **old** value because it had never been recreated after an earlier edit.

**Fix:**
- `.env.production`: `MS_CLIENT_ID=993980bd-…`, `MS_CLIENT_SECRET=` matching staging's app.
- Recreated the api container so it picked up the env:
  `docker compose --env-file .env.production up -d api && … restart proxy`.
- **Required in Azure:** the app's **Authentication → redirect URIs** must include
  `https://dealscope.io/api/integrations/microsoft/callback` (else you trade 700016 for
  `AADSTS50011` redirect-uri mismatch).

Prod and staging now **share** the same Microsoft app + secret — rotating it in one breaks the
other.

---

## 2. Google Calendar integration — consent troubleshooting

**Symptom:** "Microsoft connected but Google won't show calendar"; the Google consent screen
only listed **contacts** scopes.

**Findings (not a bug):**
- Code (`api/src/google.js`) correctly requests
  `openid email profile calendar.events contacts.readonly contacts.other.readonly` with
  `include_granted_scopes=true`.
- The contacts-only screen + "dealscope.io already has some access (4 services)" is Google's
  **incremental consent** — calendar was already granted to the prod client on a prior connect,
  so Google only re-prompted for the newly-added contacts scopes. Completing consent returns a
  token that still carries calendar.
- `integrations.js` reports `connected: true` whenever a grant exists, adding
  `needsReconsent: true` when scopes are stale — which is what made the UI nag instead of
  showing calendar.

**Attempted + reverted:** briefly repointed prod to staging's Google client (`…qjbmro…`); it
failed with **"Access blocked: this app's request is invalid"** because that client's
**Authorized redirect URIs** don't include `https://dealscope.io/...`. **Reverted** to the
original prod client `996987607351-gic4eopclh009icgnajou4i8e87fdp9u`. Stale Redis grants were
cleared so the next connect is a fresh full consent.

**To finish (deferred):** reconnect Google on prod and confirm a grant lands with the calendar
scope. The prod Google client's registered redirect is currently
`https://ghoststream.exact-it.net/...` — see §7 (old-host / OAuth migration).

---

## 3. Calendly hidden on prod (env-gated)

Calendly self-serve isn't ready for prod (sandbox app + Calendly Free-plan webhook blocker), so
its card is **hidden from the Integrations catalog on production only**, without removing the
webhook routes/creds (existing bookings keep flowing).

Generic, env-driven mechanism (not Calendly-specific):
- `api/src/integrations.js`: `HIDE_INTEGRATIONS` (comma-separated provider keys) →
  `providerHidden()` → `statusPayload()` filters `PROVIDERS`. Hides only the catalog card.
- `docker-compose.yml`: `HIDE_INTEGRATIONS: ${HIDE_INTEGRATIONS:-}` added to the `api` service
  `environment:` (vars only reach the container if explicitly listed).
- `.env.production` (gitignored): `HIDE_INTEGRATIONS=calendly`. Staging leaves it unset →
  Calendly still shows there.

**Un-hide:** blank `HIDE_INTEGRATIONS` in `.env.production`, then
`docker compose --env-file .env.production up -d api` + restart proxy (env-only, no rebuild).

---

## 4. Sidebar label: "Admin" → "Your workspace"

`web/admin/index.html` — the static `<div class="sidebar-tag">` under the DealScope logo changed
from `Admin` to `Your workspace`. Bind-mounted; hard-refresh only.

---

## 5. SEO technical foundation

Canonical host = **apex `https://dealscope.io`** (matches prod `APP_BASE_URL`). All in
bind-mounted `web/`.

- **`web/index.html`** — `<link rel="canonical">` → apex; full Open Graph
  (`type/url/site_name/image`) + Twitter `summary_large_image`; JSON-LD `@graph`
  (`Organization` + `SoftwareApplication`).
- **`web/robots.txt`** (prod) — allow marketing; `Disallow /admin /portal /arena /api
  /webhooks`; `Sitemap:` link. **`/onboarding` and `/join` are intentionally NOT disallowed** —
  they carry their own `<meta robots noindex>`, and a robots `Disallow` would stop Google from
  ever seeing that noindex. Staging uses a separate `Disallow: /` robots (kept local to the
  staging checkout) so `staging.dealscope.io` is never indexed.
- **`web/sitemap.xml`** — home + 4 legal pages, `dealscope.io` URLs. Serves 200.

Verified live: robots/sitemap 200 on the public host; canonical/OG/JSON-LD present; JSON-LD valid.

---

## 6. GA4 analytics

Measurement ID **`G-EZ946E8MEJ`** (gtag) injected high in `<head>` on the public marketing +
signup-funnel pages — `web/index.html`, `web/onboarding/index.html`, `web/join/index.html`.
**Not** on `/admin`, `/portal`, `/arena` (app/prospect surfaces).

Validated: a real-browser visit fires `…google-analytics.com/g/collect?…&tid=G-EZ946E8MEJ&en=page_view`
returning **`204`**. The "data collection isn't active" banner + standard reports lag (hours to
24–48h); **Realtime** is the immediate signal. The SOC 2 CSP header
(`default-src 'self' https: … 'unsafe-inline'`) permits gtag — no CSP change needed. Self-traffic
can be hidden by ad-blockers; test in Incognito.

> **Compliance TODO:** gtag loads unconditionally. Under GDPR/ePrivacy, EU visitors should
> consent before analytics cookies. Implement **Google Consent Mode v2** or a consent banner.

---

## 7. `www.dealscope.io` TLS + 301, and the old-host duplicate

**`www` fixed:** previously `www` had no vhost and fell through to the host's default vhost,
serving the **expired** `card6.eel-global.com` cert. Apex is canonical; `www` now 301s to it.
- Cert expanded to cover the www SAN:
  `sudo certbot certonly --nginx -d dealscope.io -d www.dealscope.io --expand -n`
  (renews `/etc/letsencrypt/live/dealscope.io/`, expires 2026-09-03).
- Host vhost `/etc/nginx/conf.d/www.dealscope.io.conf` (source:
  `proxy/host-www.dealscope.io.conf`) — port-80 ACME + 301, port-443 301 → apex.
- Verified: `curl -sI https://www.dealscope.io/` → `301` → `https://dealscope.io/`.

**Old host still serving (deferred):** `ghoststream.exact-it.net` returns `200` (proxies to
staging `:8090`) with **no redirect** → duplicate content. A 301 → `dealscope.io` is wanted, **but**
the prod **Google + Calendly OAuth redirect URIs are registered against `ghoststream.exact-it.net`**,
so a blanket redirect would break sign-in. **Migration order:** (1) add
`https://dealscope.io/api/integrations/{google,calendly}/callback` to those OAuth apps;
(2) reconnect + verify on prod; (3) then 301 the old host (keep its `/.well-known/acme-challenge/`
block so the cert keeps renewing).

---

## 8. Still open (priority order)

1. **Google Search Console** — verify the property (Domain/DNS-TXT covers www + subdomains, or
   URL-prefix via an HTML tag we can inject) and submit `https://dealscope.io/sitemap.xml`.
2. **GA4 consent gating** (Consent Mode v2) — see §6.
3. **Old-host 301 + OAuth redirect-URI migration** — see §7.
4. **Dedicated OG image polish** — current `web/assets/og.png` (1200×630, ~56 KB) generated from
   `web/assets/og.svg`; swap for a designed asset anytime by editing the SVG + re-rasterizing.
5. **Content/keyword pages** (feature / use-case / comparison / blog) — the long-term ranking
   lever; not started.
6. **Legal-page meta** (canonical/OG on terms/privacy/dpa/subprocessors) — low value, skipped.

---

## 9. Operational gotchas

- **Two checkouts diverge.** These changes were edited live in both `/home/admin/dealscope`
  (prod) and `/home/admin/ghoststream` (staging). This commit lands them on prod's `main`.
  Staging still has overlapping uncommitted edits (its own `web/*.html`, og files, and a
  **`Disallow: /`** robots) — reconcile by pushing main and pulling/cleaning staging, keeping
  staging's robots local.
- **`robots.txt` is environment-specific** (prod allows; staging blocks). The committed version
  is the prod/public one; staging's blocking copy is kept as a local file.
- **`deploy.sh` runs `git pull --ff-only` first** — uncommitted tracked edits or an unpushed
  local `main` ahead of origin can make a later deploy fail to fast-forward. Push this commit to
  origin to keep prod deploys clean.
- **OG image was rasterized in a throwaway container** (`alpine` + `rsvg-convert`), so
  `web/assets/og.png` is root-owned in the prod checkout — harmless for serving and `git add`.
