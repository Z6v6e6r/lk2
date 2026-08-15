#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Media staging baseline refused: $*" >&2
  exit 1
}

if test "$#" -ne 5; then
  fail 'usage: verify-media-staging-baseline.sh <expected-active-release> <candidate-release> <candidate-tree> <migration-manifest-base64> <compose-base64>'
fi

expected_active_release="$1"
candidate_release="$2"
candidate_tree="$3"
migration_manifest_base64="$4"
candidate_compose_base64="$5"

for value in "$expected_active_release" "$candidate_release" "$candidate_tree"; do
  case "$value" in
    *[!0-9a-f]*|'') fail 'release and tree identifiers must be 40 lowercase hexadecimal characters' ;;
  esac
  test "${#value}" -eq 40 ||
    fail 'release and tree identifiers must be 40 lowercase hexadecimal characters'
done

decode_base64() {
  if decoded="$(printf '%s' "$1" | base64 -d 2>/dev/null)"; then
    printf '%s' "$decoded"
    return 0
  fi
  fail 'candidate attestation payload is not valid base64'
}

migration_manifest="$(decode_base64 "$migration_manifest_base64")"
candidate_compose="$(decode_base64 "$candidate_compose_base64")"
test -n "$migration_manifest" || fail 'candidate migration manifest is empty'
test -n "$candidate_compose" || fail 'candidate Compose definition is empty'

legacy_alias_filename=0043_messaging_runtime.sql
legacy_alias_checksum=32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465
approved_pending_migrations='0079_profile_photo_client_assisted_source.sql
0080_community_logo_stable_delivery.sql
0081_community_logo_stable_delivery_validate.sql
0082_profile_photo_removal_commands.sql
0083_profile_photo_removal_commands_validate.sql'

if ! printf '%s\n' "$migration_manifest" | awk -F '|' '
  NF != 2 || $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/ { invalid = 1 }
  seen[$2]++
  END {
    if (NR == 0 || invalid) exit 1
    for (filename in seen) if (seen[filename] != 1) exit 1
  }
'; then
  fail 'candidate migration manifest is malformed or contains duplicate filenames'
fi

app_root="${PHUB_APP_ROOT:-/opt/phub}"
base_runtime_env="${PHUB_BASE_RUNTIME_ENV:-/etc/phub/staging.env}"
realtime_runtime_env="${PHUB_REALTIME_RUNTIME_ENV:-/etc/phub/realtime.env}"
foundation_runtime_env="$app_root/staging.chat-push-foundation.env"
cd "$app_root"

test -z "${RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE:-}" ||
  fail 'runtime shell must not redirect the chat/push foundation overlay'
for interpolation_file in infrastructure.env release.env; do
  override_count="$(awk -F= '$1 == "RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE" { count += 1 } END { print count + 0 }' "$interpolation_file")"
  test "$override_count" -eq 0 ||
    fail "$interpolation_file must not redirect the chat/push foundation overlay"
done

test -f release.env && test ! -L release.env || fail 'active release.env is absent or unsafe'
active_release_count="$(awk -F= '$1 == "RELEASE" { count += 1 } END { print count + 0 }' release.env)"
test "$active_release_count" -eq 1 || fail 'active release.env must contain exactly one RELEASE entry'
active_release="$(sed -n 's/^RELEASE=//p' release.env)"
case "$active_release" in
  *[!0-9a-f]*|'') fail 'active release identifier is malformed' ;;
esac
test "${#active_release}" -eq 40 || fail 'active release identifier is malformed'
test "$active_release" = "$expected_active_release" ||
  fail "active release changed (expected=$expected_active_release observed=$active_release)"
registry_count="$(awk -F= '$1 == "REGISTRY" { count += 1 } END { print count + 0 }' release.env)"
test "$registry_count" -eq 1 || fail 'active release.env must contain exactly one REGISTRY entry'
registry="$(sed -n 's/^REGISTRY=//p' release.env)"
test "$registry" = ghcr.io/z6v6e6r || fail 'active release registry is not approved'

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

sql() {
  infrastructure exec -T postgres sh -ec '
    exec env PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000" \
      psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"
  ' sh "$1"
}

file_value() {
  file="$1"
  key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | tail -n 1
}

runtime_value() {
  service="$1"
  key="$2"
  if test "$service" = api; then
    files="$foundation_runtime_env $app_root/staging.communities.env $app_root/staging.games.env $app_root/staging.override.env $app_root/staging.auth.env $base_runtime_env"
  elif test "$service" = realtime; then
    files="$realtime_runtime_env"
  else
    files="$foundation_runtime_env $app_root/staging.games.env $app_root/staging.override.env $app_root/staging.auth.env $base_runtime_env"
  fi
  for file in $files; do
    value="$(file_value "$file" "$key")"
    if test -n "$value"; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

running_container() {
  service="$1"
  container_id="$(compose ps --status running -q "$service")" ||
    fail "cannot resolve running $service container"
  test -n "$container_id" || fail "$service is not running"
  printf '%s' "$container_id"
}

running_flag() {
  service="$1"
  key="$2"
  container_id="$(running_container "$service")"
  env_dump="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")" ||
    fail "cannot inspect running $service environment"
  value="$(printf '%s\n' "$env_dump" | sed -n "s/^${key}=//p" | tail -n 1)"
  case "$value" in
    true | false) printf '%s' "$value" ;;
    *) fail "running $service has no literal boolean $key" ;;
  esac
}

