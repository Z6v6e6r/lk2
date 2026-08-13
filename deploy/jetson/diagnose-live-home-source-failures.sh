#!/bin/sh
set -eu

# This is intentionally a narrow, redacted diagnostic.  Live Home projection
# failures are otherwise collapsed into EXTERNAL_SOURCE_UNAVAILABLE by the
# release activation gate, which is not enough to distinguish provider,
# network, and configuration failures.
for container in phub-staging-api-1 phub-staging-worker-1; do
  echo "container=$container"
  docker logs --since 3h --tail 2000 "$container" 2>&1 \
    | sed -E \
      -e 's/(Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g' \
      -e 's/([?&](code|state|token|authorization)=)[^&[:space:]]+/\1[REDACTED]/g' \
      -e 's/((access|refresh|id|authorization)[_-]?[Tt]oken[[:space:]]*[:=][[:space:]]*)[^,[:space:]}]+/\1[REDACTED]/g' \
      -e 's/((access|refresh|id|authorization)[_-]?[Tt]oken[[:space:]]*"[[:space:]]*:[[:space:]]*")[^"]+/\1[REDACTED]/g' \
      -e 's/("?(phone|email|user[_-]?id|client[_-]?id|vivaClientId|padlHubUserId|subject|tenantId|eventId|gameId|resultId|correlationId|secret|password|api[_-]?key)"?[[:space:]]*:[[:space:]]*")[^"]+/\1[REDACTED]/g' \
    | grep -Ei 'identity provider operation|EXTERNAL_SOURCE_UNAVAILABLE|live home.*(fail|error)|projection.*(fail|error)|viva.*(fail|error|unavailable|timeout)|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|ECONNRESET|EAI_AGAIN|status[=:][[:space:]]*[45][0-9][0-9]' \
    | tail -160 \
    || true
done
