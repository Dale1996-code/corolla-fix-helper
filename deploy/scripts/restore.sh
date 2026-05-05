#!/usr/bin/env bash
# Restore a GCS snapshot to the data directory and restart the service.
#
# MUST be tested end-to-end on a scratch VM before using against production data.
# An untested backup is not a backup.
#
# Usage:
#   sudo ./restore.sh gs://my-bucket/daily/20240101T120000Z.tar.gz
#
# Optional env vars:
#   DATA_DIR      — data directory to restore into (default: /var/lib/corolla)
#   SERVICE_NAME  — systemd service name (default: corolla)
set -euo pipefail

SNAPSHOT_URL="${1:-}"
DATA_DIR="${DATA_DIR:-/var/lib/corolla}"
SERVICE_NAME="${SERVICE_NAME:-corolla}"

if [[ -z "$SNAPSHOT_URL" ]]; then
  echo "Usage: $0 <gcs-snapshot-url>" >&2
  echo "Example: $0 gs://my-bucket/daily/20240101T120000Z.tar.gz" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: this script must run as root (it stops/starts the systemd service)." >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d)
TARBALL="$TEMP_DIR/snapshot.tar.gz"

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

echo "[restore] Downloading ${SNAPSHOT_URL} ..."
gcloud storage cp "$SNAPSHOT_URL" "$TARBALL"

echo "[restore] Stopping ${SERVICE_NAME} ..."
systemctl stop "$SERVICE_NAME"

echo "[restore] Extracting into ${DATA_DIR} ..."
# The archive contains database/ and uploads/ subdirectories.
# Extract with --strip-components=0 so those subdirectories land directly
# inside DATA_DIR alongside any existing content.
tar -xzf "$TARBALL" -C "$DATA_DIR"

echo "[restore] Fixing ownership (1000:1000) ..."
chown -R 1000:1000 "$DATA_DIR"

echo "[restore] Starting ${SERVICE_NAME} ..."
systemctl start "$SERVICE_NAME"

echo "[restore] Done. Verify the app is healthy:"
echo "  curl http://127.0.0.1:4000/api/health"
echo "  journalctl -u ${SERVICE_NAME} -f"
