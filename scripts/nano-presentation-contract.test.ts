import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const caddyfile = repositoryFile('deploy/jetson/tls-ingress/Caddyfile');
const nginxConfig = repositoryFile('deploy/jetson/nginx/default.conf');
const stagingWorkflow = repositoryFile('.github/workflows/deploy-staging.yaml');
const mediaRollbackGuard = repositoryFile('deploy/jetson/verify-media-rollback-safe.sh');
const applicationRollback = repositoryFile('deploy/jetson/rollback-application.sh');
const compatibleWorkerRestore = repositoryFile(
  'deploy/jetson/prepare-compatible-worker-rollback.sh',
);
const clientRoutingRunbook = repositoryFile('docs/runbooks/client-routing-switch.md');
const rollbackRunbook = repositoryFile('docs/runbooks/rollback.md');
const userApiContract = repositoryFile('contracts/openapi/user/v1/openapi.yaml');
const productionWorkflow = repositoryFile('.github/workflows/deploy-production.yaml');
const stagingCompose = repositoryFile('deploy/compose.staging.yaml');
const productionCompose = repositoryFile('deploy/compose.production.yaml');
const stagingRoutingWorkflow = repositoryFile('.github/workflows/set-staging-routing-plan.yaml');
const stagingRoutingOperator = repositoryFile('deploy/jetson/run-client-routing-plan.sh');
const migration0057Diagnostic = repositoryFile('deploy/jetson/diagnose-migration-0057.sh');
const testPlayerDiagnostic = repositoryFile('deploy/jetson/diagnose-test-player-delegations.sh');
const userAccessOperator = repositoryFile('deploy/jetson/run-user-access.sh');
const messagingReleaseVerification = repositoryFile(
  'deploy/jetson/verify-messaging-test-release.sh',
);
const activation = repositoryFile('deploy/jetson/activate-live-home.sh');
const liveHomeSourceDiagnostic = repositoryFile(
  'deploy/jetson/diagnose-live-home-source-failures.sh',
);
const workerMain = repositoryFile('apps/worker/src/main.ts');
const communitiesReadOnlyActivation = repositoryFile(
  'deploy/jetson/activate-communities-legacy-read-only.sh',
);
const communitiesReadOnlyVerification = repositoryFile(
  'deploy/jetson/verify-communities-legacy-read-only.sh',
);
const clientAssistedActivation = repositoryFile('deploy/jetson/activate-client-assisted-viva.sh');
const verification = repositoryFile('deploy/jetson/verify-live-staging-data.sh');
const clientAssistedVerification = repositoryFile('deploy/jetson/verify-client-assisted-viva.sh');
const cupVerification = repositoryFile('deploy/jetson/verify-cup-integrations.sh');

