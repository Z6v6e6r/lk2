#!/usr/bin/env bash
set -euo pipefail

readonly MAX_ATTEMPTS=5
readonly INSPECT_TIMEOUT_SECONDS=5
readonly KILL_AFTER_SECONDS=1
readonly RETRY_DELAY_SECONDS=1
readonly TOTAL_RETRY_BUDGET_SECONDS=29
readonly BUILDER_PATTERN='^[a-z0-9][a-z0-9_.-]{0,127}$'
readonly SERVICE_PATTERN='^(web|api|worker|realtime|migrator)$'
readonly VERSION_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
readonly IMAGE_PATTERN='^moby/buildkit@sha256:[a-f0-9]{64}$'

fail_usage() {
  printf '%s\n' 'TIMEWEB_BUILDKIT_READINESS_FAILED|reason=usage' >&2
  exit 64
}

if [[ "$#" -ne 10 ]]; then
  fail_usage
fi

builder_name=''
service=''
expected_version=''
expected_image=''
diagnostic_dir=''
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --builder) builder_name="${2:-}" ;;
    --service) service="${2:-}" ;;
    --expected-version) expected_version="${2:-}" ;;
    --expected-image) expected_image="${2:-}" ;;
    --diagnostic-dir) diagnostic_dir="${2:-}" ;;
    *) fail_usage ;;
  esac
  shift 2
done

