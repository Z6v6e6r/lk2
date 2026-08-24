#!/bin/sh
set -eu

usage() {
  echo 'usage: verify-timeweb-runtime-env.sh host|content-only ENV_DIRECTORY' >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
mode=$1
env_directory=$2
[ "$mode" = host ] || [ "$mode" = content-only ] || usage
[ -d "$env_directory" ] || { echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=directory_absent' >&2; exit 1; }

base_file=$env_directory/staging.env
api_s3_file=$env_directory/staging.api-s3.env
worker_s3_file=$env_directory/staging.worker-s3.env
migrator_file=$env_directory/staging.migrator.env
realtime_file=$env_directory/realtime.env
redis_acl_file=$env_directory/redis/users.acl
infrastructure_file=$env_directory/infrastructure.env

for file in "$base_file" "$api_s3_file" "$worker_s3_file" "$migrator_file" "$realtime_file" "$redis_acl_file"; do
  [ -f "$file" ] || { echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=file_absent' >&2; exit 1; }
  [ ! -L "$file" ] || { echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=symlink_forbidden' >&2; exit 1; }
  if [ "$mode" = host ]; then
    metadata=$(stat -c '%u:%g:%a' "$file")
    expected_metadata='0:0:600'
    if [ "$file" = "$redis_acl_file" ]; then
      [ -f "$infrastructure_file" ] && [ ! -L "$infrastructure_file" ] || {
        echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=infrastructure_env_absent' >&2
        exit 1
      }
      redis_runtime_gid=$(sed -n 's/^REDIS_RUNTIME_GID=//p' "$infrastructure_file")
      printf '%s' "$redis_runtime_gid" | grep -Eq '^[1-9][0-9]{0,8}$' || {
        echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=redis_runtime_gid' >&2
        exit 1
      }
      expected_metadata="0:$redis_runtime_gid:440"
    fi
    [ "$metadata" = "$expected_metadata" ] || {
      echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=metadata_mismatch' >&2
      exit 1
    }
  fi
done

if [ "$mode" = host ]; then
  optional_directory=/opt/phub
  for optional_file in \
    "$optional_directory/staging.auth.env" \
    "$optional_directory/staging.override.env" \
    "$optional_directory/staging.games.env" \
    "$optional_directory/staging.communities.env" \
    "$optional_directory/staging.chat-push-foundation.env"
  do
    if [ -e "$optional_file" ] || [ -L "$optional_file" ]; then
      [ -f "$optional_file" ] && [ ! -L "$optional_file" ] &&
        [ "$(stat -c '%u:%g:%a' "$optional_file")" = '0:0:600' ] || {
          echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=optional_contour_metadata' >&2
          exit 1
        }
    fi
  done
fi

keys() {
  sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\1/p' "$1" | LC_ALL=C sort
}

assert_canonical_assignments() {
  file=$1
  if awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    /^[A-Za-z_][A-Za-z0-9_]*=.*/ { next }
    { invalid = 1 }
    END { exit invalid ? 0 : 1 }
  ' "$file"; then
    echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=noncanonical_assignment' >&2
    exit 1
  fi
}

assert_unique_assignments() {
  file=$1
  duplicate_keys=$(keys "$file" | uniq -d)
  [ -z "$duplicate_keys" ] || {
    echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=duplicate_assignment' >&2
    exit 1
  }
}

assert_exact_keys() {
  file=$1
  expected=$2
  actual=$(keys "$file")
  [ "$actual" = "$expected" ] || {
    echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=unexpected_key_set' >&2
    exit 1
  }
}

for file in "$base_file" "$api_s3_file" "$worker_s3_file" "$migrator_file" "$realtime_file"; do
  assert_canonical_assignments "$file"
  assert_unique_assignments "$file"
done

if keys "$base_file" | grep -Eq '^(S3_ACCESS_KEY|S3_SECRET_KEY)$'; then
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=s3_credentials_in_shared_runtime' >&2
  exit 1
fi

assert_exact_keys "$api_s3_file" "S3_ACCESS_KEY
S3_SECRET_KEY"
assert_exact_keys "$worker_s3_file" "S3_ACCESS_KEY
S3_SECRET_KEY"
assert_exact_keys "$migrator_file" 'DATABASE_URL'

for file in "$api_s3_file" "$worker_s3_file" "$migrator_file"; do
  if grep -Eq '^[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*$' "$file"; then
    echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=empty_required_value' >&2
    exit 1
  fi
done

api_access_key=$(sed -n 's/^S3_ACCESS_KEY=//p' "$api_s3_file")
api_secret_key=$(sed -n 's/^S3_SECRET_KEY=//p' "$api_s3_file")
worker_access_key=$(sed -n 's/^S3_ACCESS_KEY=//p' "$worker_s3_file")
worker_secret_key=$(sed -n 's/^S3_SECRET_KEY=//p' "$worker_s3_file")
[ "$api_access_key" != "$worker_access_key" ] && [ "$api_secret_key" != "$worker_secret_key" ] || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=s3_identity_reuse' >&2
  exit 1
}

[ "$(grep -Ec '^DATABASE_URL=' "$base_file" || true)" -eq 1 ] &&
  grep -Eq '^DATABASE_URL=postgres(ql)?://phub_runtime:[^@[:space:]]+@postgres(:5432)?/phub$' "$base_file" || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=runtime_database_identity' >&2
  exit 1
}
grep -Eq '^DATABASE_URL=postgres(ql)?://phub_migrator:[^@[:space:]]+@postgres(:5432)?/phub$' "$migrator_file" || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=migrator_database_identity' >&2
  exit 1
}
for realtime_target in \
  'DATABASE_URL=postgres(ql)?://phub_runtime:[^@[:space:]]+@postgres(:5432)?/phub' \
  'REDIS_URL=redis://phub:[^@[:space:]]+@redis(:6379)?/0' \
  'RABBITMQ_URL=amqps?://phub:[^@[:space:]]+@rabbitmq(:5672)?/phub_staging'
do
  realtime_key=${realtime_target%%=*}
  [ "$(grep -Ec "^${realtime_key}=" "$realtime_file" || true)" -eq 1 ] &&
    grep -Eq "^${realtime_target}$" "$realtime_file" || {
      echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=realtime_target_identity' >&2
      exit 1
    }
done

require_exact_value() {
  required_key=$1
  required_value=$2
  [ "$(grep -Ec "^${required_key}=" "$base_file" || true)" -eq 1 ] &&
    grep -Fx "${required_key}=${required_value}" "$base_file" >/dev/null || {
      echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=runtime_isolation_value' >&2
      exit 1
    }
}

require_exact_value APP_ENV staging
require_exact_value VIVA_MODE disabled
require_exact_value VIVA_OAUTH_ENABLED false
require_exact_value VIVA_DIRECT_READ_ENABLED false
require_exact_value VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED false
require_exact_value WEB_PUSH_ENABLED false
require_exact_value BOOKING_REMINDER_SCHEDULER_ENABLED false
require_exact_value GIFT_CERTIFICATE_PAYMENT_MODE disabled
require_exact_value GIFT_CERTIFICATE_DELIVERY_MODE disabled
require_exact_value GAMES_COMMANDS_ENABLED false
require_exact_value GAMES_RESULTS_WRITE_MODE disabled
require_exact_value LEGACY_GAME_COMMAND_BRIDGE_ENABLED false
require_exact_value PARTICIPATION_COMMANDS_ENABLED false
require_exact_value CUP_RATING_CONSUMER_ENABLED false
require_exact_value HOME_VIVA_SYNC_ENABLED false
require_exact_value ACTIVITY_HISTORY_SYNC_ENABLED false
require_exact_value CUP_PLAYER_LEVEL_PROJECTION_ENABLED false

[ "$(grep -Ec '^REDIS_URL=' "$base_file" || true)" -eq 1 ] &&
  grep -Eq '^REDIS_URL=redis://phub:[^@[:space:]]+@redis(:6379)?/0$' "$base_file" || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=runtime_redis_identity' >&2
  exit 1
}
[ "$(grep -Ec '^RABBITMQ_URL=' "$base_file" || true)" -eq 1 ] &&
  grep -Eq '^RABBITMQ_URL=amqps?://phub:[^@[:space:]]+@rabbitmq(:5672)?/phub_staging$' "$base_file" || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=runtime_rabbitmq_identity' >&2
  exit 1
}
if grep -Eq '^(VIVA_API_KEY|PROMOTIONS_ENGAGEMENT_SECRET|CUP_DEV_AUTH_[A-Za-z0-9_]*|RUNTIME_ENV_FILE|RUNTIME_AUTH_ENV_FILE|RUNTIME_OVERRIDE_ENV_FILE|RUNTIME_GAMES_ENV_FILE|RUNTIME_COMMUNITIES_ENV_FILE|RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE|REALTIME_RUNTIME_ENV_FILE|API_S3_ENV_FILE|WORKER_S3_ENV_FILE|MIGRATOR_RUNTIME_ENV_FILE)=' "$base_file"; then
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=unsafe_runtime_override' >&2
  exit 1
