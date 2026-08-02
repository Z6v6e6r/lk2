#!/bin/sh

set -eu

cd /opt/phub

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

sql() {
  infrastructure exec -T postgres sh -ec \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "$1"' \
    sh "$1"
}

attempt=0
while test "$attempt" -lt 24; do
  counts="$(sql "
    select concat(
      count(distinct identity_user.id), '|',
      count(distinct snapshot.user_id) filter (where
        snapshot.payload #>> '{snapshot,source}' = 'LOCAL_PROJECTION'
        and snapshot.payload #>> '{snapshot,completeness}' = 'PARTIAL'
        and (snapshot.payload #>> '{snapshot,staleAt}')::timestamptz > now()
      )
    )
      from identity.users identity_user
      join integration.user_delegations delegation
        on delegation.tenant_id = identity_user.tenant_id
       and delegation.user_id = identity_user.id
       and delegation.provider = 'VIVA'
       and delegation.revoked_at is null
       and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
      left join home.base_snapshots snapshot
        on snapshot.tenant_id = identity_user.tenant_id
       and snapshot.user_id = identity_user.id
     where identity_user.status = 'ACTIVE'
  ")"
  active_users="${counts%%|*}"
  ready_snapshots="${counts#*|}"
  echo "HomeBase projection readiness: ${ready_snapshots}/${active_users} active delegated users"
  if test "$active_users" -gt 0 && test "$ready_snapshots" = "$active_users"; then
    echo "Local HomeBase projections verified"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done

compose logs --no-color --tail=160 worker
echo "Local HomeBase projections did not become ready" >&2
exit 1
