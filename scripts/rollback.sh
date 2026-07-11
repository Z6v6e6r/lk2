#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <service> <previous-image-digest>" >&2
  exit 64
fi

service="$1"
digest="$2"

case "$service" in
  api|worker|realtime) ;;
  *) echo "Unsupported service: $service" >&2; exit 64 ;;
esac

case "$digest" in
  sha256:*) ;;
  *) echo "Rollback requires an immutable sha256 digest" >&2; exit 64 ;;
esac

echo "Rollback is environment-specific and must be run by the deployment workflow."
echo "Service: $service"
echo "Target digest: $digest"
echo "Follow docs/runbooks/rollback.md; do not mutate production by hand."
exit 2
