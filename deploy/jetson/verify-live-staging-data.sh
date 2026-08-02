#!/bin/sh

set -eu

cd /opt/phub

base_runtime_env=/etc/phub/staging.env
auth_runtime_env=/opt/phub/staging.auth.env
home_runtime_env=/opt/phub/staging.override.env
games_runtime_env=/opt/phub/staging.games.env

test -r "$base_runtime_env"
test -r "$auth_runtime_env"
test -r "$home_runtime_env"
test -r "$games_runtime_env"
test "$(stat -c %a "$auth_runtime_env")" = 600
test "$(stat -c %a "$games_runtime_env")" = 600

file_value() {
  file="$1"
  key="$2"
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

runtime_value() {
  key="$1"
  for file in "$games_runtime_env" "$home_runtime_env" "$auth_runtime_env" "$base_runtime_env"; do
    value="$(file_value "$file" "$key")"
    if test -n "$value"; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

require_value() {
  key="$1"
  expected="$2"
  actual="$(runtime_value "$key")"
  if test "$actual" != "$expected"; then
    echo "Unsafe staging configuration: ${key} must equal ${expected}" >&2
    exit 1
  fi
}

require_value APP_ENV staging
case "$(runtime_value VIVA_MODE)" in
  sandbox | production) ;;
  *)
    echo "Unsafe staging configuration: VIVA_MODE must use the real provider" >&2
    exit 1
    ;;
esac
require_value VIVA_OAUTH_ENABLED true
require_value VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED true
require_value VIVA_DIRECT_READ_ENABLED false
test "$(runtime_value CUP_DEV_AUTH_ENABLED)" != true
require_value HOME_READ_MODE projection
case "$(runtime_value COMMUNITIES_READ_MODE)" in
  legacy | local) ;;
  *)
    echo "Unsafe staging configuration: COMMUNITIES_READ_MODE cannot use mock" >&2
    exit 1
    ;;
esac
require_value PROMOTIONS_READ_MODE legacy
require_value GAMES_READ_ENABLED true
require_value GAMES_COMMANDS_ENABLED false
require_value LEGACY_GAMES_ROSTER_SYNC_ENABLED true
require_value LEGACY_GAMES_ROSTER_SYNC_SOURCE mongo
test -n "$(runtime_value LEGACY_GAMES_MONGODB_URI)"
test -n "$(runtime_value LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY)"
require_value ACTIVITY_HISTORY_ENABLED true
require_value ACTIVITY_HISTORY_SYNC_ENABLED true
require_value ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED true

if test "${1:-}" = preflight; then
  echo "Real staging data configuration verified"
  exit 0
fi

require_value PROMOTIONS_LEGACY_BASE_URL http://phab-showcase:3000
require_value PROMOTIONS_HERO_PLACEMENT cabinet_home
require_value PROMOTIONS_STANDARD_PLACEMENT cabinet_home
require_value PROMOTION_IMAGE_ALLOWED_HOSTS phab-showcase
require_value PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS phab-showcase

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

compose exec -T api node -e "
  const env = process.env;
  if (env.APP_ENV !== 'staging') process.exit(1);
  if (!['sandbox', 'production'].includes(env.VIVA_MODE)) process.exit(1);
  if (env.VIVA_OAUTH_ENABLED !== 'true') process.exit(1);
  if (env.VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED !== 'true') process.exit(1);
  if (env.VIVA_DIRECT_READ_ENABLED !== 'false') process.exit(1);
  if (env.CUP_DEV_AUTH_ENABLED === 'true') process.exit(1);
  if (env.HOME_READ_MODE !== 'projection') process.exit(1);
  if (env.GAMES_READ_ENABLED !== 'true') process.exit(1);
  if (env.GAMES_COMMANDS_ENABLED !== 'false') process.exit(1);
  if (env.LEGACY_GAMES_ROSTER_SYNC_SOURCE !== 'mongo') process.exit(1);
  if (!env.LEGACY_GAMES_MONGODB_URI) process.exit(1);
  if (env.ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED !== 'true') process.exit(1);
  if (env.S3_BUCKET !== 'phub-media') process.exit(1);
"

compose exec -T worker node -e "
  const env = process.env;
  if (!['sandbox', 'production'].includes(env.VIVA_MODE)) process.exit(1);
  if (env.HOME_READ_MODE !== 'projection') process.exit(1);
  if (env.LEGACY_GAMES_ROSTER_SYNC_ENABLED !== 'true') process.exit(1);
  if (env.LEGACY_GAMES_ROSTER_SYNC_SOURCE !== 'mongo') process.exit(1);
  if (!env.LEGACY_GAMES_MONGODB_URI) process.exit(1);
  if (env.ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED !== 'true') process.exit(1);
  if (env.S3_BUCKET !== 'phub-media') process.exit(1);
  const promotionSource = new URL('/api/advertising/cabinet-home', env.PROMOTIONS_LEGACY_BASE_URL);
  fetch(promotionSource, {
    headers: {
      Accept: 'application/json',
      'X-Correlation-ID': 'staging-promotion-source-verification',
    },
    signal: AbortSignal.timeout(5000),
  }).then(async (response) => {
    if (!response.ok) process.exit(1);
    const payload = await response.json();
    if (payload.placement !== 'cabinet_home' || !Array.isArray(payload.ads)) process.exit(1);
  }).catch(() => { process.exitCode = 1; });
"

compose exec -T api node -e "
  import('@phub/legacy-games-adapter').then(async ({ LegacyGamesMongoAdapter }) => {
    const adapter = new LegacyGamesMongoAdapter({
      uri: process.env.LEGACY_GAMES_MONGODB_URI,
      timeoutMs: 5000,
      maxAttempts: 1,
    });
    await adapter.read({
      from: '2020-01-01T00:00:00.000Z',
      to: '2030-01-01T00:00:00.000Z',
      limit: 1,
    });
  }).catch(() => { process.exitCode = 1; });
"

attempt=0
while test "$attempt" -lt 36; do
  viva_identities="$(sql "
    select count(*)
      from integration.external_identity_map
     where provider = 'VIVA'
  ")"
  non_viva_identities="$(sql "
    select count(*)
      from integration.external_identity_map
     where provider <> 'VIVA'
  ")"
  projection_home="$(sql "
    select count(*)
      from home.dashboard_snapshots
     where payload #>> '{snapshot,source}' = 'LOCAL_PROJECTION'
  ")"
  canonical_games="$(sql "select count(*) from games.games")"
  game_cards="$(sql "select count(*) from games.card_projections")"
  mirrored_rosters="$(sql "
    select count(*)
      from integration.legacy_game_roster_sync_state
     where mode = 'MIRROR'
  ")"

  if test "$viva_identities" -gt 0 \
    && test "$non_viva_identities" -eq 0 \
    && test "$projection_home" -gt 0 \
    && test "$canonical_games" -gt 0 \
    && test "$game_cards" -gt 0 \
    && test "$mirrored_rosters" -gt 0; then
    echo "Real staging data verified: viva_identities=$viva_identities projection_home=$projection_home canonical_games=$canonical_games game_cards=$game_cards mirrored_rosters=$mirrored_rosters"
    exit 0
  fi

  attempt=$((attempt + 1))
  sleep 5
done

echo "Real staging data did not become ready: viva_identities=$viva_identities non_viva_identities=$non_viva_identities projection_home=$projection_home canonical_games=$canonical_games game_cards=$game_cards mirrored_rosters=$mirrored_rosters" >&2
exit 1
