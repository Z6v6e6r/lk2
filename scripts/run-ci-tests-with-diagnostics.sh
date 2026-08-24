#!/usr/bin/env bash

set -uo pipefail

readonly diagnostics_dir="${CI_TEST_DIAGNOSTICS_DIR:-.ci-artifacts/test-and-coverage}"
readonly stdout_log="$diagnostics_dir/stdout.log"
readonly stderr_log="$diagnostics_dir/stderr.log"
readonly resource_log="$diagnostics_dir/resource-samples.log"
readonly watchdog_log="$diagnostics_dir/watchdog-events.log"
readonly test_pid_file="$diagnostics_dir/test.pid"
readonly helper_pid_file="$diagnostics_dir/helper-pids.txt"
readonly heartbeat_seconds="${CI_TEST_HEARTBEAT_SECONDS:-15}"
readonly watchdog_seconds="${CI_TEST_WATCHDOG_SECONDS:-480}"
readonly kill_after_seconds="${CI_TEST_KILL_AFTER_SECONDS:-30}"
readonly external_kill_after_seconds="${CI_TEST_EXTERNAL_KILL_AFTER_SECONDS:-2}"

mkdir -p "$diagnostics_dir"
: >"$stdout_log"
: >"$stderr_log"
: >"$resource_log"
: >"$watchdog_log"
export CI_TEST_DIAGNOSTICS_DIR="$diagnostics_dir"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date +%s)"
test_pid=''
test_pgid=''
monitor_pid=''
watchdog_pid=''
launcher_pid=''
finalized=0

log_watchdog_event() {
  printf 'timestamp=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$watchdog_log"
}

read_cgroup_metric() {
  local metric="$1"
  local cgroup_path=''
  local metric_path=''
  if [[ -n "$test_pid" && -r "/proc/$test_pid/cgroup" ]]; then
    cgroup_path="$(awk -F: '$1 == "0" { print $3; exit }' "/proc/$test_pid/cgroup")"
  fi
  metric_path="/sys/fs/cgroup${cgroup_path}/${metric}"
  if [[ -r "$metric_path" ]]; then
    tr '\n' ';' <"$metric_path"
  else
    printf 'unavailable'
  fi
}

capture_snapshot() {
  local phase="$1"
  local timestamp
  local main_rss_kib='unavailable'
  local main_vsz_kib='unavailable'
  local group_rss_kib='unavailable'
  local process_count='unavailable'
  local active_suites='[]'
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ -n "$test_pid" ]] && kill -0 "$test_pid" 2>/dev/null; then
    main_rss_kib="$(ps -o rss= -p "$test_pid" 2>/dev/null | awk '{ print $1 }')"
    main_vsz_kib="$(ps -o vsz= -p "$test_pid" 2>/dev/null | awk '{ print $1 }')"
    group_rss_kib="$(ps -eo pgid=,rss= 2>/dev/null | awk -v pgid="$test_pgid" '$1 == pgid { total += $2 } END { print total + 0 }')"
  fi
  process_count="$(ps -e --no-headers 2>/dev/null | wc -l | awk '{ print $1 }')"
  if [[ -r "$diagnostics_dir/active-suites.json" ]]; then
    active_suites="$(tr -d '\n' <"$diagnostics_dir/active-suites.json" | cut -c1-1000)"
  fi

  printf 'heartbeat timestamp=%s phase=%s test_pid=%s main_rss_kib=%s group_rss_kib=%s memory_current=%s active_suites=%s\n' \
    "$timestamp" "$phase" "${test_pid:-unavailable}" "${main_rss_kib:-unavailable}" \
    "${group_rss_kib:-unavailable}" "$(read_cgroup_metric memory.current)" "$active_suites"

  {
    printf '\n=== snapshot timestamp=%s phase=%s ===\n' "$timestamp" "$phase"
    printf 'test_pid=%s test_pgid=%s process_count=%s main_rss_kib=%s main_vsz_kib=%s group_rss_kib=%s\n' \
      "${test_pid:-unavailable}" "${test_pgid:-unavailable}" "$process_count" \
      "${main_rss_kib:-unavailable}" "${main_vsz_kib:-unavailable}" \
      "${group_rss_kib:-unavailable}"
    printf 'active_suites=%s\n' "$active_suites"
    printf 'memory.current=%s\n' "$(read_cgroup_metric memory.current)"
    printf 'memory.max=%s\n' "$(read_cgroup_metric memory.max)"
    printf 'memory.peak=%s\n' "$(read_cgroup_metric memory.peak)"
    printf 'memory.events=%s\n' "$(read_cgroup_metric memory.events)"
    printf 'load_average='; uptime || true
    printf 'cpu_count='; nproc || true
    free -b || true
    df -h . || true
    df -i . || true
    if [[ -n "$test_pgid" ]]; then
      ps -eo pid,ppid,pgid,stat,pcpu,pmem,rss,vsz,etime,comm --forest \
        | awk -v pgid="$test_pgid" 'NR == 1 || $3 == pgid' || true
    fi
  } >>"$resource_log" 2>&1
}

stop_helper() {
  local helper_pid="$1"
  if [[ -n "$helper_pid" ]]; then
    kill "$helper_pid" 2>/dev/null || true
    wait "$helper_pid" 2>/dev/null || true
  fi
}

