# Commands

*Read when: running tests, migrations, or the api locally; anything touching CI.*

Run from `api/` (Node 22). Note: `node`/`npm` may not be on the host PATH — if so, run inside the api image, e.g. `docker run --rm -v "$PWD":/app -w /app <api-image> <cmd>`.

Mount the **repo root**, not just `api/`: the admin-badge guard in `test/cutoverGroup1.test.js` reads `web/admin/admin.js` and fails (deliberately loudly, never skips) if `web/` is absent — `docker compose run --rm --no-deps -v "$PWD":/repo -w /repo/api api npm test`.

```bash
npm test                       # full suite: node --test test/*.test.js
node --test test/plans.test.js # a single test file
npm run migrate                # apply pending SQL migrations (also runs automatically on api boot)
npm start                      # node src/index.js
npm run smoke:schemas          # live-schema check — SPENDS MONEY, never in CI (see below)
npm run smoke:temperature      # re-derive per-model temperature support — SPENDS MONEY, never in CI
```

**The live-schema smoke check** (`api/test/live/smoke.js`, ADR-0006 §9 item 3) sends
every structured-output schema the product uses to a live provider and reports whether
it is accepted. CI makes no model call and the CD smoke test touches no AI path, so this
is the only thing that catches a schema the provider rejects — run it before flipping any
task to a new provider. It is deliberately outside `npm test`.

From the **repo root**, not `api/`:

```bash
docker compose run --rm --no-deps -v "$PWD/api":/app -w /app \
  api node test/live/smoke.js [--provider=both] [--cluster=watch,discovery] [--dry-run]
```

- `compose run`, not `docker run --env-file .env`. The api service's `DATABASE_*` and
  `REDIS_PASSWORD` are *derived* in `docker-compose.yml` and do not exist in `.env` under
  those names — with `--env-file` the check still calls the model but cannot reach
  Postgres, so its own `usage_costs` rows are silently lost.
- The volume mount is required: the api image's runtime stage ships only `src/` and
  `db/`, so `docker compose exec api node test/live/smoke.js` is `MODULE_NOT_FOUND`.
- Exit codes are distinct — `1` a schema was rejected, `2` bad invocation, `3` accepted
  but a field lost its ability to be null, `4` errors only (nothing judged, re-run).
  A transient 429/529 is an **error**, never a rejection.

**The temperature probe** (`api/test/live/temperature.js`) is the same shape, for a
different capability: `temperature` was removed in the Claude 4.7 generation, so
`anthropic.js` decides per model from a default-allow list. Being *under*-broad there is a
hard 400 on every request to that model and CI cannot see it, so the probe re-derives the
list against the live API, and the free guards in `api/test/anthropicSurface.test.js` check
the list against the probe's recorded table on every CI run. Run it whenever a Claude tier default changes.
`1` = we send temperature to a model that rejects it (an outage), `3` = we drop it on a
model that accepts it (determinism only), `2`/`4` as above.

- **Tests** use Node's built-in runner. Most are pure-logic (no DB); the auth/session ones need **Redis reachable** and env `JWT_SECRET`, `ENCRYPTION_KEY`, `NODE_ENV=test`. There is **no Postgres in CI**, so anything touching `db.query` can't be unit-tested yet — keep new tests DB-free or stub `db`.
- **CI** (`.github/workflows/ci.yml`) runs on every push on a **self-hosted runner**: `npm ci` → syntax-check all of `src/` → `npm test` → advisory `npm audit`. It's the SOC 2 CC8.1 change gate.
