# Commands

Run from `api/` (Node 22). Note: `node`/`npm` may not be on the host PATH — if so, run inside the api image, e.g. `docker run --rm -v "$PWD":/app -w /app <api-image> <cmd>`.

```bash
npm test                       # full suite: node --test test/*.test.js
node --test test/plans.test.js # a single test file
npm run migrate                # apply pending SQL migrations (also runs automatically on api boot)
npm start                      # node src/index.js
```

- **Tests** use Node's built-in runner. Most are pure-logic (no DB); the auth/session ones need **Redis reachable** and env `JWT_SECRET`, `ENCRYPTION_KEY`, `NODE_ENV=test`. There is **no Postgres in CI**, so anything touching `db.query` can't be unit-tested yet — keep new tests DB-free or stub `db`.
- **CI** (`.github/workflows/ci.yml`) runs on every push on a **self-hosted runner**: `npm ci` → syntax-check all of `src/` → `npm test` → advisory `npm audit`. It's the SOC 2 CC8.1 change gate.
