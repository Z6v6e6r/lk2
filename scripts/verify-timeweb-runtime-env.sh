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
redis_acl_file=$env_directory/redis/users.acl
infrastructure_file=$env_directory/infrastructure.env

for file in "$base_file" "$api_s3_file" "$worker_s3_file" "$migrator_file" "$redis_acl_file"; do
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
  for optional_file in \
    /opt/phub/staging.auth.env \
    /opt/phub/staging.override.env \
    /opt/phub/staging.games.env \
    /opt/phub/staging.communities.env \
    /opt/phub/staging.chat-push-foundation.env
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

assert_exact_keys() {
  file=$1
  expected=$2
  actual=$(keys "$file")
  [ "$actual" = "$expected" ] || {
    echo 'TIMEWEB_ENV_VERIFY_FAILED|reason=unexpected_key_set' >&2
    exit 1
  }
}

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
