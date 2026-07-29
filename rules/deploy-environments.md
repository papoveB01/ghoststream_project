# Deploy & environments

*Read when: deploying, or reasoning about which environment a checkout is. The
promotion order that gets you here is in [conventions](./conventions.md).*

`./deploy.sh {staging|production}` — run from the environment's own checkout. It `git pull --ff-only`s, rebuilds the **api image from the working tree**, runs pending migrations on boot, and bounces the proxy. `DEPLOY_SKIP_PULL=1` suppresses the pull so the caller controls exactly which commit ships.

**Normally you don't run it directly** — CD does, via `ops/cd-deploy.sh`, which adds the identity check, the live-tree snapshot, commit pinning and a smoke test. See [conventions](./conventions.md) for the pipeline; use `ops/cd-deploy.sh {staging|production} [ref]` for a by-hand deploy that behaves identically.

**The same host runs multiple environments off separate checkouts of this repo**, distinguished only by `CONTAINER_PREFIX` / `COMPOSE_PROJECT_NAME` + env file:

- `deploy.sh staging` → `.env`, project `ghost-*`, proxy `:8090`, `staging.dealscope.io`
- `deploy.sh production` → `.env.production`, project `dsp-*`/`dealscope-prod`, proxy `:8091`, `dealscope.io`

**Do not infer which environment a checkout is from its folder name** — verify via the env file's `APP_BASE_URL` / `CONTAINER_PREFIX` and the running container prefix before deploying. Unlike `web/`/`proxy/`, `api/` is **baked into the image**, so api changes require a rebuild (`deploy.sh`), and editing a checkout's files does not affect running api containers until then.

## After a deploy: never plain-`git checkout` a branch in an environment checkout

`ops/cd-deploy.sh` pins a checkout to the deployed commit, and for a bare SHA that
leaves it on **detached HEAD**. Putting it back on a branch looks harmless and is not:

- A checkout's local `main` is often **stale** — CD fast-forwards `origin/main`, not the
  local ref, so `main` can still point at the previous release.
- `web/` and `proxy/` are **live bind mounts**. `git checkout main` with a stale `main`
  rewrites those files instantly, so the running environment silently serves the
  *previous* release's frontend — no deploy, no restart, no log line, nothing to notice.
  On production that is a live regression the moment the command returns.

Move the branch pointer to the deployed commit instead of moving the working tree:

```bash
DEPLOYED=$(git rev-parse HEAD)          # while still detached at the deployed SHA
git checkout -B main "$DEPLOYED"        # same commit → working tree does not change
git branch --set-upstream-to origin/main main
```

Verify by fingerprinting the served assets before and after (`md5sum` over `web/**`);
they must be identical. If they differ, the environment just changed underneath you.