terminate_test_group() {
  local live_pid="${test_pid:-$launcher_pid}"
  if [[ -n "$test_pgid" && -n "$live_pid" ]] && kill -0 "$live_pid" 2>/dev/null; then
    kill -TERM -- "-$test_pgid" 2>/dev/null || true
    sleep "$external_kill_after_seconds"
    if kill -0 "$live_pid" 2>/dev/null; then
      kill -KILL -- "-$test_pgid" 2>/dev/null || true
    fi
  fi
  if [[ -n "$launcher_pid" ]]; then
    wait "$launcher_pid" 2>/dev/null || true
  fi
}

write_final_evidence() {
  local status="$1"
  local termination_reason="$2"
  local ended_at
  local ended_epoch

  capture_snapshot final
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ended_epoch="$(date +%s)"
  {
    printf 'started_at=%s\n' "$started_at"
    printf 'ended_at=%s\n' "$ended_at"
    printf 'duration_seconds=%s\n' "$((ended_epoch - started_epoch))"
    printf 'test_pid=%s\n' "${test_pid:-unavailable}"
    printf 'test_pgid=%s\n' "${test_pgid:-unavailable}"
    printf 'exit_status=%s\n' "$status"
    printf 'termination=%s\n' "$termination_reason"
  } >"$diagnostics_dir/status.txt"

  if command -v dmesg >/dev/null 2>&1; then
    dmesg --color=never 2>&1 | grep -Eai 'oom|out of memory|killed process' | tail -n 100 \
      >"$diagnostics_dir/kernel-oom-evidence.log" || true
  fi
}

finalize() {
  local status="$1"
  local termination_reason="$2"
  local terminate_group="${3:-false}"

  if [[ "$finalized" -eq 1 ]]; then
    return
  fi
  finalized=1
  trap - TERM INT
  stop_helper "$watchdog_pid"
  stop_helper "$monitor_pid"
  if [[ "$terminate_group" == true ]]; then
    terminate_test_group
  fi
  write_final_evidence "$status" "$termination_reason"
}

terminate_for_external_signal() {
  local signal_name="$1"
  local status="$2"
  log_watchdog_event "reason=external_termination signal=$signal_name target_pgid=${test_pgid:-unavailable}"
  finalize "$status" "external_signal_$signal_name" true
  exit "$status"
}

trap 'terminate_for_external_signal TERM 143' TERM
trap 'terminate_for_external_signal INT 130' INT

{
  printf 'started_at=%s\n' "$started_at"
  printf 'runner_os=%s\n' "${RUNNER_OS:-unknown}"
  printf 'runner_arch=%s\n' "${RUNNER_ARCH:-unknown}"
  printf 'runner_image_os=%s\n' "${ImageOS:-unknown}"
  printf 'runner_image_version=%s\n' "${ImageVersion:-unknown}"
  printf 'node_version=%s\n' "$(node --version)"
  printf 'npm_version=%s\n' "$(npm --version)"
  printf 'npm_cache=%s\n' "$(npm config get cache)"
  uname -a
  lscpu || true
} >"$diagnostics_dir/runtime.txt" 2>&1

capture_snapshot preflight

test_command=(
  node --require why-is-node-running/include ./node_modules/vitest/vitest.mjs run
  --coverage
  --reporter=default
  --reporter=hanging-process
  --reporter=junit
  --reporter=./scripts/vitest-ci-diagnostics-reporter.ts
  --outputFile.junit="$diagnostics_dir/junit.xml"
)
if [[ "$#" -gt 0 ]]; then
  test_command=("$@")
fi

setsid bash -c 'printf "%s\n" "$$" >"$1"; shift; exec "$@"' bash "$test_pid_file" \
  "${test_command[@]}" \
  > >(tee -a "$stdout_log") \
  2> >(tee -a "$stderr_log" >&2) &
launcher_pid=$!
test_pgid="$launcher_pid"

for _attempt in {1..100}; do
  if [[ -s "$test_pid_file" ]]; then
    read -r test_pid <"$test_pid_file"
    break
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

log_watchdog_event "reason=started launcher_pid=$launcher_pid test_pid=${test_pid:-unavailable} test_pgid=${test_pgid:-unavailable}"

(
  while kill -0 "$launcher_pid" 2>/dev/null; do
    capture_snapshot running
    sleep "$heartbeat_seconds"
  done
) &
monitor_pid=$!

(
  sleep "$watchdog_seconds"
  if kill -0 "$test_pid" 2>/dev/null; then
    log_watchdog_event "reason=watchdog_deadline signal=USR1 target_pid=$test_pid"
    kill -USR1 "$test_pid" 2>/dev/null || true
    sleep "$kill_after_seconds"
    if kill -0 "$test_pid" 2>/dev/null; then
      log_watchdog_event "reason=watchdog_grace_expired signal=KILL target_pgid=$test_pgid"
      kill -KILL -- "-$test_pgid" 2>/dev/null || true
    fi
  fi
) &
watchdog_pid=$!
{
  printf 'monitor_pid=%s\n' "$monitor_pid"
  printf 'watchdog_pid=%s\n' "$watchdog_pid"
} >"$helper_pid_file"

wait "$launcher_pid"
test_status=$?
if [[ "$test_status" -eq 137 ]] && grep -q 'reason=watchdog_grace_expired' "$watchdog_log"; then
  termination_reason='watchdog_sigkill'
elif [[ "$test_status" -ge 128 ]]; then
  termination_reason="signal_$((test_status - 128))"
else
  termination_reason='normal_exit'
fi
finalize "$test_status" "$termination_reason"

exit "$test_status"
