#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
IFS=$(printf ' \t\n_')
IFS=${IFS%_}
LANG=C
LC_ALL=C
export PATH IFS LANG LC_ALL
umask 077
unset CDPATH ENV BASH_ENV CURL_HOME \
  DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR \
  http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY no_proxy

fail() {
  echo "TIMEWEB_ROOT_EXECUTOR_FAILED|reason=$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail root_required
[ "$#" -ge 1 ] || fail usage
operation=$1
shift

app_root=/opt/phub
release_parent=$app_root/releases
bundle_custody=/var/lib/phub-preflight/timeweb-bundles
authorization_root=/var/lib/phub-preflight/timeweb-authorizations
authorization_consumed=$authorization_root/consumed
audit_file=/var/log/phub-timeweb-root-executor.audit
lock_file=/run/lock/phub-timeweb-root-executor.lock

metadata_is() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%u:%g:%a' "$1")" = "$2" ]
}

[ ! -L "$lock_file" ] || fail lock_symlink
if [ ! -e "$lock_file" ]; then
  install -o root -g root -m 0600 /dev/null "$lock_file" || fail lock_create
fi
metadata_is "$lock_file" '0:0:600' || fail lock_metadata
exec 9<>"$lock_file"
flock -n 9 || fail operation_in_progress

prepare_authorization_state() {
  install -d -o root -g root -m 0700 "$authorization_root" "$authorization_consumed"
  [ ! -L "$audit_file" ] || fail audit_symlink
  if [ ! -e "$audit_file" ]; then
    install -o root -g root -m 0600 /dev/null "$audit_file" || fail audit_create
  fi
  metadata_is "$audit_file" '0:0:600' || fail audit_metadata
}

audit_event() {
  audit_outcome=$1
  printf '%s|operation=%s|ops_sha=%s|nonce=%s|outcome=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$authorized_operation" "$authorized_ops_sha" \
    "$authorization_nonce" "$audit_outcome" >> "$audit_file" || fail audit_write
}

terminal_result=
terminal_audit() {
  terminal_status=$?
  trap - EXIT
  if [ -n "${authorized_operation:-}" ] && [ "$terminal_result" != PASSED ]; then
    audit_event FAILED
  fi
  exit "$terminal_status"
}
trap terminal_audit EXIT

authorize_operation() {
  requested_operation=$1
  requested_ops_sha=$2
  printf '%s' "$requested_operation" | grep -Eq '^(install-bundle|rollback-ops|start-infrastructure|start-application-dark|start-ingress|rollback-green)$' ||
    fail authorization_operation
  printf '%s' "$requested_ops_sha" | grep -Eq '^[0-9a-f]{40}$' || fail authorization_ops_sha
  prepare_authorization_state
  permit=$authorization_root/$requested_operation.$requested_ops_sha.permit
  metadata_is "$permit" '0:0:400' || fail authorization_absent
  [ "$(wc -l < "$permit" | tr -d ' ')" = 5 ] || fail authorization_shape
  [ "$(sed -n '1p' "$permit")" = PHUB_TIMEWEB_ROOT_AUTHORIZATION_V1 ] || fail authorization_version
  [ "$(grep -Ec '^operation=' "$permit")" -eq 1 ] || fail authorization_shape
  [ "$(grep -Ec '^ops_sha=' "$permit")" -eq 1 ] || fail authorization_shape
  [ "$(grep -Ec '^expires_epoch=' "$permit")" -eq 1 ] || fail authorization_shape
  [ "$(grep -Ec '^nonce=' "$permit")" -eq 1 ] || fail authorization_shape
  [ "$(sed -n 's/^operation=//p' "$permit")" = "$requested_operation" ] || fail authorization_mismatch
  [ "$(sed -n 's/^ops_sha=//p' "$permit")" = "$requested_ops_sha" ] || fail authorization_mismatch
  expires_epoch=$(sed -n 's/^expires_epoch=//p' "$permit")
  authorization_nonce=$(sed -n 's/^nonce=//p' "$permit")
  printf '%s' "$expires_epoch" | grep -Eq '^[0-9]{10}$' || fail authorization_expiry
  printf '%s' "$authorization_nonce" | grep -Eq '^[0-9a-f]{32}$' || fail authorization_nonce
  now_epoch=$(date +%s)
  [ "$expires_epoch" -ge "$now_epoch" ] && [ "$expires_epoch" -le $((now_epoch + 3600)) ] ||
    fail authorization_expiry
  consumed_permit=$authorization_consumed/$requested_operation.$requested_ops_sha.$authorization_nonce.permit
  [ ! -e "$consumed_permit" ] && [ ! -L "$consumed_permit" ] || fail authorization_replayed
  mv -T "$permit" "$consumed_permit" || fail authorization_consume
  chmod 0400 "$consumed_permit"
  authorized_operation=$requested_operation
  authorized_ops_sha=$requested_ops_sha
  audit_event AUTHORIZED
}

