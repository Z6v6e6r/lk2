#!/bin/sh

set -eu

supported_active_release=e308181da5222645d9a87d03642923c6841be8d1
supported_candidate_sha=c4aa5e8106fffc9a4fb8f9fb03efc9a6ba1c3239
supported_patch_sha256=399d38e983d6f0dc54c97bda377c12a74357db4c1104a9fa1a32406cac1ed35d

fail() {
  printf '%s\n' "Legacy OTP hotfix source verification refused: $*" >&2
  exit 1
}

test "$#" -eq 3 ||
  fail 'usage: verify-legacy-otp-hotfix-source.sh <expected-active-sha> <candidate-sha> <candidate-checkout>'
expected_active=$1
candidate=$2
candidate_checkout=$3

for value in "$expected_active" "$candidate"; do
  test "${#value}" -eq 40 || fail 'release inputs must be 40-character SHAs'
  case "$value" in *[!0-9a-f]*) fail 'release inputs must be lowercase hexadecimal SHAs' ;; esac
done
test "$expected_active" = "$supported_active_release" || fail 'active release is not the reviewed legacy base'
test "$candidate" = "$supported_candidate_sha" || fail 'candidate is not the exact reviewed OTP hotfix commit'
test -d "$candidate_checkout" && git -C "$candidate_checkout" rev-parse --git-dir >/dev/null 2>&1 ||
  fail 'candidate checkout is absent'
test "$(git -C "$candidate_checkout" rev-parse HEAD)" = "$candidate" || fail 'candidate checkout HEAD differs'
git -C "$candidate_checkout" cat-file -e "$expected_active^{commit}" || fail 'active commit is unavailable'

parent_line=$(git -C "$candidate_checkout" rev-list --parents -n 1 "$candidate")
test "$(printf '%s\n' "$parent_line" | awk '{ print NF }')" -eq 2 || fail 'candidate must be a non-merge single-parent commit'
test "$(printf '%s\n' "$parent_line" | awk '{ print $2 }')" = "$expected_active" || fail 'candidate parent is not the exact active release'

actual_patch_sha256=$(git -C "$candidate_checkout" diff --binary "$expected_active..$candidate" | sha256sum | awk '{ print $1 }')
test "$actual_patch_sha256" = "$supported_patch_sha256" || fail 'candidate patch differs from the reviewed immutable OTP hotfix'

expected_paths='.env.example
apps/api/Dockerfile
apps/api/src/app.test.ts
apps/api/src/app.ts
apps/api/src/auth/auth-routes.test.ts
apps/api/src/auth/auth-routes.ts
apps/api/src/auth/auth-service.ts
apps/api/src/auth/challenge-store.ts
apps/api/src/bookings/activity-history-routes.ts
apps/api/src/bookings/booking-recommendation-routes.ts
apps/api/src/bookings/booking-screen-read-job-store.test.ts
apps/api/src/bookings/booking-screen-read-job-store.ts
apps/api/src/coach-games/coach-game-summary-routes.test.ts
apps/api/src/coach-games/coach-game-summary-routes.ts
apps/api/src/main.ts
apps/migrator/Dockerfile
apps/realtime/Dockerfile
apps/web/src/auth-gateway.test.ts
apps/web/src/auth-gateway.ts
apps/web/src/viva-browser-otp.test.ts
apps/web/src/viva-browser-otp.ts
apps/worker/Dockerfile
apps/worker/src/community-home-sync.ts
apps/worker/src/main.ts
apps/worker/src/platform-home-sync.test.ts
apps/worker/src/platform-home-sync.ts
contracts/openapi/user/v1/openapi.yaml
deploy/jetson/activate-live-home.sh
docs/adr/0004-provider-neutral-authentication.md
docs/adr/0005-viva-user-delegation-and-direct-transport.md
packages/api-sdk/src/index.ts
packages/auth/src/index.ts
packages/config/src/index.test.ts
packages/config/src/index.ts
packages/viva-adapter/src/identity.test.ts
packages/viva-adapter/src/identity.ts
packages/viva-client-adapter/src/client-transport.test.ts
packages/viva-client-adapter/src/index.ts
scripts/nano-presentation-contract.test.ts
scripts/verify-production-workspace-imports.js
scripts/verify-production-workspace-imports.test.ts'
actual_paths=$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" | LC_ALL=C sort)
test "$actual_paths" = "$expected_paths" || fail 'candidate changed-path set differs from the reviewed allowlist'

