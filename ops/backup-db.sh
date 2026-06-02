#!/usr/bin/env bash
# Postgres logical backup for GhostStream (SOC 2 A1.2 — backup & recovery + DR).
#
# 1) Dumps ghost-db to a timestamped gzip in BACKUP_DIR (local copy).
# 2) Off-sites the dump to Cloudflare R2 under R2_PREFIX, reusing the app's
#    existing R2 credentials/bucket (api/src/knowledge/r2.js via the ghost-api
#    container). R2 encrypts objects at rest (AES-256) and the transfer is TLS;
#    the bucket is private (objects are never publicly listed/served).
# 3) Prunes both local and R2 copies older than RETENTION_DAYS.
#
# Off-site failure is non-fatal (the local dump is kept) but logged as WARN and
# the script exits non-zero so monitoring can alert. Set OFFSITE=0 to skip R2.
#
# Usage:    ops/backup-db.sh
# Env:      BACKUP_DIR (default /home/admin/ghoststream/backups)
#           RETENTION_DAYS (default 14)
#           DB_CONTAINER (default ghost-db), API_CONTAINER (default ghost-api)
#           R2_PREFIX (default db-backups/), OFFSITE (default 1)
#
# Cron (daily 02:30):
#   30 2 * * *  /home/admin/ghoststream/ops/backup-db.sh >> /home/admin/ghoststream/backups/backup.log 2>&1
#
# Restore (DESTRUCTIVE — into a fresh/empty DB):
#   # from R2:   docker exec ghost-api node -e 'const r2=require("/app/src/knowledge/r2");r2.presignGet("db-backups/<file>",300).then(u=>console.log(u))'
#   #            curl -s "<signed-url>" -o dump.sql.gz
#   # from local: gunzip -c backups/ghoststream-YYYYmmdd-HHMMSS.sql.gz \
#   #              | docker exec -i ghost-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/admin/ghoststream/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_CONTAINER="${DB_CONTAINER:-ghost-db}"
API_CONTAINER="${API_CONTAINER:-ghost-api}"
R2_PREFIX="${R2_PREFIX:-db-backups/}"
OFFSITE="${OFFSITE:-1}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="ghoststream-${STAMP}.sql.gz"
OUT="${BACKUP_DIR}/${FILE}"
EXIT=0

mkdir -p "$BACKUP_DIR"

if ! docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" >/dev/null 2>&1; then
  echo "[backup] ERROR: container ${DB_CONTAINER} is not running" >&2
  exit 1
fi

echo "[backup] $(date -u +%FT%TZ) dumping ${DB_CONTAINER} -> ${OUT}"
# --clean --if-exists so the dump is safely re-appliable into an existing DB.
docker exec "$DB_CONTAINER" sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  | gzip -9 > "$OUT"

# Fail loudly on a truncated/empty dump rather than silently keeping garbage.
if [ ! -s "$OUT" ]; then
  echo "[backup] ERROR: dump is empty — removing ${OUT}" >&2
  rm -f "$OUT"
  exit 1
fi
echo "[backup] ok (local): ${OUT} ($(du -h "$OUT" | cut -f1))"

# --- off-site to R2 (reuses the app's R2 client + bucket) -------------------
if [ "$OFFSITE" = "1" ]; then
  if docker inspect -f '{{.State.Running}}' "$API_CONTAINER" >/dev/null 2>&1; then
    if docker exec -e BK_KEY="${R2_PREFIX}${FILE}" -i "$API_CONTAINER" node -e '
        const r2 = require("/app/src/knowledge/r2");
        if (!r2.isConfigured()) { console.error("R2 not configured"); process.exit(3); }
        const chunks = [];
        process.stdin.on("data", (d) => chunks.push(d));
        process.stdin.on("end", async () => {
          try {
            const body = Buffer.concat(chunks);
            await r2.putObject({ key: process.env.BK_KEY, body, contentType: "application/gzip" });
            console.log("[backup] ok (offsite): r2://" + process.env.BK_KEY + " (" + body.length + " bytes)");
            process.exit(0);
          } catch (e) { console.error("offsite upload failed:", e.message); process.exit(4); }
        });
      ' < "$OUT"; then
      :
    else
      echo "[backup] WARN: off-site upload to R2 failed — local copy retained" >&2
      EXIT=2
    fi

    # R2 retention prune (parse the timestamp from the object key).
    docker exec -e BK_PREFIX="$R2_PREFIX" -e BK_RET="$RETENTION_DAYS" "$API_CONTAINER" node -e '
      const r2 = require("/app/src/knowledge/r2");
      (async () => {
        if (!r2.isConfigured()) return;
        const keys = await r2.listObjects(process.env.BK_PREFIX);
        const ret = parseInt(process.env.BK_RET, 10) || 14;
        const cutoff = Date.now() - ret * 86400000;
        let n = 0;
        for (const k of keys) {
          const m = k.match(/(\d{8})-(\d{6})\.sql\.gz$/);
          if (!m) continue;
          const d = m[1], t = m[2];
          const iso = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}Z`;
          if (new Date(iso).getTime() < cutoff) { await r2.deleteObject(k); n++; }
        }
        console.log("[backup] r2 pruned " + n + " object(s) older than " + ret + "d");
      })().catch((e) => { console.error("[backup] WARN: r2 prune failed:", e.message); });
    ' || echo "[backup] WARN: r2 prune step errored" >&2
  else
    echo "[backup] WARN: ${API_CONTAINER} not running — skipped off-site" >&2
    EXIT=2
  fi
fi

# --- local retention prune --------------------------------------------------
PRUNED="$(find "$BACKUP_DIR" -name 'ghoststream-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
echo "[backup] pruned ${PRUNED} local dump(s) older than ${RETENTION_DAYS} day(s)"

exit $EXIT
