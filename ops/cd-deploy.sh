#!/usr/bin/env bash
# CD deploy — reconcile an environment checkout to a git ref, deploy it, smoke-test it.
#
# The self-hosted Actions runner runs as `admin`: the same user that owns both
# environment checkouts and is in the `docker` group. So CD needs no SSH, no image
# registry and no deploy secret — it just drives deploy.sh on the real checkout.
# This is a plain script on purpose: if Actions is unavailable, running it by hand
# produces exactly the same deploy as the pipeline.
#
#   ops/cd-deploy.sh staging    [ref]   → /home/admin/ghoststream, .env
#   ops/cd-deploy.sh production [ref]   → /home/admin/dealscope,   .env.production
#
# Checkout paths are overridable via STAGING_CHECKOUT / PRODUCTION_CHECKOUT.
#
# Safety properties, in the order they are enforced:
#   1. It verifies the checkout's APP_BASE_URL actually belongs to the environment it
#      was told to deploy. Folder names are never trusted (rules/deploy-environments.md)
#      — the whole point is that two checkouts of this repo on one host differ only by
#      env file, so deploying prod into the staging tree is a one-typo mistake.
#   2. Any uncommitted or unmerged local state is committed to a
#      `<env>-live-snapshot-<utc>` branch BEFORE anything is reset, and pushed if it
#      can be. Prod checkouts have historically carried hand-edits that never went back
#      to git; this is the automated form of the manual snapshot step that
#      rules/conventions.md requires before a production deploy.
#   3. It deploys one explicit commit (DEPLOY_SKIP_PULL=1), never "whatever origin
#      happens to have by the time deploy.sh runs" — so the SHA that CI tested is the
#      SHA that ships.
#   4. It fails if the environment is not actually serving afterwards.
#
# It deliberately does NOT roll back. Migrations run on api boot and are forward-only,
# so an automatic revert can leave the schema ahead of the code — a worse failure than
# the one it is trying to fix. On failure it prints the exact command to go back and
# stops, leaving the decision to a human.
set -euo pipefail

ENV="${1:-}"
REF="${2:-main}"

case "$ENV" in
  staging)
    CHECKOUT="${STAGING_CHECKOUT:-/home/admin/ghoststream}"
    ENV_FILE=".env"
    # staging.dealscope.io — must be the staging host, not the apex
    EXPECT_URL_RE='^https://staging\.'
    DEFAULT_BIND='127.0.0.1:8090'
    ;;
  production)
    CHECKOUT="${PRODUCTION_CHECKOUT:-/home/admin/dealscope}"
    ENV_FILE=".env.production"
    # dealscope.io / www.dealscope.io — anything with a staging host fails this
    EXPECT_URL_RE='^https://(www\.)?dealscope\.io'
    DEFAULT_BIND='127.0.0.1:8091'
    ;;
  *)
    echo "usage: $0 {staging|production} [ref]" >&2
    exit 2
    ;;
esac

log() { printf '[cd:%s] %s\n' "$ENV" "$*"; }
die() { printf '[cd:%s] FATAL: %s\n' "$ENV" "$*" >&2; exit 1; }

[ -d "$CHECKOUT/.git" ] || die "$CHECKOUT is not a git checkout"
cd "$CHECKOUT"
[ -f "$ENV_FILE" ]  || die "missing $ENV_FILE in $CHECKOUT"
[ -x ./deploy.sh ]  || die "missing or non-executable deploy.sh in $CHECKOUT"

# Last assignment wins, surrounding quotes stripped. Deliberately sed and not a
# grep pipeline: a missing key makes grep exit 1, and under `set -o pipefail` that
# propagates out of `VAR="$(env_val KEY)"` and trips `set -e` — killing the script
# before any ${VAR:-default} fallback can apply. staging's .env legitimately omits
# PROXY_BIND (it inherits the compose default), so an absent key has to read as an
# empty string, not as a fatal error. sed always exits 0.
env_val() {
  sed -n -E "s/^$1=[\"']?([^\"']*)[\"']?[[:space:]]*$/\1/p" "$ENV_FILE" | tail -n1
}

# ── 1. Identity guard ──────────────────────────────────────────────────────────
APP_BASE_URL="$(env_val APP_BASE_URL)"
[ -n "$APP_BASE_URL" ] || die "APP_BASE_URL is not set in $CHECKOUT/$ENV_FILE — cannot prove which environment this is"
printf '%s' "$APP_BASE_URL" | grep -Eq "$EXPECT_URL_RE" \
  || die "$CHECKOUT/$ENV_FILE has APP_BASE_URL=$APP_BASE_URL, which is not a '$ENV' URL. Refusing to deploy $ENV from this checkout."
