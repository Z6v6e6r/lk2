import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const caddyfile = repositoryFile('deploy/jetson/tls-ingress/Caddyfile');
const nginxConfig = repositoryFile('deploy/jetson/nginx/default.conf');
const stagingWorkflow = repositoryFile('.github/workflows/deploy-staging.yaml');
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
    expect(validateJob).toContain('[ "$REQUEST_REF" != \'refs/heads/main\' ]');
    expect(validateJob).toContain('mode=diagnostics');
    expect(validateJob).toContain('mode=deploy');
    expect(diagnoseJob).toContain('needs: validate-request');
    expect(diagnoseJob).toContain("needs.validate-request.outputs.mode == 'diagnostics'");
    expect(diagnoseJob).not.toContain('deploy_confirmation');
    expect(buildGate).toContain('needs: validate-request');
    expect(buildGate).toContain("needs.validate-request.outputs.mode == 'deploy'");
    expect(deployGate).toContain('needs: [validate-request, build]');
    expect(deployGate).toContain('always()');
    expect(deployGate).toContain("needs.build.result == 'success'");
    expect(deployGate).toContain("needs.validate-request.outputs.mode == 'deploy'");
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
    expect(nginxConfig).toMatch(
      /location = \/realtime\/health\/live\s*\{[\s\S]*?http:\/\/realtime:3001\/health\/live;[\s\S]*?\}/,
    );
    expect(nginxConfig).toMatch(
      /location = \/realtime\/health\/ready\s*\{[\s\S]*?http:\/\/realtime:3001\/health\/ready;[\s\S]*?\}/,
    );
    expect(nginxConfig).toMatch(
      /location \^~ \/realtime\/\s*\{[\s\S]*?proxy_set_header Upgrade \$http_upgrade;[\s\S]*?proxy_pass \$realtime_upstream;[\s\S]*?\}/,
    );
    expect(stagingWorkflow).toContain(
      'https://lk.nano.padlhub.su/realtime/health/ready >/dev/null',
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
