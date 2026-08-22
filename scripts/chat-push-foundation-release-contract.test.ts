import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const workflow = repositoryFile('.github/workflows/deploy-staging.yaml');
const releaseHelper = repositoryFile('deploy/jetson/run-chat-push-foundation-release.sh');
const cloneVerifier = repositoryFile('deploy/jetson/verify-chat-push-foundation-clone.sh');
const runtimeVerifier = repositoryFile('deploy/jetson/verify-chat-push-foundation-runtime.sh');
const stagingCompose = repositoryFile('deploy/compose.staging.yaml');
const backup = repositoryFile('deploy/jetson/backup-application.sh');
const rollback = repositoryFile('deploy/jetson/rollback-application.sh');

describe('chat/push staging foundation release contract', () => {
  it('requires an explicit solo-owner, main-only, non-rerunnable request', () => {
    expect(workflow).toContain('- CHAT_PUSH_FOUNDATION');
    expect(workflow).toContain('- CHAT_PUSH_FOUNDATION_RECOVERY');
    expect(workflow).toContain('APPLY_CHAT_PUSH_FOUNDATION_STAGING');
    expect(workflow).toContain('RESUME_CHAT_PUSH_FOUNDATION_STAGING');
    expect(workflow).toContain('NO_BOOKING_PRODUCER_ACTIVE');
    expect(workflow).toContain('[ "$REQUEST_REF" != \'refs/heads/main\' ]');
    expect(workflow).toContain('[ "$RUN_ATTEMPT" != 1 ]');
    expect(workflow).toContain('github.run_attempt == 1');
    expect(workflow).toContain('[ "$ACTOR" != "$TRIGGERING_ACTOR" ]');
    expect(workflow).toContain('[ "$WORKFLOW_SHA" != "$REQUEST_SHA" ]');
    expect(workflow).toContain('environment: staging-foundation-maintenance');
    expect(workflow).toContain('APPROVED_SOLO_OWNER_V1');
    expect(workflow).not.toContain('APPROVED_WITH_REQUIRED_REVIEWER_V1');
    expect(workflow).toContain('STAGING_FOUNDATION_SOLO_OWNER_ID');
    expect(workflow).toContain('STAGING_FOUNDATION_OPERATOR_IDS');
    expect(workflow).toContain('[ "$ALLOWED_OPERATOR_IDS" = "$SOLO_OWNER_ID" ]');
    expect(workflow).toContain('[ "$ACTOR_ID" = "$SOLO_OWNER_ID" ]');
    expect(workflow).toContain('[ "$ACTOR" = "$REPOSITORY_OWNER" ]');
    expect(workflow).toContain('String(run.actor?.id) !== process.argv[5]');
    expect(workflow).toContain('String(run.triggering_actor?.id) !== process.argv[5]');
    expect(workflow).toContain('FOUNDATION_ACTION_REVISION_NOT_PINNED');
    expect(workflow).toContain('application/vnd.github.raw+json');
    expect(workflow).toContain('?ref=$REQUEST_SHA');
    expect(workflow).toContain('FOUNDATION_EXPECTED_CANDIDATE_SHA" != "$REQUEST_SHA');
    expect(releaseHelper).toContain('foundation workflow reruns are forbidden');
    expect(releaseHelper).toContain(
      'application backup release does not match the approved active release',
    );
  });

  it('gates every staging operation on immutable third-party Action revisions', () => {
    const useLines = workflow.split(/\r?\n/).filter((line) => /^\s*(?:-\s*)?uses\s*:/.test(line));
    const thirdPartyUses = useLines.filter((line) => !/^\s*(?:-\s*)?uses\s*:\s*\.\//.test(line));

    expect(useLines).toHaveLength(22);
    expect(thirdPartyUses).toHaveLength(22);
    for (const line of thirdPartyUses) {
      expect(line).toMatch(/^\s*(?:-\s*)?uses\s*:\s*[A-Za-z0-9_./-]+@[0-9a-f]{40}\s*(?:#.*)?$/);
    }
    expect(workflow).toContain('STAGING_ACTION_REVISION_NOT_PINNED');
    expect(workflow.indexOf('STAGING_ACTION_REVISION_NOT_PINNED')).toBeLessThan(
      workflow.indexOf('  set-user-access:'),
    );
  });

  it('repairs only the exact runtime env metadata through the solo-owner gate', () => {
    expect(workflow).toContain('REPAIR_STAGING_RUNTIME_ENV_PERMISSIONS');
    expect(workflow).toContain('mode=repair-runtime-env');
    expect(workflow).toContain('needs: [validate-request, authorize-foundation-maintenance]');
    expect(workflow).toContain('runtime_env=/etc/phub/staging.env');
    expect(workflow).toContain('[ ! -w /etc/phub ]');
    expect(workflow).toContain('test ! -L "$runtime_env"');
    expect(workflow).toContain('sudo -n chown phub-deploy:phub-deploy "$runtime_env"');
    expect(workflow).toContain('sudo -n chmod 0600 "$runtime_env"');
    expect(workflow).toContain(
      '[ "$(stat -c "%U:%G:%a" "$runtime_env")" = phub-deploy:phub-deploy:600 ]',
    );

    const repairStart = workflow.indexOf('  repair-foundation-runtime-env-permissions:');
    const repairEnd = workflow.indexOf('\n  set-user-access:', repairStart);
    const repairJob = workflow.slice(repairStart, repairEnd);
    expect(repairJob).not.toContain('cat ');
    expect(repairJob).not.toContain('docker compose');
    expect(repairJob).not.toContain('db:migrate');
    expect(repairJob).not.toContain('CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK');
  });

  it('keeps the ACK in one helper command after drain and final backup only', () => {
    expect(workflow).not.toContain('CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK');
    expect(releaseHelper.match(/CHAT_PUSH_FOUNDATION_MAINTENANCE_V1/g)).toHaveLength(1);
    expect(releaseHelper).toContain('-e CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK');
    expect(releaseHelper).toContain('MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS=30000');
    expect(releaseHelper).toContain('-e MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS migrator');
    expect(releaseHelper).not.toContain('release.env <<');

    const operationalStart = releaseHelper.indexOf('pre_result="$(foundation_verify pre)"');
    const stop = releaseHelper.indexOf('compose stop api worker realtime', operationalStart);
    const drained = releaseHelper.indexOf('foundation_verify drained', stop);
    const dump = releaseHelper.indexOf('pg_dump -U', drained);
    const restore = releaseHelper.indexOf('VERIFY_CHAT_PUSH_FOUNDATION_BACKUP', dump);
    const secondDrained = releaseHelper.indexOf('foundation_verify drained', drained + 1);
    const clone = releaseHelper.indexOf('verify-chat-push-foundation-clone.sh', secondDrained);
    const finalRolePre = releaseHelper.indexOf('role_verify pre', clone);
    const finalRuntimeDrain = releaseHelper.indexOf(
      'verify-chat-push-foundation-runtime.sh" drained',
      clone,
    );
    const finalContour = releaseHelper.indexOf('contour_verify', finalRuntimeDrain);
    const finalRabbit = releaseHelper.indexOf('verify_rabbit_inventory false', finalContour);
    const applyCall = releaseHelper.indexOf('apply_foundation_migrations', finalRolePre);
    const applyFunctionStart = releaseHelper.indexOf('apply_foundation_migrations()');
    const phaseMarker = releaseHelper.indexOf('MIGRATION_STARTED', applyFunctionStart);
    const acknowledgement = releaseHelper.indexOf(
      'CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_MAINTENANCE_V1',
      phaseMarker,
    );
    const postVerification = releaseHelper.indexOf('verify_post_migration', applyCall);

    expect(operationalStart).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(operationalStart);
    expect(drained).toBeGreaterThan(stop);
    expect(dump).toBeGreaterThan(drained);
    expect(restore).toBeGreaterThan(dump);
    expect(secondDrained).toBeGreaterThan(restore);
    expect(clone).toBeGreaterThan(secondDrained);
    expect(finalRolePre).toBeGreaterThan(clone);
    expect(finalRuntimeDrain).toBeGreaterThan(clone);
    expect(finalContour).toBeGreaterThan(finalRuntimeDrain);
    expect(finalRabbit).toBeGreaterThan(finalContour);
    expect(finalRolePre).toBeGreaterThan(finalRabbit);
    expect(applyCall).toBeGreaterThan(finalRolePre);
    expect(phaseMarker).toBeGreaterThan(applyFunctionStart);
    expect(acknowledgement).toBeGreaterThan(phaseMarker);
    expect(postVerification).toBeGreaterThan(applyCall);
  });

  it('has an exact recovery path that reuses evidence and never restores or restarts old writers', () => {
    const recoveryBranch = releaseHelper.slice(
      releaseHelper.indexOf('else\n  verify_monitoring_digest'),
      releaseHelper.indexOf('verify_post_migration\nstart_candidate_runtime'),
    );

    expect(recoveryBranch).toContain('recovery_pending="$(pending_foundation_count');
    expect(recoveryBranch).toContain('apply_foundation_migrations');
    expect(recoveryBranch).not.toContain('pg_dump');
    expect(recoveryBranch).not.toContain('verify-postgres-backup-restore');
    expect(recoveryBranch).not.toContain('verify-chat-push-foundation-clone');
    expect(releaseHelper).toContain('stored candidate release digest mismatch');
    expect(releaseHelper).toContain('active release changed after the failed foundation run');
    expect(workflow).toContain(
      'cmp /opt/phub/release.env "$backup_dir/foundation.candidate-release.env"',
    );
    expect(releaseHelper).toContain('foundation pending set changed during recovery preflight');
    expect(releaseHelper).toContain('write_phase_marker RECOVERY_STARTED');
    expect(releaseHelper).toContain('write_phase_marker RECOVERY_DRAINING');
    expect(releaseHelper).toContain('write_phase_marker RECOVERY_WRITERS_DRAINED');
    expect(releaseHelper.indexOf('write_phase_marker RECOVERY_STARTED')).toBeLessThan(
      releaseHelper.indexOf('available_kb="$(df -Pk /'),
    );
    const prepareRecovery = workflow.indexOf('prepare-recovery');
    const installDefinitions = workflow.indexOf('name: Install release and ingress definitions');
    expect(prepareRecovery).toBeGreaterThan(-1);
    expect(installDefinitions).toBeGreaterThan(prepareRecovery);
    expect(workflow).toContain(
      'compose_next="/opt/phub/.compose-staging-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.next"',
    );
    expect(workflow).toContain('trap cleanup_compose_next EXIT HUP INT TERM');
    expect(workflow).not.toContain('phub-deploy@$HOST:/opt/phub/compose.yaml"');
    const composeValidation = workflow.indexOf(
      '-f "$compose_next" config --quiet --no-interpolate',
      installDefinitions,
    );
    const composeActivation = workflow.indexOf(
      'mv "$compose_next" /opt/phub/compose.yaml',
      composeValidation,
    );
    expect(composeValidation).toBeGreaterThan(installDefinitions);
    expect(composeActivation).toBeGreaterThan(composeValidation);
    expect(workflow).toContain('foundation.candidate-release.env');
    expect(workflow).toContain('candidate-active "$candidate_release"');
    expect(runtimeVerifier).toContain("'{{.State.Health.Status}}'");
    expect(runtimeVerifier).toContain("'{{.Config.Image}}'");
    expect(workflow).toContain('Contain a failed foundation recovery without starting old writers');
    expect(workflow).toContain('EXTERNAL_SMOKE_FAILED');
    expect(workflow).toContain('run-id: ${{ inputs.foundation_original_run_id }}');
    expect(workflow).toContain('FOUNDATION_ORIGINAL_RUN_MISMATCH');
    expect(workflow).toContain('run.head_sha !== process.argv[4]');
    expect(workflow).toContain("run.path !== '.github/workflows/deploy-staging.yaml'");
    expect(workflow).toContain(
      "needs.verify.result == 'success' && inputs.deployment_profile != 'CHAT_PUSH_FOUNDATION_RECOVERY'",
    );
  });

  it('starts digest-pinned API, worker, realtime and web strictly in that order', () => {
    const api = releaseHelper.indexOf('compose up -d --no-deps api');
    const runtimeMarker = releaseHelper.indexOf('write_phase_marker CANDIDATE_RUNTIME_STARTING');
    const apiAttest = releaseHelper.indexOf('api-ready', api);
    const worker = releaseHelper.indexOf('compose up -d --no-deps worker', apiAttest);
    const workerAttest = releaseHelper.indexOf('worker-ready', worker);
    const realtime = releaseHelper.indexOf('compose up -d --no-deps realtime', workerAttest);
    const realtimeAttest = releaseHelper.indexOf('realtime-ready', realtime);
    const web = releaseHelper.indexOf('compose up -d --no-deps web', realtimeAttest);
    const live = releaseHelper.indexOf('foundation_verify live', web);

    expect(api).toBeGreaterThan(-1);
    expect(runtimeMarker).toBeGreaterThan(-1);
    expect(api).toBeGreaterThan(runtimeMarker);
    expect(apiAttest).toBeGreaterThan(api);
    expect(worker).toBeGreaterThan(apiAttest);
    expect(workerAttest).toBeGreaterThan(worker);
    expect(realtime).toBeGreaterThan(workerAttest);
    expect(realtimeAttest).toBeGreaterThan(realtime);
    expect(web).toBeGreaterThan(realtimeAttest);
    expect(live).toBeGreaterThan(web);
  });

  it('rehearses the exact migration on an owned clone without leaking the target acknowledgement', () => {
    expect(cloneVerifier).toContain('createdb -U "$POSTGRES_USER"');
    expect(cloneVerifier).toContain('--template="$POSTGRES_DB"');
    expect(cloneVerifier).toContain('clone_role_verify pre');
    expect(cloneVerifier).toContain('clone_foundation_verify post');
    expect(cloneVerifier).toContain('CHAT_PUSH_FOUNDATION_CAPTURE_CATALOG_BASELINE=true');
    expect(cloneVerifier).toContain('catalog_digest=');
    expect(cloneVerifier).toContain('clone_migrate false');
    expect(cloneVerifier).not.toContain('-e CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK');
    expect(cloneVerifier).toContain('trap on_exit EXIT');
    expect(cloneVerifier).toContain('trap on_signal HUP INT TERM');
    expect(cloneVerifier).toContain('exit 130');
  });

  it('binds exact database, catalog, Rabbit and Prometheus evidence to the release', () => {
    expect(releaseHelper).toContain('verify-chat-push-foundation-contour.js');
    expect(releaseHelper).toContain('CHAT_PUSH_FOUNDATION_EXPECTED_CATALOG_DIGEST');
    expect(releaseHelper).toContain('verify-chat-push-foundation-operational.js "$rabbit_mode"');
    expect(releaseHelper).toContain('verify-chat-push-foundation-operational.js prometheus');
    expect(releaseHelper).toContain(
      'verify-chat-push-foundation-operational.js prometheus-targets',
    );
    expect(releaseHelper).toContain(
      'verify-chat-push-foundation-operational.js prometheus-heartbeat',
    );
    expect(releaseHelper).toContain(
      'verify-chat-push-foundation-operational.js prometheus-collection-success',
    );
    expect(releaseHelper).toContain(
      'verify-chat-push-foundation-operational.js prometheus-gauge-present',
    );
    expect(releaseHelper).toContain('phub_worker_operational_collection_heartbeat_unixtime');
    expect(releaseHelper).toContain('phub_worker_operational_collection_success');
    expect(releaseHelper).toContain(
      "*[!0-9a-f]*) fail 'candidate worker container identity is invalid'",
    );
    expect(releaseHelper).toContain(
      'phub_worker_notifications_booking_reminder_oldest_due_age_seconds',
    );
    expect(releaseHelper).toContain('verify_booking_quiet_window');
    expect(releaseHelper).toContain('quiet_deadline="$((quiet_started + 30))"');
    expect(releaseHelper).toContain('booking.confirmed.v1');
    expect(releaseHelper).toContain('booking.changed.v1');
    expect(workflow).toContain('monitoring.padlhub-alerts.yaml.absent');
    expect(workflow).toContain('--force-recreate prometheus');
    expect(workflow).toContain('release.foundation.${{ github.run_id }}.env');
    expect(workflow).toContain(
      'FOUNDATION_MONITORING_RULES_SHA256=$(sha256sum deploy/jetson/monitoring/padlhub-alerts.yaml',
    );
    expect(releaseHelper).toContain('candidate release env must contain exactly ten lines');
    expect(releaseHelper).toContain(
      'release_value "$candidate_release_env" FOUNDATION_MONITORING_RULES_SHA256',
    );
    expect(releaseHelper).toContain(
      'installed monitoring definition does not match candidate source',
    );
  });

  it('uses a final API/worker-only kill-switch overlay and snapshots both states', () => {
    expect(stagingCompose.match(/RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE/g)).toHaveLength(2);
    const api = stagingCompose.slice(
      stagingCompose.indexOf('  api:'),
      stagingCompose.indexOf('  realtime:'),
    );
    const realtime = stagingCompose.slice(
      stagingCompose.indexOf('  realtime:'),
      stagingCompose.indexOf('  worker:'),
    );
    const worker = stagingCompose.slice(
      stagingCompose.indexOf('x-application-runtime:'),
      stagingCompose.indexOf('x-realtime-runtime:'),
    );
    const migrator = stagingCompose.slice(stagingCompose.indexOf('  migrator:'));

    expect(api).toContain('RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE');
    expect(worker).toContain('RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE');
    expect(realtime).not.toContain('RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE');
    expect(migrator).not.toContain('RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE');
    expect(runtimeVerifier).toContain('foundation overlay must contain exactly three lines');
    expect(backup).toContain('staging.chat-push-foundation.env.absent');
    expect(rollback).toContain('staging.chat-push-foundation.env.absent');
  });

  it('preserves unrelated runtime files and excludes activation and promotion paths', () => {
    expect(releaseHelper).toContain(
      'for preserved in staging.auth.env staging.override.env staging.communities.env staging.games.env',
    );
    expect(releaseHelper).toContain('compare_preserved_file "$preserved"');
    expect(releaseHelper).not.toMatch(/activate-live-home|routing-plan|activate-communities|Caddy/);
    expect(workflow).toContain(
      "if: ${{ inputs.deployment_profile != 'CHAT_PUSH_FOUNDATION' && inputs.deployment_profile != 'CHAT_PUSH_FOUNDATION_RECOVERY' }}",
    );
    expect(workflow).not.toContain('FULL_LIVE_HOME');
    expect(workflow).not.toContain(
      "inputs.deployment_profile == 'FULL_LIVE_HOME' || inputs.deployment_profile == 'CHAT_PUSH_FOUNDATION'",
    );
    const boundedInstall = workflow.slice(
      workflow.indexOf(
        'if [ "$DEPLOYMENT_PROFILE" != CHAT_PUSH_FOUNDATION ] && [ "$DEPLOYMENT_PROFILE" != CHAT_PUSH_FOUNDATION_RECOVERY ]; then',
        workflow.indexOf('name: Install release and ingress definitions'),
      ),
      workflow.indexOf('scp deploy/jetson/verify-postgres-backup-restore.sh'),
    );
    expect(boundedInstall).toContain('activate-live-home.sh');
    expect(boundedInstall).toContain('activate-communities-legacy-read-only.sh');
    expect(boundedInstall).toContain('activate-client-assisted-viva.sh');
    expect(boundedInstall).toContain('run-client-routing-plan.sh');
    expect(boundedInstall.trimEnd()).toMatch(/fi$/);
  });

  it('binds the recovery backup by path, size, digest and archive readability', () => {
    expect(releaseHelper).toContain('database backup manifest must contain exactly one');
    expect(releaseHelper).toContain('PATH=$backup_path_value');
    expect(releaseHelper).toContain('SIZE=$backup_size_value');
    expect(releaseHelper).toContain('SHA256=$backup_sha256_value');
    expect(releaseHelper).toContain('stored database backup size mismatch');
    expect(releaseHelper).toContain('stored database backup digest mismatch');
    expect(releaseHelper).toContain('pg_restore --list < "$database_backup"');
  });

  it('blocks automatic old-writer rollback after the migration phase marker', () => {
    const rollbackStep = workflow.indexOf('name: Roll back a failed staging application release');
    const foundationGuard = workflow.indexOf('chat-push-foundation.phase', rollbackStep);
    const stop = workflow.indexOf('stop api worker realtime', foundationGuard);
    const mediaGuard = workflow.indexOf('PHUB_MEDIA_ROLLBACK_MODE=pre-cutover', stop);

    expect(foundationGuard).toBeGreaterThan(rollbackStep);
    expect(stop).toBeGreaterThan(foundationGuard);
    expect(mediaGuard).toBeGreaterThan(stop);
    expect(releaseHelper).toContain('trap on_signal HUP INT TERM');
    expect(releaseHelper).toContain(
      'Foundation phase marker is present; keeping every writer stopped.',
    );
    expect(releaseHelper).toContain('compose stop api worker realtime');
    expect(releaseHelper).toContain('Foundation database-session recheck failed');
    expect(releaseHelper.indexOf('release_completed=true')).toBeGreaterThan(
      releaseHelper.indexOf('foundation_verify live'),
    );
    expect(workflow).toContain('Monitoring was not mutated before the failed foundation install.');
    const monitoringRestore = workflow.indexOf('monitoring_restore_status="$?"', rollbackStep);
    const applicationRollback = workflow.indexOf(
      '--confirm=ROLLBACK_STAGING_RELEASE',
      monitoringRestore,
    );
    const monitoringFailure = workflow.indexOf(
      'Application rollback completed, but monitoring restoration failed',
      applicationRollback,
    );
    expect(monitoringRestore).toBeGreaterThan(rollbackStep);
    expect(applicationRollback).toBeGreaterThan(monitoringRestore);
    expect(monitoringFailure).toBeGreaterThan(applicationRollback);
  });
});
