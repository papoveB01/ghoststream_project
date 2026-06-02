#!/usr/bin/env bash
# Postgres logical backup for GhostStream (SOC 2 A1.2 — backup & recovery).
#
# Dumps the ghost-db container to a timestamped gzip, then prunes dumps older
# than RETENTION_DAYS. Designed to run from the repo host via cron. It does NOT
# encrypt or off-site the dump — pipe BACKUP_DIR to an encrypted, off-host
# target (e.g. restic/rclone to R2) for a real DR posture.
#
# Usage:    ops/backup-db.sh
# Env:      BACKUP_DIR (default /home/admin/ghoststream/backups)
#           RETENTION_DAYS (default 14)
#           DB_CONTAINER (default ghost-db)
#
# Cron (daily 02:30, log to syslog):
#   30 2 * * *  /home/admin/ghoststream/ops/backup-db.sh >> /var/log/ghoststream-backup.log 2>&1
#
# Restore (DESTRUCTIVE — into a fresh/empty DB):
#   gunzip -c backups/ghoststream-YYYYmmdd-HHMMSS.sql.gz \
#     | docker exec -i ghost-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/admin/ghoststream/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_CONTAINER="${DB_CONTAINER:-ghost-db}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/ghoststream-${STAMP}.sql.gz"

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

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] ok: ${OUT} (${SIZE})"

# Retention prune.
PRUNED="$(find "$BACKUP_DIR" -name 'ghoststream-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
echo "[backup] pruned ${PRUNED} dump(s) older than ${RETENTION_DAYS} day(s)"
