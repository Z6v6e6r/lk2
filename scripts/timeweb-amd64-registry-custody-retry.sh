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

phub_ghcr_custody_fetch_exact_statement_blob() {
  local service="${1:?service is required}"
  local expected_digest="${2:?expected digest is required}"
  local expected_size="${3:?expected size is required}"
  local expected_media_type="${4:?expected media type is required}"
  local registry_token="${5:?registry token is required}"
  local destination="${6:?destination is required}"
  local maximum_blob_bytes="${PHUB_GHCR_CUSTODY_MAX_BLOB_BYTES:-33554432}"
  local maximum_redirects="${PHUB_GHCR_CUSTODY_MAX_REDIRECTS:-3}"
  local connect_timeout_seconds="${PHUB_GHCR_CUSTODY_CONNECT_TIMEOUT_SECONDS:-10}"
  local maximum_time_seconds="${PHUB_GHCR_CUSTODY_MAX_TIME_SECONDS:-60}"
  local low_speed_time_seconds="${PHUB_GHCR_CUSTODY_LOW_SPEED_TIME_SECONDS:-15}"
  local low_speed_limit_bytes="${PHUB_GHCR_CUSTODY_LOW_SPEED_LIMIT_BYTES:-1024}"
  local registry_origin="${PHUB_GHCR_CUSTODY_REGISTRY_ORIGIN:-https://ghcr.io}"
  local temporary="$destination.attempt-$$"
  local metadata
  local curl_status
  local http_status
  local content_type_and_redirects
  local content_type
  local redirect_count
  local observed_size
  local observed_digest

  [[ "$service" =~ ^(web|api|worker|realtime|migrator)$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_INVALID_BLOB_SERVICE' >&2
    return 64
  }
  [[ "$expected_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "::error::PHUB_GHCR_CUSTODY_INVALID_BLOB_DIGEST|service=$service" >&2
    return 64
  }
  [[ "$expected_size" =~ ^[1-9][0-9]*$ ]] || {
    echo "::error::PHUB_GHCR_CUSTODY_INVALID_BLOB_SIZE|service=$service|digest=$expected_digest" >&2
    return 64
  }
  [[ "$maximum_blob_bytes" =~ ^[1-9][0-9]*$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_MAX_BLOB_BYTES must be a positive integer' >&2
    return 64
  }
  (( expected_size <= maximum_blob_bytes )) || {
    echo "::error::PHUB_GHCR_CUSTODY_BLOB_TOO_LARGE|service=$service|digest=$expected_digest|expectedSize=$expected_size|maxBytes=$maximum_blob_bytes" >&2
    return 1
  }
  [[ "$expected_media_type" = application/vnd.in-toto+json ]] || {
    echo "::error::PHUB_GHCR_CUSTODY_UNEXPECTED_DESCRIPTOR_MEDIA_TYPE|service=$service|digest=$expected_digest" >&2
    return 1
  }
  [[ "$maximum_redirects" =~ ^[1-9][0-9]*$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_MAX_REDIRECTS must be a positive integer' >&2
    return 64
  }
  [[ "$connect_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_CONNECT_TIMEOUT_SECONDS must be a positive integer' >&2
    return 64
  }
  [[ "$maximum_time_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_MAX_TIME_SECONDS must be a positive integer' >&2
    return 64
  }
  [[ "$low_speed_time_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_LOW_SPEED_TIME_SECONDS must be a positive integer' >&2
    return 64
  }
  [[ "$low_speed_limit_bytes" =~ ^[1-9][0-9]*$ ]] || {
    echo '::error::PHUB_GHCR_CUSTODY_LOW_SPEED_LIMIT_BYTES must be a positive integer' >&2
    return 64
  }
  if [[ "$registry_origin" != https://ghcr.io ]]; then
    [[ "${PHUB_GHCR_CUSTODY_TESTING:-}" = 1 ]] &&
      [[ "$registry_origin" =~ ^https://(localhost|127\.0\.0\.1):[1-9][0-9]{0,4}$ ]] || {
      echo '::error::PHUB_GHCR_CUSTODY_INVALID_REGISTRY_ORIGIN' >&2
      return 64
    }
  fi

  rm -f "$temporary"
  if metadata="$({
    printf 'header = "Authorization: Bearer %s"\n' "$registry_token"
  } | curl --disable --fail --silent --show-error --location \
    --max-redirs "$maximum_redirects" \
    --connect-timeout "$connect_timeout_seconds" \
    --max-time "$maximum_time_seconds" \
    --speed-time "$low_speed_time_seconds" \
    --speed-limit "$low_speed_limit_bytes" \
    --max-filesize "$expected_size" \
    --remove-on-error \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --config - \
    "$registry_origin/v2/z6v6e6r/phub-$service/blobs/$expected_digest" \
    --output "$temporary" \
    --write-out $'%{http_code}\n%{content_type}\n%{num_redirects}')"; then
    curl_status=0
  else
    curl_status=$?
  fi
  if (( curl_status != 0 )); then
    echo "::error::PHUB_GHCR_CUSTODY_BLOB_FETCH_FAILED|service=$service|digest=$expected_digest|curlExit=$curl_status" >&2
    rm -f "$temporary"
    return 1
  fi

  http_status="${metadata%%$'\n'*}"
  content_type_and_redirects="${metadata#*$'\n'}"
  content_type="${content_type_and_redirects%%$'\n'*}"
  content_type="${content_type%%;*}"
  redirect_count="${content_type_and_redirects##*$'\n'}"
  [[ "$http_status" = 200 ]] || {
    echo "::error::PHUB_GHCR_CUSTODY_UNEXPECTED_BLOB_STATUS|service=$service|digest=$expected_digest|status=$http_status" >&2
    rm -f "$temporary"
    return 1
  }
  [[ "$redirect_count" =~ ^[0-9]+$ ]] && (( redirect_count <= maximum_redirects )) || {
    echo "::error::PHUB_GHCR_CUSTODY_INVALID_REDIRECT_COUNT|service=$service|digest=$expected_digest" >&2
    rm -f "$temporary"
    return 1
  }
  case "$content_type" in
    application/vnd.in-toto+json|application/octet-stream) ;;
    *)
      echo "::error::PHUB_GHCR_CUSTODY_UNEXPECTED_BLOB_MEDIA_TYPE|service=$service|digest=$expected_digest" >&2
      rm -f "$temporary"
      return 1
      ;;
  esac
  [[ -s "$temporary" ]] || {
    echo "::error::PHUB_GHCR_CUSTODY_EMPTY_BLOB|service=$service|digest=$expected_digest" >&2
    rm -f "$temporary"
    return 1
  }
  observed_size="$(wc -c < "$temporary" | tr -d ' ')"
  [[ "$observed_size" = "$expected_size" ]] || {
    echo "::error::PHUB_GHCR_CUSTODY_WRONG_BLOB_SIZE|service=$service|digest=$expected_digest|expectedSize=$expected_size|observedSize=$observed_size" >&2
    rm -f "$temporary"
    return 1
  }
  observed_digest="sha256:$(sha256sum "$temporary" | awk '{print $1}')"
  [[ "$observed_digest" = "$expected_digest" ]] || {
    echo "::error::PHUB_GHCR_CUSTODY_WRONG_BLOB_DIGEST|service=$service|expected=$expected_digest|observed=$observed_digest" >&2
    rm -f "$temporary"
    return 1
  }
  jq -e 'type == "object"' "$temporary" >/dev/null || {
    echo "::error::PHUB_GHCR_CUSTODY_INVALID_BLOB_JSON|service=$service|digest=$expected_digest" >&2
    rm -f "$temporary"
    return 1
  }
  mv "$temporary" "$destination"
}
