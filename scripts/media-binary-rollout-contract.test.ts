import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const workflow = repositoryFile('.github/workflows/deploy-staging.yaml');
const baseline = repositoryFile('deploy/jetson/verify-media-staging-baseline.sh');
const ledger = repositoryFile('deploy/jetson/verify-media-migration-ledger.sh');
const rehearsal = repositoryFile('deploy/jetson/rehearse-media-migration.sh');
const apiSmoke = repositoryFile('deploy/jetson/verify-media-binary-api.sh');
const diskBudget = repositoryFile('deploy/jetson/verify-media-disk-budget.sh');
const rollbackGuard = repositoryFile('deploy/jetson/verify-media-rollback-safe.sh');
const stagingRunbook = repositoryFile('docs/runbooks/jetson-staging.md');
const clientRoutingRunbook = repositoryFile('docs/runbooks/client-routing-switch.md');

function workflowJob(name: string, nextName: string): string {
  const boundary = nextName ? `(?=^  ${nextName}:\\n)` : '(?![\\s\\S])';
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)${boundary}`, 'm'));
  if (!match?.[1]) throw new Error(`workflow job ${name} is missing`);
  return match[1];
}

describe('media binary-only staging rollout contract', () => {
  it('requires the exact active release and runs the media baseline before build', () => {
    const validate = workflowJob('validate-request', 'set-user-access');
    const mediaBaseline = workflowJob('media-baseline', 'verify');
    const verify = workflowJob('verify', 'build');

    expect(workflow).toContain('- MEDIA_BINARY_ONLY');
    expect(workflow).toContain('diagnose_media:');
    expect(workflow).toContain('expected_active_release:');
    expect(validate).toContain('^[0-9a-f]{40}$');
    expect(validate).toContain(
      'Expected active release is valid only for media diagnostics or MEDIA_BINARY_ONLY.',
    );
    expect(validate).toContain('Strict media diagnostics are read-only and cannot restart udisks.');
    expect(validate).toContain('or include foundation-maintenance inputs.');
    expect(mediaBaseline).toContain('Attest media baseline before build or staging writes');
    expect(mediaBaseline).toContain('< deploy/jetson/verify-media-staging-baseline.sh');
    expect(mediaBaseline).toContain('< deploy/jetson/verify-media-rollback-safe.sh');
    expect(mediaBaseline).not.toContain('scp ');
    expect(mediaBaseline).not.toContain('docker compose up');
    expect(verify).toContain("needs.media-baseline.result == 'success'");
    expect(workflow.indexOf('  media-baseline:')).toBeLessThan(workflow.indexOf('  build:'));
  });

  it('preserves the final-precedence chat/push overlay in the media baseline', () => {
    expect(baseline).toContain('staging.chat-push-foundation.env');
    expect(baseline).toContain('RUNTIME_CHAT_PUSH_FOUNDATION_ENV_FILE');
    expect(baseline).toContain('must not redirect the chat/push foundation overlay');
    expect(baseline).toContain('files="$foundation_runtime_env $app_root/staging.communities.env');
  });

  it('keeps the read-only baseline fail-closed across flags, migration journal and storage', () => {
    for (const flag of [
      'PROFILE_PHOTO_CLIENT_SYNC_ENABLED',
      'COMMUNITY_INVITES_ENABLED',
      'COMMUNITIES_REALTIME_ENABLED',
      'COMMUNITY_MEDIA_ENABLED',
      'COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED',
      'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED',
    ]) {
      expect(baseline).toContain(flag);
    }
    expect(baseline).toContain('default_transaction_read_only=on');
    expect(baseline).toContain('begin transaction read only;');
    expect(baseline).toContain('staging ledger contains an unknown migration');
    expect(baseline).toContain('staging migration checksum mismatch');
    expect(baseline).toContain(
      "approved_pending_migrations='0079_profile_photo_client_assisted_source.sql",
    );
    expect(baseline).toContain('0082_profile_photo_removal_commands.sql');
    expect(baseline).toContain('0083_profile_photo_removal_commands_validate.sql');
    for (const orderedState of [
      '0\\|0\\|0\\|0\\|0',
      '1\\|0\\|0\\|0\\|0',
      '1\\|1\\|0\\|0\\|0',
      '1\\|1\\|1\\|0\\|0',
      '1\\|1\\|1\\|1\\|0',
      '1\\|1\\|1\\|1\\|1',
    ]) {
      expect(baseline).toContain(orderedState);
    }
    expect(baseline).not.toContain('1\\|1\\|1\\|0\\|1');
    expect(baseline).toContain('profile_photo_client_commands_kind_check');
    expect(baseline).toContain('profile_photo_client_commands_payload_check');
    expect(baseline).toContain('pg_get_expr(conbin, conrelid)');
    expect(baseline).not.toContain('pg_get_constraintdef(oid)');
    expect(baseline).toContain("'2|0|2|4|1'");
    expect(baseline).toContain("'2|2|2|4|1'");
    expect(baseline).not.toContain(
      "approved_pending_migrations='0053_profile_visibility_sections.sql",
    );
    expect(baseline).toContain('media migration chain is partial or out of order');
    expect(baseline).toContain('media rollout requires PostgreSQL 16');
    expect(baseline).toContain('candidate Compose definition does not render');
    expect(baseline).toContain('active release registry is not approved');
    expect(baseline).toContain('is not running the digest recorded by the active release');
    expect(baseline).toContain('GetBucketVersioningCommand');
    expect(baseline).toContain('GetBucketPolicyCommand');
    expect(baseline).toContain('HeadObjectCommand');
    expect(baseline).toContain('policyAllowsAnonymousAccess');
    expect(baseline).toContain('lifecycleCanDeleteDurable');
    expect(baseline).toContain('"profile-photos/", "community-logos/", "community-media/ready/"');
    expect(baseline).toContain('MEDIA_QUARANTINE_CLEANUP_REQUIRED');
    expect(baseline).toContain('MEDIA_REFERENCED_OBJECT_PREFLIGHT_TIMEOUT');
    expect(baseline).toContain('head.ContentType !== "image/webp"');
    expect(baseline).toContain('GetObjectCommand');
    expect(baseline).toContain('hash.digest("hex") !== expectedSha256');
    expect(baseline).toContain('head.Metadata?.sha256 !== expectedSha256');
    expect(baseline).toContain('no existing profile-photo object');
    expect(baseline).toContain('no existing community-logo object');
    expect(baseline).toContain('referenced media object keys are malformed');
    expect(baseline).toContain('swap activity was observed');
    expect(baseline).toContain('more than 75 percent of swap is already used');
    expect(baseline).toContain('cgroup memory headroom');
    expect(baseline).toContain('memory PSI avg10 is unavailable or exceeds 1.00');
    expect(baseline).not.toContain('PutObjectCommand');
    expect(baseline).not.toMatch(/\b(insert|update|delete|truncate)\s+/i);
    expect(rollbackGuard).toContain('if test "$rollback_mode" != feature; then');
    expect(rollbackGuard).toContain('default_transaction_read_only=on');
    expect(rollbackGuard).toContain('statement_timeout=30000');
    expect(ledger).toContain('policy.polroles = array[0]::oid[]');
    expect(ledger).toContain('0044_contextual_messaging_projection.sql');
    expect(baseline).toContain('0044_contextual_messaging_projection.sql');
    expect(baseline).toContain('test "$legacy_alias_count" -le 2');
    expect(ledger).toContain(
      "tenant_id=nullifcurrent_setting''app.tenant_id''::text,true,''''::text::uuid",
    );
    expect(ledger).toContain('total_rls_policies=3');
    expect(ledger).toContain('validated_profile_command_constraints=2');
    expect(ledger).toContain('exact_profile_command_constraint_definitions=2');
    expect(ledger).toContain('profile_command_column_state=4');
    expect(ledger).toContain('profile_command_default=1');
    expect(ledger).toContain("media_invariants\" = '0|1|3|1|3|3|2|2|4|1'");
    expect(stagingRunbook).toContain('`0079` through `0083`');
    expect(stagingRunbook).toContain('`0082`-applied');
  });

  it('keeps the embedded storage probe syntactically valid', () => {
    const probe = baseline.match(
      /printf '%s\\n' "\$object_keys" \| compose exec -T worker node -e '\n([\s\S]*?)\n' \|\| fail/,
    )?.[1];

    expect(probe).toBeDefined();
    const syntax = spawnSync(process.execPath, ['--check', '-'], {
      encoding: 'utf8',
      input: probe ?? '',
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('fails the pre-write gate when a runtime file and serving container disagree', () => {
    const probe = baseline.match(
      /effective_config_fingerprint=.*?node -e '\n([\s\S]*?)\n' "\$api_container"/,
    )?.[1];
    expect(probe).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), 'phub-media-runtime-fingerprint-'));
    const docker = join(directory, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh
if test "$1" = image && test "$2" = inspect; then
  printf '[{"Config":{"Env":["NODE_ENV=production","NODE_VERSION=22.0.0","PATH=/usr/local/bin:/usr/bin","YARN_VERSION=1.22.22"]}}]\n'
  exit 0
fi
case "$2" in
  api) value="$FAKE_API_FLAG" ;;
  worker) value=false ;;
  realtime) value=false ;;
  *) exit 1 ;;
esac
printf '[{"Config":{"Env":["NODE_ENV=production","NODE_VERSION=22.0.0","PATH=/usr/local/bin:/usr/bin","YARN_VERSION=1.22.22","COMMUNITY_MEDIA_ENABLED=%s"' "$value"
if test -n "\${FAKE_EXTRA_ENV:-}"; then
  printf ',"%s"' "$FAKE_EXTRA_ENV"
fi
printf ']},"Image":"image-%s"}]\n' "$2"
`,
    );
    chmodSync(docker, 0o700);
    const candidate = JSON.stringify({
      services: {
        api: { environment: { COMMUNITY_MEDIA_ENABLED: 'false' } },
        worker: { environment: { COMMUNITY_MEDIA_ENABLED: 'false' } },
        realtime: { environment: { COMMUNITY_MEDIA_ENABLED: 'false' } },
      },
    });
    try {
      const matching = spawnSync(
        process.execPath,
        ['-e', probe ?? '', 'api', 'worker', 'realtime'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            FAKE_API_FLAG: 'false',
          },
          input: candidate,
        },
      );
      expect(matching.status, matching.stderr).toBe(0);
      expect(matching.stdout).toMatch(/^[0-9a-f]{64}$/);

      const drifted = spawnSync(
        process.execPath,
        ['-e', probe ?? '', 'api', 'worker', 'realtime'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            FAKE_API_FLAG: 'true',
          },
          input: candidate,
        },
      );
      expect(drifted.status).not.toBe(0);
      expect(drifted.stderr).toContain('RUNTIME_ENV_DRIFT:api:COMMUNITY_MEDIA_ENABLED');

      const undeclaredRuntimeOverride = spawnSync(
        process.execPath,
        ['-e', probe ?? '', 'api', 'worker', 'realtime'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            FAKE_API_FLAG: 'false',
            FAKE_EXTRA_ENV: 'NODE_OPTIONS=--use-openssl-ca',
          },
          input: candidate,
        },
      );
      expect(undeclaredRuntimeOverride.status).not.toBe(0);
      expect(undeclaredRuntimeOverride.stderr).toContain('RUNTIME_ENV_DRIFT:api:NODE_OPTIONS');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects destructive lifecycle rules for every durable media namespace', () => {
    const lifecycleSource = baseline.match(
      /(const lifecyclePrefix = [\s\S]*?)(?=\s{4}const lifecycleCleansQuarantine =)/,
    )?.[1];
    expect(lifecycleSource).toBeDefined();
    const durableRules = [
      '',
      'profile-',
      'profile-photos/',
      'profile-photos/tenant/',
      'community-logos/',
      'community-logos/tenant/',
      'community-media/ready/',
      'community-media/ready/tenant/',
    ].map((prefix) => ({
      Status: 'Enabled',
      Filter: { Prefix: prefix },
      Expiration: { Days: 30 },
    }));
    const rules = [
      ...durableRules,
      {
        Status: 'Enabled',
        Filter: { Prefix: 'community-media/quarantine/' },
        Expiration: { Days: 7 },
      },
      {
        Status: 'Enabled',
        Filter: { Prefix: 'profile-photos/' },
        Transitions: [{ Days: 1, StorageClass: 'GLACIER' }],
      },
    ];
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `${lifecycleSource}; process.stdout.write(JSON.stringify(${JSON.stringify(
          rules,
        )}.map(lifecycleCanDeleteDurable)));`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([...durableRules.map(() => true), false, true]);
  });

  it('rehearses the exact migration manifest on an isolated PostgreSQL 16 clone first', () => {
    const deploy = workflowJob('deploy', '');
    const restore = deploy.indexOf('sh /opt/phub/rehearse-media-migration.sh');
    const restoreCredential = deploy.lastIndexOf(
      'MIGRATOR_DATABASE_URL="$migrator_database_url"',
      restore,
    );
    const restoreRuntimeCredential = deploy.lastIndexOf(
      'RUNTIME_DATABASE_URL="$runtime_database_url"',
      restore,
    );
    const sharedMigration = deploy.indexOf(
      '-e "PGOPTIONS=-c lock_timeout=5000 -c statement_timeout=600000',
      restore + 1,
    );
    const sharedCredential = deploy.lastIndexOf(
      'MIGRATOR_DATABASE_URL="$migrator_database_url"',
      sharedMigration,
    );
    const postMigrationRoleBoundary = deploy.indexOf(
      'DATABASE_ROLE_BOUNDARY_PHASE=post',
      sharedMigration,
    );

    expect(restore).toBeGreaterThan(-1);
    expect(restoreCredential).toBeGreaterThan(-1);
    expect(restoreCredential).toBeLessThan(restore);
    expect(restoreRuntimeCredential).toBeGreaterThan(-1);
    expect(restoreRuntimeCredential).toBeLessThan(restore);
    expect(sharedMigration).toBeGreaterThan(restore);
    expect(sharedCredential).toBeGreaterThan(restore);
    expect(sharedCredential).toBeLessThan(sharedMigration);
    expect(postMigrationRoleBoundary).toBeGreaterThan(sharedMigration);
    expect(rehearsal).toContain('createdb -U "$POSTGRES_USER" --template=template0');
    expect(rehearsal).toContain('pg_restore -U "$POSTGRES_USER"');
    expect(rehearsal).not.toContain('pg_restore -U "$POSTGRES_USER" --dbname="$1" --no-owner');
    expect(deploy).toContain('pg_dump -U');
    expect(deploy).toContain('--format=custom');
    expect(deploy).not.toContain('--format=custom --no-owner --no-acl');
    expect(rehearsal).toContain('PHUB_RESTORE_DATABASE');
    expect(rehearsal).toContain('DATABASE_ROLE_BOUNDARY_DATABASE_OVERRIDE');
    expect(rehearsal).toContain('DATABASE_ROLE_BOUNDARY_SCOPE=media');
    expect(rehearsal).toContain('verify-media-runtime-role.js');
    expect(rehearsal).toContain('MEDIA_RUNTIME_TENANT_KEY=local-padel');
    expect(rehearsal).toContain('verify-media-migration-ledger.sh');
    expect(rehearsal).toContain('dropdb -U "$POSTGRES_USER" --force');
    expect(rehearsal).toContain('second candidate migrator invocation was not a no-op');
    expect(rehearsal).toContain('cleanup=confirmed status=passed');
    expect(rehearsal).toContain('postgres|5432|$shared_database');
    expect(deploy).toContain('database_role_boundary_scope=media');
    expect(deploy).toContain('-e DATABASE_ROLE_BOUNDARY_PHASE -e DATABASE_ROLE_BOUNDARY_SCOPE');
    expect(ledger).toContain('16????');
    expect(ledger).toContain('community_logo_sync_delivery_pair_chk');
    expect(ledger).toContain('relrowsecurity and relforcerowsecurity');
    expect(ledger).toContain('media_invariants');
    expect(diskBudget).toContain('media_disk_budget phase=%s');
  });

  it('rolls API, worker, realtime and web sequentially while preserving old-client media reads', () => {
    const deploy = workflowJob('deploy', '');
    const mediaBranchStart = deploy.indexOf('elif [ "$deployment_profile" = MEDIA_BINARY_ONLY ]');
    const mediaBranchEnd = deploy.indexOf('\n            else', mediaBranchStart);
    const mediaBranch = deploy.slice(mediaBranchStart, mediaBranchEnd);

    const api = mediaBranch.indexOf('compose up -d --no-deps api');
    const oldClientSmoke = mediaBranch.indexOf('verify-media-binary-api.sh');
    const worker = mediaBranch.indexOf('compose up -d --no-deps worker');
    const realtime = mediaBranch.indexOf('compose up -d --no-deps realtime');
    const candidateNginx = mediaBranch.indexOf('up -d --force-recreate nginx');
    const ingressSmoke = mediaBranch.indexOf('verify-media-binary-api.sh', oldClientSmoke + 1);
    const web = mediaBranch.indexOf('compose up -d --no-deps web');
    expect(api).toBeGreaterThan(-1);
    expect(oldClientSmoke).toBeGreaterThan(api);
    expect(worker).toBeGreaterThan(oldClientSmoke);
    expect(realtime).toBeGreaterThan(worker);
    expect(candidateNginx).toBeGreaterThan(realtime);
    expect(ingressSmoke).toBeGreaterThan(candidateNginx);
    expect(web).toBeGreaterThan(ingressSmoke);
    expect(web).toBeGreaterThan(realtime);
    expect(apiSmoke).toContain('/public/api/v1/media/profile-photos/');
    expect(apiSmoke).toContain('/public/api/v1/media/community-logos/');
    expect(apiSmoke).toContain('running API is not the exact candidate digest');
    expect(apiSmoke).toContain('active_release" = "$expected_candidate_release');
    expect(apiSmoke).toContain(
      'public web release does not match the expected compatibility boundary',
    );
    expect(apiSmoke).toContain('--resolve lk.nano.padlhub.su:443:127.0.0.1');
    expect(apiSmoke).toContain('canonical_https_media=passed');
    expect(deploy).toContain('Verify media through the promoted canonical ingress');
  });

  it('documents the same mixed-version rollout order as the workflow', () => {
    const stagingWorker = stagingRunbook.indexOf('Worker and realtime follow one at a time.');
    const stagingNginx = stagingRunbook.indexOf('Candidate Nginx is then recreated');
    const stagingWeb = stagingRunbook.indexOf('web follows last');
    expect(stagingWorker).toBeGreaterThan(-1);
    expect(stagingNginx).toBeGreaterThan(stagingWorker);
    expect(stagingWeb).toBeGreaterThan(stagingNginx);

    const routingWorker = clientRoutingRunbook.indexOf('deploy worker and realtime sequentially');
    const routingNginx = clientRoutingRunbook.indexOf('Recreate candidate Nginx');
    const routingWeb = clientRoutingRunbook.indexOf('then replace web last');
    expect(routingWorker).toBeGreaterThan(-1);
    expect(routingNginx).toBeGreaterThan(routingWorker);
    expect(routingWeb).toBeGreaterThan(routingNginx);
  });

  it('does not activate unrelated LK modes and proves runtime/routing preservation afterwards', () => {
    const deploy = workflowJob('deploy', '');
    const firstReattestation = deploy.indexOf(
      'Re-attest the media baseline before the first staging write',
    );
    const backup = deploy.indexOf('Preserve the active digest-pinned application release');
    expect(firstReattestation).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(firstReattestation);
    const secretIsolation = deploy.slice(
      deploy.indexOf('Verify API and realtime secret isolation'),
      firstReattestation,
    );
    expect(secretIsolation).not.toContain('scp ');
    expect(deploy).toContain('if [ "$deployment_profile" != MEDIA_BINARY_ONLY ]; then');
    expect(deploy).toContain(
      '&& [ "$deployment_profile" != MEDIA_BINARY_ONLY ]; then\n              rm -f /opt/phub/staging.communities.env',
    );
    expect(deploy).toContain('Attest preserved media baseline after binary-only rollout');
    expect(deploy).toContain('test "$observed_routing" = "$EXPECTED_ROUTING_FINGERPRINT"');
    expect(deploy).toContain('test "$observed_runtime" = "$EXPECTED_RUNTIME_CONFIG_FINGERPRINT"');
    expect(deploy).toContain('test "$snapshot_release" = "$EXPECTED_ACTIVE_RELEASE"');
    expect(deploy).toContain('sh /opt/phub/verify-media-disk-budget.sh post-pull');
    expect(deploy).toContain('media-rollout/restore-evidence.txt');
    expect(deploy).toContain('media_shared_migration duration_seconds=');
    expect(deploy).not.toContain('43:community-logo)');
    expect(deploy).not.toContain('FULL_LIVE_HOME');
    expect(deploy).not.toContain(
      "inputs.deployment_profile == 'MEDIA_BINARY_ONLY' || inputs.deployment_profile == 'FULL_LIVE_HOME'",
    );
  });
});
