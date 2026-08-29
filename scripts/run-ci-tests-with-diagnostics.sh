#!/usr/bin/env bash

set -uo pipefail

readonly diagnostics_dir="${CI_TEST_DIAGNOSTICS_DIR:-.ci-artifacts/test-and-coverage}"
readonly stdout_log="$diagnostics_dir/stdout.log"
readonly stderr_log="$diagnostics_dir/stderr.log"
readonly resource_log="$diagnostics_dir/resource-samples.log"
readonly watchdog_log="$diagnostics_dir/watchdog-events.log"
readonly test_pid_file="$diagnostics_dir/test.pid"
readonly helper_pid_file="$diagnostics_dir/helper-pids.txt"
readonly status_file="$diagnostics_dir/status.txt"
readonly monitor_ready_file="$diagnostics_dir/monitor.ready"
readonly watchdog_ready_file="$diagnostics_dir/watchdog.ready"
readonly watchdog_failure_file="$diagnostics_dir/watchdog-failure.txt"
readonly watchdog_completed_file="$diagnostics_dir/watchdog-completed.txt"
readonly watchdog_stop_file="$diagnostics_dir/watchdog-stop-requested"
readonly watchdog_stopped_file="$diagnostics_dir/watchdog-stopped.txt"
readonly heartbeat_seconds="${CI_TEST_HEARTBEAT_SECONDS:-15}"
readonly watchdog_seconds="${CI_TEST_WATCHDOG_SECONDS:-480}"
readonly kill_after_seconds="${CI_TEST_KILL_AFTER_SECONDS:-30}"
readonly external_kill_after_seconds="${CI_TEST_EXTERNAL_KILL_AFTER_SECONDS:-2}"
readonly helper_shutdown_seconds="${CI_TEST_HELPER_SHUTDOWN_SECONDS:-2}"
readonly process_group_probe_timeout="${CI_TEST_PROCESS_GROUP_PROBE_TIMEOUT:-1s}"
readonly process_group_probe_command="${CI_TEST_PROCESS_GROUP_PROBE_COMMAND:-}"
readonly final_snapshot_timeout="${CI_TEST_FINAL_SNAPSHOT_TIMEOUT:-5s}"
readonly final_snapshot_command="${CI_TEST_FINAL_SNAPSHOT_COMMAND:-}"
readonly output_redaction_timeout="${CI_TEST_OUTPUT_REDACTION_TIMEOUT:-10s}"
readonly output_redaction_command="${CI_TEST_OUTPUT_REDACTION_COMMAND:-}"
readonly residual_process_group_status=125
readonly supervisor_cleanup_status=126

mkdir -p "$diagnostics_dir"
: >"$stdout_log"
: >"$stderr_log"
: >"$resource_log"
: >"$watchdog_log"
rm -f \
  "$monitor_ready_file" \
  "$watchdog_ready_file" \
  "$watchdog_failure_file" \
  "$watchdog_completed_file" \
  "$watchdog_stop_file" \
  "$watchdog_stopped_file"
export CI_TEST_DIAGNOSTICS_DIR="$diagnostics_dir"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date +%s)"
test_pid=''
test_pgid=''
monitor_pid=''
watchdog_pid=''
launcher_pid=''
finalized=0
registration_in_progress=0
pending_signal_name=''
pending_signal_status=''
final_status=''
cleanup_failure_phase=''

