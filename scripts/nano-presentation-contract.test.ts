import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const caddyfile = repositoryFile('deploy/jetson/tls-ingress/Caddyfile');
const nginxConfig = repositoryFile('deploy/jetson/nginx/default.conf');
const stagingWorkflow = repositoryFile('.github/workflows/deploy-staging.yaml');
const stagingRoutingWorkflow = repositoryFile('.github/workflows/set-staging-routing-plan.yaml');
const stagingRoutingOperator = repositoryFile('deploy/jetson/run-client-routing-plan.sh');
const migration0057Diagnostic = repositoryFile('deploy/jetson/diagnose-migration-0057.sh');
const testPlayerDiagnostic = repositoryFile('deploy/jetson/diagnose-test-player-delegations.sh');
const userAccessOperator = repositoryFile('deploy/jetson/run-user-access.sh');
const messagingReleaseVerification = repositoryFile(
  'deploy/jetson/verify-messaging-test-release.sh',
);
const activation = repositoryFile('deploy/jetson/activate-live-home.sh');
const verification = repositoryFile('deploy/jetson/verify-live-staging-data.sh');
const cupVerification = repositoryFile('deploy/jetson/verify-cup-integrations.sh');

describe('Nano presentation release contract', () => {
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
    expect(buildGate).toContain('needs: validate-request');
    expect(buildGate).toContain("needs.validate-request.outputs.mode == 'deploy'");
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
    expect(stagingWorkflow).toContain("inputs.deployment_profile == 'FULL_LIVE_HOME'");
    expect(stagingWorkflow).toContain("inputs.deployment_profile == 'MESSAGING_TEST'");
    expect(stagingWorkflow).toContain(
      'Verify messaging test release and preserve the current Home mode',
    );
    expect(stagingWorkflow).toContain(
      'cmp "$backup_dir/staging.override.env" /opt/phub/staging.override.env',
    );
    expect(messagingReleaseVerification).toContain('default_transaction_read_only=on');
    expect(messagingReleaseVerification).toContain("runtime_state\" = 'true|true|true'");
    expect(messagingReleaseVerification).toContain('0057_messaging_runtime.sql');
    expect(messagingReleaseVerification).toContain('"AUTH_REQUIRED"');
    expect(messagingReleaseVerification).toContain('/realtime/health/ready');
    expect(messagingReleaseVerification).not.toMatch(
      /^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/im,
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

    expect(stagingWorkflow).toContain(
      'STAGING_RELEASE_BACKUP_DIR: /opt/phub/backups/releases/pre-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(backupStep).toBeGreaterThan(-1);
    expect(backupStep).toBeLessThan(installStep);
    expect(rollbackStep).toBeGreaterThan(smokeStep);
    expect(stagingWorkflow).toContain('steps.application-backup.outputs.ready');
    expect(stagingWorkflow).toContain('failure() || cancelled()');
    expect(stagingWorkflow).toContain('BACKUP_STAGING_RELEASE');
    expect(stagingWorkflow).toContain('--validate-only');
    expect(stagingWorkflow).toContain('--confirm=ROLLBACK_STAGING_RELEASE');
    expect(stagingWorkflow).toContain('PHUB_ROLLBACK_BACKUP_ROOT=/opt/phub/backups/releases');
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
      'Refresh the audited routing plan immediately before live Home activation',
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

  it('requires same-origin CUP notifications, tenant authorization and shared engagement key', () => {
    expect(cupVerification).toContain(
      'PADLHUB_NOTIFICATION_API_BASE_URL https://cup.nano.padlhub.su',
    );
    expect(cupVerification).toContain("'notifications.manage' = any(access.permissions)");
    expect(cupVerification).toContain('cup_engagement_secret" != "$api_engagement_secret');
    expect(cupVerification).not.toContain('echo "$api_engagement_secret"');
  });
});
