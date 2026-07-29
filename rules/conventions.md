# Conventions

*Read when: writing code, commits, PRs, migrations, or ADRs — i.e. before you commit.*

## Code style (`api/`, `mcp/`)
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
1. Implement on a branch; validate on **staging** first — either `./deploy.sh staging` in the staging checkout, or dispatch **CD** with `target: staging` and the branch as `ref`.
2. Before promoting, **merge `origin/main` *into* the branch** and re-validate — this pulls in fixes that landed on `main` (e.g. security PRs) so the promotion can't silently regress them. Then `main` fast-forwards cleanly.
3. **Fast-forwarding `main` and pushing *is* the promotion.** CI runs; on green, CD deploys staging, smoke-tests it, then deploys production. There is no separate production step to remember.
4. Watch the CD run. A failed staging smoke test means production is never attempted. A failed production deploy stops with the rollback command printed — CD does **not** auto-revert, because migrations run on api boot and are forward-only, so a blind revert can leave the schema ahead of the code.
- Prod checkouts may carry hand-edits that never went back to git. You no longer protect them by hand: `ops/cd-deploy.sh` commits any dirty or unmerged state to a `<env>-live-snapshot-<utc>` branch (pushed when it can be) *before* reconciling the checkout. Nothing is discarded — but it does mean **anything uncommitted in a checkout leaves the working tree on the next deploy**, which matters most for the staging checkout, since that doubles as the dev workspace.

## CI/CD (as executed)
- **CI** — `.github/workflows/ci.yml` runs on **every push, all branches** (push-only: `pull_request` would double-run each commit and would execute fork code on our own deploy host). Self-hosted runner, systemd service on the deploy host; GitHub-hosted minutes are not used. Jobs: `npm ci` → syntax-check all of `src/` → `npm test` (Redis service on an auto-assigned host port, since the box is shared) → advisory `npm audit`. Runs are cancelled when superseded — except on `main`, whose run gates the deploy.
- **CD is automatic** — `.github/workflows/cd.yml`, triggered by `workflow_run` on a **successful CI run on `main`**, deploying that exact SHA. Order is staging → smoke-test → production, serialized host-wide by a `concurrency: cd` group. `workflow_dispatch` allows a manual deploy of any ref to either environment (that's how you put a branch on staging).
- The pipeline is thin on purpose: all logic lives in **`ops/cd-deploy.sh`**, which verifies the checkout's identity, snapshots local state, pins the checkout to one commit, runs `deploy.sh` with `DEPLOY_SKIP_PULL=1`, and smoke-tests `/api/health`, `/capture/health` and `/` through the proxy. Run it by hand when Actions is unavailable and you get the same deploy. Migrations run on api boot as part of it.

## Migrations
- Live in `api/db/migrations/NNNN_*.sql`, applied in lexical order by `db/migrate.js` (tracked in `schema_migrations`), automatically on api boot. **Never edit an applied migration — add a new numbered one.**

## ADRs
- `docs/adr/` records are authoritative for any decision spanning more than one module; add one (don't just code) for storage/auth/pricing/queue changes. `docs/README.md` explains when.