log_watchdog_event() {
  local event_line
  printf -v event_line 'timestamp=%s %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
  printf '%s\n' "$event_line" >>"$watchdog_log"
  printf '%s\n' "$event_line"
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

helper_group_has_live_processes() {
  local helper_pgid="$1"
  timeout --signal=KILL "$process_group_probe_timeout" \
    bash -c 'ps -eo pgid=,stat= | awk -v pgid="$1" '\''$1 == pgid && $2 !~ /^Z/ { found = 1 } END { exit(found ? 0 : 1) }'\''' \
    bash "$helper_pgid" >/dev/null 2>&1
}

helper_pid_is_running() {
  local helper_pid="$1"
  local process_pid
  local process_name
  local process_state

  if [[ ! -r "/proc/$helper_pid/stat" ]]; then
    return 1
  fi
  read -r process_pid process_name process_state _rest <"/proc/$helper_pid/stat" || return 1
  [[ "$process_state" != Z && "$process_state" != X ]]
}

stop_helper() {
  local helper_pid="$1"
  local helper_name=monitor
  local deadline
  local forced_kill=false
  local probe_status

  if [[ -z "$helper_pid" ]]; then
    return
  fi
  if [[ "$helper_pid" == "$watchdog_pid" ]]; then
    helper_name=watchdog
    : >"$watchdog_stop_file"
  fi

  log_watchdog_event "reason=finalization_phase phase=${helper_name}_shutdown state=started target_pgid=$helper_pid"
  kill -TERM -- "-$helper_pid" 2>/dev/null || true
  deadline=$((SECONDS + helper_shutdown_seconds))
  while helper_pid_is_running "$helper_pid"; do
    if [[ "$SECONDS" -ge "$deadline" ]]; then
      forced_kill=true
      log_watchdog_event "reason=finalization_budget_exceeded phase=${helper_name}_shutdown action=SIGKILL target_pgid=$helper_pid"
      kill -KILL -- "-$helper_pid" 2>/dev/null || true
      break
    fi
    sleep 0.05
  done

  wait "$helper_pid" 2>/dev/null || true
  if [[ "$helper_name" == watchdog && "$forced_kill" == false && \
    ! -s "$watchdog_completed_file" && ! -s "$watchdog_failure_file" && \
    ! -s "$watchdog_stopped_file" ]]; then
    cleanup_failure_phase='watchdog_unexpected_exit'
    log_watchdog_event "reason=supervisor_cleanup_failure phase=$cleanup_failure_phase target_pgid=$helper_pid"
  fi
  helper_group_has_live_processes "$helper_pid"
  probe_status=$?
  if [[ "$probe_status" -eq 0 ]]; then
    forced_kill=true
    log_watchdog_event "reason=finalization_budget_exceeded phase=${helper_name}_shutdown action=SIGKILL target_pgid=$helper_pid residual_group=true"
    kill -KILL -- "-$helper_pid" 2>/dev/null || true
    helper_group_has_live_processes "$helper_pid"
    probe_status=$?
  fi
  if [[ "$probe_status" -gt 1 ]]; then
    kill -KILL -- "-$helper_pid" 2>/dev/null || true
  fi
  if [[ "$probe_status" -eq 0 || "$probe_status" -gt 1 ]]; then
    cleanup_failure_phase="${helper_name}_shutdown"
    log_watchdog_event "reason=supervisor_cleanup_failure phase=$cleanup_failure_phase target_pgid=$helper_pid"
    return 1
  fi
  log_watchdog_event "reason=finalization_phase phase=${helper_name}_shutdown state=completed forced_kill=$forced_kill"
}

process_group_alive() {
  local probe_status

  if [[ -z "$test_pgid" ]]; then
    return 1
  fi
  if [[ -n "$process_group_probe_command" ]]; then
    timeout --signal=KILL "$process_group_probe_timeout" \
      "$process_group_probe_command" "$test_pgid" >/dev/null 2>&1
  else
    helper_group_has_live_processes "$test_pgid"
  fi
  probe_status=$?
  case "$probe_status" in
    0 | 1) return "$probe_status" ;;
    124 | 137)
      log_watchdog_event "reason=finalization_budget_exceeded phase=process_group_probe target_pgid=$test_pgid probe_status=$probe_status"
      ;;
    *)
      log_watchdog_event "reason=supervisor_probe_failure phase=process_group_probe target_pgid=$test_pgid probe_status=$probe_status"
      ;;
  esac
  return 2
}

terminate_test_group() {
  local probe_status

  process_group_alive
  probe_status=$?
  if [[ "$probe_status" -eq 2 ]]; then
    cleanup_failure_phase='process_group_probe'
    kill -KILL -- "-$test_pgid" 2>/dev/null || true
    if [[ -n "$launcher_pid" ]]; then
      wait "$launcher_pid" 2>/dev/null || true
    fi
    return 1
  fi
  if [[ "$probe_status" -eq 0 ]]; then
    kill -TERM -- "-$test_pgid" 2>/dev/null || true
    sleep "$external_kill_after_seconds"
    process_group_alive
    probe_status=$?
    if [[ "$probe_status" -eq 2 ]]; then
      cleanup_failure_phase='process_group_probe'
      kill -KILL -- "-$test_pgid" 2>/dev/null || true
      if [[ -n "$launcher_pid" ]]; then
        wait "$launcher_pid" 2>/dev/null || true
      fi
      return 1
    fi
    if [[ "$probe_status" -eq 0 ]]; then
      kill -KILL -- "-$test_pgid" 2>/dev/null || true
    fi
  fi
  if [[ -n "$launcher_pid" ]]; then
    wait "$launcher_pid" 2>/dev/null || true
  fi
  process_group_alive
  probe_status=$?
  if [[ "$probe_status" -eq 0 || "$probe_status" -eq 2 ]]; then
    cleanup_failure_phase='test_process_group_shutdown'
    kill -KILL -- "-$test_pgid" 2>/dev/null || true
    return 1
  fi
}

