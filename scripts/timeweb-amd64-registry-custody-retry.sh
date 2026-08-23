#!/usr/bin/env bash
# Bounded, read-only retry helper for eventually consistent GHCR custody reads.
# It deliberately retries only the exact command supplied by the caller.

phub_ghcr_custody_retry() {
  local stage="${1:?retry stage is required}"
  shift
  local attempt=1
  local max_attempts="${PHUB_GHCR_CUSTODY_MAX_ATTEMPTS:-5}"
  local delay_seconds="${PHUB_GHCR_CUSTODY_INITIAL_DELAY_SECONDS:-2}"

  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_MAX_ATTEMPTS must be a positive integer' >&2
    return 64
  }
  [[ "$delay_seconds" =~ ^[0-9]+$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_INITIAL_DELAY_SECONDS must be a non-negative integer' >&2
    return 64
  }

  while (( attempt <= max_attempts )); do
    echo "PHUB_GHCR_CUSTODY_READ|stage=$stage|attempt=$attempt|maxAttempts=$max_attempts" >&2
    if "$@"; then
      echo "PHUB_GHCR_CUSTODY_PASSED|stage=$stage|attempt=$attempt|maxAttempts=$max_attempts" >&2
      return 0
    fi

    if (( attempt == max_attempts )); then
      echo "::error::PHUB_GHCR_CUSTODY_EXHAUSTED|stage=$stage|attempt=$attempt|maxAttempts=$max_attempts" >&2
      return 1
    fi

    echo "PHUB_GHCR_CUSTODY_RETRY|stage=$stage|attempt=$attempt|maxAttempts=$max_attempts|delaySeconds=$delay_seconds" >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
    delay_seconds=$((delay_seconds * 2))
  done
}

phub_ghcr_custody_read_exact_json() {
  local reference="${1:?registry reference is required}"
  local expected_digest="${2:?expected digest is required}"
  local destination="${3:?destination is required}"
  local temporary="$destination.attempt-$$"
  rm -f "$temporary"
  docker buildx imagetools inspect "$reference" --raw > "$temporary"
  local observed_digest
  observed_digest="sha256:$(sha256sum "$temporary" | awk '{print $1}')"
  test "$observed_digest" = "$expected_digest" || {
    echo "::error::PHUB_GHCR_CUSTODY_WRONG_DIGEST|reference=$reference|expected=$expected_digest|observed=$observed_digest" >&2
    rm -f "$temporary"
    return 1
  }
  mv "$temporary" "$destination"
}