for protected in packages/database/migrations package.json package-lock.json deploy/compose.staging.yaml; do
  test -z "$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" -- "$protected")" ||
    fail "candidate changes protected path $protected"
done

active_migrations=$(git -C "$candidate_checkout" ls-tree -r "$expected_active" -- packages/database/migrations)
candidate_migrations=$(git -C "$candidate_checkout" ls-tree -r "$candidate" -- packages/database/migrations)
test "$active_migrations" = "$candidate_migrations" || fail 'candidate migration tree differs'
actual_contract_paths=$(git -C "$candidate_checkout" diff --name-only "$expected_active..$candidate" -- contracts)
test "$actual_contract_paths" = 'contracts/openapi/user/v1/openapi.yaml' ||
  fail 'candidate contract changes differ from the reviewed user-v1 OTP contract'
active_compose=$(git -C "$candidate_checkout" rev-parse "$expected_active:deploy/compose.staging.yaml")
candidate_compose=$(git -C "$candidate_checkout" rev-parse "$candidate:deploy/compose.staging.yaml")
test "$active_compose" = "$candidate_compose" || fail 'candidate staging Compose differs'

identity_source=$(git -C "$candidate_checkout" show "$candidate:packages/viva-adapter/src/identity.ts")
printf '%s' "$identity_source" | grep -Fq "phoneE164.startsWith('+') ? phoneE164.slice(1) : phoneE164" ||
  fail 'candidate lacks the reviewed Viva phone serializer'
printf '%s' "$identity_source" | grep -Fq "url.searchParams.set('phoneNumber', toVivaPhoneNumber(input.phoneE164))" ||
  fail 'candidate SMS request does not use the reviewed serializer'
printf '%s' "$identity_source" | grep -Fq 'phone_number: toVivaPhoneNumber(input.phoneE164)' ||
  fail 'candidate token request does not use the reviewed serializer'
printf '%s' "$identity_source" | grep -Fq "algorithms: ['RS256']" ||
  fail 'candidate does not bind Viva tokens to RS256 verification'
printf '%s' "$identity_source" | grep -Fq 'issuer: this.issuer' ||
  fail 'candidate does not bind Viva tokens to the configured issuer'
printf '%s' "$identity_source" | grep -Fq 'payload.azp !== this.options.clientId' ||
  fail 'candidate does not bind Viva tokens to the configured client'
printf '%s' "$identity_source" | grep -Fq "stringClaim(payload, ['tenant_key', 'tenantKey']) !== providerTenantKey" ||
  fail 'candidate does not bind Viva tokens to the requested tenant'
printf '%s' "$identity_source" | grep -Fq "payload.phone_number_verified !== true" ||
  fail 'candidate does not require a verified OTP phone claim'
printf '%s' "$identity_source" | grep -Fq "identityMode !== 'RECOVERY_SUBJECT_ONLY'" ||
  fail 'candidate lacks the reviewed recovery-only OAuth boundary'
printf '%s' "$identity_source" | grep -Fq 'profileApiBaseUrl' &&
  fail 'candidate retains the retired server profile endpoint'
auth_service_source=$(git -C "$candidate_checkout" show "$candidate:apps/api/src/auth/auth-service.ts")
printf '%s' "$auth_service_source" | grep -Fq "identityMode: pending.recoveryUserId ? 'RECOVERY_SUBJECT_ONLY' : 'STANDARD'" ||
  fail 'candidate recovery-only OAuth mode is not derived from server-held recovery state'