require_disabled() {
  service="$1"
  key="$2"
  configured="$(runtime_value "$service" "$key")"
  test "$configured" = false || fail "$service runtime files must set $key=false"
  observed="$(running_flag "$service" "$key")"
  test "$observed" = false || fail "running $service must have $key=false"
  printf 'flag service=%s key=%s value=false\n' "$service" "$key"
}

for service in web api worker realtime; do
  container_id="$(running_container "$service")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
  test "$health" = healthy || fail "$service is not healthy"
  image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
  case "$service" in
    web) digest_key=WEB_IMAGE_DIGEST ;;
    api) digest_key=API_IMAGE_DIGEST ;;
    worker) digest_key=WORKER_IMAGE_DIGEST ;;
    realtime) digest_key=REALTIME_IMAGE_DIGEST ;;
  esac
  digest_count="$(awk -F= -v key="$digest_key" '$1 == key { count += 1 } END { print count + 0 }' release.env)"
  test "$digest_count" -eq 1 || fail "active release.env must contain exactly one $digest_key entry"
  expected_digest="$(sed -n "s/^${digest_key}=//p" release.env)"
  case "$expected_digest" in
    sha256:*) ;;
    *) fail "$digest_key is malformed" ;;
  esac
  digest_hex="${expected_digest#sha256:}"
  case "$digest_hex" in *[!0-9a-f]*|'') fail "$digest_key is malformed" ;; esac
  test "${#digest_hex}" -eq 64 || fail "$digest_key is malformed"
  expected_image_ref="$registry/phub-$service@$expected_digest"
  case "$image_id" in sha256:*) ;; *) fail "$service image ID is malformed" ;; esac
  test "$image_ref" = "$expected_image_ref" ||
    fail "$service is not running the digest recorded by the active release"
  printf 'runtime service=%s health=healthy image_id=%s image_ref=%s\n' \
    "$service" "$image_id" "$image_ref"
done

for service in api worker; do
  require_disabled "$service" PROFILE_PHOTO_CLIENT_SYNC_ENABLED
  require_disabled "$service" COMMUNITY_INVITES_ENABLED
  require_disabled "$service" COMMUNITIES_REALTIME_ENABLED
  require_disabled "$service" COMMUNITY_MEDIA_ENABLED
  require_disabled "$service" COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED
  require_disabled "$service" COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED
done
require_disabled realtime COMMUNITIES_REALTIME_ENABLED

file_config_fingerprint="$({
  for file in \
    "$base_runtime_env" \
    "$realtime_runtime_env" \
    "$app_root/staging.auth.env" \
    "$app_root/staging.override.env" \
    "$app_root/staging.communities.env" \
    "$app_root/staging.games.env" \
    "$foundation_runtime_env"; do
    if test -f "$file" && test ! -L "$file"; then
      checksum_line="$(sha256sum "$file")"
      printf 'present|%s|%s\n' "$file" "${checksum_line%% *}"
    elif test ! -e "$file"; then
      printf 'absent|%s\n' "$file"
    else
      fail "runtime file is unsafe: $file"
    fi
  done
} | sha256sum | cut -d ' ' -f 1)"

if ! candidate_config="$(printf '%s\n' "$candidate_compose" |
  docker compose --env-file infrastructure.env --env-file release.env -f - --profile migration config --format json)"; then
  fail 'candidate Compose definition does not render against staging release metadata'
fi
api_container="$(running_container api)"
worker_container="$(running_container worker)"
realtime_container="$(running_container realtime)"
if ! effective_config_fingerprint="$(printf '%s' "$candidate_config" | node -e '
  const { createHash } = require("node:crypto");
  const { execFileSync } = require("node:child_process");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const config = JSON.parse(input);
    const services = ["api", "worker", "realtime"];
    const containers = process.argv.slice(1);
    const envMap = (entries) => new Map(entries.map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    const material = [];
    for (const [index, service] of services.entries()) {
      const candidate = config.services?.[service]?.environment ?? {};
      const inspected = JSON.parse(execFileSync("docker", ["inspect", containers[index]], { encoding: "utf8" }));
      const running = envMap(inspected[0]?.Config?.Env ?? []);
      const imageId = inspected[0]?.Image;
      if (typeof imageId !== "string" || imageId.length === 0) {
        process.stderr.write(`RUNTIME_ENV_DRIFT:${service}:IMAGE\n`);
        process.exit(1);
      }
      const image = JSON.parse(execFileSync("docker", ["image", "inspect", imageId], { encoding: "utf8" }));
      const imageDefaults = envMap(image[0]?.Config?.Env ?? []);
      if (running.get("NODE_ENV") !== "production") {
        process.stderr.write(`RUNTIME_ENV_DRIFT:${service}:NODE_ENV\n`);
        process.exit(1);
      }
      material.push(`${service}\0NODE_ENV\0production`);
      const keys = new Set([
        ...Object.keys(candidate),
        ...[...running.keys()].filter((key) => imageDefaults.get(key) !== running.get(key)),
      ]);
      for (const key of [...keys].sort()) {
        const expected = Object.prototype.hasOwnProperty.call(candidate, key) ? String(candidate[key] ?? "") : undefined;
        const observed = running.get(key);
        if (expected === undefined || observed === undefined || expected !== observed) {
          process.stderr.write(`RUNTIME_ENV_DRIFT:${service}:${key}\n`);
          process.exit(1);
        }
        material.push(`${service}\0${key}\0${observed}`);
      }
    }
    process.stdout.write(createHash("sha256").update(material.join("\n")).digest("hex"));
  });
