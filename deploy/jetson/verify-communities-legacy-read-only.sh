#!/bin/sh

set -eu

cd /opt/phub

base_runtime_env=/etc/phub/staging.env
communities_env=/opt/phub/staging.communities.env
communities_legacy_base_url=https://padlhub.su

test -r "$base_runtime_env"

file_value() {
  file="$1"
  key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | tail -n 1
}

base_value() {
  file_value "$base_runtime_env" "$1"
}

communities_value() {
  key="$1"
  value="$(file_value "$communities_env" "$key")"
  if test -n "$value"; then
    printf '%s' "$value"
    return 0
  fi
  base_value "$key"
}

require_value() {
  key="$1"
  expected="$2"
  actual="$(communities_value "$key")"
  if test "$actual" != "$expected"; then
    echo "Unsafe Communities read-only configuration: ${key} must equal ${expected}" >&2
    exit 1
  fi
}

test "$(base_value APP_ENV)" = staging
case "$communities_legacy_base_url" in
  https://*) ;;
  *) echo 'Communities legacy source must use HTTPS' >&2; exit 1 ;;
esac

if test "${1:-}" = preflight; then
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    "${communities_legacy_base_url%/}/lk/communities?view=summary" >/dev/null
  echo 'Communities legacy read-only source preflight verified'
  exit 0
fi

require_value COMMUNITIES_READ_MODE legacy
require_value COMMUNITIES_LEGACY_BASE_URL "$communities_legacy_base_url"
require_value COMMUNITY_LEGACY_READ_DETAIL_ENABLED true
require_value COMMUNITY_LEGACY_READ_FEED_ENABLED true
require_value COMMUNITY_LEGACY_READ_CHAT_ENABLED true
require_value COMMUNITY_LEGACY_READ_RATING_ENABLED true
require_value COMMUNITIES_LEGACY_TIMEOUT_MS 2500
require_value COMMUNITIES_LEGACY_MAX_ATTEMPTS 1
require_value COMMUNITIES_LEGACY_CACHE_TTL_MS 120000
require_value COMMUNITY_MEDIA_ENABLED false
require_value COMMUNITY_INVITES_ENABLED false
require_value COMMUNITIES_REALTIME_ENABLED false

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

compose exec -T api node -e "
  const env = process.env;
  const expected = {
    APP_ENV: 'staging',
    COMMUNITIES_READ_MODE: 'legacy',
    COMMUNITIES_LEGACY_BASE_URL: 'https://padlhub.su',
    COMMUNITY_LEGACY_READ_DETAIL_ENABLED: 'true',
    COMMUNITY_LEGACY_READ_FEED_ENABLED: 'true',
    COMMUNITY_LEGACY_READ_CHAT_ENABLED: 'true',
    COMMUNITY_LEGACY_READ_RATING_ENABLED: 'true',
    COMMUNITIES_LEGACY_TIMEOUT_MS: '2500',
    COMMUNITIES_LEGACY_MAX_ATTEMPTS: '1',
    COMMUNITIES_LEGACY_CACHE_TTL_MS: '120000',
    COMMUNITY_MEDIA_ENABLED: 'false',
    COMMUNITY_INVITES_ENABLED: 'false',
    COMMUNITIES_REALTIME_ENABLED: 'false',
  };
  for (const [key, value] of Object.entries(expected)) if (env[key] !== value) process.exit(1);
"

test -z "$(compose ps -q worker)"
test -z "$(compose ps -q realtime)"

curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3000/health/ready >/dev/null

# Select only existing PadlHub identities and existing legacy mappings. This is a read-only probe;
# the response is discarded and no identity, token or provider payload is written to logs.
candidates="$(infrastructure exec -T postgres sh -ec '
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -c "
    select tenant.id::text, source.user_id::text, mapping.internal_id::text
      from identity.tenants tenant
      join integration.community_home_source_components source
        on source.tenant_id = tenant.id and source.source_mode = '\''LEGACY'\''
      join identity.users viewer
        on viewer.tenant_id = source.tenant_id
       and viewer.id = source.user_id
       and viewer.status = '\''ACTIVE'\''
      join integration.external_entity_map mapping
        on mapping.tenant_id = source.tenant_id
       and mapping.external_system = '\''LK_LEGACY'\''
       and mapping.entity_type = '\''community'\''
       and exists (
         select 1
           from jsonb_array_elements(source.payload) item
          where item ->> '\''id'\'' = mapping.internal_id::text
       )
     where tenant.tenant_key = '\''local-padel'\'' and tenant.active = true
     order by source.last_synced_at desc, source.user_id, mapping.internal_id
     limit 20
  "
')"
test -n "$candidates"

authenticated_projection_ok=false
status_200=0
status_404=0
status_503=0
status_other=0
while IFS='|' read -r tenant_id user_id community_id; do
  test -n "$tenant_id$user_id$community_id" || continue
  access_token="$(compose exec -T api node --input-type=module -e '
    import { randomUUID } from "node:crypto";
    import { SignJWT } from "jose";
    const [tenantId, userId] = process.argv.slice(1);
    const token = await new SignJWT({
      tenants: [tenantId], roles: ["client"], permissions: [], sid: randomUUID(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(process.env.JWT_ISSUER)
      .setAudience(process.env.JWT_AUDIENCE)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET));
    process.stdout.write(token);
  ' "$tenant_id" "$user_id")"
  status="$(curl --silent --show-error --connect-timeout 2 --max-time 8 \
    --output /dev/null --write-out '%{http_code}' \
    -H "Authorization: Bearer $access_token" \
    -H 'X-App-Platform: web' \
    -H 'X-App-Version: communities-staging-smoke' \
    -H "X-Correlation-ID: communities-staging-${GITHUB_RUN_ID:-manual}" \
    "http://127.0.0.1:3000/user/api/v1/local-padel/community-views/$community_id")"
  access_token=''
  if test "$status" = 200; then
    status_200=$((status_200 + 1))
    authenticated_projection_ok=true
    break
  fi
  case "$status" in
    404) status_404=$((status_404 + 1)) ;;
    503) status_503=$((status_503 + 1)) ;;
    *) status_other=$((status_other + 1)) ;;
  esac
done <<EOF
$candidates
EOF

if test "$authenticated_projection_ok" != true; then
  printf '%s\n' \
    "Communities authenticated projection failed: ok=$status_200 hidden=$status_404 unavailable=$status_503 other=$status_other" >&2
  exit 1
fi
echo 'Communities legacy read-only runtime and authenticated projection verified'
