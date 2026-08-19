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
    }
    expect(source('.github/workflows/communities-staged-migration-rehearsal.yaml')).toContain(
      'REHEARSE_COMMUNITIES_STAGING_29_V1',
    );
    expect(source('.github/workflows/communities-staged-migration-rehearsal.yaml')).toContain(
      'REHEARSE_COMMUNITIES_STAGING_32_V1',
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

  it('runs three exact phases, then an ordinary no-op, checks roles and cleans the clone', () => {
    const rehearsal = source('deploy/jetson/rehearse-media-migration.sh');
    const rolePre = rehearsal.indexOf('run_clone_role_boundary pre');
    const pre = rehearsal.indexOf('run_clone_migrator pre_foundation');
    const foundation = rehearsal.indexOf('run_clone_migrator foundation');
    const post = rehearsal.indexOf('run_clone_migrator post_foundation');
    const noOp = rehearsal.indexOf('rerun_output="$(run_clone_migrator)"');
    const rolePost = rehearsal.indexOf('run_clone_role_boundary post');
    const runtimeProbe = rehearsal.lastIndexOf('\nrun_clone_runtime_probe\n');
    const verifyManifest = rehearsal.lastIndexOf('sh "$ledger_verifier"');
    const measureIndexes = rehearsal.lastIndexOf('measure_community_media_quota_indexes');
    const strictDrop = rehearsal.lastIndexOf('dropdb -U "$POSTGRES_USER" --force');

    expect(pre).toBeGreaterThan(rolePre);
    expect(foundation).toBeGreaterThan(pre);
    expect(post).toBeGreaterThan(foundation);
    expect(noOp).toBeGreaterThan(post);
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

  it('reserves 32_V1 as fail-closed while binding the reviewed ACL matrix and inspector', () => {
    const workflow = source('.github/workflows/communities-staged-migration-rehearsal.yaml');
    const wrapper = source('deploy/jetson/run-communities-staged-migration-rehearsal.sh');
    const rehearsal = source('deploy/jetson/rehearse-media-migration.sh');
    const runbook = source('docs/runbooks/communities-chain-integration.md');
    const matrix = source('packages/database/src/eligibility-payment-acl-matrix.ts');
    const inspector = source('apps/migrator/src/eligibility-payment-acl-boundary.ts');

    expect(workflow).toContain('32_V1 is clone-evidence preparation only');
    expect(wrapper).toContain('32_V1 is clone-evidence preparation only');
    expect(rehearsal).toContain('32_V1 is clone-evidence preparation only');
    expect(runbook).toContain('f5ea040e4498a45310ad671f321e3044c33743ca7b0cbee7c72bc01ee9b6a91d');
    expect(runbook).toContain('eligibility-payment-acl-v1');
    expect(runbook).toContain('PROVISION_ELIGIBILITY_PAYMENT_ACL_V1');
    expect(runbook).toContain('VERIFY_ELIGIBILITY_PAYMENT_RUNTIME_RLS_V1');
    expect(runbook).toContain('not wired into any');
    expect(source('apps/migrator/tsup.config.ts')).toContain(
      "'src/provision-eligibility-payment-acl.ts'",
    );
    expect(source('apps/migrator/tsup.config.ts')).toContain(
      "'src/verify-eligibility-payment-runtime-role.ts'",
    );
    expect(runbook).toContain('065df6510c35ea1be09dad9b6415b25c30543902837336739911555ec3dcad26');
    expect(runbook).toContain('runtime role only `USAGE` (never `CREATE`)');
    expect(runbook).toContain('implementation evidence only');
    expect(matrix).toContain('COLUMN_ACL=FORBIDDEN');
    expect(inspector).toContain("set local search_path = 'pg_catalog'");
    expect(inspector).toContain('begin transaction read only');
    expect(runbook).toContain('eligibility_payment=3');
    expect(runbook).toContain('every `authorizes*=false` boundary remains unchanged');
  });
});
