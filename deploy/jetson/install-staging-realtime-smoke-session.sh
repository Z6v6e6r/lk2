#!/bin/sh
set -eu

fail() {
  printf '%s\n' "staging_realtime_smoke_install status=failed code=$1" >&2
  exit 1
}

test "$(id -u)" -eq 0 || fail SMOKE_INSTALL_ROOT_REQUIRED
test "$#" -eq 4 || fail SMOKE_INSTALL_USAGE_INVALID
expected_tenant_id=$1
expected_user_id=$2
expected_phone_last4=$3
confirmation=$4
uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
printf '%s' "$expected_tenant_id" | grep -Eq "$uuid_pattern" || fail SMOKE_TENANT_ID_INVALID
printf '%s' "$expected_user_id" | grep -Eq "$uuid_pattern" || fail SMOKE_USER_ID_INVALID
printf '%s' "$expected_phone_last4" | grep -Eq '^[0-9]{4}$' || fail SMOKE_PHONE_LAST4_INVALID
test "$confirmation" = INSTALL_STAGING_REALTIME_SMOKE_SESSION || fail SMOKE_INSTALL_CONFIRMATION_REQUIRED

IFS= read -r refresh_token || fail SMOKE_REFRESH_TOKEN_REQUIRED
if IFS= read -r unexpected; then
  unset refresh_token unexpected
  fail SMOKE_REFRESH_TOKEN_MULTILINE
fi
printf '%s' "$refresh_token" | grep -Eq '^[A-Za-z0-9_-]{43}$' || {
  unset refresh_token
  fail SMOKE_REFRESH_TOKEN_INVALID
}

deploy_uid=$(id -u phub-deploy)
deploy_gid=$(id -g phub-deploy)
secret_root=/etc/phub
target=$secret_root/staging-realtime-smoke
test "$(stat -c '%F:%u:%g:%a' "$secret_root")" = "directory:0:$deploy_gid:750" || {
  unset refresh_token
  fail SMOKE_SECRET_ROOT_UNSAFE
}
test ! -e "$target" && test ! -L "$target" || {
  unset refresh_token
  fail SMOKE_STATE_ALREADY_EXISTS
}
install -d -o 0 -g 0 -m 700 "$target"
temporary=$target/.session.json.next
trap 'unset refresh_token; rm -f "$temporary" "$target/session.json"; rmdir "$target" 2>/dev/null || true' EXIT HUP INT TERM
umask 077
set -C
printf '{"expectedPermissions":["chat.direct.create"],"expectedPhoneLast4":"%s","expectedRoles":["client"],"expectedTenantId":"%s","expectedUserId":"%s","generation":0,"lastRotatedAt":null,"pendingIdempotencyKey":null,"refreshExpiresAt":null,"refreshToken":"%s","tenantKey":"local-padel","version":1}\n' \
  "$expected_phone_last4" "$expected_tenant_id" "$expected_user_id" "$refresh_token" > "$temporary"
set +C
unset refresh_token
chmod 600 "$temporary"
chown "$deploy_uid:$deploy_gid" "$temporary"
sync -f "$temporary"
mv "$temporary" "$target/session.json"
sync -f "$target"
chown "$deploy_uid:$deploy_gid" "$target"
chmod 700 "$target"
sync -f "$secret_root"
trap - EXIT HUP INT TERM
printf '%s\n' 'staging_realtime_smoke_install tenant=local-padel status=installed'
