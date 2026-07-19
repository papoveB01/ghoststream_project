# Conventions

## Code style
- **Vanilla JS, CommonJS** (`require`/`module.exports`) — no TypeScript, no ESM. 2-space indent, single quotes, semicolons, `camelCase`, template literals, UTC for all date math.
- No formatter/linter is enforced (CI only `node --check`s syntax). **Match the surrounding file** for spacing, naming, and structure.
- **Comment the *why*, not the *what*.** Load-bearing modules (`plans.js`, `usage.js`, `entitlements.js`, `credits.js`) open with a paragraph explaining the design and inline-note every non-obvious invariant. Keep this density when editing them; a throwaway comment on a one-off is not expected.

## Commits
- **Conventional Commits with a scope:** `type(scope): summary`. Types in use: `feat`, `fix`, `ci`, `chore`, `style`, plus `Merge …`. Scopes are area names, e.g. `pricing`, `security`, `auth`, `crm`, `kb`, `discovery`, `deps`, `gate`, `seo`, `email`.
- Reference the PR in the subject: `fix(security): SSRF guard on server-side scrape URLs (#36)`.
- Body explains the *why* and any risk; multi-line is normal. Commits carry a `Co-Authored-By:` trailer.
- Keep commits **scoped to one change**; the security work shipped as one PR per fix (#29–#37), not a bundle.

## Pull requests
- Work on a branch (`feat/…`, `fix/…`, `chore/…`), open a PR, merge to `main` via `Merge pull request #NN`. CI must be green first (it's the SOC 2 CC8.1 change gate).
- One reviewable concern per PR. Security/behavioral changes get their own PR so the merge record is auditable.

## Merge & promotion (hub-and-spoke)
`origin` on GitHub is the **hub**; each environment is a **spoke** checkout that deploys itself. Promotion order:
1. Implement on a branch; validate on **staging** first.
2. Before promoting, **merge `origin/main` *into* the branch** and re-validate — this pulls in fixes that landed on `main` (e.g. security PRs) so the promotion can't silently regress them. Then `main` fast-forwards cleanly.
3. Fast-forward `main`, deploy staging, smoke-test.
4. **Production is gated:** explicit human go + green CI + **a snapshot branch of the prod checkout's live tree** (`git checkout -b prod-live-snapshot-<date>; git add -A; git commit`) captured *before* touching it, so nothing is lost. Then reconcile the prod checkout to `main`, `./deploy.sh production`, and smoke-test.
- Prod checkouts may carry hand-edits that never went back to git — never `deploy.sh production` over a dirty tree without snapshotting and reconciling it against `main` first.

## CI/CD (as executed)
- **CI** — `.github/workflows/ci.yml` runs on **every push (all branches) and PRs**, on a **self-hosted runner** (systemd service on the deploy host; GitHub-hosted minutes are not used). Jobs: `npm ci` → syntax-check all of `src/` → `npm test` (Redis service on an auto-assigned host port, since the box is shared) → advisory `npm audit`.
- **CD is manual, not automatic.** Pushing/merging never deploys. Deployment is `./deploy.sh {staging|production}` run on the environment's checkout (see [deploy-environments](./deploy-environments.md)). Migrations run on api boot as part of the deploy.

## Migrations
- Live in `api/db/migrations/NNNN_*.sql`, applied in lexical order by `db/migrate.js` (tracked in `schema_migrations`), automatically on api boot. **Never edit an applied migration — add a new numbered one.**

## ADRs
- `docs/adr/` records are authoritative for any decision spanning more than one module; add one (don't just code) for storage/auth/pricing/queue changes. `docs/README.md` explains when.
