import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Communities staged migration rehearsal contract', () => {
  it('keeps staged acknowledgements out of all deployment workflows', () => {
    for (const workflow of [
      '.github/workflows/deploy-staging.yaml',
      '.github/workflows/deploy-production.yaml',
      '.github/workflows/communities-staging-preflight.yaml',
    ]) {
      expect(source(workflow)).not.toContain('COMMUNITIES_STAGED_REHEARSAL_29_V1');
      expect(source(workflow)).not.toContain('COMMUNITIES_STAGED_REHEARSAL_32_V1');
      expect(source(workflow)).not.toContain('COMMUNITIES_STAGED_REHEARSAL_33_V1');
      expect(source(workflow)).not.toContain('COMMUNITIES_STAGED_REHEARSAL_34_V1');
    }
    expect(source('.github/workflows/communities-staged-migration-rehearsal.yaml')).toContain(
      'REHEARSE_COMMUNITIES_STAGING_29_V1',
    );
    expect(source('.github/workflows/communities-staged-migration-rehearsal.yaml')).toContain(
      'REHEARSE_COMMUNITIES_STAGING_32_V1',
    );
    expect(source('.github/workflows/communities-staged-migration-rehearsal.yaml')).toContain(
      'REHEARSE_COMMUNITIES_STAGING_33_V1',
    );
    expect(source('.github/workflows/communities-staged-migration-rehearsal.yaml')).toContain(
      'REHEARSE_COMMUNITIES_STAGING_34_V1',
    );
  });

  it('binds backup, source ledger, candidate and migrator digest before clone creation', () => {
    const rehearsal = source('deploy/jetson/rehearse-media-migration.sh');
    const backupBinding = rehearsal.indexOf('staged backup SHA does not match');
    const candidateBinding = rehearsal.indexOf(
      'staged release environment candidate SHA does not match',
    );
    const digestBinding = rehearsal.indexOf(
      'staged release environment migrator digest does not match',
    );
    const createClone = rehearsal.indexOf('createdb -U "$POSTGRES_USER" --template=template0');

    expect(backupBinding).toBeGreaterThanOrEqual(0);
    expect(candidateBinding).toBeGreaterThan(backupBinding);
    expect(digestBinding).toBeGreaterThan(candidateBinding);
    expect(createClone).toBeGreaterThan(digestBinding);
    expect(rehearsal).toContain('stat -c %u "$release_env"');
    expect(rehearsal).toContain('compose pull migrator');
    expect(rehearsal).toContain('docker image inspect "$staged_migrator_image"');
    expect(rehearsal).toContain('postgres-communities-rehearsal-*.dump');
    expect(rehearsal).not.toContain('"$backup_root"/postgres-communities-preflight-*.dump');
    expect(rehearsal).toContain('staged archive does not contain ACL entries');
    expect(rehearsal).toContain('staged archive does not contain default ACL entries');
  });

  it('runs exact versioned phases, then an ordinary no-op, checks roles and cleans the clone', () => {
    const rehearsal = source('deploy/jetson/rehearse-media-migration.sh');
    const rolePre = rehearsal.indexOf('run_clone_role_boundary pre');
    const pre = rehearsal.indexOf('run_clone_migrator pre_foundation');
    const foundation = rehearsal.indexOf('run_clone_migrator foundation');
    const post = rehearsal.indexOf('run_clone_migrator post_foundation');
    const aclPre = rehearsal.indexOf('pre_acl_output="$(run_eligibility_acl_command');
    const fixture = rehearsal.indexOf('run_cup_projection_rehearsal prepare');
    const eligibility = rehearsal.indexOf('run_clone_migrator eligibility_payment');
    const cup = rehearsal.indexOf('run_clone_migrator cup_projection');
    const participation = rehearsal.indexOf('run_clone_migrator participation_command');
    const aclPost = rehearsal.indexOf('post_acl_output="$(run_eligibility_acl_command');
    const cupProbe = rehearsal.indexOf('run_cup_projection_rehearsal probe');
    const noOp = rehearsal.indexOf('rerun_output="$(run_clone_migrator)"');
    const rolePost = rehearsal.indexOf('run_clone_role_boundary post');
    const runtimeProbe = rehearsal.lastIndexOf('\nrun_clone_runtime_probe\n');
    const verifyManifest = rehearsal.lastIndexOf('sh "$ledger_verifier"');
    const measureIndexes = rehearsal.lastIndexOf('measure_community_media_quota_indexes');
    const strictDrop = rehearsal.lastIndexOf('dropdb -U "$POSTGRES_USER" --force');

    expect(pre).toBeGreaterThan(rolePre);
    expect(foundation).toBeGreaterThan(pre);
    expect(post).toBeGreaterThan(foundation);
    expect(aclPre).toBeGreaterThan(post);
    expect(fixture).toBeGreaterThan(aclPre);
    expect(eligibility).toBeGreaterThan(fixture);
    expect(cup).toBeGreaterThan(eligibility);
    expect(participation).toBeGreaterThan(cup);
    expect(aclPost).toBeGreaterThan(participation);
    expect(cupProbe).toBeGreaterThan(aclPost);
    expect(noOp).toBeGreaterThan(cupProbe);
    expect(rolePost).toBeGreaterThan(noOp);
    expect(runtimeProbe).toBeGreaterThan(rolePost);
    expect(verifyManifest).toBeGreaterThan(runtimeProbe);
    expect(measureIndexes).toBeGreaterThan(verifyManifest);
    expect(strictDrop).toBeGreaterThan(runtimeProbe);
    expect(rehearsal).toContain('second candidate migrator invocation was not a no-op');
    expect(rehearsal).toContain('reindex index community_content.$2;');
    expect(rehearsal).toContain(
      'PGOPTIONS="-c lock_timeout=5000 -c statement_timeout=600000 -c idle_in_transaction_session_timeout=600000"',
    );
    expect(rehearsal).toContain('quota_index_measurements=4');
    expect(rehearsal).toContain('authoritative_privacy_missing_count');
    expect(rehearsal).toContain('profile privacy payload backfill is incomplete');
    expect(rehearsal).toContain('cleanup=confirmed status=passed');
  });

  it('documents the implementation as clone-only and non-authoritative for staging', () => {
    const runbook = source('docs/runbooks/communities-chain-integration.md');
    expect(runbook).toContain('Exact 29-file staged clone rehearsal contract');
    expect(runbook).toContain('The shared `/opt/phub/release.env` is never changed.');
    expect(runbook).toContain('merging this implementation grants neither authority');
    expect(runbook).toContain('must not be the inventory key, backup key or `STAGING_DEPLOY_KEY`');
    expect(runbook).toContain('rejects the existing `postgres-communities-preflight-*`');
  });

  it('keeps older contracts frozen and binds 34_V1 to its ACL matrix and runtime probes', () => {
    const workflow = source('.github/workflows/communities-staged-migration-rehearsal.yaml');
    const wrapper = source('deploy/jetson/run-communities-staged-migration-rehearsal.sh');
    const rehearsal = source('deploy/jetson/rehearse-media-migration.sh');
    const runbook = source('docs/runbooks/communities-chain-integration.md');
    const matrix = source('packages/database/src/eligibility-payment-acl-matrix.ts');
    const inspector = source('apps/migrator/src/eligibility-payment-acl-boundary.ts');
    const provisioner = source(
      'apps/migrator/src/provision-eligibility-payment-cup-projection-acl.ts',
    );
    const projectionProbe = source('apps/migrator/src/cup-player-level-projection-rehearsal.ts');
    const participationProvisioner = source(
      'apps/migrator/src/provision-eligibility-payment-participation-command-acl.ts',
    );
    const participationProbe = source(
      'apps/migrator/src/participation-command-foundation-rehearsal.ts',
    );

    expect(workflow).toContain('32_V1 remains a frozen preparation-only contract');
    expect(wrapper).toContain('32_V1 remains frozen');
    expect(rehearsal).toContain('32_V1 is clone-evidence preparation only');
    expect(runbook).toContain('f5ea040e4498a45310ad671f321e3044c33743ca7b0cbee7c72bc01ee9b6a91d');
    expect(runbook).toContain('eligibility-payment-acl-v1');
    expect(runbook).toContain('PROVISION_ELIGIBILITY_PAYMENT_ACL_V1');
    expect(runbook).toContain('VERIFY_ELIGIBILITY_PAYMENT_RUNTIME_RLS_V1');
    expect(runbook).toContain('not wired into any');
    expect(source('apps/migrator/tsup.config.ts')).toContain(
      "'src/provision-eligibility-payment-cup-projection-acl.ts'",
    );
    expect(source('apps/migrator/tsup.config.ts')).toContain(
      "'src/verify-eligibility-payment-runtime-role.ts'",
    );
    expect(source('apps/migrator/tsup.config.ts')).toContain(
      "'src/provision-eligibility-payment-participation-command-acl.ts'",
    );
    expect(source('apps/migrator/tsup.config.ts')).toContain(
      "'src/participation-command-foundation-rehearsal.ts'",
    );
    expect(runbook).toContain('065df6510c35ea1be09dad9b6415b25c30543902837336739911555ec3dcad26');
    expect(runbook).toContain('runtime role only `USAGE` (never `CREATE`)');
    expect(runbook).toContain('implementation evidence only');
    expect(matrix).toContain('COLUMN_ACL=FORBIDDEN');
    expect(inspector).toContain("set local search_path = 'pg_catalog'");
    expect(inspector).toContain('begin transaction read only');
    expect(provisioner).toContain('ELIGIBILITY_PAYMENT_CUP_PROJECTION_ACL_RELATIONS');
    expect(projectionProbe).toContain("reusedEvent.outcome !== 'idempotency_conflict'");
    expect(projectionProbe).toContain("crossTenant.outcome !== 'actor_not_mapped'");
    expect(participationProvisioner).toContain(
      'ELIGIBILITY_PAYMENT_PARTICIPATION_COMMAND_ACL_RELATIONS',
    );
    expect(participationProbe).toContain("denied.state !== 'REJECTED'");
    expect(participationProbe).toContain("applied.state !== 'APPLIED'");
    expect(runbook).toContain('Exact 33-file executable clone rehearsal contract');
    expect(runbook).toContain('3f61d60f27ab90bf4fe8498af29771b06925ece3b1ac6c7cac32b296d86c06d0');
    expect(runbook).toContain('83cba43d957e8104fc91b139020342dc154f571155c5fadafe36874583310310');
    expect(runbook).toContain('eligibility_payment=3 cup_projection=1');
    expect(runbook).toContain('`authorizes*=false` boundary remains unchanged');
    expect(runbook).toContain('Exact 34-file participation-command clone rehearsal contract');
    expect(runbook).toContain('488d3c7a9494b3c4587b2e849f937fe161ce3a9c7c7e336e63188cfaafdedc98');
    expect(runbook).toContain('482afdc666acb2caa268c66b46575614acf10807727ca9e6a086eb805b38ca6e');
  });
});