write_status_file() {
  local status="$1"
  local child_status="$2"
  local termination_reason="$3"
  local finalization_state="$4"
  local ended_at
  local ended_epoch
  local temporary_status_file="$status_file.tmp.$$"

  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ended_epoch="$(date +%s)"
  {
    printf 'started_at=%s\n' "$started_at"
    printf 'ended_at=%s\n' "$ended_at"
    printf 'duration_seconds=%s\n' "$((ended_epoch - started_epoch))"
    printf 'test_pid=%s\n' "${test_pid:-unavailable}"
    printf 'test_pgid=%s\n' "${test_pgid:-unavailable}"
    printf 'child_exit_status=%s\n' "$child_status"
    printf 'exit_status=%s\n' "$status"
    printf 'termination=%s\n' "$termination_reason"
    printf 'finalization=%s\n' "$finalization_state"
    printf 'cleanup_failure_phase=%s\n' "${cleanup_failure_phase:-none}"
  } >"$temporary_status_file"
  mv "$temporary_status_file" "$status_file"
}

capture_final_snapshot() {
  if [[ -n "$final_snapshot_command" ]]; then
    timeout --signal=TERM --kill-after=1s "$final_snapshot_timeout" \
      "$final_snapshot_command" </dev/null >/dev/null 2>&1
  else
    timeout --signal=TERM --kill-after=1s "$final_snapshot_timeout" \
      bash -c 'capture_snapshot final' </dev/null >/dev/null 2>&1
  fi
}

redact_output_logs() {
  local redaction_status

  if [[ -n "$output_redaction_command" ]]; then
    timeout --signal=KILL "$output_redaction_timeout" \
      "$output_redaction_command" "$stdout_log" "$stderr_log"
    redaction_status=$?
  else
    timeout --signal=KILL "$output_redaction_timeout" node --input-type=commonjs - "$stdout_log" "$stderr_log" <<'NODE'
const { readFileSync, renameSync, writeFileSync } = require('node:fs');

const sensitiveName = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASS|KEY|AUTHORIZATION|COOKIE)(?:_|$)/iu;
const credentialLocationName = /(?:^|_)(?:(?:DATABASE|REDIS|RABBITMQ|AMQP|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB)_URL|DSN|URI|CONNECTION_STRING|CREDENTIALS)(?:_|$)/iu;
const sensitiveValues = Object.entries(process.env)
  .filter(
    ([name, value]) =>
      (sensitiveName.test(name) || credentialLocationName.test(name)) &&
      typeof value === 'string' &&
      value.length >= 4,
  )
  .map(([, value]) => value)
  .sort((left, right) => right.length - left.length);