' "$api_container" "$worker_container" "$realtime_container")"; then
  fail 'candidate runtime environment differs from the currently serving effective configuration'
fi
config_fingerprint="$(printf '%s|%s' "$file_config_fingerprint" "$effective_config_fingerprint" |
  sha256sum | cut -d ' ' -f 1)"
printf 'runtime_config_fingerprint=%s\n' "$config_fingerprint"
printf 'candidate_compose release=%s tree=%s status=rendered\n' "$candidate_release" "$candidate_tree"

ledger="$(sql "begin transaction read only;
  select filename || '|' || checksum from public.schema_migrations order by filename;
  commit;")"
ledger="$(printf '%s\n' "$ledger" | awk -F '|' 'NF == 2 { print }')"
if ! printf '%s\n' "$ledger" | awk -F '|' '
  NF != 2 || $1 !~ /^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/ || $2 !~ /^[0-9a-f]{64}$/ { exit 1 }
'; then
  fail 'staging migration ledger is malformed'
fi

applied_count=0
pending_count=0
legacy_alias_count=0
while IFS='|' read -r filename checksum; do
  test -n "$filename" || continue
  expected_checksum="$(printf '%s\n' "$migration_manifest" |
    awk -F '|' -v filename="$filename" '$2 == filename { print $1 }')"
  if test -z "$expected_checksum"; then
    if test "$filename" = "$legacy_alias_filename" && test "$checksum" = "$legacy_alias_checksum"; then
      legacy_alias_count=$((legacy_alias_count + 1))
      printf 'migration filename=%s checksum=%s state=reviewed-legacy-alias\n' "$filename" "$checksum"
      continue
    fi
    fail "staging ledger contains an unknown migration: $filename"
  fi
  test "$checksum" = "$expected_checksum" || fail "staging migration checksum mismatch: $filename"
done <<EOF
$ledger
EOF

while IFS='|' read -r checksum filename; do
  observed_checksum="$(printf '%s\n' "$ledger" |
    awk -F '|' -v filename="$filename" '$1 == filename { print $2 }')"
  if test -z "$observed_checksum"; then
    printf '%s\n' "$approved_pending_migrations" | grep -Fx "$filename" >/dev/null ||
      fail "staging is missing a migration outside the approved binary-only expand set: $filename"
    state=pending
    pending_count=$((pending_count + 1))
  else
    test "$observed_checksum" = "$checksum" || fail "staging migration checksum mismatch: $filename"
    state=applied-matching
    applied_count=$((applied_count + 1))
  fi
  printf 'migration filename=%s checksum=%s state=%s\n' "$filename" "$checksum" "$state"
done <<EOF
$migration_manifest
EOF
test "$legacy_alias_count" -le 1 || fail 'staging migration ledger contains duplicate legacy aliases'
printf 'migration_manifest applied=%s pending=%s reviewed_legacy_aliases=%s status=compatible\n' \
  "$applied_count" "$pending_count" "$legacy_alias_count"

server_version="$(sql 'show server_version_num')"
case "$server_version" in
  16????) ;;
  *) fail "media rollout requires PostgreSQL 16 (observed=$server_version)" ;;
esac
printf 'database_engine postgres=%s status=supported\n' "$server_version"

database_activity="$(sql "begin transaction read only;
  select
    count(*) filter (where xact_start < now() - interval '30 seconds')::text || '|' ||
    count(*) filter (where wait_event_type = 'Lock')::text
  from pg_stat_activity
  where datname = current_database() and pid <> pg_backend_pid();
  commit;")"
database_activity="$(printf '%s\n' "$database_activity" | awk -F '|' 'NF == 2 { print; exit }')"
test "$database_activity" = '0|0' || fail "staging has long transactions or lock waits ($database_activity)"
printf 'database_activity long_transactions=0 lock_waiters=0\n'

routing_fingerprint="$(sql "begin transaction read only;
  select md5(coalesce(string_agg(row_to_json(plan)::text, '' order by tenant_id), ''))
  from integration.client_routing_plans plan;
  commit;")"
routing_fingerprint="$(printf '%s\n' "$routing_fingerprint" | awk '/^[0-9a-f]{32}$/ { print; exit }')"
test -n "$routing_fingerprint" || fail 'cannot fingerprint the staging routing plan'
printf 'routing_fingerprint=%s\n' "$routing_fingerprint"

relation_inventory="$(sql "begin transaction read only;
  select schemaname || '.' || relname || '|rows=' || n_live_tup::text ||
    '|bytes=' || pg_total_relation_size(relid)::text
  from pg_stat_user_tables
  where relname in (
    'user_profile_photo_sync', 'profile_photo_client_commands', 'profile_photo_object_gc',
    'community_logo_sync', 'community_home_source_components', 'dashboard_components',
    'dashboard_snapshots', 'base_snapshots', 'outbox_events'
  )
  order by schemaname, relname;
  commit;")"
printf '%s\n' "$relation_inventory" | awk -F '|' 'NF >= 3 { print "relation " $0 }'