complete_authorized_operation() {
  audit_event PASSED
  terminal_result=PASSED
}

verify_release_files() {
  verify_root=$1
  verify_manifest=$2
  apply_modes=$3
  [ -s "$verify_manifest" ] && [ -f "$verify_manifest" ] && [ ! -L "$verify_manifest" ] ||
    fail files_manifest_invalid
  verified_count=0
  while IFS='|' read -r install_mode checksum source_sha relative_path extra || [ -n "$install_mode$checksum$source_sha$relative_path$extra" ]; do
    [ -z "$extra" ] || fail files_manifest_fields
    case "$install_mode" in 0644|0755) ;; *) fail files_manifest_mode ;; esac
    printf '%s' "$checksum" | grep -Eq '^[0-9a-f]{64}$' || fail files_manifest_checksum
    printf '%s' "$source_sha" | grep -Eq '^[0-9a-f]{40}$' || fail files_manifest_source_sha
    printf '%s' "$relative_path" | grep -Eq '^[A-Za-z0-9._/-]+$' || fail files_manifest_path
    case "$relative_path" in /*|*../*|../*|*/..|..|'') fail files_manifest_path ;; esac
    release_file=$verify_root/$relative_path
    [ -f "$release_file" ] && [ ! -L "$release_file" ] || fail release_file_invalid
    [ "$(stat -c '%u:%g' "$release_file")" = '0:0' ] || fail release_file_owner
    [ "$(sha256sum "$release_file" | awk '{ print $1 }')" = "$checksum" ] ||
      fail release_file_checksum
    if [ "$apply_modes" = true ]; then
      chmod "$install_mode" "$release_file"
    fi
    [ "0$(stat -c '%a' "$release_file")" = "$install_mode" ] || fail release_file_mode
    verified_count=$((verified_count + 1))
  done < "$verify_manifest"
  [ "$verified_count" -gt 0 ] || fail files_manifest_empty
  invalid_directory=$(find "$verify_root" -type d -printf '%u:%g:%m\n' | \
    awk '$0 != "root:root:755" { print; exit }')
  [ -z "$invalid_directory" ] || fail release_directory_metadata
}

executor_path=$(realpath -e "$0") || fail executor_resolution
[ "$executor_path" = /usr/local/sbin/phub-timeweb-root-executor ] || fail executor_path
metadata_is "$executor_path" '0:0:755' || fail executor_metadata

verify_current_release() {
  [ -L "$app_root/current" ] || fail current_symlink_absent
  current_release=$(realpath -e "$app_root/current") || fail current_resolution
  case "$current_release" in "$release_parent"/[0-9a-f][0-9a-f]*) ;; *) fail current_outside_release_root ;; esac
  ops_sha=${current_release##*/}
  printf '%s' "$ops_sha" | grep -Eq '^[0-9a-f]{40}$' || fail current_ops_sha
  [ -d "$current_release" ] && [ ! -L "$current_release" ] || fail current_release_invalid
  [ "$(stat -c '%u:%g' "$current_release")" = '0:0' ] || fail current_release_owner
  [ "$(stat -c '%A' "$current_release" | cut -c6,9)" = '--' ] || fail current_release_writable
  metadata_is "$current_release/.phub-files.sha256" '0:0:444' || fail files_manifest_metadata
  verify_release_files "$current_release" "$current_release/.phub-files.sha256" false
}

verify_runtime_inputs() {
  metadata_is /etc/phub/infrastructure.env '0:0:600' || fail infrastructure_env_metadata
  metadata_is /etc/phub/ingress.env '0:0:600' || fail ingress_env_metadata
  metadata_is "$app_root/release.env" '0:0:440' || fail release_env_metadata
  "$current_release/scripts/verify-timeweb-runtime-env.sh" host /etc/phub >/dev/null ||
    fail runtime_env_contract
  "$current_release/deploy/jetson/verify-runtime-env-isolation.sh" \
    /etc/phub/staging.env /etc/phub/realtime.env root false >/dev/null ||
    fail realtime_env_contract
}