describe('Nano presentation release contract', () => {
  it('keeps the legacy Communities pilot worker stopped without probing its readiness', () => {
    expect(stagingWorkflow).toContain(
      'if [ "$deployment_profile" = COMMUNITIES_LEGACY_READ_ONLY ]; then',
    );
    expect(stagingWorkflow).toContain('compose stop worker realtime');
    expect(stagingWorkflow).toMatch(
      /if \[ "\$deployment_profile" != COMMUNITIES_LEGACY_READ_ONLY \]; then\s+compose exec -T worker node -e/,
    );
  });

  it('requires an explicit main-branch confirmation for deploy while preserving diagnostics', () => {
    const validateJob = stagingWorkflow.match(
      / {2}validate-request:\n([\s\S]*?)\n {2}diagnose-home:/,
    )?.[1];
    const diagnoseJob = stagingWorkflow.match(/ {2}diagnose-home:\n([\s\S]*?)\n {2}build:/)?.[1];
    const buildGate = stagingWorkflow.match(/ {2}build:\n([\s\S]*?)\n {4}runs-on:/)?.[1];
    const deployGate = stagingWorkflow.match(/ {2}deploy:\n([\s\S]*?)\n {4}runs-on:/)?.[1];

    expect(stagingWorkflow).not.toMatch(/^ {2}push:/m);
    expect(stagingWorkflow).toMatch(/^ {2}workflow_dispatch:/m);
    expect(stagingWorkflow).toMatch(
      /deploy_confirmation:\n\s+description: Type DEPLOY_STAGING[\s\S]*?type: string/,
    );
    expect(validateJob).toContain('[ -n "$DEPLOY_CONFIRMATION" ]');
    expect(validateJob).toContain('[ "$DEPLOY_CONFIRMATION" != \'DEPLOY_STAGING\' ]');
    expect(validateJob).toContain('[ "$ROUTING_APPLY_CONFIRMATION" != \'APPLY_ROUTING_PLAN\' ]');
    expect(validateJob).toContain('[ "$REQUEST_REF" != \'refs/heads/main\' ]');
    expect(validateJob).toContain('mode=diagnostics');
    expect(validateJob).toContain('mode=user-access');
    expect(validateJob).toContain('mode=deploy');
    expect(diagnoseJob).toContain('needs: validate-request');
    expect(diagnoseJob).toContain("needs.validate-request.outputs.mode == 'diagnostics'");
    expect(diagnoseJob).not.toContain('deploy_confirmation');
    expect(diagnoseJob).toContain('Inspect active release metadata without values');
    expect(diagnoseJob).toContain("'sh -s -- /opt/phub/release.env'");
    expect(diagnoseJob).toContain('< deploy/jetson/inspect-release-env.sh');
    expect(diagnoseJob).toContain('continue-on-error: true');
    expect(diagnoseJob).toContain('Inspect migration 0057 state read-only');
    expect(diagnoseJob).toContain(
      'sha256sum packages/database/migrations/0057_messaging_runtime.sql',
    );
    expect(diagnoseJob).toContain('< deploy/jetson/diagnose-migration-0057.sh');
    expect(validateJob).toContain('DIAGNOSTIC_PHONE_LAST4');
    expect(validateJob).toContain("'^[0-9]{4}(,[0-9]{4}){0,9}$'");
    expect(diagnoseJob).toContain('Inspect selected test-player delegations read-only');
    expect(diagnoseJob).toContain('< deploy/jetson/diagnose-test-player-delegations.sh');
    expect(stagingWorkflow).toContain(
      'Preview the complete user-access replacement without writes',
    );
    expect(stagingWorkflow).toContain('Apply the audited complete user-access replacement');
    expect(stagingWorkflow).toContain("APPLY_USER_ACCESS) printf '%s\\n' 'access_apply=true'");
    expect(buildGate).toContain('needs: [validate-request, verify]');
    expect(buildGate).toContain("needs.validate-request.outputs.mode == 'deploy'");
    expect(buildGate).toContain("needs.verify.result == 'success'");
    expect(deployGate).toContain('needs: [validate-request, build]');
    expect(deployGate).toContain('always()');
    expect(deployGate).toContain("needs.build.result == 'success'");
    expect(deployGate).toContain("needs.validate-request.outputs.mode == 'deploy'");
  });

  it('keeps the migration 0057 staging diagnostic structurally read-only', () => {
    expect(migration0057Diagnostic).toContain('default_transaction_read_only=on');
    expect(migration0057Diagnostic).toContain('begin transaction read only;');
    expect(migration0057Diagnostic).toContain('commit;');
    expect(migration0057Diagnostic).toContain("'0057_messaging_runtime.sql'");
    expect(migration0057Diagnostic).toContain("'0043_messaging_runtime.sql'");
    expect(migration0057Diagnostic).toContain('pg_catalog.pg_policies');
    expect(migration0057Diagnostic).toContain('pg_catalog.pg_constraint');
    expect(migration0057Diagnostic).toContain('pg_catalog.pg_indexes');
    expect(migration0057Diagnostic).not.toMatch(
      /^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/im,
    );
    expect(migration0057Diagnostic).not.toMatch(/compose\s+(up|run)|migrator/i);
  });

  it('keeps selected test-player diagnostics read-only and redacted', () => {
    expect(testPlayerDiagnostic).toContain('default_transaction_read_only=on');
    expect(testPlayerDiagnostic).toContain('begin transaction read only;');
    expect(testPlayerDiagnostic).toContain("'phone=***' || suffix");
    expect(testPlayerDiagnostic).toContain("'operator_candidate'");
    expect(testPlayerDiagnostic).toContain("'notifications.manage' = any(access.permissions)");
    expect(testPlayerDiagnostic).not.toContain('phone_e164::text');
    expect(testPlayerDiagnostic).not.toContain('refresh_token_ciphertext');
    expect(testPlayerDiagnostic).not.toContain('subject');
    expect(testPlayerDiagnostic).not.toMatch(
      /^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/im,
    );
  });

  it('runs staging user-access changes only through the reviewed dry-run/apply operator', () => {
    expect(userAccessOperator).toContain('set-user-access.ts:/app/set-user-access.ts:ro');
    expect(userAccessOperator).toContain('--confirm=APPLY_USER_ACCESS');
    expect(userAccessOperator).toContain('--profile migration run --rm --no-deps');
    expect(stagingWorkflow).toContain("needs.validate-request.outputs.mode == 'user-access'");
    expect(stagingWorkflow).toContain("needs.validate-request.outputs.access_apply == 'true'");
  });

  it('deploys the messaging test contour without changing the current Home mode', () => {
    expect(stagingWorkflow).toContain('MESSAGING_TEST');
    expect(stagingWorkflow).toContain('CLIENT_ASSISTED_VIVA');
    expect(stagingWorkflow).toContain("inputs.deployment_profile == 'FULL_LIVE_HOME'");
    expect(stagingWorkflow).toContain("inputs.deployment_profile == 'MESSAGING_TEST'");
    expect(stagingWorkflow).toContain(
      'Verify messaging test release and preserve the current Home mode',
    );
    expect(stagingWorkflow).toContain('sh /opt/phub/verify-messaging-test-release.sh');
    expect(stagingWorkflow).toContain(
      'cmp "$backup_dir/staging.override.env" /opt/phub/staging.override.env',
    );
    expect(messagingReleaseVerification).toContain('default_transaction_read_only=on');
    expect(messagingReleaseVerification).toContain(
      "concat_ws('|', http_enabled::text, direct_enabled::text, realtime_enabled::text)",
    );
    expect(messagingReleaseVerification).toContain(
      'require_equal "$runtime_state" \'true|true|true\'',
    );
    expect(messagingReleaseVerification).toContain('Messaging test release verification failed:');
    expect(messagingReleaseVerification).toContain('0057_messaging_runtime.sql');
    expect(messagingReleaseVerification).toContain('"AUTH_REQUIRED"');
    expect(messagingReleaseVerification).toContain('/realtime/health/ready');
    expect(messagingReleaseVerification).not.toMatch(
      /^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/im,
    );
  });

  it('pins staging browser auth to the canonical Nano origin and callback', () => {
    const authEnvProvisioning = stagingWorkflow.match(
      /auth_env=\/opt\/phub\/staging\.auth\.env([\s\S]*?)chmod 600 "\$auth_env_tmp"/,
    )?.[1];

    expect(authEnvProvisioning).toBeDefined();
    expect(authEnvProvisioning).toContain('CORS_ORIGINS=https://lk.nano.padlhub.su');
    expect(authEnvProvisioning).toContain(
      'VIVA_END_USER_API_URL=https://api.vivacrm.ru/end-user/api',
    );
    expect(authEnvProvisioning).toContain(
      'VIVA_OAUTH_REDIRECT_URI=https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/viva/callback',
    );
    expect(authEnvProvisioning).toContain(
      'VIVA_OAUTH_SUCCESS_REDIRECT_URL=https://lk.nano.padlhub.su/',
    );
    expect(authEnvProvisioning).not.toContain('http://127.0.0.1');
    expect(verification).toContain('require_value CORS_ORIGINS https://lk.nano.padlhub.su');
    expect(verification).toContain(
      'require_value VIVA_OAUTH_REDIRECT_URI https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/viva/callback',
    );
    expect(verification).toContain(
      'community_logo_stable_delivery="$(runtime_value COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED)"',
    );
    expect(verification).toContain('false | true)');
    expect(verification).not.toContain(
      'require_value COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED false',
    );
    expect(verification).toContain(
      'require_value COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false',
    );
    expect(verification).toContain(
      'require_running_flag api COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED "$community_logo_stable_delivery"',
    );
    expect(verification).toContain(
      'require_running_flag worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED "$community_logo_stable_delivery"',
    );
  });

  it('snapshots the active application before mutation and rolls it back after later failures', () => {
    const backupStep = stagingWorkflow.indexOf(
      'name: Preserve the active digest-pinned application release',
    );
    const installStep = stagingWorkflow.indexOf('name: Install release and ingress definitions');
    const smokeStep = stagingWorkflow.indexOf('name: Staging smoke test');
    const rollbackStep = stagingWorkflow.indexOf(
      'name: Roll back a failed staging application release',
    );
    const runtimeFlagStep = stagingWorkflow.match(
      /- name: Attest community-logo flags in every API and worker runtime\n([\s\S]*?)\n {6}- name:/,
    )?.[1];
    const restoreVerificationStep = stagingWorkflow.indexOf('VERIFY_STAGING_POSTGRES_BACKUP');
    const capacityVerificationStep = stagingWorkflow.indexOf('VERIFY_STAGING_POSTGRES_CAPACITY');
    const dumpStep = stagingWorkflow.indexOf('pg_dump -U');
    const migrationStep = stagingWorkflow.indexOf('compose --profile migration run --rm migrator');

    expect(stagingWorkflow).toContain(
      'STAGING_RELEASE_BACKUP_DIR: /opt/phub/backups/releases/pre-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(backupStep).toBeGreaterThan(-1);
    expect(backupStep).toBeLessThan(installStep);
    expect(rollbackStep).toBeGreaterThan(smokeStep);
    expect(stagingWorkflow).toContain('steps.application-backup.outputs.ready');
    expect(stagingWorkflow).toContain('failure() || cancelled()');
    expect(stagingWorkflow).toContain('BACKUP_STAGING_RELEASE');
    expect(stagingWorkflow).toContain('verify-postgres-backup-restore.sh.next');
    expect(stagingWorkflow).toContain('VERIFY_STAGING_POSTGRES_BACKUP');
    expect(stagingWorkflow).toContain('umask 077');
    expect(stagingWorkflow).toContain('mkdir -m 700 "$backup_dir"');
    expect(stagingWorkflow).toContain('[ ! -L "$backup_dir" ]');
    expect(stagingWorkflow).toContain('[ ! -L "$backup_path" ]');
    expect(stagingWorkflow).toContain('mktemp "$backup_dir/.postgres-pre-');
    expect(stagingWorkflow).toContain('[ "$(stat -c %a "$backup_tmp")" = 600 ]');
    expect(stagingWorkflow).toContain('[ "$(stat -c %a "$backup_path")" = 600 ]');
    expect(stagingWorkflow).toContain('PHUB_POSTGRES_STORAGE_PATH=/var/lib/docker');
    expect(capacityVerificationStep).toBeGreaterThan(-1);
    expect(dumpStep).toBeGreaterThan(capacityVerificationStep);
    expect(restoreVerificationStep).toBeGreaterThan(dumpStep);
    expect(restoreVerificationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(restoreVerificationStep);
    const backupRestoreSegment = stagingWorkflow.slice(dumpStep, migrationStep);
    expect(backupRestoreSegment).not.toContain('|| true');
    expect(backupRestoreSegment).not.toContain('set +e');
    expect(stagingWorkflow).toContain('--validate-only');
    expect(stagingWorkflow).toContain('--confirm=ROLLBACK_STAGING_RELEASE');
    expect(stagingWorkflow).toContain('PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases');
    expect(stagingWorkflow.indexOf('compose up -d --remove-orphans web api')).toBeLessThan(
      stagingWorkflow.indexOf('compose up -d --remove-orphans worker realtime'),
    );
    expect(stagingWorkflow).not.toMatch(/^\s+compose up -d --remove-orphans\s*$/m);
    expect(stagingWorkflow).toContain('wait_for_service api');
    expect(stagingWorkflow).toContain('verify-media-rollback-safe.sh');
    expect(stagingWorkflow).toContain('PHUB_MEDIA_ROLLBACK_MODE=pre-cutover');
    expect(mediaRollbackGuard).toContain('COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED');
    expect(mediaRollbackGuard).toContain('COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED');
    expect(mediaRollbackGuard).toContain('PROFILE_PHOTO_CLIENT_SYNC_ENABLED');
    expect(mediaRollbackGuard).toContain('source_url is null');
    expect(mediaRollbackGuard).toContain('profile_photo_client_commands');
    expect(mediaRollbackGuard).toContain('profile_photo_object_gc');
    expect(mediaRollbackGuard).toContain('delivery_url is null');
    expect(mediaRollbackGuard).toContain('/public/api/v1/media/community-logos/');
    expect(mediaRollbackGuard).toContain('integration.community_home_source_components');
    expect(mediaRollbackGuard).toContain('home.dashboard_snapshots');
    expect(mediaRollbackGuard).toContain('home.base_snapshots');
    expect(mediaRollbackGuard).toContain('published_at is null');
    expect(mediaRollbackGuard).toContain('staging.games.env');
    expect(mediaRollbackGuard).toContain(
      'require_running_service_flag worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED true',
    );
    expect(mediaRollbackGuard).toContain(
      'require_running_flag api COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED false',
    );
    expect(mediaRollbackGuard).toContain('phub.home-projector.v1');
    expect(mediaRollbackGuard).toContain('compose stop worker');
    expect(mediaRollbackGuard).toContain('PHUB_MEDIA_ROLLBACK_MODE');
    expect(mediaRollbackGuard).toContain('PHUB_MEDIA_ROLLBACK_MODE:-feature');
    expect(mediaRollbackGuard).toContain('integration.media_cutover_state');
    expect(mediaRollbackGuard).toContain('compatible-client');
    expect(mediaRollbackGuard).toContain('compatible-logo');
    expect(mediaRollbackGuard).toContain('client_compatible');
    expect(mediaRollbackGuard).toContain('community_compatible');
    expect(mediaRollbackGuard).toContain('phub.client-media-rollback.v1');
    expect(mediaRollbackGuard).toContain('phub.community-logo-rollback.v1');
    expect(mediaRollbackGuard).not.toContain('payload::text like');
    expect(mediaRollbackGuard).toContain("item->>'logoUrl' like");
    expect(clientRoutingRunbook).toContain('PHUB_MEDIA_ROLLBACK_MODE=feature');
    expect(clientRoutingRunbook).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media');
    expect(clientRoutingRunbook).toContain('PHUB_MEDIA_ROLLBACK_MODE=compatible-client');
    expect(clientRoutingRunbook).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo');
    expect(clientRoutingRunbook).toContain('PHUB_MEDIA_ROLLBACK_MODE=compatible-logo');
    expect(clientRoutingRunbook).toMatch(
      /For such a rollback,[\s\S]{0,180}`PHUB_MEDIA_ROLLBACK_MODE=feature`/,
    );
    expect(clientRoutingRunbook).not.toMatch(
      /For such a rollback,[\s\S]{0,180}`PHUB_MEDIA_ROLLBACK_MODE=compatible-(?:client|logo)`/,
    );
    expect(applicationRollback).toContain('PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER');
    expect(applicationRollback).toContain('attested worker container changed');
    expect(applicationRollback).toContain('WORKER_IMAGE_DIGEST');
    expect(applicationRollback).toContain('phub.client-media-rollback.v1');
    expect(compatibleWorkerRestore).toContain('CLIENT_MEDIA_ROLLBACK_V1=true');
    expect(applicationRollback).toContain('phub.community-logo-rollback.v1');
    expect(compatibleWorkerRestore).toContain('COMMUNITY_LOGO_ROLLBACK_V1=true');
    expect(clientRoutingRunbook).toMatch(
      /current migration chain ends at\s+`0081_community_logo_stable_delivery_validate\.sql`/,
    );
    expect(clientRoutingRunbook).toContain('0079_profile_photo_client_assisted_source.sql');
    expect(clientRoutingRunbook).toContain('0080_community_logo_stable_delivery.sql');
    expect(clientRoutingRunbook).toContain('0081_community_logo_stable_delivery_validate.sql');
    expect(clientRoutingRunbook).toMatch(/Do not down-migrate `0079`, `0080` or\s+`0081`/);
    expect(clientRoutingRunbook).toContain('normal repeat-deploy rollback is stable-to-stable');
    expect(clientRoutingRunbook).toContain('returning community logos to signed URLs');
    expect(rollbackRunbook).toContain(
      'Migrations `0079`, `0080` and `0081` remain applied in both rollback paths.',
    );
    for (const schema of ['CommunityMinimalView', 'CommunityPublicView', 'CommunityMemberView']) {
      const schemaBlock = userApiContract.match(
        new RegExp(`^    ${schema}:[\\s\\S]*?(?=^    [A-Z][A-Za-z0-9]+:)`, 'm'),
      )?.[0];
      expect(schemaBlock, `${schema} must be present`).toBeDefined();
      expect(schemaBlock).toContain(
        "pattern: '^(https?://.+|/public/api/v1/media/community-logos/[0-9a-f-]{36}/[0-9a-f-]{36})$'",
      );
    }
    expect(stagingWorkflow).toContain('prepare-compatible-worker-rollback.sh');
    expect(stagingWorkflow).toContain('PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER=true');
    expect(stagingWorkflow).toContain('guard_status="$?"');
    expect(stagingWorkflow).toContain('42)');
    expect(stagingWorkflow).toContain('43)');
    expect(stagingWorkflow).toContain('compatibility_floor=client-media');
    expect(stagingWorkflow).toContain('compatible_guard_mode=compatible-client');
    expect(stagingWorkflow).toContain('compatibility_floor=community-logo');
    expect(stagingWorkflow).toContain('compatible_guard_mode=compatible-logo');
    expect(runtimeFlagStep).toContain(
      "if: ${{ inputs.deployment_profile != 'COMMUNITIES_LEGACY_READ_ONLY' }}",
    );
    expect(runtimeFlagStep).toContain('verify-live-staging-data.sh runtime-flags');
  });

  it('isolates the Communities legacy profile to API and proves its read-only source path', () => {
    const apiService = stagingCompose.match(/\n {2}api:\n([\s\S]*?)\n {2}realtime:/)?.[1];
    const workerService = stagingCompose.match(/\n {2}worker:\n([\s\S]*?)\n {2}migrator:/)?.[1];
    const realtimeService = stagingCompose.match(/\n {2}realtime:\n([\s\S]*?)\n {2}worker:/)?.[1];

    expect(apiService).toContain('RUNTIME_COMMUNITIES_ENV_FILE');
    expect(workerService).not.toContain('RUNTIME_COMMUNITIES_ENV_FILE');
    expect(realtimeService).not.toContain('RUNTIME_COMMUNITIES_ENV_FILE');
    expect(communitiesReadOnlyActivation).toContain('stop_and_verify worker');
    expect(communitiesReadOnlyActivation).toContain('stop_and_verify realtime');
    expect(communitiesReadOnlyActivation).toContain('compose ps --status running -q');
    expect(communitiesReadOnlyActivation).toContain('restore_profile');
    expect(communitiesReadOnlyActivation).not.toMatch(
      /compose up -d --force-recreate api[^\n]*\|\| true/,
    );
    expect(communitiesReadOnlyVerification).toContain('/lk/communities?view=summary');
    expect(communitiesReadOnlyActivation).toContain(
      'COMMUNITIES_LEGACY_BASE_URL=https://padlhub.su',
    );
    expect(communitiesReadOnlyVerification).toContain(
      'require_value COMMUNITIES_LEGACY_BASE_URL "$communities_legacy_base_url"',
    );
    expect(communitiesReadOnlyVerification).not.toContain('base_value COMMUNITIES_LEGACY_BASE_URL');
    expect(communitiesReadOnlyVerification).toContain(
      'integration.community_home_source_components',
    );
    expect(communitiesReadOnlyVerification).toContain('new SignJWT');
    expect(communitiesReadOnlyVerification).toContain('/community-views/$community_id');
    expect(communitiesReadOnlyVerification).toContain('authenticated_projection_ok=true');
  });

  it('allows production promotion only from a successful Full Live Home staging gate', () => {
    expect(stagingWorkflow).toContain("inputs.deployment_profile == 'FULL_LIVE_HOME'");
    expect(stagingWorkflow).toContain('name: production-promotion-eligibility');
    expect(stagingWorkflow).toContain('PROFILE=FULL_LIVE_HOME');
    expect(productionWorkflow).toContain('name: production-promotion-eligibility');
    expect(productionWorkflow).toContain('Require the full staging promotion profile');
    expect(productionWorkflow).toContain('= FULL_LIVE_HOME');
    expect(productionWorkflow).toContain('= "$RELEASE"');
    expect(productionWorkflow).toContain('= "$RUN_ID"');
  });

  it('keeps migrator DDL credentials out of application runtime services', () => {
    const stagingWeb = stagingCompose.match(/\n {2}web:\n([\s\S]*?)\n {2}api:/)?.[1];
    const stagingMigrator = stagingCompose.match(/\n {2}migrator:\n([\s\S]*?)\n\nnetworks:/)?.[1];
    const productionMigrator = productionCompose.match(
      /\n {2}migrator:\n([\s\S]*?)\n\nnetworks:/,
    )?.[1];

    for (const migrator of [stagingMigrator, productionMigrator]) {
      expect(migrator).toBeDefined();
      expect(migrator).toContain('env_file: []');
      expect(migrator).toContain('DATABASE_URL: ${MIGRATOR_DATABASE_URL:-}');
      expect(migrator).not.toContain('RUNTIME_ENV_FILE');
    }
    expect(stagingWeb).toBeDefined();
    expect(stagingWeb).toContain('env_file: []');
    expect(stagingWeb).not.toContain('RUNTIME_ENV_FILE');

    expect(stagingWorkflow).toContain('migrator_env=/etc/phub/staging.migrator.env');
    expect(productionWorkflow).toContain('migrator_env=/etc/phub/migrator.env');
    for (const workflow of [stagingWorkflow, productionWorkflow]) {
      const normalizedWorkflow = workflow.replaceAll('\\"', '"');
      expect(normalizedWorkflow).toContain('test "$(stat -c %a "$migrator_env")" = 600');
      expect(normalizedWorkflow).toContain('test ! "$runtime_env" -ef "$migrator_env"');
      expect(normalizedWorkflow).toContain(
        'test "$runtime_database_url" != "$migrator_database_url"',
      );
      expect(normalizedWorkflow).toContain(
        '--entrypoint node migrator apps/migrator/dist/verify-role-boundary.js',
      );
      expect(normalizedWorkflow).toContain(
        '-e RUNTIME_DATABASE_URL -e MIGRATOR_DATABASE_URL -e DATABASE_ROLE_BOUNDARY_PHASE',
      );
      expect(normalizedWorkflow).toContain('DATABASE_ROLE_BOUNDARY_PHASE=pre');
      expect(normalizedWorkflow).toContain('DATABASE_ROLE_BOUNDARY_PHASE=post');
      expect(
        normalizedWorkflow.match(
          /--entrypoint node migrator apps\/migrator\/dist\/verify-role-boundary\.js/g,
        ),
      ).toHaveLength(2);
      expect(normalizedWorkflow).toContain('MIGRATOR_DATABASE_URL="$migrator_database_url"');
    }
  });

  it('moves the Viva callback to HTTPS before the API consumes it', () => {
    const legacyIpSite = caddyfile.match(/http:\/\/185\.155\.18\.146 \{([\s\S]*?)\n\}/)?.[1];

    expect(legacyIpSite).toBeDefined();
    expect(legacyIpSite).toContain('@viva_callback path /user/api/v1/*/auth/viva/callback');
    expect(legacyIpSite).toContain('redir @viva_callback https://lk.nano.padlhub.su{uri} 302');
    expect(legacyIpSite).toContain('redir https://lk.nano.padlhub.su{uri} permanent');
    expect(legacyIpSite).not.toContain('reverse_proxy');
  });

  it('keeps CUP API calls same-origin and limits the PadlHub route set', () => {
    expect(caddyfile).toContain('@padlhub_api path /user/api/* /admin/api/* /public/api/*');
    expect(caddyfile).toMatch(/handle @padlhub_api\s*\{\s*reverse_proxy api:3000\s*}/);
    expect(caddyfile).toMatch(/handle\s*\{\s*reverse_proxy showcase-proxy:80\s*}/);
  });

  it('publishes realtime health probes without changing the WebSocket route', () => {
    const tlsPromotion = stagingWorkflow.match(
      /name: Promote canonical Nano TLS ingress\n([\s\S]*?)\n {6}- name: Verify local HomeBase projections/,
    )?.[1];

    expect(nginxConfig).toMatch(
      /location = \/realtime\/health\/live\s*\{[\s\S]*?http:\/\/realtime:3001\/health\/live;[\s\S]*?\}/,
    );
    expect(nginxConfig).toMatch(
      /location = \/realtime\/health\/ready\s*\{[\s\S]*?http:\/\/realtime:3001\/health\/ready;[\s\S]*?\}/,
    );
    expect(nginxConfig).toMatch(
      /location \^~ \/realtime\/\s*\{[\s\S]*?proxy_set_header Upgrade \$http_upgrade;[\s\S]*?proxy_pass \$realtime_upstream;[\s\S]*?\}/,
    );
    expect(tlsPromotion).toContain(
      'probe_canonical_ready https://lk.nano.padlhub.su/realtime/health/ready',
    );
    expect(tlsPromotion).toContain('while [ "$attempt" -lt 15 ]; do');
    expect(tlsPromotion).toContain('--connect-timeout 2');
    expect(tlsPromotion).toContain('--max-time 5');
    expect(tlsPromotion).toContain('sleep 2');
    expect(tlsPromotion).toMatch(
      /if \[ "\$ingress_ready" -ne 1 \]; then[\s\S]*?rollback_caddy[\s\S]*?exit 1/,
    );
  });

  it('activates browser read jobs only with a usable mixed routing envelope', () => {
    expect(activation).toContain("printf 'VIVA_DIRECT_READ_ENABLED=true\\n'");
    expect(activation).toContain("plan.mode = 'MIXED_END_USER_READS'");
    expect(activation).toContain("plan.direct_read_operations @> array['profile.read']::text[]");
    expect(activation).toContain("binding.provider = 'VIVA'");
    expect(verification).toContain('require_value VIVA_DIRECT_READ_ENABLED true');
    expect(verification).toContain('routing_ready_delegations');
  });

  it('captures redacted candidate-worker evidence before a failed Live Home rollback', () => {
    const failureGate = activation.slice(
      activation.indexOf('if test "$projection_ready" -ne 1; then'),
      activation.indexOf('write_runtime_override projection'),
    );
    const restoreOverride = failureGate.indexOf(
      'write_runtime_override "$previous_home_read_mode"',
    );
    const captureEvidence = failureGate.indexOf(
      'sh /opt/phub/diagnose-live-home-source-failures.sh "$activation_started" worker',
    );
    const recreateWorker = failureGate.indexOf('compose up -d --force-recreate worker');

    expect(stagingWorkflow).toContain('scp deploy/jetson/diagnose-live-home-source-failures.sh');
    expect(restoreOverride).toBeGreaterThan(-1);
    expect(captureEvidence).toBeGreaterThan(restoreOverride);
    expect(recreateWorker).toBeGreaterThan(captureEvidence);
    expect(failureGate).toContain('continuing worker rollback');
    expect(liveHomeSourceDiagnostic).toContain('timeout 15 docker logs --since="$since"');
    expect(liveHomeSourceDiagnostic).toContain('Viva Home read operation');
    expect(liveHomeSourceDiagnostic).toContain('providerTenantKey');
    expect(workerMain).toContain("logger.info({ metric }, 'Viva Home read operation')");
    expect(workerMain).not.toContain(
      "logger.info({ metric, providerTenantKey }, 'Viva Home read operation')",
    );
  });

  it('activates Nano client-assisted Viva reads without the blocked server Home sync', () => {
    expect(stagingWorkflow).toContain("inputs.deployment_profile == 'CLIENT_ASSISTED_VIVA'");
    expect(stagingWorkflow).toContain(
      'Activate and verify client-assisted Viva reads independently of Home sync',
    );
    expect(stagingWorkflow).toContain('sh /opt/phub/activate-client-assisted-viva.sh');
    expect(stagingWorkflow).toContain('sh /opt/phub/verify-client-assisted-viva.sh');
    expect(clientAssistedActivation).toContain("printf '%s\\n' 'VIVA_DIRECT_READ_ENABLED=true'");
    expect(clientAssistedActivation).toContain("printf '%s\\n' 'HOME_VIVA_SYNC_ENABLED=false'");
    expect(clientAssistedActivation).toContain(
      "printf '%s\\n' 'HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED=false'",
    );
    expect(clientAssistedActivation).toContain('previous_home_read_mode');
    expect(clientAssistedActivation).toContain("plan.mode = 'MIXED_END_USER_READS'");
    expect(clientAssistedActivation).toContain(
      "plan.direct_read_operations = array['profile.read']::text[]",
    );
    expect(clientAssistedActivation).toContain('other_mixed_plans');
    expect(clientAssistedActivation).toContain('restoring the previous runtime override');
    expect(clientAssistedVerification).toContain('require_value VIVA_DIRECT_READ_ENABLED true');
    expect(clientAssistedVerification).toContain('require_value HOME_VIVA_SYNC_ENABLED false');
    expect(clientAssistedVerification).toContain(
      'require_value CORS_ORIGINS https://lk.nano.padlhub.su',
    );
    expect(clientAssistedVerification).toContain(
      'require_value VIVA_OAUTH_REDIRECT_URI https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/viva/callback',
    );
    expect(clientAssistedVerification).toContain('/booking-screen-read-jobs');
    expect(clientAssistedVerification).toContain('/activity-history-read-jobs');
    expect(clientAssistedVerification).toContain('surface: "GAMES"');
    expect(clientAssistedVerification).toContain('surface: "TRAININGS"');
    expect(clientAssistedVerification).toContain('Origin: https://lk.nano.padlhub.su');
    expect(clientAssistedVerification).toContain('Nano CORS accepted');
  });

  it('changes the staging routing plan only through a confirmed audited operator', () => {
    expect(stagingRoutingWorkflow).not.toMatch(/^ {2}push:/m);
    expect(stagingRoutingWorkflow).toMatch(/^ {2}workflow_dispatch:/m);
    expect(stagingRoutingWorkflow).toContain('REQUEST_REF: ${{ github.ref }}');
    expect(stagingRoutingWorkflow).toContain('[ "$REQUEST_REF" != \'refs/heads/main\' ]');
    expect(stagingRoutingWorkflow).toContain('APPLY_ROUTING_PLAN');
    expect(stagingRoutingWorkflow).toContain('environment: staging');
    expect(stagingRoutingWorkflow).toContain('Validate the requested routing plan without writes');
    expect(stagingRoutingWorkflow).toContain('Apply the audited routing plan');
    expect(stagingRoutingWorkflow).toContain("needs.validate-request.outputs.apply == 'true'");
    expect(stagingRoutingOperator).toContain('--mode MIXED_END_USER_READS');
    expect(stagingRoutingOperator).toContain('--operations profile.read');
    expect(stagingRoutingOperator).toContain('--valid-for-seconds 60');
    expect(stagingRoutingOperator).toContain('set -- "$@" --apply');
    expect(stagingRoutingOperator).toContain('--experimental-strip-types');
    expect(stagingRoutingOperator).toContain(
      '/opt/phub/set-client-routing-plan.ts:/app/set-client-routing-plan.ts:ro',
    );
    const homeBaseGate = stagingWorkflow.indexOf('Verify local HomeBase projections');
    const routingRefresh = stagingWorkflow.indexOf(
      'Refresh the audited routing plan for browser-assisted Viva reads',
    );
    const liveHomeActivation = stagingWorkflow.indexOf('Activate and verify live Home projection');
    expect(homeBaseGate).toBeGreaterThan(-1);
    expect(routingRefresh).toBeGreaterThan(homeBaseGate);
    expect(liveHomeActivation).toBeGreaterThan(routingRefresh);
    expect(stagingWorkflow).toContain(
      'routing-mixed-deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}',
    );
    expect(stagingWorkflow).toContain('"$reason" false');
    expect(stagingWorkflow).toContain('"$reason" true');
  });

  it('bounds communities and activates all four independent CUP placements', () => {
    for (const capability of ['DETAIL', 'FEED', 'CHAT', 'RATING']) {
      expect(activation).toContain(`printf 'COMMUNITY_LEGACY_READ_${capability}_ENABLED=true\\n'`);
      expect(verification).toContain(
        `require_value COMMUNITY_LEGACY_READ_${capability}_ENABLED true`,
      );
      expect(verification).toContain(`env.COMMUNITY_LEGACY_READ_${capability}_ENABLED !== 'true'`);
    }
    expect(activation).toContain("printf 'COMMUNITIES_LEGACY_TIMEOUT_MS=2500\\n'");
    expect(activation).toContain("printf 'COMMUNITIES_LEGACY_MAX_ATTEMPTS=1\\n'");
    expect(activation).toContain('PROMOTIONS_HERO_PLACEMENT=cabinet_home_top');
    expect(activation).toContain('PROMOTIONS_RECOMMENDATION_STRIP_PLACEMENT=cabinet_for_me_strip');
    expect(activation).toContain('PROMOTIONS_RECOMMENDATION_CARD_PLACEMENT=cabinet_for_me_card');
    expect(verification).toContain("['cabinet_home_top', '/api/advertising/cabinet-home-top']");
    expect(verification).toContain(
      "['cabinet_for_me_card', '/api/advertising/cabinet-for-me-card']",
    );
  });

  it('provides a Viva-independent Communities legacy read-only staging profile', () => {
    expect(stagingWorkflow).toContain('COMMUNITIES_LEGACY_READ_ONLY');
    expect(stagingWorkflow).toContain(
      'Activate and verify Communities legacy read-only projection',
    );
    expect(stagingWorkflow).toContain(
      "inputs.deployment_profile == 'COMMUNITIES_LEGACY_READ_ONLY'",
    );
    expect(communitiesReadOnlyActivation).toContain('compose up -d --force-recreate api');
    expect(communitiesReadOnlyActivation).not.toContain('force-recreate worker');
    expect(communitiesReadOnlyActivation).not.toContain('force-recreate realtime');
    expect(communitiesReadOnlyActivation).toContain(
      'sh /opt/phub/verify-communities-legacy-read-only.sh',
    );
    expect(communitiesReadOnlyActivation).toContain('restoring the previous process state');
    expect(communitiesReadOnlyActivation).toContain('restore_profile');
    for (const capability of ['DETAIL', 'FEED', 'CHAT', 'RATING']) {
      expect(communitiesReadOnlyActivation).toContain(
        `COMMUNITY_LEGACY_READ_${capability}_ENABLED=true`,
      );
      expect(communitiesReadOnlyVerification).toContain(
        `require_value COMMUNITY_LEGACY_READ_${capability}_ENABLED true`,
      );
    }
    expect(communitiesReadOnlyVerification).not.toContain('VIVA_DELEGATION');
    expect(communitiesReadOnlyVerification).not.toContain('MIXED_END_USER_READS');
  });

  it('requires same-origin CUP notifications, tenant authorization and shared engagement key', () => {
    expect(cupVerification).toContain(
      'PADLHUB_NOTIFICATION_API_BASE_URL https://cup.nano.padlhub.su',
    );
    expect(cupVerification).toContain("'notifications.manage' = any(access.permissions)");
    expect(cupVerification).toContain('cup_engagement_secret" != "$api_engagement_secret');
    expect(cupVerification).not.toContain('echo "$api_engagement_secret"');
    expect(cupVerification).toContain('API and worker WEB_PUSH_ENABLED gates must match');
    expect(cupVerification).toContain('normalized_web_push_origins');
    expect(cupVerification).toContain(
      'Enabled Web Push requires the same app ID in API and worker',
    );
    expect(cupVerification).toContain(
      'Enabled Web Push requires the same environment in API and worker',
    );
    expect(cupVerification).toContain(
      'Enabled Web Push requires the same non-empty endpoint-origin allowlist in API and worker',
    );
  });
});
