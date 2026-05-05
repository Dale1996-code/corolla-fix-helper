#!/usr/bin/env bash
# Daily backup: downloads a .tar.gz snapshot from the app's backup-export endpoint
# and uploads it to GCS. Schedule with the accompanying systemd timer (daily).
#
# Required env vars (set in /etc/corolla.env or export before running):
#   GCS_BUCKET   — destination bucket name, e.g. my-project-corolla-backups
#
# Optional:
#   APP_URL      — base URL of the running app (default: http://127.0.0.1:4000)
#   BACKUP_DIR   — local staging directory (default: /tmp/corolla-backups)
set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:4000}"
GCS_BUCKET="${GCS_BUCKET:-}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/corolla-backups}"

if [[ -z "$GCS_BUCKET" ]]; then
  echo "ERROR: GCS_BUCKET is not set." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
LOCAL_FILE="$BACKUP_DIR/corolla-fix-helper-backup-${TIMESTAMP}.tar.gz"

echo "[backup] Downloading snapshot from ${APP_URL}/api/settings/backup-export ..."
curl -sSf --max-time 120 \
  -H "Accept: application/gzip" \
  -o "$LOCAL_FILE" \
  "${APP_URL}/api/settings/backup-export"

GCS_PATH="gs://${GCS_BUCKET}/daily/${TIMESTAMP}.tar.gz"
echo "[backup] Uploading to ${GCS_PATH} ..."
gcloud storage cp "$LOCAL_FILE" "$GCS_PATH"

rm -f "$LOCAL_FILE"
echo "[backup] Done — ${GCS_PATH}"