[[ "$builder_name" =~ $BUILDER_PATTERN ]] || fail_usage
[[ "$service" =~ $SERVICE_PATTERN ]] || fail_usage
[[ "$expected_version" =~ $VERSION_PATTERN ]] || fail_usage
[[ "$expected_image" =~ $IMAGE_PATTERN ]] || fail_usage
[[ "$diagnostic_dir" = /* ]] || fail_usage

umask 077
mkdir -p "$diagnostic_dir"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/phub-buildkit-readiness.XXXXXX")"
readiness_deadline_seconds=$((SECONDS + TOTAL_RETRY_BUDGET_SECONDS))
cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

sanitize_file() {
  local input_file="$1"
  local output_file="$2"
  dd if="$input_file" bs=16384 count=1 status=none \
    | LC_ALL=C tr -cd '\11\12\15\40-\176' \
    | while IFS= read -r line || [[ -n "$line" ]]; do
        lower_line="$(printf '%s' "$line" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
        case "$lower_line" in
          *auth* | *token* | *password* | *secret* | *cookie* | *credential* | *signature* | *x-amz-*)
            printf '%s\n' '[REDACTED_SENSITIVE_LINE]'
            ;;
          *) printf '%s\n' "$line" ;;
        esac
      done > "$output_file"
}

write_summary() {
  local reason="$1"
  local verified="$2"
  local attempt_count="$3"
  local exit_status="$4"
  local container_count="$5"
  local container_state="$6"
  local last_stderr_file="$7"
  local temporary_summary="$diagnostic_dir/summary.txt.tmp"
  {
    printf 'schema=PHUB_TIMEWEB_BUILDKIT_READINESS_V1\n'
    printf 'service=%s\n' "$service"
    printf 'builder=%s\n' "$builder_name"
    printf 'verified=%s\n' "$verified"
    printf 'reason=%s\n' "$reason"
    printf 'max_attempts=%s\n' "$MAX_ATTEMPTS"
    printf 'attempt_count=%s\n' "$attempt_count"
    printf 'inspect_timeout_seconds=%s\n' "$INSPECT_TIMEOUT_SECONDS"
    printf 'kill_after_seconds=%s\n' "$KILL_AFTER_SECONDS"
    printf 'retry_delay_seconds=%s\n' "$RETRY_DELAY_SECONDS"
    printf 'total_retry_budget_seconds=%s\n' "$TOTAL_RETRY_BUDGET_SECONDS"
    printf 'last_exit_status=%s\n' "$exit_status"
    printf 'matching_container_count=%s\n' "$container_count"
    printf 'container_state=%s\n' "$container_state"
    printf 'expected_buildkit_version=%s\n' "$expected_version"
    printf 'expected_buildkit_image=%s\n' "$expected_image"
    printf 'last_inspect_stderr_begin\n'
    if [[ -f "$last_stderr_file" ]]; then
      sed -n '1,80p' "$last_stderr_file"
    fi
    printf 'last_inspect_stderr_end\n'
  } > "$temporary_summary"
  mv "$temporary_summary" "$diagnostic_dir/summary.txt"
}

hard_fail() {
  local reason="$1"
  local attempt_count="$2"
  local exit_status="$3"
  local container_count="$4"
  local container_state="$5"
  local last_stderr_file="$6"
  write_summary \
    "$reason" false "$attempt_count" "$exit_status" "$container_count" "$container_state" \
    "$last_stderr_file"
  printf 'TIMEWEB_BUILDKIT_READINESS_FAILED|reason=%s|builder=%s|attempt=%s\n' \
    "$reason" "$builder_name" "$attempt_count" >&2
  exit 1
}

last_exit_status='not_run'
last_container_count='not_checked'
last_container_state='not_checked'
last_stderr_file=''

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
  raw_stdout="$temporary_dir/attempt-$attempt.stdout.raw"
  raw_stderr="$temporary_dir/attempt-$attempt.stderr.raw"
  attempt_stdout="$diagnostic_dir/attempt-$attempt.stdout.txt"
  attempt_stderr="$diagnostic_dir/attempt-$attempt.stderr.txt"
  attempt_status="$diagnostic_dir/attempt-$attempt.status.txt"
  remaining_seconds=$((readiness_deadline_seconds - SECONDS))
  if [[ "$remaining_seconds" -le 0 ]]; then
    hard_fail \
      readiness_budget_exhausted "$((attempt - 1))" "$last_exit_status" \
      "$last_container_count" "$last_container_state" "$last_stderr_file"
  fi
  inspect_timeout_seconds="$INSPECT_TIMEOUT_SECONDS"
  if [[ "$remaining_seconds" -lt "$inspect_timeout_seconds" ]]; then
    inspect_timeout_seconds="$remaining_seconds"
  fi

  set +e
  timeout --signal=TERM --kill-after="${KILL_AFTER_SECONDS}s" "${inspect_timeout_seconds}s" \
    docker buildx inspect "$builder_name" --bootstrap > "$raw_stdout" 2> "$raw_stderr"
  inspect_status=$?
  set -e
  sanitize_file "$raw_stdout" "$attempt_stdout"
  sanitize_file "$raw_stderr" "$attempt_stderr"
  {
    printf 'attempt=%s\n' "$attempt"
    printf 'exit_status=%s\n' "$inspect_status"
  } > "$attempt_status"
  last_exit_status="$inspect_status"
  last_stderr_file="$attempt_stderr"

  observed_versions="$(awk '/^BuildKit version:[[:space:]]+/ {print $3}' "$attempt_stdout")"
  version_count="$(printf '%s\n' "$observed_versions" | awk 'NF {count += 1} END {print count + 0}')"
  observed_version="$(printf '%s\n' "$observed_versions" | awk 'NF {print; exit}')"
  if [[ "$version_count" -gt 1 ]]; then
    hard_fail \
      buildkit_version_ambiguous "$attempt" "$inspect_status" not_checked not_checked \
      "$attempt_stderr"
  fi
  if [[ "$version_count" -eq 1 && "$observed_version" != "$expected_version" ]]; then
    hard_fail \
      buildkit_version_mismatch "$attempt" "$inspect_status" not_checked not_checked \
      "$attempt_stderr"
  fi

  container_stderr_raw="$temporary_dir/attempt-$attempt.container.stderr.raw"
  set +e
  expected_container_name="buildx_buildkit_${builder_name}0"
  remaining_seconds=$((readiness_deadline_seconds - SECONDS))
  if [[ "$remaining_seconds" -le 0 ]]; then
    hard_fail \
      readiness_budget_exhausted "$attempt" "$inspect_status" not_checked not_checked \
      "$attempt_stderr"
  fi
  container_ids="$(
    timeout --signal=TERM --kill-after="${KILL_AFTER_SECONDS}s" "${remaining_seconds}s" \
      docker ps -a \
      --filter "name=buildx_buildkit_$builder_name" \
      --format '{{.ID}}|{{.Names}}' 2> "$container_stderr_raw" \
      | awk -F '|' -v expected="$expected_container_name" '$2 == expected {print $1}'
  )"
  container_ps_status=$?
  set -e
  if [[ "$container_ps_status" -ne 0 ]]; then
    hard_fail \
      container_inventory_failed "$attempt" "$inspect_status" unknown unknown "$attempt_stderr"
  fi
  container_count="$(printf '%s\n' "$container_ids" | awk 'NF {count += 1} END {print count + 0}')"
  last_container_count="$container_count"
  if [[ "$container_count" -gt 1 ]]; then
    hard_fail \
      matching_container_count_mismatch "$attempt" "$inspect_status" "$container_count" unknown \
      "$attempt_stderr"
  fi
  if [[ "$container_count" -eq 0 ]]; then
    last_container_state=unknown
    if [[ "$inspect_status" -eq 0 || "$version_count" -ne 0 ]]; then
      hard_fail \
        matching_container_count_mismatch "$attempt" "$inspect_status" "$container_count" unknown \
        "$attempt_stderr"
    fi
    write_summary \
      bootstrap_container_pending false "$attempt" "$inspect_status" "$container_count" unknown \
      "$attempt_stderr"
    if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
      remaining_seconds=$((readiness_deadline_seconds - SECONDS))
      if [[ "$remaining_seconds" -le "$RETRY_DELAY_SECONDS" ]]; then
        hard_fail \
          readiness_budget_exhausted "$attempt" "$inspect_status" "$container_count" unknown \
          "$attempt_stderr"
      fi
      sleep "$RETRY_DELAY_SECONDS"
      continue
    fi
    break
  fi
  container_id="$(printf '%s\n' "$container_ids" | awk 'NF {print; exit}')"

  remaining_seconds=$((readiness_deadline_seconds - SECONDS))
  if [[ "$remaining_seconds" -le 0 ]]; then
    hard_fail \
      readiness_budget_exhausted "$attempt" "$inspect_status" "$container_count" unknown \
      "$attempt_stderr"
  fi
  set +e
  container_observation="$(
    timeout --signal=TERM --kill-after="${KILL_AFTER_SECONDS}s" "${remaining_seconds}s" \
      docker inspect \
      --format '{{.State.Running}}|{{.State.Status}}|{{.Config.Image}}' \
      "$container_id" 2> "$container_stderr_raw"
  )"
  container_inspect_status=$?
  set -e
  if [[ "$container_inspect_status" -ne 0 ]]; then
    hard_fail \
      container_inspect_failed "$attempt" "$inspect_status" "$container_count" unknown \
      "$attempt_stderr"
  fi
  IFS='|' read -r container_running container_state container_image <<< "$container_observation"
  last_container_state="$container_state"
  printf 'container_id=%s\nrunning=%s\nstate=%s\nimage=%s\n' \
    "$container_id" "$container_running" "$container_state" "$container_image" \
    > "$diagnostic_dir/attempt-$attempt.container.txt"

  if [[ "$container_image" != "$expected_image" ]]; then
    hard_fail \
      buildkit_image_mismatch "$attempt" "$inspect_status" "$container_count" "$container_state" \
      "$attempt_stderr"
  fi
  if [[ "$inspect_status" -ne 0 && "$version_count" -eq 1 ]]; then
    hard_fail \
      inspect_failed_after_metadata "$attempt" "$inspect_status" "$container_count" \
      "$container_state" "$attempt_stderr"
  fi
  if [[ "$inspect_status" -eq 0 && "$version_count" -eq 0 ]]; then
    hard_fail \
      inspect_succeeded_without_version "$attempt" "$inspect_status" "$container_count" \
      "$container_state" "$attempt_stderr"
  fi
  if [[ "$inspect_status" -eq 0 && "$version_count" -eq 1 ]]; then
    if [[ "$container_running" != true || "$container_state" != running ]]; then
      hard_fail \
        container_not_running "$attempt" "$inspect_status" "$container_count" "$container_state" \
        "$attempt_stderr"
    fi
    write_summary \
      verified true "$attempt" "$inspect_status" "$container_count" "$container_state" \
      "$attempt_stderr"
    printf 'TIMEWEB_BUILDKIT_READINESS_PASSED|builder=%s|attempt=%s\n' \
      "$builder_name" "$attempt"
    exit 0
  fi

  case "$container_state" in
    created | restarting | running) ;;
    *)
      hard_fail \
        container_not_starting "$attempt" "$inspect_status" "$container_count" \
        "$container_state" "$attempt_stderr"
      ;;
  esac

  write_summary \
    bootstrap_retrying false "$attempt" "$inspect_status" "$container_count" "$container_state" \
    "$attempt_stderr"
  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    remaining_seconds=$((readiness_deadline_seconds - SECONDS))
    if [[ "$remaining_seconds" -le "$RETRY_DELAY_SECONDS" ]]; then
      hard_fail \
        readiness_budget_exhausted "$attempt" "$inspect_status" "$container_count" \
        "$container_state" "$attempt_stderr"
    fi
    sleep "$RETRY_DELAY_SECONDS"
  fi
done

hard_fail \
  buildkit_readiness_exhausted "$MAX_ATTEMPTS" "$last_exit_status" "$last_container_count" \
  "$last_container_state" "$last_stderr_file"
