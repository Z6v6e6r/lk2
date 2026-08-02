#!/bin/sh

set -eu

cd /opt/phub

tenant_key="${1:-local-padel}"
case "$tenant_key" in
  '' | *[!a-z0-9-]*)
    echo 'Tenant key must contain only lowercase letters, digits and hyphens' >&2
    exit 1
    ;;
esac

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

runtime_value() {
  service="$1"
  key="$2"
  compose exec -T "$service" node -e \
    "process.stdout.write(String(process.env[process.argv[1]] || ''))" "$key"
}

require_runtime_value() {
  service="$1"
  key="$2"
  expected="$3"
  actual="$(runtime_value "$service" "$key")"
  if test "$actual" != "$expected"; then
    echo "${service}: ${key} must equal ${expected}" >&2
    exit 1
  fi
}

require_runtime_secret() {
  service="$1"
  key="$2"
  value="$(runtime_value "$service" "$key")"
  if test "${#value}" -lt 32; then
    echo "${service}: ${key} must be configured as a 32+ character runtime secret" >&2
    exit 1
  fi
}

require_runtime_value worker PROMOTIONS_READ_MODE legacy
require_runtime_value worker PROMOTIONS_LEGACY_BASE_URL http://phab-showcase:3000
require_runtime_value worker PROMOTIONS_HERO_PLACEMENT cabinet_home_top
require_runtime_value worker PROMOTIONS_STANDARD_PLACEMENT cabinet_home
require_runtime_value worker PROMOTIONS_RECOMMENDATION_STRIP_PLACEMENT cabinet_for_me_strip
require_runtime_value worker PROMOTIONS_RECOMMENDATION_CARD_PLACEMENT cabinet_for_me_card
require_runtime_secret api PROMOTIONS_ENGAGEMENT_SECRET

api_engagement_secret="$(runtime_value api PROMOTIONS_ENGAGEMENT_SECRET)"
showcase_container=''
for container_id in $(docker ps --filter network=phab-showcase_default --format '{{.ID}}'); do
  if docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
    grep -q '^PADLHUB_NOTIFICATION_API_BASE_URL='; then
    showcase_container="$container_id"
    break
  fi
done
if test -z "$showcase_container"; then
  echo 'CUP showcase container with PadlHub notification configuration was not found' >&2
  exit 1
fi

cup_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$showcase_container")"
has_cup_value() {
  key="$1"
  expected="$2"
  printf '%s\n' "$cup_environment" | grep -Fqx "${key}=${expected}"
}

has_cup_value PADLHUB_NOTIFICATION_API_BASE_URL https://cup.nano.padlhub.su || {
  echo 'CUP must use the same-origin https://cup.nano.padlhub.su PadlHub API route' >&2
  exit 1
}
has_cup_value PADLHUB_NOTIFICATION_TENANT_KEY "$tenant_key" || {
  echo "CUP notification tenant must equal ${tenant_key}" >&2
  exit 1
}
cup_engagement_secret="$(printf '%s\n' "$cup_environment" | sed -n 's/^ADVERTISING_ENGAGEMENT_SECRET=//p' | tail -n 1)"
if test -z "$cup_engagement_secret" || test "$cup_engagement_secret" != "$api_engagement_secret"; then
  echo 'CUP and PadlHub API advertising engagement secrets are absent or different' >&2
  exit 1
fi

notification_state="$(sql "
  select concat_ws('|',
    settings.in_app_enabled,
    settings.web_push_enabled,
    exists (
      select 1
        from integration.notification_provider_accounts provider
       where provider.tenant_id = tenant.id
         and provider.channel = 'PUSH'
         and provider.platform = 'WEB'
         and provider.provider = 'WEB_PUSH'
         and provider.app_id = 'padlhub-web'
         and provider.environment = 'SANDBOX'
         and provider.status = 'ACTIVE'
    ),
    exists (
      select 1
        from identity.user_access_profiles access
       where access.tenant_id = tenant.id
         and 'admin' = any(access.roles)
         and 'notifications.manage' = any(access.permissions)
    )
  )
    from identity.tenants tenant
    left join notifications.tenant_runtime_settings settings
      on settings.tenant_id = tenant.id
   where tenant.tenant_key = '${tenant_key}'
     and tenant.active = true
")"

case "$notification_state" in
  true\|false\|*\|true) ;;
  true\|true\|true\|true) ;;
  '')
    echo "Active tenant ${tenant_key} was not found" >&2
    exit 1
    ;;
  *)
    echo 'CUP notifications require in-app runtime and an authorized notifications.manage admin' >&2
    exit 1
    ;;
esac

if test "$(runtime_value api WEB_PUSH_ENABLED)" = true; then
  require_runtime_secret api NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS
  require_runtime_secret api WEB_PUSH_VAPID_PRIVATE_KEY
  require_runtime_secret worker NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS
  require_runtime_secret worker WEB_PUSH_VAPID_PRIVATE_KEY
  case "$notification_state" in
    true\|true\|true\|true) ;;
    *)
      echo 'Enabled Web Push requires tenant runtime, provider account and CUP admin access' >&2
      exit 1
      ;;
  esac
fi

compose exec -T worker node -e "
  const sources = [
    ['cabinet_home_top', '/api/advertising/cabinet-home-top'],
    ['cabinet_home', '/api/advertising/cabinet-home'],
    ['cabinet_for_me_strip', '/api/advertising/cabinet-for-me-strip'],
    ['cabinet_for_me_card', '/api/advertising/cabinet-for-me-card'],
  ];
  Promise.all(sources.map(async ([placement, path]) => {
    const response = await fetch(new URL(path, process.env.PROMOTIONS_LEGACY_BASE_URL), {
      headers: { Accept: 'application/json', 'X-Correlation-ID': 'cup-integration-preflight' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('HTTP_' + response.status);
    const payload = await response.json();
    if (payload.placement !== placement || !Array.isArray(payload.ads)) throw new Error('CONTRACT');
  })).catch(() => { process.exitCode = 1; });
"

echo "CUP promotions and notification control are configured for ${tenant_key}"
