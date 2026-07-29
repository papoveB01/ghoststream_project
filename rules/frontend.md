# Frontend (`web/`)

*Read when: editing anything under `web/`. Backend contracts are in
[architecture](./architecture.md).*

**No build step, no framework, no bundler.** `web/` is a live nginx bind-mount — edit a
file, hard-refresh, done. Never add a toolchain here without an ADR; the whole
deploy story for the frontend is "the file on disk is the file served".

## Apps

| Path | What |
| --- | --- |
| `web/admin/` | The product SPA — the only substantial app. `index.html` + `admin.js` + `admin.css`. |
| `web/index.html`, `landing.{css,js}` | Marketing landing page (public, SEO-sensitive — canonical is the apex `dealscope.io`). |
| `web/onboarding/`, `web/join/` | Signup / sub-tenant invite acceptance. |
| `web/arena/` | Roleplay practice app. |
| `web/portal/` | Prospect-facing portal. |
| `web/privacy/`, `terms/`, `dpa/`, `subprocessors/` | Legal pages. |
| `web/admin/vendor/` | The only third-party code (`driver.js`, the first-run tour). Vendored, not fetched from a CDN. |

## Admin SPA conventions

- **One IIFE** in `admin.js` (~13k lines) — no modules, no exports. Helpers `$`,
  `show`, `hide`, `fetchJson` at the top.
- **Hash routing.** `sections` + `loaders` maps at the top of `admin.js` are the
  registry; a new screen means a `<section id="...">` in `index.html`, an entry in
  both maps, and a nav item. Navigate with `window.location.hash = '#section'`.
  Hashes carry query state (`#calls?status=ready`).
- **Sections load lazily and cache** via the `loaded` map — set `loaded.x = false` to
  force a re-render.
- **Auth is cookie-based**: every call is `fetch('/api/…', { credentials: 'include' })`.
  No token is read or stored in JS.
- **Persisted UI state** uses `sessionStorage`/`localStorage` under `ds.*` (or legacy
  `gs_*`) keys, always inside `try/catch` — storage can be blocked.
- Plan-dependent UI is driven by flags resolved in `init()` (`isSuperadmin`,
  `marketWatchAvailable`, …). The server is still the authority — gating in the SPA is
  presentation only, never a security boundary.

## Styling

`admin.css` is a token-driven design system ("Intelligence Console" — graphite + paper
+ one signal green). **Restyle by changing the `:root` tokens, not by hardcoding
colors in components.** A scoped dark treatment ("night islands") is opted into
per-card with the `.night` class — instrument surfaces (stats, charts, Market Map) go
dark; prose, intel and forms stay on paper.

## Gotchas

- `web/` and `proxy/` apply without a rebuild, but `api/` does not — a change spanning
  both still needs a deploy.
- Prod checkouts have historically carried **uncommitted hand-edits under `web/`**.
  Because `deploy.sh` does a `git pull --ff-only`, check `git status` in the prod
  checkout before touching it (see [deploy-environments](./deploy-environments.md)).
