#!/usr/bin/env sh
set -eu

if [ -z "${BACKUP_FILE:-}" ]; then
  echo "BACKUP_FILE is required" >&2
  exit 64
fi

test -s "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" >/dev/null
echo "Backup archive is readable: $BACKUP_FILE"