for (const file of process.argv.slice(2)) {
  let contents = readFileSync(file, 'utf8');
  for (const value of sensitiveValues) contents = contents.replaceAll(value, '[REDACTED]');
  const temporary = `${file}.redacted.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}
NODE
    redaction_status=$?
  fi
  if [[ "$redaction_status" -ne 0 ]]; then
    cleanup_failure_phase='output_redaction'
    printf '%s\n' '[diagnostic output suppressed because redaction failed]' >"$stdout_log"
    printf '%s\n' '[diagnostic output suppressed because redaction failed]' >"$stderr_log"
    log_watchdog_event "reason=supervisor_cleanup_failure phase=$cleanup_failure_phase"
    return 1
  fi
}

write_final_evidence() {
  local status="$1"
  local child_status="$2"
  local termination_reason="$3"

  capture_final_snapshot
  if [[ "$?" -ne 0 ]]; then
    cleanup_failure_phase='final_resource_snapshot'
    log_watchdog_event "reason=finalization_budget_exceeded phase=$cleanup_failure_phase"
  fi

  if command -v dmesg >/dev/null 2>&1; then
    timeout --signal=KILL 2s bash -c \
      'dmesg --color=never 2>&1 | grep -Eai '\''oom|out of memory|killed process'\'' | tail -n 100' \
      >"$diagnostics_dir/kernel-oom-evidence.log" || true
  fi

  if [[ -n "$cleanup_failure_phase" ]]; then
    final_status="$supervisor_cleanup_status"
    termination_reason='supervisor_cleanup_failure'
  else
    final_status="$status"
  fi
  write_status_file "$final_status" "$child_status" "$termination_reason" complete
}

finalize() {
  local status="$1"
  local termination_reason="$2"
  local terminate_group="${3:-false}"
  local captured_child_status="${child_status:-$status}"

  if [[ "$finalized" -eq 1 ]]; then
    return
  fi
  finalized=1
  trap - TERM INT
  write_status_file "$status" "$captured_child_status" "$termination_reason" child_exit_captured
  log_watchdog_event "reason=finalization_phase phase=child_exit_captured child_status=$captured_child_status effective_status=$status"
  stop_helper "$watchdog_pid" || true
  stop_helper "$monitor_pid" || true
  if [[ "$terminate_group" == true ]]; then
    terminate_test_group || true
  fi
  if [[ -s "$watchdog_failure_file" ]]; then
    read -r cleanup_failure_phase <"$watchdog_failure_file"
  fi
  redact_output_logs || true
  write_final_evidence "$status" "$captured_child_status" "$termination_reason"
}

terminate_for_external_signal() {
  local signal_name="$1"
  local status="$2"
  if [[ "$registration_in_progress" -eq 1 ]]; then
    pending_signal_name="$signal_name"
    pending_signal_status="$status"
    return
  fi
  log_watchdog_event "reason=external_termination signal=$signal_name target_pgid=${test_pgid:-unavailable}"
  finalize "$status" "external_signal_$signal_name" true
  exit "$final_status"
}

handle_pending_external_signal() {
  if [[ -n "$pending_signal_name" ]]; then
    terminate_for_external_signal "$pending_signal_name" "$pending_signal_status"
  fi
}

wait_for_helper_ready() {
  local helper_name="$1"
  local helper_pid="$2"
  local ready_file="$3"
  local ready_pid=''

  for _attempt in {1..100}; do
    if [[ -s "$ready_file" ]]; then
      read -r ready_pid <"$ready_file"
      if [[ "$ready_pid" == "$helper_pid" ]]; then
        return
      fi
    fi
    if ! kill -0 "$helper_pid" 2>/dev/null; then
      break
    fi
    sleep 0.02
  done
  cleanup_failure_phase="${helper_name}_startup"
  log_watchdog_event "reason=supervisor_cleanup_failure phase=$cleanup_failure_phase target_pid=$helper_pid"
  return 1
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

export diagnostics_dir resource_log watchdog_log watchdog_failure_file watchdog_completed_file
export watchdog_stop_file watchdog_stopped_file test_pid test_pgid launcher_pid
export heartbeat_seconds watchdog_seconds kill_after_seconds
export process_group_probe_timeout process_group_probe_command
export -f capture_snapshot helper_group_has_live_processes helper_pid_is_running read_cgroup_metric
export -f log_watchdog_event process_group_alive

registration_in_progress=1
setsid bash -c 'printf "%s\n" "$$" >"$1"; shift; exec "$@"' bash "$test_pid_file" \
  "${test_command[@]}" \
  >"$stdout_log" \
  2>"$stderr_log" &
launcher_pid=$!
test_pgid="$launcher_pid"
registration_in_progress=0
handle_pending_external_signal

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

registration_in_progress=1
setsid bash -c '
  if [[ "${CI_TEST_MONITOR_IGNORE_TERM:-false}" == true ]]; then
    trap "" TERM
  else
    trap "exit 0" TERM INT
  fi
  printf "%s\n" "$$" >"$1"
  shift
  if [[ -n "${CI_TEST_MONITOR_HELPER_COMMAND:-}" ]]; then
    exec "$CI_TEST_MONITOR_HELPER_COMMAND"
  fi
  while kill -0 "$launcher_pid" 2>/dev/null; do
    capture_snapshot running
    sleep "$heartbeat_seconds"
  done
' bash "$monitor_ready_file" </dev/null >>"$resource_log" 2>&1 &
monitor_pid=$!
wait_for_helper_ready monitor "$monitor_pid" "$monitor_ready_file" || true
registration_in_progress=0
handle_pending_external_signal

registration_in_progress=1
setsid bash -c '
  watchdog_exit_guard() {
    local watchdog_exit_status=$?
    if [[ -e "$watchdog_stop_file" ]]; then
      if [[ "${CI_TEST_WATCHDOG_FAILURE_ON_STOP:-false}" == true ]]; then
        printf "%s\n" watchdog_failure_on_stop >"$watchdog_failure_file.tmp.$$"
        mv "$watchdog_failure_file.tmp.$$" "$watchdog_failure_file"
        log_watchdog_event "reason=supervisor_cleanup_failure phase=watchdog_failure_on_stop exit_status=$watchdog_exit_status target_pgid=$test_pgid"
      else
        printf "%s\n" stopped >"$watchdog_stopped_file.tmp.$$"
        mv "$watchdog_stopped_file.tmp.$$" "$watchdog_stopped_file"
      fi
      return
    fi
    if [[ -s "$watchdog_completed_file" || -s "$watchdog_failure_file" ]]; then
      return
    fi
    printf "%s\n" watchdog_unexpected_exit >"$watchdog_failure_file.tmp.$$"
    mv "$watchdog_failure_file.tmp.$$" "$watchdog_failure_file"
    log_watchdog_event "reason=supervisor_cleanup_failure phase=watchdog_unexpected_exit action=SIGKILL exit_status=$watchdog_exit_status target_pgid=$test_pgid"
    kill -KILL -- "-$test_pgid" 2>/dev/null || true
  }
  trap watchdog_exit_guard EXIT
  if [[ "${CI_TEST_WATCHDOG_IGNORE_TERM:-false}" == true ]]; then
    trap "" TERM
  else
    trap "if [[ \"${CI_TEST_WATCHDOG_SIGKILL_ON_STOP:-false}\" == true ]]; then kill -KILL \"$$\"; else exit 0; fi" TERM INT
  fi
  if [[ "${CI_TEST_WATCHDOG_EXIT_BEFORE_READY:-false}" == true ]]; then
    exit 23
  fi
  printf "%s\n" "$$" >"$1"
  shift
  if [[ "${CI_TEST_WATCHDOG_EXIT_AFTER_READY:-false}" == true ]]; then
    exit 24
  fi
  if [[ "${CI_TEST_WATCHDOG_SIGKILL_AFTER_READY:-false}" == true ]]; then
    kill -KILL "$$"
  fi
  if [[ -n "${CI_TEST_WATCHDOG_HELPER_COMMAND:-}" ]]; then
    exec "$CI_TEST_WATCHDOG_HELPER_COMMAND"
  fi
  sleep "$watchdog_seconds"
  process_group_alive
  probe_status=$?
  if [[ "$probe_status" -eq 2 ]]; then
    printf "%s\n" watchdog_process_group_probe >"$watchdog_failure_file.tmp.$$"
    mv "$watchdog_failure_file.tmp.$$" "$watchdog_failure_file"
    log_watchdog_event "reason=supervisor_cleanup_failure phase=watchdog_process_group_probe action=SIGKILL target_pgid=$test_pgid"
    kill -KILL -- "-$test_pgid" 2>/dev/null || true
  elif [[ "$probe_status" -eq 0 ]]; then
    log_watchdog_event "reason=watchdog_deadline signal=USR1 target_pid=${test_pid:-unavailable} target_pgid=$test_pgid"
    if [[ -n "$test_pid" ]] && kill -0 "$test_pid" 2>/dev/null; then
      kill -USR1 "$test_pid" 2>/dev/null || true
    fi
    sleep "$kill_after_seconds"
    process_group_alive
    probe_status=$?
    if [[ "$probe_status" -eq 2 ]]; then
      printf "%s\n" watchdog_process_group_probe >"$watchdog_failure_file.tmp.$$"
      mv "$watchdog_failure_file.tmp.$$" "$watchdog_failure_file"
      log_watchdog_event "reason=supervisor_cleanup_failure phase=watchdog_process_group_probe action=SIGKILL target_pgid=$test_pgid"
      kill -KILL -- "-$test_pgid" 2>/dev/null || true
    elif [[ "$probe_status" -eq 0 ]]; then
      log_watchdog_event "reason=watchdog_grace_expired signal=KILL target_pgid=$test_pgid"
      kill -KILL -- "-$test_pgid" 2>/dev/null || true
    fi
  fi
  if [[ ! -s "$watchdog_failure_file" ]]; then
    printf "%s\n" completed >"$watchdog_completed_file.tmp.$$"
    mv "$watchdog_completed_file.tmp.$$" "$watchdog_completed_file"
  fi
' bash "$watchdog_ready_file" </dev/null >/dev/null 2>&1 &
watchdog_pid=$!
if ! wait_for_helper_ready watchdog "$watchdog_pid" "$watchdog_ready_file"; then
  kill -KILL -- "-$test_pgid" 2>/dev/null || true
fi
registration_in_progress=0
handle_pending_external_signal
{
  printf 'monitor_pid=%s\n' "$monitor_pid"
  printf 'watchdog_pid=%s\n' "$watchdog_pid"
} >"$helper_pid_file.tmp.$$"
mv "$helper_pid_file.tmp.$$" "$helper_pid_file"

first_completed_pid=''
while helper_pid_is_running "$launcher_pid" && helper_pid_is_running "$watchdog_pid"; do
  sleep 0.05
done
if ! helper_pid_is_running "$watchdog_pid"; then
  first_completed_pid="$watchdog_pid"
  wait "$watchdog_pid" 2>/dev/null
  first_completed_status=$?
else
  first_completed_pid="$launcher_pid"
  wait "$launcher_pid" 2>/dev/null
  first_completed_status=$?
fi
if [[ "$first_completed_pid" == "$watchdog_pid" ]]; then
  if [[ ! -s "$watchdog_completed_file" && ! -s "$watchdog_failure_file" ]]; then
    printf '%s\n' watchdog_unexpected_exit >"$watchdog_failure_file.tmp.$$"
    mv "$watchdog_failure_file.tmp.$$" "$watchdog_failure_file"
    log_watchdog_event "reason=supervisor_cleanup_failure phase=watchdog_unexpected_exit action=SIGKILL target_pgid=$test_pgid"
  fi
  if [[ -s "$watchdog_failure_file" ]]; then
    kill -KILL -- "-$test_pgid" 2>/dev/null || true
  fi
  wait "$launcher_pid" 2>/dev/null
  child_status=$?
else
  child_status="$first_completed_status"
fi
test_status="$child_status"
write_status_file "$test_status" "$child_status" pending_finalization child_exit_captured
log_watchdog_event "reason=finalization_phase phase=child_exit_captured child_status=$child_status"
residual_process_group=false
if [[ -s "$watchdog_failure_file" ]]; then
  read -r cleanup_failure_phase <"$watchdog_failure_file"
fi
process_group_alive
process_group_probe_status=$?
if [[ "$process_group_probe_status" -eq 2 ]]; then
  cleanup_failure_phase='process_group_probe'
  kill -KILL -- "-$test_pgid" 2>/dev/null || true
elif [[ "$process_group_probe_status" -eq 0 ]]; then
  residual_process_group=true
  log_watchdog_event "reason=residual_process_group_after_leader_exit target_pgid=$test_pgid leader_status=$child_status"
  terminate_test_group || true
fi
if [[ -n "$cleanup_failure_phase" ]]; then
  test_status="$supervisor_cleanup_status"
  termination_reason='supervisor_cleanup_failure'
elif [[ "$child_status" -eq 0 && "$residual_process_group" == true ]]; then
  test_status="$residual_process_group_status"
  termination_reason='residual_process_group_after_success'
elif [[ "$child_status" -ne 0 && "$residual_process_group" == true ]]; then
  test_status="$supervisor_cleanup_status"
  cleanup_failure_phase='residual_process_group_after_nonzero_exit'
  termination_reason='supervisor_cleanup_failure'
elif [[ "$child_status" -eq 137 ]] && grep -q 'reason=watchdog_grace_expired' "$watchdog_log"; then
  termination_reason='watchdog_sigkill'
elif [[ "$child_status" -ge 128 ]]; then
  termination_reason="signal_$((child_status - 128))"
else
  termination_reason='normal_exit'
fi
finalize "$test_status" "$termination_reason"
cat "$stdout_log"
cat "$stderr_log" >&2

exit "$final_status"
