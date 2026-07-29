#!/usr/bin/env bash
# DealScope deploy — run from an environment's checkout.
#   ./deploy.sh staging      → uses .env             (project ghoststream,    proxy :8090)
#   ./deploy.sh production   → uses .env.production   (project dealscope-prod, proxy :8091)
#
# web/ and proxy/ are live bind-mounts (no rebuild needed for those). This
# fast-forwards the checkout, then rebuilds the api image + recreates any
# service whose config changed. Pending DB migrations run on api boot.
#
# DEPLOY_SKIP_PULL=1 skips the fast-forward and builds whatever the tree is at.
# CD sets this: ops/cd-deploy.sh has already pinned the checkout to the exact
# commit CI tested, and pulling again here would silently widen the deploy to
# any commit that landed on origin in between.
set -euo pipefail

ENV="${1:-}"
case "$ENV" in
  staging)    ENV_FILE=".env" ;;
  production) ENV_FILE=".env.production" ;;
  *) echo "usage: $0 [staging|production]" >&2; exit 1 ;;
esac

cd "$(dirname "$0")"
[ -f "$ENV_FILE" ] || { echo "[deploy] missing $ENV_FILE in $(pwd)" >&2; exit 1; }

echo "[deploy] env=$ENV  file=$ENV_FILE  dir=$(pwd)"
if [ "${DEPLOY_SKIP_PULL:-0}" = "1" ]; then
  echo "[deploy] skipping git pull (DEPLOY_SKIP_PULL=1) — deploying $(git rev-parse --short HEAD) as-is"
else
  git pull --ff-only
fi
docker compose --env-file "$ENV_FILE" up -d --build
# Rebuilding api recreates its container (new IP); the in-container nginx
# resolves upstreams once at start, so it'd keep proxying the OLD ip and 502.
# Bounce the proxy so it re-resolves api/capture. (Idempotent if unchanged.)
docker compose --env-file "$ENV_FILE" restart proxy
echo "[deploy] containers:"
docker compose --env-file "$ENV_FILE" ps
