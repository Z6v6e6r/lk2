#!/bin/sh

set -eu

tenant_key="${1:?tenant key is required}"
actor_id="${2:?actor UUID is required}"
user_id="${3:?target user UUID is required}"
roles="${4:?roles are required}"
permissions="${5:?permissions are required}"
apply="${6:-false}"

case "$apply" in
  true | false) ;;
  *)
    echo 'apply must be true or false' >&2
    exit 1
    ;;
esac

cd /opt/phub
test -r infrastructure.env
test -r release.env
test -r /opt/phub/set-user-access.ts

set -- \
  "--tenant-key=$tenant_key" \
  "--actor-id=$actor_id" \
  "--user-id=$user_id" \
  "--roles=$roles" \
  "--permissions=$permissions"

if test "$apply" = true; then
  set -- "$@" --confirm=APPLY_USER_ACCESS
fi

docker compose --env-file infrastructure.env --env-file release.env \
  --profile migration run --rm --no-deps \
  --volume /opt/phub/set-user-access.ts:/app/set-user-access.ts:ro \
  --entrypoint node migrator \
  --experimental-strip-types /app/set-user-access.ts "$@"

