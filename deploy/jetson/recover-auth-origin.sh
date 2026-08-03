#!/bin/sh
set -eu

cd /opt/phub

auth_env=/opt/phub/staging.auth.env
backup="${auth_env}.origin-pre-$(date -u +%Y%m%dT%H%M%SZ)"
auth_tmp="${auth_env}.$$"
headers_tmp="/tmp/phub-auth-origin-headers.$$"
body_tmp="/tmp/phub-auth-origin-body.$$"
committed=false

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

wait_for_api() {
  attempt=0
  while test "$attempt" -lt 18; do
    container_id="$(compose ps -q api)"
    if test -n "$container_id" && \
      test "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  return 1
}

rollback() {
  rm -f "$auth_tmp" "$headers_tmp" "$body_tmp"
  if test "$committed" != true; then
    cp "$backup" "$auth_env"
    chmod 600 "$auth_env"
    compose up -d --no-deps --force-recreate api >/dev/null 2>&1 || true
  fi
}
trap rollback EXIT HUP INT TERM

test -r "$auth_env"
cp "$auth_env" "$backup"

origins="$(compose exec -T api node -e \
  "process.stdout.write(String(process.env.CORS_ORIGINS || ''))")"
for required_origin in https://lk.nano.padlhub.su https://cup.nano.padlhub.su; do
  case ",$origins," in
    *,"$required_origin",*) ;;
    *)
      if test -n "$origins"; then
        origins="${origins},${required_origin}"
      else
        origins="$required_origin"
      fi
      ;;
  esac
done

awk -v origins="$origins" '
  /^CORS_ORIGINS=/ { print "CORS_ORIGINS=" origins; replaced=1; next }
  { print }
  END { if (!replaced) print "CORS_ORIGINS=" origins }
' "$auth_env" > "$auth_tmp"
chmod 600 "$auth_tmp"
mv "$auth_tmp" "$auth_env"

compose up -d --no-deps --force-recreate api
wait_for_api

status="$(curl --silent --show-error --max-time 15 \
  --resolve lk.nano.padlhub.su:443:127.0.0.1 \
  --request POST \
  --header 'Origin: https://lk.nano.padlhub.su' \
  --header 'X-Session-Intent: refresh' \
  --header 'Idempotency-Key: 00000000-0000-4000-8000-000000000011' \
  --header 'X-Correlation-ID: 00000000-0000-4000-8000-000000000012' \
  --header 'X-App-Platform: web' \
  --dump-header "$headers_tmp" \
  --output "$body_tmp" \
  --write-out '%{http_code}' \
  https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/session/refresh)"

test "$status" = 401
grep -Fqi 'access-control-allow-origin: https://lk.nano.padlhub.su' "$headers_tmp"
grep -Fq '"code":"AUTH_SESSION_REVOKED"' "$body_tmp"

committed=true
printf '%s\n' "Canonical Nano browser origins repaired; unauthenticated refresh returns AUTH_SESSION_REVOKED"
