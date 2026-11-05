import { r1RuntimePrivilegeRequirements } from './r1-runtime-privilege-audit.js';
import { planR1RuntimeGrants119 } from './r1-runtime-grants119.js';
import { preservedFixture, encoded, sha256 } from './timeweb-notification-preserved.fixture.js';
import { R1_API_WORKER119_OPERATION } from './timeweb-r1-api-worker119-profile.js';
import { R1_TAIL } from './r1-tail-migration-profile.js';
export function r1ApiWorker119Fixture() {
  const old = '702625eb669643c52bf69f55bc65c2e3e74f5ef9',
    sha = 'a'.repeat(40),
    tree = 'b'.repeat(40),
    attempt = '00000000-0000-4000-8000-000000000001';
  const id = (
    service: string,
    digest: string,
    revision: string | null,
    releaseId: string | null,
  ) => ({
    id: String(['api', 'worker', 'postgres', 'web', 'realtime'].indexOf(service) + 1).repeat(64),
    image:
      (service === 'postgres' ? 'docker.io/library/postgres' : 'ghcr.io/z6v6e6r/phub-' + service) +
      '@sha256:' +
      digest,
    imageId: 'sha256:' + digest,
    revision,
    releaseId,
    restarts: 0,
    startedAt: '2026-11-03T00:00:00.000Z',
  });
  return {
    schema: R1_API_WORKER119_OPERATION,
    profile: 'production',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    controllerSha: sha,
    controllerTree: tree,
    controllerSourceCiRunId: '42',
    candidateSha: sha,
    candidateTree: tree,
    sourceCiRunId: '42',
    publicationRunId: '43',
    artifactId: '44',
    artifactDigest: 'sha256:' + 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    apiImage: 'ghcr.io/z6v6e6r/phub-api@sha256:' + 'a'.repeat(64),
    workerImage: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + 'b'.repeat(64),
    publishedMigratorImage: 'ghcr.io/z6v6e6r/phub-migrator@sha256:' + 'e'.repeat(64),
    expectedApi: id(
      'api',
      '9e21147cd07700db19169e0a41b8d4b60873be90741067d17684bc676cd45838',
      old,
      old + '-40464392233-1',
    ),
    expectedWorker: id(
      'worker',
      '32d5795114c20d900c22802dec27a3b8200c2bef755c94eba4b2a477152c92ec',
      old,
      null,
    ),
    expectedPostgres: {
      ...id(
        'postgres',
        'cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
        null,
        null,
      ),
      id: 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c',
    },
    expectedWeb: id(
      'web',
      '3'.repeat(64),
      '871cc2f8660ec98ec4b95f50a78aad1e6d1b1cfe',
      '871cc2f8660ec98ec4b95f50a78aad1e6d1b1cfe-41-1',
    ),
    expectedRealtime: id('realtime', '4'.repeat(64), old, null),
    expectedCurrentSecretSetReleaseId: old + '-40464392233-1',
    candidateSecretHashes: Object.fromEntries(
      ['.release-identity.json', 'api.env', 'worker.env', 'realtime.env', 'migrator.env'].map(
        (n) => [n, '5'.repeat(64)],
      ),
    ),
    expectedFcmSource: '/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
    androidGate: {
      schema: 'PHUB_ANDROID_GATE_EXPECTATION_V1',
      snapshotSha256: '6'.repeat(64),
      enabledTenantCount: 1,
      activeProviderCount: 1,
    },
    completedTail: {
      schema: 'PHUB_R1_TAIL_COMPLETED_V1',
      attemptId: attempt,
      controllerSha: sha,
      controllerTree: tree,
      files: Object.fromEntries(
        [
          'request.json',
          'preparation.json',
          'plan.json',
          'migration-receipt.json',
          'migration-success.json',
          'cleanup.json',
          'role-proof.json',
        ].map((n) => [n, '7'.repeat(64)]),
      ),
      backup: {
        path:
          '/opt/phub/timeweb-beta/backups/' +
          sha +
          '-42-1-r1-tail-pre108-' +
          attempt +
          '/database-backup-receipt.json',
        sha256: '8'.repeat(64),
        operationSha256: '9'.repeat(64),
        preimageSha256: 'a'.repeat(64),
        target: { databaseName: 'phub_beta', systemIdentifier: '7679125609183186977' },
        sourceLedgerSha256: R1_TAIL.checkpoints['108'],
      },
    },
    expiresAt: '2026-11-03T01:00:00.000Z',
    confirmation: 'UPGRADE_R1_API_WORKER_AFTER119_KEEP_WEB_REALTIME_SECRETS_AND_ANDROID_GATES',
  };
}