printf '%s' "$auth_service_source" | grep -Fq "challenge.transport === 'browser_phone_otp_v1'" ||
  fail 'candidate does not require browser proof for a browser OTP challenge'
printf '%s' "$auth_service_source" | grep -Fq 'verifyBrowserPhoneAccessToken' ||
  fail 'candidate does not verify the browser access-token proof server-side'

auth_routes_source=$(git -C "$candidate_checkout" show "$candidate:apps/api/src/auth/auth-routes.ts")
printf '%s' "$auth_routes_source" | grep -Fq "body.capability === 'browser_phone_otp_v1'" ||
  fail 'candidate does not require an explicit browser OTP capability'
printf '%s' "$auth_routes_source" | grep -Fq "request.headers['x-app-platform'] === 'web'" ||
  fail 'candidate does not restrict browser OTP capability to the web client'
printf '%s' "$auth_routes_source" | grep -Fq 'hasConfiguredBrowserOrigin(request, config)' ||
  fail 'candidate does not bind browser OTP to the configured first-party Origin'

browser_otp_source=$(git -C "$candidate_checkout" show "$candidate:apps/web/src/viva-browser-otp.ts")
printf '%s' "$browser_otp_source" | grep -Fq "credentials: 'omit'" ||
  fail 'candidate browser OTP transport does not omit browser credentials'
printf '%s' "$browser_otp_source" | grep -Fq 'VIVA_BROWSER_OTP_TIMEOUT_MS = 3_000' ||
  fail 'candidate browser OTP transport lacks the reviewed bounded timeout'
printf '%s' "$browser_otp_source" | grep -Fq 'refresh_token' ||
  fail 'candidate browser OTP boundary does not explicitly discard the Viva refresh token'

api_app_source=$(git -C "$candidate_checkout" show "$candidate:apps/api/src/app.ts")
printf '%s' "$api_app_source" | grep -Fq 'evidenceJob.sessionId === sessionId' ||
  fail 'candidate routing outcomes are not bound to the authenticated session'
printf '%s' "$api_app_source" | grep -Fq "outcome.data.operation === 'profile.read' || outcome.data.operation === 'schedule.read'" ||
  fail 'candidate does not require correlated evidence for profile and schedule success'
booking_job_source=$(git -C "$candidate_checkout" show "$candidate:apps/api/src/bookings/booking-screen-read-job-store.ts")
printf '%s' "$booking_job_source" | grep -Fq 'readonly sessionId: string' ||
  fail 'candidate booking evidence job lacks a server-derived session binding'
browser_gateway_source=$(git -C "$candidate_checkout" show "$candidate:apps/web/src/auth-gateway.ts")
printf '%s' "$browser_gateway_source" | grep -Fq 'evidenceJobId: job.jobId' ||
  fail 'candidate browser transport does not correlate Viva success with the server-issued job'
api_sdk_source=$(git -C "$candidate_checkout" show "$candidate:packages/api-sdk/src/index.ts")
printf '%s' "$api_sdk_source" | grep -Fq 'const { evidenceJobId, ...body } = input' ||
  fail 'candidate does not keep evidence metadata outside the routing-outcome body contract'
printf '%s' "$api_sdk_source" | grep -Fq 'evidenceJobId ?? createCorrelationId()' ||
  fail 'candidate does not carry the server-issued job through X-Correlation-ID'

api_main=$(git -C "$candidate_checkout" show "$candidate:apps/api/src/main.ts")
worker_main=$(git -C "$candidate_checkout" show "$candidate:apps/worker/src/main.ts")
for runtime_source in "$api_main" "$worker_main"; do
  printf '%s' "$runtime_source" | grep -Eq 'Viva(HomeSource|CoachGameSummary|ExerciseRecommendation)|runVivaHomeSyncCycle|VIVA_AUTH_PROFILE_API_URL' &&
    fail 'candidate runtime still wires a Viva End User reader'