infra_compose() {
  docker compose --project-directory "$current_release/deploy/timeweb" \
    --env-file /etc/phub/infrastructure.env \
    -f "$current_release/deploy/timeweb/compose.infrastructure.yaml" "$@"
}

app_compose() {
  docker compose --project-directory "$current_release/deploy" \
    --env-file "$app_root/release.env" \
    -f "$current_release/deploy/compose.timeweb-staging.yaml" "$@"
}

ingress_compose() {
  docker compose --project-directory "$current_release/deploy/timeweb" \
    --env-file /etc/phub/ingress.env \
    -f "$current_release/deploy/timeweb/compose.ingress.yaml" "$@"
}

preflight() {
  verify_current_release
  verify_runtime_inputs
  infra_compose config --quiet
  app_compose --profile worker --profile migration config --quiet
  ingress_compose config --quiet
}

install_bundle() {
  [ "$#" -eq 4 ] || fail install_usage
  install_ops_sha=$1
  expected_archive_sha=$2
  expected_contracts_archive_sha=$3
  expected_artifacts_sha=$4
  printf '%s' "$install_ops_sha" | grep -Eq '^[0-9a-f]{40}$' || fail install_ops_sha
  printf '%s' "$expected_archive_sha" | grep -Eq '^[0-9a-f]{64}$' || fail install_archive_sha
  printf '%s' "$expected_contracts_archive_sha" | grep -Eq '^[0-9a-f]{64}$' ||
    fail install_contracts_archive_sha
  printf '%s' "$expected_artifacts_sha" | grep -Eq '^[0-9a-f]{64}$' || fail install_artifacts_sha
  candidate_directory=$bundle_custody/$install_ops_sha
  [ -d "$candidate_directory" ] && [ ! -L "$candidate_directory" ] || fail candidate_directory
  [ "$(stat -c '%u:%g:%a' "$candidate_directory")" = '0:0:700' ] || fail candidate_directory_metadata
  archive=$candidate_directory/timeweb-ops-$install_ops_sha.tar.gz
  contracts_archive=$candidate_directory/timeweb-application-contracts-$install_ops_sha.tar.gz
  files_manifest=$candidate_directory/timeweb-ops-$install_ops_sha.files.sha256
  receipt=$candidate_directory/timeweb-ops-$install_ops_sha.receipt
  artifacts=$candidate_directory/timeweb-ops-$install_ops_sha.artifacts.sha256
  for file in "$archive" "$contracts_archive" "$files_manifest" "$receipt" "$artifacts"; do
    metadata_is "$file" '0:0:440' || fail candidate_file_metadata
  done
  [ "$(sha256sum "$artifacts" | awk '{ print $1 }')" = "$expected_artifacts_sha" ] ||
    fail candidate_artifacts_manifest_checksum
  (cd "$candidate_directory" && sha256sum -c "${artifacts##*/}" >/dev/null) ||
    fail candidate_artifacts_checksum
  actual_archive_sha=$(sha256sum "$archive" | awk '{ print $1 }')
  [ "$actual_archive_sha" = "$expected_archive_sha" ] || fail candidate_archive_checksum
  actual_contracts_archive_sha=$(sha256sum "$contracts_archive" | awk '{ print $1 }')
  [ "$actual_contracts_archive_sha" = "$expected_contracts_archive_sha" ] ||
    fail candidate_contracts_archive_checksum
  grep -Fx "ops_sha=$install_ops_sha" "$receipt" >/dev/null || fail candidate_receipt_ops_sha
  grep -Fx "archive_sha256=$expected_archive_sha" "$receipt" >/dev/null ||
    fail candidate_receipt_archive_sha
  grep -Fx "contracts_archive_sha256=$expected_contracts_archive_sha" "$receipt" >/dev/null ||
    fail candidate_receipt_contracts_archive_sha
  [ "$(sed -n '1p' "$receipt")" = PHUB_TIMEWEB_OPS_BUNDLE_V2 ] || fail candidate_receipt_version
  application_sha=$(sed -n 's/^application_sha=//p' "$receipt")
  [ "$(grep -Ec '^application_sha=' "$receipt")" -eq 1 ] || fail candidate_application_sha
  printf '%s' "$application_sha" | grep -Eq '^[0-9a-f]{40}$' || fail candidate_application_sha
  for receipt_tree_key in tree_sha application_tree_sha contracts_tree_sha; do
    [ "$(grep -Ec "^${receipt_tree_key}=" "$receipt")" -eq 1 ] || fail candidate_receipt_tree
    receipt_tree_sha=$(sed -n "s/^${receipt_tree_key}=//p" "$receipt")
    printf '%s' "$receipt_tree_sha" | grep -Eq '^[0-9a-f]{40}$' || fail candidate_receipt_tree
  done
  grep -Fx 'installation=false' "$receipt" >/dev/null || fail candidate_receipt_authority
  for candidate_archive in "$archive" "$contracts_archive"; do
    tar -tzf "$candidate_archive" | awk '
      /^\// || /(^|\/)\.\.($|\/)/ || $0 == "" { exit 1 }
    ' || fail candidate_archive_path
    tar -tvzf "$candidate_archive" | awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }' ||
      fail candidate_archive_type
  done
  release_directory=$release_parent/$install_ops_sha
  incoming_directory=$release_parent/.incoming-$install_ops_sha
  [ ! -e "$release_directory" ] && [ ! -L "$release_directory" ] || fail release_already_exists
  [ ! -e "$incoming_directory" ] && [ ! -L "$incoming_directory" ] || fail incoming_release_exists
  install -d -o root -g root -m 0755 "$release_parent" "$incoming_directory"
  tar -xzf "$archive" -C "$incoming_directory" --no-same-owner --no-same-permissions ||
    fail candidate_extract
  tar -xzf "$contracts_archive" -C "$incoming_directory" --no-same-owner --no-same-permissions ||
    fail candidate_contracts_extract
  grep -Fx "PHUB_APPLICATION_SHA=$application_sha" \
    "$incoming_directory/deploy/timeweb/application-candidate.env" >/dev/null ||
    fail candidate_application_binding
  chown -R root:root "$incoming_directory"
  find "$incoming_directory" -type d -exec chmod 0755 {} +
  verify_release_files "$incoming_directory" "$files_manifest" true
  install -o root -g root -m 0444 "$files_manifest" "$incoming_directory/.phub-files.sha256"
  mv -T "$incoming_directory" "$release_directory"
  if [ -L "$app_root/current" ]; then
    previous_release=$(realpath -e "$app_root/current") || fail previous_release_resolution
    case "$previous_release" in "$release_parent"/[0-9a-f][0-9a-f]*) ;; *) fail previous_release_path ;; esac
    previous_ops_sha=${previous_release##*/}
    printf '%s' "$previous_ops_sha" | grep -Eq '^[0-9a-f]{40}$' || fail previous_release_sha
    previous_next=$app_root/previous.next.$install_ops_sha
    [ ! -e "$previous_next" ] && [ ! -L "$previous_next" ] || fail previous_next_exists
    ln -s "$previous_release" "$previous_next"
    mv -Tf "$previous_next" "$app_root/previous"
  fi
  next_link=$app_root/current.next.$install_ops_sha
  [ ! -e "$next_link" ] && [ ! -L "$next_link" ] || fail next_link_exists
  ln -s "$release_directory" "$next_link"
  mv -Tf "$next_link" "$app_root/current"
  echo "TIMEWEB_ROOT_EXECUTOR_PASSED|operation=install-bundle|ops_sha=$install_ops_sha|deploy=false"
}