export function r1ApiWorker119PlanFixture() {
  const op = r1ApiWorker119Fixture();
  const secret = {
    releaseId: op.expectedCurrentSecretSetReleaseId,
    device: 1,
    inode: 2,
    files: op.candidateSecretHashes,
  };
  const names = [
    ...new Set(
      ['api', 'worker'].flatMap((c) =>
        r1RuntimePrivilegeRequirements(c as 'api' | 'worker')
          .filter((r) => r.tenantTable)
          .map((r) => r.relation),
      ),
    ),
  ].sort();
  const grants = planR1RuntimeGrants119({
    databaseName: 'phub_beta',
    systemIdentifier: '7679125609183186977',
    recovery: false,
    roleSafe: true,
    schemas: [...new Set(names.map((name) => name.split('.')[0]!))].sort().map((name) => ({
      name,
      owner: 'phub_beta',
      acl: '{phub_beta=UC/phub_beta,phub_runtime=U/phub_beta}',
      migratorUsage: name !== 'games',
      migratorCreate: false,
    })),
    ledger: structuredClone(R1_TAIL.inventory),
    tables: names.map((relation) => ({
      relation,
      owner: 'phub_migrator',
      kind: 'r',
      rls: true,
      forceRls: true,
      schemaUsage: true,
      schemaCreate: false,
      schemaOwnerAssumable: false,
      acl: [],
      columns: ['completed_at', 'id', 'outcome', 'used_at'].map((name) => ({ name, acl: [] })),
    })),
  });
  const plan = {
    ...preservedFixture().plan,
    schema: 'PHUB_TIMEWEB_R1_API_WORKER119_PLAN_V1',
    operationSha256: sha256(encoded(op)),
    controllerSha: op.controllerSha,
    manifestSha256: op.manifestSha256,
    artifactDigest: op.artifactDigest,
    baselinePath: `/opt/phub/timeweb-beta/releases/${op.expectedWeb.releaseId}/installed-components.env`,
    previous: { api: op.expectedApi, worker: op.expectedWorker },
    candidate: {
      api: {
        image: op.apiImage,
        releaseId: op.candidateSha + '-' + op.publicationRunId + '-1',
        revision: op.candidateSha,
      },
      worker: { image: op.workerImage, releaseId: null, revision: op.candidateSha },
    },
    excluded: [op.expectedWeb, op.expectedRealtime],
    previousSecrets: secret,
    candidateSecrets: secret,
    packagedLedger: structuredClone(R1_TAIL.inventory),
    migrationProof: {
      completedMigrationSha256: sha256(encoded(op.completedTail)),
      installedMigratorImage: op.publishedMigratorImage,
      migrationPlanSha256: op.completedTail.files['plan.json'],
      migrationSuccessSha256: op.completedTail.files['migration-success.json'],
      migrationReceiptSha256: op.completedTail.files['migration-receipt.json'],
      catalogSha256: '8'.repeat(64),
      backup: op.completedTail.backup,
      target: op.completedTail.backup.target,
    },
    migratorImage: op.publishedMigratorImage,
    androidGate: op.androidGate,
    completedMigrationSha256: sha256(encoded(op.completedTail)),
    runtimeGrants: grants,
    previousWorkerGate: null,
  };
  return { op, plan, operationBytes: encoded(op), planBytes: encoded(plan) };
}
