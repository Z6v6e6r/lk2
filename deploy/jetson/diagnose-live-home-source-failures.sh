#!/bin/sh
set -eu

# This is intentionally a narrow, redacted diagnostic.  Live Home projection
# failures are otherwise collapsed into EXTERNAL_SOURCE_UNAVAILABLE by the
# release activation gate, which is not enough to distinguish provider,
# network, and configuration failures.
since="${1:-3h}"
scope="${2:-all}"

case "$scope" in
  all) containers="phub-staging-api-1 phub-staging-worker-1" ;;
  worker) containers="phub-staging-worker-1" ;;
  *)
    echo "Usage: $0 [since] [all|worker]" >&2
    exit 2
    ;;
esac

umask 077
raw_log=
filtered_log=
cleanup() {
  test -z "$raw_log" || rm -f "$raw_log"
  test -z "$filtered_log" || rm -f "$filtered_log"
}
trap cleanup EXIT HUP INT TERM
raw_log="$(mktemp /tmp/phub-live-home-source-raw.XXXXXX)"
filtered_log="$(mktemp /tmp/phub-live-home-source-filtered.XXXXXX)"

diagnostic_status=0
matched_evidence=0
for container in $containers; do
  echo "container=$container"
  : > "$raw_log"
  : > "$filtered_log"
  set +e
  timeout 15 docker logs --since="$since" --tail 2000 "$container" > "$raw_log" 2>&1
  docker_status=$?
  set -e
  if test "$docker_status" -ne 0; then
    echo "Live Home diagnostic log read failed: container=$container status=$docker_status" >&2
    diagnostic_status=1
    continue
  fi
  sed -E \
      -e 's/(Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g' \
      -e 's/([?&](code|state|token|authorization)=)[^&[:space:]]+/\1[REDACTED]/g' \
      -e 's/((access|refresh|id|authorization)[_-]?[Tt]oken[[:space:]]*[:=][[:space:]]*)[^,[:space:]}]+/\1[REDACTED]/g' \
      -e 's/((access|refresh|id|authorization)[_-]?[Tt]oken[[:space:]]*"[[:space:]]*:[[:space:]]*")[^"]+/\1[REDACTED]/g' \
      -e 's/("?(phone(Last4|[_-]?last4)?|email|user[_-]?[Ii]d|client[_-]?[Ii]d|external[_-]?[Ii]d|provider[_-]?[Ii]d|vivaClientId|padlHubUserId|subject|tenantId|eventId|gameId|resultId|correlationId|providerTenantKey|authorization|cookie|secret|password|api[_-]?key)"?[[:space:]]*:[[:space:]]*")[^"]+/\1[REDACTED]/g' \
      "$raw_log" \
    | grep -Ei 'Viva Home read operation|Viva identity operation|identity provider operation|EXTERNAL_SOURCE_UNAVAILABLE|live home.*(fail|error)|projection.*(fail|error)|viva.*(fail|error|unavailable|timeout)|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|ECONNRESET|EAI_AGAIN|status[=:][[:space:]]*[45][0-9][0-9]' \
    | tail -160 \
    > "$filtered_log" \
    || true
  if test -s "$filtered_log"; then
    cat "$filtered_log"
    matched_evidence=1
  fi
done

if test "$matched_evidence" -ne 1; then
  echo "Live Home diagnostic found no matching redacted evidence" >&2
  diagnostic_status=1
fi

exit "$diagnostic_status"