fi

if [ "$mode" = host ]; then
  optional_directory=/opt/phub
else
  optional_directory=$env_directory/optional
fi
for optional_file in \
  "$optional_directory/staging.auth.env" \
  "$optional_directory/staging.override.env" \
  "$optional_directory/staging.games.env" \
  "$optional_directory/staging.communities.env" \
  "$optional_directory/staging.chat-push-foundation.env"
do
  [ -f "$optional_file" ] || continue
  assert_canonical_assignments "$optional_file"
  assert_unique_assignments "$optional_file"
  if grep -Eq '^(APP_ENV|DATABASE_URL|REDIS_URL|RABBITMQ_URL|VIVA_MODE|VIVA_OAUTH_ENABLED|VIVA_DIRECT_READ_ENABLED|VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED|WEB_PUSH_ENABLED|BOOKING_REMINDER_SCHEDULER_ENABLED|GIFT_CERTIFICATE_PAYMENT_MODE|GIFT_CERTIFICATE_DELIVERY_MODE|GAMES_COMMANDS_ENABLED|GAMES_RESULTS_WRITE_MODE|LEGACY_GAME_COMMAND_BRIDGE_ENABLED|PARTICIPATION_COMMANDS_ENABLED|CUP_RATING_CONSUMER_ENABLED|CUP_PLAYER_LEVEL_PROJECTION_ENABLED|HOME_VIVA_SYNC_ENABLED|ACTIVITY_HISTORY_SYNC_ENABLED|VIVA_API_KEY|PROMOTIONS_ENGAGEMENT_SECRET|CUP_DEV_AUTH_[A-Za-z0-9_]*|.*_ENV_FILE)=' "$optional_file"; then
    echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=optional_contour_shadowing' >&2
    exit 1
  fi
done

default_acl_count=$(grep -Ec '^user default on nopass ~\* -@all \+ping$' "$redis_acl_file" || true)
application_acl_count=$(grep -Ec '^user phub on >[^[:space:]]{20,} ~\* \+@read \+@write \+@connection \+@transaction \+@pubsub -@admin -@dangerous \+eval \+evalsha$' "$redis_acl_file" || true)
[ "$(grep -Ec 'replace-with-generated-secret|synthetic-secret' "$redis_acl_file" || true)" -eq 0 ] || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=redis_acl_placeholder' >&2
  exit 1
}
[ "$default_acl_count" -eq 1 ] && [ "$application_acl_count" -eq 1 ] || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=redis_acl_contract' >&2
  exit 1
}
[ "$(grep -Ec '^user ' "$redis_acl_file" || true)" -eq 2 ] || {
  echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=redis_acl_unexpected_user' >&2
  exit 1
}

echo "TIMEWEB_ENV_VERIFY_PASSED|mode=$mode|values_printed=false"
