#!/usr/bin/env bash
# DealScope deploy — run from an environment's checkout.
#   ./deploy.sh staging      → uses .env             (project ghoststream,    proxy :8090)
#   ./deploy.sh production   → uses .env.production   (project dealscope-prod, proxy :8091)
#
# web/ and proxy/ are live bind-mounts (no rebuild needed for those). This
# fast-forwards the checkout, then rebuilds the api image + recreates any
# service whose config changed. Pending DB migrations run on api boot.
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
git pull --ff-only
docker compose --env-file "$ENV_FILE" up -d --build
echo "[deploy] containers:"
docker compose --env-file "$ENV_FILE" ps
