#!/bin/sh
set -eu

fail() {
  printf '%s\n' "otp_runtime_image_probe status=failed class=$1" >&2
  exit 1
}

test "$#" -eq 2 || fail invalid-arguments
service=$1
image_ref=$2

case "$service" in
  api | worker | realtime | migrator) ;;
  *) fail unsupported-application ;;
esac

prefix="ghcr.io/z6v6e6r/phub-$service@sha256:"
case "$image_ref" in
  "$prefix"*) ;;
  *) fail invalid-image-reference ;;
esac
digest=${image_ref#"$prefix"}
test "${#digest}" -eq 64 || fail invalid-image-reference
case "$digest" in *[!0-9a-f]*) fail invalid-image-reference ;; esac

probe_name="phub-otp-runtime-probe-$service-$$"
probe_class=unclassified

cleanup_probe() {
  remove_probe >/dev/null 2>&1 || :
}

bounded_docker() {
  limit=$1
  shift
  timeout --signal=TERM --kill-after=2s "$limit" docker "$@"
}

remove_probe() {
  bounded_docker 10s rm -f "$probe_name" >/dev/null 2>&1 || :
  remaining=$(bounded_docker 10s ps -aq --filter "name=^/${probe_name}$" 2>/dev/null) ||
    return 1
  test -z "$remaining"
}

trap cleanup_probe EXIT
trap 'exit 1' HUP INT TERM

probe_program=$(cat <<'NODE'
const application = process.argv[1];
const classifications = new Map([
  ['ERR_MODULE_NOT_FOUND', 'module-not-found'],
  ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'package-path-not-exported'],
  ['ERR_DLOPEN_FAILED', 'native-module-load-failed'],
  ['EACCES', 'access-denied'],
  ['EROFS', 'readonly-filesystem'],
]);

try {
  const { verifyProductionWorkspaceImports } = await import(
    './scripts/verify-production-workspace-imports.js'
  );
  await verifyProductionWorkspaceImports(application);
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const failureClass = classifications.get(code) ?? 'unclassified';
  console.log(
    `production_workspace_imports application=${application} status=failed class=${failureClass}`,
  );
  process.exitCode = 70;
}
NODE
)

run_probe() {
  memory=$1
  if ! remove_probe; then
    probe_class=container-cleanup-failed
    return 1
  fi
  if ! bounded_docker 30s create \
    --name "$probe_name" \
    --platform linux/arm64 \
    --pull=never \
    --network none \
    --read-only \
    --user 1001:1001 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory "$memory" \
    --cpus 1 \
    --entrypoint node \
    "$image_ref" \
    --input-type=module \
    --eval "$probe_program" \
    "$service" >/dev/null 2>&1; then
    probe_class=container-create-failed
    return 1
  fi

  set +e
  result=$(timeout --signal=TERM --kill-after=5s 60s docker start --attach "$probe_name" 2>/dev/null)
  start_status=$?
  set -e

  if ! oom_killed=$(bounded_docker 10s inspect --format '{{.State.OOMKilled}}' "$probe_name" 2>/dev/null); then
    probe_class=container-inspect-failed
    return 1
  fi
  if ! remove_probe; then
    probe_class=container-cleanup-failed
    return 1
  fi

  expected_pass="production_workspace_imports application=$service status=passed"
  if test "$start_status" -eq 0 && test "$result" = "$expected_pass"; then
    probe_class=passed
    return 0
  fi

  if test "$start_status" -eq 124; then
    probe_class=timeout
    return 1
  fi
  if test "$oom_killed" = true; then
    probe_class=oom
    return 1
  fi

  for class in module-not-found package-path-not-exported native-module-load-failed access-denied readonly-filesystem unclassified; do
    if test "$result" = "production_workspace_imports application=$service status=failed class=$class"; then
      probe_class=$class
      return 1
    fi
  done

  if test "$start_status" -eq 0; then
    probe_class=invalid-output
  else
    probe_class=process-failed
  fi
  return 1
}

if run_probe 256m; then
  printf '%s\n' "otp_runtime_image_probe application=$service memory=256m status=passed"
  exit 0
fi
first_class=$probe_class

if run_probe 512m; then
  if test "$first_class" = oom; then
    final_class=memory-budget-exceeded
  else
    final_class=nondeterministic
  fi
  printf '%s\n' \
    "otp_runtime_image_probe application=$service status=failed class=$final_class first=$first_class retry=passed" >&2
  exit 1
fi
second_class=$probe_class

printf '%s\n' \
  "otp_runtime_image_probe application=$service status=failed class=$first_class retry=$second_class" >&2
exit 1