rollback_ops() {
  [ -L "$app_root/previous" ] || fail previous_symlink_absent
  verify_current_release
  old_current=$current_release
  old_ops_sha=$ops_sha
  previous_release=$(realpath -e "$app_root/previous") || fail previous_resolution
  case "$previous_release" in "$release_parent"/[0-9a-f][0-9a-f]*) ;; *) fail previous_outside_release_root ;; esac
  previous_ops_sha=${previous_release##*/}
  printf '%s' "$previous_ops_sha" | grep -Eq '^[0-9a-f]{40}$' || fail previous_ops_sha
  metadata_is "$previous_release/.phub-files.sha256" '0:0:444' || fail previous_manifest_metadata
  verify_release_files "$previous_release" "$previous_release/.phub-files.sha256" false
  current_next=$app_root/current.rollback.$old_ops_sha
  previous_next=$app_root/previous.rollback.$old_ops_sha
  [ ! -e "$current_next" ] && [ ! -L "$current_next" ] || fail rollback_current_link_exists
  [ ! -e "$previous_next" ] && [ ! -L "$previous_next" ] || fail rollback_previous_link_exists
  ln -s "$previous_release" "$current_next"
  ln -s "$old_current" "$previous_next"
  mv -Tf "$current_next" "$app_root/current"
  mv -Tf "$previous_next" "$app_root/previous"
  echo "TIMEWEB_ROOT_EXECUTOR_PASSED|operation=rollback-ops|ops_sha=$previous_ops_sha|previous_ops_sha=$old_ops_sha|containers_changed=false"
}

