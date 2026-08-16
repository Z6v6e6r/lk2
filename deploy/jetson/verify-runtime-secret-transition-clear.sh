#!/bin/sh
set -eu

secret_root=${1:-/etc/phub}
app_root=${2:-/opt/phub}
for root in "$secret_root" "$app_root"; do
  test -d "$root" && test ! -L "$root" || {
    printf '%s\n' 'runtime secret transition root is absent or unsafe' >&2
    exit 1
  }
done

for unresolved in \
  "$secret_root/.runtime-secret-isolation.transition.json" \
  "$secret_root/.runtime-secret-isolation.transition.json.next" \
  "$secret_root/.runtime-secret-isolation.staging.backup" \
  "$secret_root/.runtime-secret-isolation.staging.next" \
  "$secret_root/.runtime-secret-isolation.realtime.next" \
  "$app_root/.runtime-secret-isolation.compose.backup" \
  "$app_root/.runtime-secret-isolation.compose.next" \
  "$app_root/.runtime-secret-bootstrap.compose.next" \
  "$app_root/.runtime-secret-bootstrap.release.next"; do
  if test -e "$unresolved" || test -L "$unresolved"; then
    printf '%s\n' 'runtime secret transition is unresolved; deployment is blocked' >&2
    exit 1
  fi
done

printf '%s\n' 'runtime_secret_transition status=clear'
