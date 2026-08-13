#!/bin/sh

set -eu

tenant_key="${1:?tenant key is required}"
actor_id="${2:?actor UUID is required}"
idempotency_key="${3:?idempotency key is required}"
correlation_id="${4:?correlation ID is required}"
reason="${5:?reason is required}"
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
test -r /opt/phub/set-client-routing-plan.ts

set -- \
  --tenant "$tenant_key" \
  --mode MIXED_END_USER_READS \
  --operations profile.read \
  --actor "$actor_id" \
  --idempotency-key "$idempotency_key" \
  --correlation-id "$correlation_id" \
  --reason "$reason" \
  --valid-for-seconds 60

if test "$apply" = true; then
  set -- "$@" --apply
fi

docker compose --env-file infrastructure.env --env-file release.env \
  --profile migration run --rm --no-deps \
  --volume /opt/phub/set-client-routing-plan.ts:/app/set-client-routing-plan.ts:ro \
  --entrypoint node migrator \
  --experimental-strip-types /app/set-client-routing-plan.ts "$@"
