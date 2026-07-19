# Deploy & environments

`./deploy.sh {staging|production}` — run from the environment's own checkout. It `git pull --ff-only`s, rebuilds the **api image from the working tree**, runs pending migrations on boot, and bounces the proxy.

**The same host runs multiple environments off separate checkouts of this repo**, distinguished only by `CONTAINER_PREFIX` / `COMPOSE_PROJECT_NAME` + env file:

- `deploy.sh staging` → `.env`, project `ghost-*`, proxy `:8090`, `staging.dealscope.io`
- `deploy.sh production` → `.env.production`, project `dsp-*`/`dealscope-prod`, proxy `:8091`, `dealscope.io`

**Do not infer which environment a checkout is from its folder name** — verify via the env file's `APP_BASE_URL` / `CONTAINER_PREFIX` and the running container prefix before deploying. Unlike `web/`/`proxy/`, `api/` is **baked into the image**, so api changes require a rebuild (`deploy.sh`), and editing a checkout's files does not affect running api containers until then.