media_schema_state="$(sql "begin transaction read only;
  select
    (select count(*) from public.schema_migrations where filename = '0079_profile_photo_client_assisted_source.sql')::text || '|' ||
    (select count(*) from public.schema_migrations where filename = '0080_community_logo_stable_delivery.sql')::text || '|' ||
    (select count(*) from public.schema_migrations where filename = '0081_community_logo_stable_delivery_validate.sql')::text || '|' ||
    (select count(*) from public.schema_migrations where filename = '0082_profile_photo_removal_commands.sql')::text || '|' ||
    (select count(*) from public.schema_migrations where filename = '0083_profile_photo_removal_commands_validate.sql')::text;
  commit;")"
media_schema_state="$(printf '%s\n' "$media_schema_state" | awk -F '|' 'NF == 5 { print; exit }')"
case "$media_schema_state" in
  0\|0\|0\|0\|0 | 1\|0\|0\|0\|0 | 1\|1\|0\|0\|0 | 1\|1\|1\|0\|0 | 1\|1\|1\|1\|0 | 1\|1\|1\|1\|1) ;;
  *) fail "media migration chain is partial or out of order ($media_schema_state)" ;;
esac
case "$media_schema_state" in
  1\|1\|1\|0\|0 | 1\|1\|1\|1\|0 | 1\|1\|1\|1\|1)
  media_invariants="$(sql "begin transaction read only;
    select
      (select count(*) from integration.community_logo_sync
        where (delivery_url is null) <> (delivery_expires_at is null))::text || '|' ||
      (select count(*) from pg_constraint
        where conname = 'community_logo_sync_delivery_pair_chk'
          and conrelid = 'integration.community_logo_sync'::regclass
          and contype = 'c'
          and convalidated
          and translate(lower(pg_get_expr(conbin, conrelid)), E' \n\t()', '') =
            'delivery_urlisnull=delivery_expires_atisnull')::text;
    commit;")"
  media_invariants="$(printf '%s\n' "$media_invariants" | awk -F '|' 'NF == 2 { print; exit }')"
  test "$media_invariants" = '0|1' || fail "media schema invariants are not satisfied ($media_invariants)"
  ;;