done

config_source=$(git -C "$candidate_checkout" show "$candidate:packages/config/src/index.ts")
printf '%s' "$config_source" | grep -Fq 'HOME_VIVA_SYNC_ENABLED is retired because Viva End User reads require client-assisted browser transport' ||
  fail 'candidate config does not fail closed for retired Viva Home sync'
activation_source=$(git -C "$candidate_checkout" show "$candidate:deploy/jetson/activate-live-home.sh")
printf '%s' "$activation_source" | grep -Fq 'FULL_LIVE_HOME is retired' ||
  fail 'candidate legacy server-read activation does not fail closed'

for service in api worker realtime migrator; do
  dockerfile=$(git -C "$candidate_checkout" show "$candidate:apps/$service/Dockerfile")
  printf '%s' "$dockerfile" | grep -Fq 'npm ci --omit=dev --include=optional --workspaces --no-audit --no-fund' ||
    fail "$service image lacks the reviewed clean production install"
  printf '%s' "$dockerfile" | grep -Fq 'find apps packages -name node_modules -prune -exec rm -rf -- {} +' ||
    fail "$service image does not remove copied nested workspace installs"
  printf '%s' "$dockerfile" | grep -Fq "node scripts/verify-production-workspace-imports.js $service" ||
    fail "$service image lacks the reviewed production import probe"
  printf '%s' "$dockerfile" | grep -Fq 'chmod -R a+rX apps packages' ||
    fail "$service image does not normalize workspace read permissions"
  printf '%s' "$dockerfile" | grep -Fq 'scripts node_modules' ||
    fail "$service image does not normalize probe and dependency read permissions"
  printf '%s' "$dockerfile" | grep -Fq 'chmod a+r package.json package-lock.json .npmrc' ||
    fail "$service image does not normalize root manifest read permissions"
  user_line=$(printf '%s\n' "$dockerfile" | grep -nFx 'USER appuser' | cut -d: -f1)
  probe_line=$(printf '%s\n' "$dockerfile" | grep -nF "RUN node scripts/verify-production-workspace-imports.js $service" | cut -d: -f1)
  test -n "$user_line" && test -n "$probe_line" && test "$user_line" -lt "$probe_line" ||
    fail "$service image does not run the import probe as appuser"
  printf '%s\n' "$dockerfile" | grep -Eq 'chmod.*(a\+w|o\+w|777)' &&
    fail "$service image grants broad write permissions"
  printf '%s' "$dockerfile" | grep -Fq 'COPY --from=build /workspace/node_modules ./node_modules' &&
    fail "$service image copies builder node_modules"
  printf '%s' "$dockerfile" | grep -Fq 'npm prune' && fail "$service image prunes a copied dependency tree"
done

migrator_dockerfile=$(git -C "$candidate_checkout" show "$candidate:apps/migrator/Dockerfile")
printf '%s' "$migrator_dockerfile" | grep -Fq 'chmod -R a+rX apps packages migrations scripts node_modules' ||
  fail 'migrator image does not normalize migration read permissions'

probe_source=$(git -C "$candidate_checkout" show "$candidate:scripts/verify-production-workspace-imports.js")
printf '%s' "$probe_source" | grep -Fq "supportedApplications = new Set(['api', 'worker', 'realtime', 'migrator'])" ||
  fail 'candidate import probe does not bind the four Node applications'
printf '%s' "$probe_source" | grep -Fq 'await import(specifier)' ||
  fail 'candidate import probe does not load resolved production dependencies'
printf '%s' "$probe_source" | grep -Fq "join(applicationRoot, 'dist')" ||
  fail 'candidate import probe does not scan built application output'

printf '%s\n' "legacy_otp_hotfix_source active=$expected_active candidate=$candidate paths=41 migrations=unchanged contracts=user_v1_otp_reviewed compose=unchanged status=passed"