log "target: $CHECKOUT ($APP_BASE_URL)"

git fetch --prune --quiet origin

PREV_SHA="$(git rev-parse HEAD)"
PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Prefer the remote's view of the ref — CD ships what origin has, not a stale local.
TARGET_SHA="$(git rev-parse --verify --quiet "origin/$REF^{commit}" || true)"
[ -n "$TARGET_SHA" ] || TARGET_SHA="$(git rev-parse --verify --quiet "$REF^{commit}" || true)"
[ -n "$TARGET_SHA" ] || die "cannot resolve ref '$REF'"

# ── 2. Snapshot anything that would otherwise be discarded ─────────────────────
DIRTY=0;    [ -n "$(git status --porcelain)" ] && DIRTY=1
UNMERGED=0; git merge-base --is-ancestor HEAD "$TARGET_SHA" || UNMERGED=1

if [ "$DIRTY" = 1 ] || [ "$UNMERGED" = 1 ]; then
  SNAP="${ENV}-live-snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
  log "local state present (uncommitted=$DIRTY, commits-not-in-target=$UNMERGED) — snapshotting to $SNAP first"
  git checkout -q -b "$SNAP"          # keeps the working tree exactly as it is
  git add -A                          # .env* and backups/ are gitignored — no secrets captured
  git -c user.name='dealscope-cd' -c user.email='cd@dealscope.io' \
      commit -q -m "chore(cd): snapshot $ENV live tree before deploying ${TARGET_SHA:0:7}" \
    || log "nothing new to commit on $SNAP"
  if git push -q origin "$SNAP" 2>/dev/null; then
    log "snapshot pushed → origin/$SNAP"
  else
    log "WARNING: could not push $SNAP; it exists only in $CHECKOUT"
  fi
fi

# ── 3. Reconcile to the exact commit, then deploy it ───────────────────────────
log "reconciling ${PREV_BRANCH}@${PREV_SHA:0:7} → ${REF}@${TARGET_SHA:0:7}"
if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
  # Named branch: keep the checkout on a real branch so humans can still `git pull`.
  git checkout -q -B "$REF" "$TARGET_SHA"
  git branch -q --set-upstream-to "origin/$REF" "$REF" || true
else
  # A bare SHA has no branch to live on; pin the checkout to it explicitly.
  git checkout -q --detach "$TARGET_SHA"
fi
git reset --hard -q "$TARGET_SHA"

log "deploying ${TARGET_SHA:0:7} …"
DEPLOY_SKIP_PULL=1 ./deploy.sh "$ENV"

# ── 4. Prove it is actually serving ────────────────────────────────────────────
PROXY_BIND="$(env_val PROXY_BIND)"
PROXY_BIND="${PROXY_BIND:-$DEFAULT_BIND}"

rollback_hint() {
  cat >&2 <<EOF
[cd:$ENV] ${TARGET_SHA:0:7} deployed but did not come up healthy.
[cd:$ENV] NOT rolling back automatically: migrations run on api boot and are
[cd:$ENV] forward-only, so a blind revert can leave the schema ahead of the code.
[cd:$ENV] To go back by hand:
[cd:$ENV]   cd $CHECKOUT && git checkout -B $PREV_BRANCH $PREV_SHA && DEPLOY_SKIP_PULL=1 ./deploy.sh $ENV
EOF
}

smoke() {
  local path="$1" tries=30 i=0 code=''
  while [ "$i" -lt "$tries" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${PROXY_BIND}${path}" || true)"
    if [ "$code" = '200' ]; then
      log "smoke ok: ${path} → 200"
      return 0
    fi
    i=$((i + 1))
    sleep 3
  done
  log "smoke FAILED: ${path} → ${code:-no-response} after $((tries * 3))s"
  rollback_hint
  exit 1
}

log "smoke-testing http://${PROXY_BIND} …"
smoke /api/health        # api container + proxy upstream re-resolution
smoke /capture/health    # capture container
smoke /                  # nginx serving web/

log "DEPLOYED ${TARGET_SHA:0:7} ($APP_BASE_URL)"

# Machine-readable tail for the workflow's job summary.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ✅ ${ENV} — \`${TARGET_SHA:0:7}\`"
    echo ''
    echo "| | |"
    echo "|---|---|"
    echo "| URL | ${APP_BASE_URL} |"
    echo "| Checkout | \`${CHECKOUT}\` |"
    echo "| Previous | \`${PREV_BRANCH}@${PREV_SHA:0:7}\` |"
    echo "| Deployed | \`${REF}@${TARGET_SHA:0:7}\` |"
    echo "| Subject | $(git log -1 --pretty=%s "$TARGET_SHA") |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