esac
case "$media_schema_state" in
  1\|1\|1\|1\|0 | 1\|1\|1\|1\|1)
    profile_command_constraints="$(sql "begin transaction read only;
      select
        count(*)::text || '|' ||
        count(*) filter (where convalidated)::text || '|' ||
        count(*) filter (where
          (conname = 'profile_photo_client_commands_kind_check' and
            translate(lower(pg_get_expr(conbin, conrelid)), E' \n\t()', '') =
              'command_kind::text=anyarray[''upsert''::charactervarying,''delete''::charactervarying]::text[]') or
          (conname = 'profile_photo_client_commands_payload_check' and
            translate(lower(pg_get_expr(conbin, conrelid)), E' \n\t()', '') =
              'command_kind::text=''upsert''::textandrequest_sha256isnotnullandcontent_sha256isnotnullandobject_keyisnotnullorcommand_kind::text=''delete''::textandrequest_sha256isnullandcontent_sha256isnullandobject_keyisnullandavatar_urlisnull'))::text || '|' ||
        (select count(*)
          from pg_attribute
          where attrelid = 'integration.profile_photo_client_commands'::regclass
            and not attisdropped
            and (
              (attname = 'command_kind' and attnotnull) or
              (attname in ('request_sha256', 'content_sha256', 'object_key') and not attnotnull)
            ))::text || '|' ||
        (select count(*)
          from pg_attribute attribute
          join pg_attrdef attribute_default
            on attribute_default.adrelid = attribute.attrelid
            and attribute_default.adnum = attribute.attnum
          where attribute.attrelid = 'integration.profile_photo_client_commands'::regclass
            and attribute.attname = 'command_kind'
            and translate(lower(pg_get_expr(attribute_default.adbin, attribute_default.adrelid)), E' \n\t()', '') =
              '''upsert''::charactervarying')::text
      from pg_constraint
      where conrelid = 'integration.profile_photo_client_commands'::regclass
        and contype = 'c'
        and conname in (
          'profile_photo_client_commands_kind_check',
          'profile_photo_client_commands_payload_check'
        );
      commit;")"
    profile_command_constraints="$(printf '%s\n' "$profile_command_constraints" | awk -F '|' 'NF == 5 { print; exit }')"
    if test "$media_schema_state" = '1|1|1|1|0'; then
      test "$profile_command_constraints" = '2|0|2|4|1' ||
        fail "profile-photo command constraints do not match the unvalidated 0082 state ($profile_command_constraints)"
    else
      test "$profile_command_constraints" = '2|2|2|4|1' ||
        fail "profile-photo command constraints are not validated ($profile_command_constraints)"
    fi
    ;;
esac
printf 'media_schema migrations=%s status=compatible\n' "$media_schema_state"

docker_root="$(docker info --format '{{.DockerRootDir}}')"
case "$docker_root" in /*) ;; *) fail 'Docker root directory is unavailable' ;; esac
test -d "$docker_root" || fail 'Docker root directory is unavailable'
database_size_bytes="$(sql 'select pg_database_size(current_database())')"
case "$database_size_bytes" in *[!0-9]*|'') fail 'staging database size is unavailable' ;; esac
database_size_kb=$(((database_size_bytes + 1023) / 1024))
app_disk_available_kb="$(df -Pk "$app_root" | awk 'END { print $4 }')"
docker_disk_available_kb="$(df -Pk "$docker_root" | awk 'END { print $4 }')"
app_device="$(df -Pk "$app_root" | awk 'END { print $1 }')"
docker_device="$(df -Pk "$docker_root" | awk 'END { print $1 }')"
inode_available_percent="$(df -Pi "$app_root" | awk 'END { gsub(/%/, "", $5); print 100 - $5 }')"
mem_available_kb="$(awk '$1 == "MemAvailable:" { print $2 }' /proc/meminfo)"
swap_total_kb="$(awk '$1 == "SwapTotal:" { print $2 }' /proc/meminfo)"
swap_free_kb="$(awk '$1 == "SwapFree:" { print $2 }' /proc/meminfo)"
for metric in "$app_disk_available_kb" "$docker_disk_available_kb" "$inode_available_percent" "$mem_available_kb" "$swap_total_kb" "$swap_free_kb"; do
  case "$metric" in *[!0-9]*|'') fail 'host capacity metrics are unavailable' ;; esac
done
image_reserve_kb="${PHUB_MEDIA_BASELINE_IMAGE_RESERVE_KB:-8388608}"
safety_reserve_kb="${PHUB_MEDIA_BASELINE_SAFETY_RESERVE_KB:-4194304}"
for reserve in "$image_reserve_kb" "$safety_reserve_kb"; do
  case "$reserve" in *[!0-9]*|'') fail 'disk reserve configuration is malformed' ;; esac
done
if test "$app_device" = "$docker_device"; then
  app_required_kb=$((image_reserve_kb + safety_reserve_kb + database_size_kb * 3))
  docker_required_kb="$app_required_kb"
else
  app_required_kb=$((safety_reserve_kb + database_size_kb))
  docker_required_kb=$((image_reserve_kb + safety_reserve_kb + database_size_kb * 2))
fi
test "$app_disk_available_kb" -ge "$app_required_kb" ||
  fail "application filesystem cannot retain the dump and rollout safety reserve (available=$app_disk_available_kb required=$app_required_kb KiB)"
test "$docker_disk_available_kb" -ge "$docker_required_kb" ||
  fail "Docker filesystem cannot retain candidate images, restore clone, WAL and safety reserve (available=$docker_disk_available_kb required=$docker_required_kb KiB)"
test "$inode_available_percent" -ge "${PHUB_MEDIA_BASELINE_MIN_INODE_PERCENT:-15}" ||
  fail "less than 15 percent of root filesystem inodes are available ($inode_available_percent percent)"
test "$mem_available_kb" -ge "${PHUB_MEDIA_BASELINE_MIN_MEMORY_KB:-1048576}" ||
  fail "less than 1 GiB MemAvailable remains for sequential rollout ($mem_available_kb KiB)"

vmstat_counter() {
  key="$1"
  awk -v key="$key" '$1 == key { print $2 }' /proc/vmstat
}
pswpin_before="$(vmstat_counter pswpin)"
pswpout_before="$(vmstat_counter pswpout)"
oom_before="$(vmstat_counter oom_kill)"
for counter in "$pswpin_before" "$pswpout_before" "$oom_before"; do
  case "$counter" in *[!0-9]*|'') fail 'kernel pressure counters are unavailable' ;; esac
done
if test -r /sys/fs/cgroup/memory.current && test -r /sys/fs/cgroup/memory.events; then
  cgroup_mode=v2
  cgroup_current_before="$(sed -n '1p' /sys/fs/cgroup/memory.current)"
  cgroup_limit="$(sed -n '1p' /sys/fs/cgroup/memory.max)"
  cgroup_oom_before="$(awk '$1 == "oom_kill" { print $2 }' /sys/fs/cgroup/memory.events)"
elif test -r /sys/fs/cgroup/memory/memory.usage_in_bytes && test -r /sys/fs/cgroup/memory/memory.failcnt; then
  cgroup_mode=v1
  cgroup_current_before="$(sed -n '1p' /sys/fs/cgroup/memory/memory.usage_in_bytes)"
  cgroup_limit="$(sed -n '1p' /sys/fs/cgroup/memory/memory.limit_in_bytes)"
  cgroup_oom_before="$(sed -n '1p' /sys/fs/cgroup/memory/memory.failcnt)"
else
  fail 'cgroup memory accounting is unavailable'
fi
for counter in "$cgroup_current_before" "$cgroup_oom_before"; do
  case "$counter" in *[!0-9]*|'') fail 'cgroup memory counters are malformed' ;; esac
done
case "$cgroup_limit" in max) ;; *[!0-9]*|'') fail 'cgroup memory limit is malformed' ;; esac
sleep "${PHUB_MEDIA_BASELINE_SAMPLE_SECONDS:-5}"
pswpin_after="$(vmstat_counter pswpin)"
pswpout_after="$(vmstat_counter pswpout)"
oom_after="$(vmstat_counter oom_kill)"
for counter in "$pswpin_after" "$pswpout_after" "$oom_after"; do
  case "$counter" in *[!0-9]*|'') fail 'kernel pressure counters are unavailable' ;; esac
done
if test "$cgroup_mode" = v2; then
  cgroup_current_after="$(sed -n '1p' /sys/fs/cgroup/memory.current)"
  cgroup_oom_after="$(awk '$1 == "oom_kill" { print $2 }' /sys/fs/cgroup/memory.events)"
else
  cgroup_current_after="$(sed -n '1p' /sys/fs/cgroup/memory/memory.usage_in_bytes)"
  cgroup_oom_after="$(sed -n '1p' /sys/fs/cgroup/memory/memory.failcnt)"
fi
for counter in "$cgroup_current_after" "$cgroup_oom_after"; do
  case "$counter" in *[!0-9]*|'') fail 'cgroup memory counters are malformed' ;; esac
done
swap_delta=$((pswpin_after - pswpin_before + pswpout_after - pswpout_before))
oom_delta=$((oom_after - oom_before))
cgroup_oom_delta=$((cgroup_oom_after - cgroup_oom_before))
test "$swap_delta" -eq 0 || fail "swap activity was observed during the bounded capacity sample ($swap_delta pages)"
test "$oom_delta" -eq 0 || fail "an OOM kill was observed during the bounded capacity sample ($oom_delta)"
test "$cgroup_oom_delta" -eq 0 || fail "a cgroup memory failure was observed during the bounded capacity sample ($cgroup_oom_delta)"
if test "$cgroup_limit" != max; then
  cgroup_headroom_bytes=$((cgroup_limit - cgroup_current_after))
  test "$cgroup_headroom_bytes" -ge "${PHUB_MEDIA_BASELINE_MIN_CGROUP_HEADROOM_BYTES:-536870912}" ||
    fail "less than 512 MiB cgroup memory headroom remains ($cgroup_headroom_bytes bytes)"
else
  cgroup_headroom_bytes=unlimited
fi
test -r /proc/pressure/memory || fail 'memory PSI accounting is unavailable'
memory_pressure_avg10="$(awk -F '[ =]' '$1 == "some" { print $3 }' /proc/pressure/memory)"
awk -v value="$memory_pressure_avg10" 'BEGIN {
  if (value !~ /^[0-9]+([.][0-9]+)?$/) exit 1
  exit !(value <= 1.00)
}' || fail "memory PSI avg10 is unavailable or exceeds 1.00 ($memory_pressure_avg10)"
swap_used_kb=$((swap_total_kb - swap_free_kb))
if test "$swap_total_kb" -gt 0; then
  swap_used_percent=$((swap_used_kb * 100 / swap_total_kb))
  test "$swap_free_kb" -ge "${PHUB_MEDIA_BASELINE_MIN_SWAP_FREE_KB:-524288}" ||
    fail "less than 512 MiB swap remains free ($swap_free_kb KiB)"
  test "$swap_used_percent" -le "${PHUB_MEDIA_BASELINE_MAX_SWAP_USED_PERCENT:-75}" ||
    fail "more than 75 percent of swap is already used ($swap_used_percent percent)"
else
  swap_used_percent=0
fi
printf 'capacity database_size_bytes=%s app_disk_available_kb=%s app_disk_required_kb=%s docker_disk_available_kb=%s docker_disk_required_kb=%s inode_available_percent=%s mem_available_kb=%s swap_total_kb=%s swap_used_kb=%s swap_free_kb=%s swap_delta_pages=0 oom_total=%s oom_delta=0 cgroup_mode=%s cgroup_current_bytes=%s cgroup_limit_bytes=%s cgroup_headroom_bytes=%s cgroup_oom_delta=0 memory_psi_avg10=%s\n' \
  "$database_size_bytes" "$app_disk_available_kb" "$app_required_kb" "$docker_disk_available_kb" "$docker_required_kb" "$inode_available_percent" "$mem_available_kb" "$swap_total_kb" "$swap_used_kb" "$swap_free_kb" "$oom_after" "$cgroup_mode" "$cgroup_current_after" "$cgroup_limit" "$cgroup_headroom_bytes" "$memory_pressure_avg10"
printf 'capacity_swap used_percent=%s max_used_percent=%s min_free_kb=%s status=passed\n' \
  "$swap_used_percent" "${PHUB_MEDIA_BASELINE_MAX_SWAP_USED_PERCENT:-75}" "${PHUB_MEDIA_BASELINE_MIN_SWAP_FREE_KB:-524288}"

raw_object_keys="$(sql "begin transaction read only;
  select distinct object_key from (
    select object_key from integration.user_profile_photo_sync where object_key is not null
    union all
    select object_key from integration.community_logo_sync where object_key is not null
  ) referenced order by object_key;
  commit;")"
raw_referenced_count="$(printf '%s\n' "$raw_object_keys" | awk 'NF { count += 1 } END { print count + 0 }')"
object_keys="$(printf '%s\n' "$raw_object_keys" | awk '/^(profile-photos|community-logos)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.webp$/ { print }')"
referenced_count="$(printf '%s\n' "$object_keys" | awk 'NF { count += 1 } END { print count + 0 }')"
test "$referenced_count" -eq "$raw_referenced_count" ||
  fail 'one or more referenced media object keys are malformed'
profile_referenced_count="$(printf '%s\n' "$object_keys" | awk '/^profile-photos\// { count += 1 } END { print count + 0 }')"
community_referenced_count="$(printf '%s\n' "$object_keys" | awk '/^community-logos\// { count += 1 } END { print count + 0 }')"
test "$profile_referenced_count" -gt 0 ||
  fail 'no existing profile-photo object is available for a read-only storage probe'
test "$community_referenced_count" -gt 0 ||
  fail 'no existing community-logo object is available for a read-only storage probe'

printf '%s\n' "$object_keys" | compose exec -T worker node -e '
  const { createHash } = require("node:crypto");
  const { GetBucketAclCommand, GetBucketCorsCommand, GetBucketLifecycleConfigurationCommand,
    GetBucketPolicyCommand, GetBucketVersioningCommand, GetObjectCommand, HeadObjectCommand,
    S3Client } = require("@aws-sdk/client-s3");
  const { NodeHttpHandler } = require("@smithy/node-http-handler");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", async () => {
    const keys = input.split(/\n/).map((value) => value.trim()).filter(Boolean);
    const bucket = process.env.S3_BUCKET;
    const expectedOrigins = new Set((process.env.COMMUNITIES_MEDIA_ALLOWED_ORIGINS || "")
      .split(",").map((value) => value.trim()).filter(Boolean));
    const expectedHeaders = new Set((process.env.COMMUNITIES_MEDIA_ALLOWED_UPLOAD_HEADERS ||
      "content-type,cache-control,if-none-match,x-amz-checksum-sha256,x-amz-meta-padlhub-media-id,x-amz-meta-padlhub-sha256")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
    if (bucket !== "phub-media" || !process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY ||
      process.env.S3_AUTO_CREATE_BUCKET !== "false" || expectedOrigins.size === 0 || expectedHeaders.size === 0) {
      throw new Error("MEDIA_STORAGE_CONFIG_INVALID");
    }
    if (expectedOrigins.size !== (process.env.COMMUNITIES_MEDIA_ALLOWED_ORIGINS || "").split(",").filter(Boolean).length) {
      throw new Error("MEDIA_STORAGE_ORIGINS_INVALID");
    }
    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || "us-east-1",
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 10000 }),
    });
    const name = (error) => error instanceof Error ? error.name : "Unknown";
    const scopedPrincipal = (value) => {
      if (typeof value === "string") return value.length > 0 && value !== "*";
      if (Array.isArray(value)) return value.length > 0 && value.every(scopedPrincipal);
      if (!value || typeof value !== "object") return false;
      const entries = Object.values(value);
      return entries.length > 0 && entries.every(scopedPrincipal);
    };
    const policyAllowsAnonymousAccess = (document) => {
      const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement].filter(Boolean);
      return statements.some((statement) => {
        if (!statement || typeof statement !== "object" || statement.Effect !== "Allow") return false;
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        const affectsS3 = actions.some((action) => typeof action !== "string" || action === "*" || action.startsWith("s3:"));
        if (!affectsS3) return false;
        if (Object.prototype.hasOwnProperty.call(statement, "NotPrincipal")) return true;
        return !scopedPrincipal(statement.Principal);
      });
    };
    const lifecyclePrefix = (rule) => rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? "";
    const hasOnlyPrefixFilter = (rule) => {
      if (rule.Filter?.And) return Object.keys(rule.Filter.And).every((key) => key === "Prefix");
      if (rule.Filter) return Object.keys(rule.Filter).every((key) => key === "Prefix");
      return rule.Prefix !== undefined;
    };
    const durablePrefixes = ["profile-photos/", "community-logos/", "community-media/ready/"];
    const lifecycleCanDeleteDurable = (rule) => {
      if (rule.Status !== "Enabled") return false;
      const prefix = lifecyclePrefix(rule);
      const overlapsDurable = durablePrefixes.some((durable) =>
        prefix === "" || durable.startsWith(prefix) || prefix.startsWith(durable));
      return overlapsDurable && Boolean(
        rule.Expiration || rule.NoncurrentVersionExpiration ||
        (rule.Transitions || []).length || (rule.NoncurrentVersionTransitions || []).length,
      );
    };
    const lifecycleCleansQuarantine = (rule) => {
      if (rule.Status !== "Enabled" || !hasOnlyPrefixFilter(rule)) return false;
      const prefix = lifecyclePrefix(rule);
      const days = rule.NoncurrentVersionExpiration?.NoncurrentDays;
      return (prefix === "" || "community-media/quarantine/".startsWith(prefix)) &&
        Number.isInteger(days) && days >= 1 && days <= 7;
    };
    try {
      const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      if (versioning.Status !== "Enabled") throw new Error("MEDIA_BUCKET_VERSIONING_REQUIRED");
      const acl = await client.send(new GetBucketAclCommand({ Bucket: bucket }));
      if ((acl.Grants || []).some((grant) => /AllUsers|AuthenticatedUsers/i.test(grant.Grantee?.URI || ""))) {
        throw new Error("MEDIA_BUCKET_PUBLIC_ACL_FORBIDDEN");
      }
      try {
        const policy = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        const document = policy.Policy ? JSON.parse(policy.Policy) : {};
        if (policyAllowsAnonymousAccess(document)) {
          throw new Error("MEDIA_BUCKET_PUBLIC_POLICY_FORBIDDEN");
        }
      } catch (error) {
        if (!["NoSuchBucketPolicy", "NoSuchPolicy"].includes(name(error))) throw error;
      }
      const cors = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      const observedOrigins = new Set();
      const uploadReadyOrigins = new Set();
      const allowedMethods = new Set(["GET", "HEAD", "PUT"]);
      for (const rule of cors.CORSRules || []) {
        const origins = rule.AllowedOrigins || [];
        const methods = new Set((rule.AllowedMethods || []).map((method) => method.toUpperCase()));
        const headers = new Set((rule.AllowedHeaders || []).map((header) => header.toLowerCase()));
        for (const origin of origins) {
          if (!expectedOrigins.has(origin)) throw new Error("MEDIA_BUCKET_CORS_ORIGIN_FORBIDDEN");
          observedOrigins.add(origin);
        }
        for (const method of methods) {
          if (!allowedMethods.has(method)) throw new Error("MEDIA_BUCKET_CORS_METHOD_FORBIDDEN");
        }
        for (const header of headers) {
          if (header === "*" || !expectedHeaders.has(header)) throw new Error("MEDIA_BUCKET_CORS_HEADER_FORBIDDEN");
        }
        if (methods.has("PUT") && [...expectedHeaders].every((header) => headers.has(header))) {
          for (const origin of origins) uploadReadyOrigins.add(origin);
        }
      }
      if ([...expectedOrigins].some((origin) => !observedOrigins.has(origin))) {
        throw new Error("MEDIA_BUCKET_CORS_ORIGINS_MISSING");
      }
      if ([...expectedOrigins].some((origin) => !uploadReadyOrigins.has(origin))) {
        throw new Error("MEDIA_BUCKET_CORS_UPLOAD_RULE_MISSING");
      }
      let lifecycleRules = [];
      try {
        lifecycleRules = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))).Rules || [];
      } catch (error) {
        if (!["NoSuchLifecycleConfiguration", "NoSuchConfiguration"].includes(name(error))) throw error;
      }
      if (lifecycleRules.some(lifecycleCanDeleteDurable)) throw new Error("MEDIA_DURABLE_LIFECYCLE_DELETE_FORBIDDEN");
      if (!lifecycleRules.some(lifecycleCleansQuarantine)) throw new Error("MEDIA_QUARANTINE_CLEANUP_REQUIRED");
      if (keys.length > 10000) throw new Error("MEDIA_REFERENCED_OBJECT_INVENTORY_TOO_LARGE");
      const maxObjectBytes = 5 * 1024 * 1024;
      const maxInventoryBytes = 512 * 1024 * 1024;
      let cursor = 0;
      let inventoryBytes = 0;
      let missing = 0;
      let invalid = 0;
      let timedOut = false;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 180000);
      const readers = Array.from({ length: Math.min(4, keys.length) }, async () => {
        while (cursor < keys.length) {
          const index = cursor++;
          try {
            const key = keys[index];
            const expectedSha256 = key.slice(key.lastIndexOf("/") + 1, -".webp".length);
            const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: abort.signal });
            const contentLength = Number(head.ContentLength);
            if (head.ContentType !== "image/webp" || !Number.isSafeInteger(contentLength) ||
              contentLength <= 0 || contentLength > maxObjectBytes || head.Metadata?.sha256 !== expectedSha256) {
              invalid += 1;
              continue;
            }
            if (head.ChecksumSHA256 && Buffer.from(head.ChecksumSHA256, "base64").toString("hex") !== expectedSha256) {
              invalid += 1;
              continue;
            }
            inventoryBytes += contentLength;
            if (inventoryBytes > maxInventoryBytes) throw new Error("MEDIA_REFERENCED_OBJECT_INVENTORY_BYTES_EXCEEDED");
            const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: abort.signal });
            if (!object.Body) {
              invalid += 1;
              continue;
            }
            const hash = createHash("sha256");
            let received = 0;
            for await (const chunk of object.Body) {
              received += chunk.length;
              if (received > maxObjectBytes) throw new Error("MEDIA_REFERENCED_OBJECT_TOO_LARGE");
              hash.update(chunk);
            }
            if (received !== contentLength || hash.digest("hex") !== expectedSha256) invalid += 1;
          } catch (error) {
            if (abort.signal.aborted || name(error) === "AbortError") timedOut = true;
            if (["MEDIA_REFERENCED_OBJECT_INVENTORY_BYTES_EXCEEDED", "MEDIA_REFERENCED_OBJECT_TOO_LARGE"].includes(
              error instanceof Error ? error.message : "",
            )) throw error;
            missing += 1;
          }
        }
      });
      try {
        await Promise.all(readers);
      } finally {
        clearTimeout(timeout);
      }
      if (timedOut) throw new Error("MEDIA_REFERENCED_OBJECT_PREFLIGHT_TIMEOUT");
      if (missing !== 0) throw new Error(`MEDIA_REFERENCED_OBJECTS_MISSING:${missing}`);
      if (invalid !== 0) throw new Error(`MEDIA_REFERENCED_OBJECTS_INVALID:${invalid}`);
      const profile = keys.filter((key) => key.startsWith("profile-photos/")).length;
      const community = keys.filter((key) => key.startsWith("community-logos/")).length;
      process.stdout.write(`storage bucket=phub-media private=true versioning=enabled cors=restricted durable_lifecycle_delete=false quarantine_cleanup_days_max=7 referenced=${keys.length} bytes=${inventoryBytes} profile=${profile} community=${community} missing=0 invalid=0 integrity=sha256\n`);
    } finally {
      client.destroy();
    }
  }).catch((error) => {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "MEDIA_STORAGE_PREFLIGHT_FAILED";
    process.stderr.write(`Media storage preflight failed: ${code}\n`);
    process.exitCode = 1;
  });
' || fail 'private media storage or referenced-object preflight failed'

printf 'media_baseline active_release=%s candidate_release=%s candidate_tree=%s status=passed\n' \
  "$active_release" "$candidate_release" "$candidate_tree"