case "$operation" in
  install-bundle)
    [ "$#" -eq 4 ] || fail install_usage
    authorize_operation install-bundle "$1"
    install_bundle "$@"
    complete_authorized_operation
    ;;
  preflight)
    [ "$#" -eq 0 ] || fail usage
    preflight
    echo "TIMEWEB_ROOT_EXECUTOR_PASSED|operation=preflight|ops_sha=$ops_sha|mutation=false"
    ;;
  rollback-ops)
    [ "$#" -eq 0 ] || fail usage
    verify_current_release
    authorize_operation rollback-ops "$ops_sha"
    rollback_ops
    complete_authorized_operation
    ;;
  status)
    [ "$#" -eq 0 ] || fail usage
    verify_current_release
    infra_compose ps
    app_compose --profile worker ps
    ingress_compose ps
    docker volume ls --filter label=com.docker.compose.project=phub-timeweb-infrastructure \
      --format 'TIMEWEB_VOLUME|project=phub-timeweb-infrastructure|name={{.Name}}'
    docker volume ls --filter label=com.docker.compose.project=phub-timeweb-ingress \
      --format 'TIMEWEB_VOLUME|project=phub-timeweb-ingress|name={{.Name}}'
    ;;
  probe)
    [ "$#" -eq 1 ] || fail usage
    verify_current_release
    "$current_release/scripts/probe-timeweb-green.sh" "$1"
    ;;
  start-infrastructure)
    [ "$#" -eq 0 ] || fail usage
    preflight
    authorize_operation start-infrastructure "$ops_sha"
    infra_compose up -d
    complete_authorized_operation
    echo "TIMEWEB_ROOT_EXECUTOR_PASSED|operation=start-infrastructure|ops_sha=$ops_sha"
    ;;
  start-application-dark)
    [ "$#" -eq 0 ] || fail usage
    preflight
    authorize_operation start-application-dark "$ops_sha"
    app_compose up -d web api realtime
    complete_authorized_operation
    echo "TIMEWEB_ROOT_EXECUTOR_PASSED|operation=start-application-dark|ops_sha=$ops_sha"
    ;;
  start-ingress)
    [ "$#" -eq 0 ] || fail usage
    preflight
    authorize_operation start-ingress "$ops_sha"
    ingress_compose up -d caddy
    complete_authorized_operation
    echo "TIMEWEB_ROOT_EXECUTOR_PASSED|operation=start-ingress|ops_sha=$ops_sha"
    ;;
  rollback-green)
    [ "$#" -eq 0 ] || fail usage
    verify_current_release
    authorize_operation rollback-green "$ops_sha"
    rollback_failed=0
    ingress_compose stop caddy || rollback_failed=1
    app_compose --profile worker --profile migration stop migrator worker api realtime web ||
      rollback_failed=1
    infra_compose stop || rollback_failed=1
    for rollback_project in phub-timeweb-ingress phub-timeweb-staging phub-timeweb-infrastructure; do
      running_ids=$(docker ps -q --filter "label=com.docker.compose.project=$rollback_project") ||
        rollback_failed=1
      [ -z "$running_ids" ] || rollback_failed=1
    done
    if [ "$rollback_failed" -ne 0 ]; then
      fail rollback_incomplete
    fi
    complete_authorized_operation
    echo "TIMEWEB_ROOT_EXECUTOR_PASSED|operation=rollback-green|ops_sha=$ops_sha|volumes_preserved=true"
    ;;
  *) fail unsupported_operation ;;
esac
