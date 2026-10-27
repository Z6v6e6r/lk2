import { CLOSED_APPLICATION_BACKUPS } from './timeweb-closed-application-backup.js';
import {
  CLOSED_APPLICATION_DATABASE_TARGET,
  CLOSED_APPLICATION_POSTGRES_CONTAINER,
  CLOSED_APPLICATION_HOST_TARGET,
  CLOSED_APPLICATION_OPERATION_SCHEMAS,
  type ClosedApplicationKind,
  type ClosedApplicationOperation,
  type ClosedRuntimeIdentity,
} from './timeweb-closed-application-profile.js';
import {
  closedApplicationAclPlan,
  type ClosedApplicationAclRow,
} from './closed-application-migration-acl.js';

function aclFixture(profile: ClosedApplicationKind): ClosedApplicationAclRow[] {
  const tables =
    profile === 'game_start_0103'
      ? ['games.games', 'identity.tenants', 'identity.users']
      : ['identity.users'];
  const rows: ClosedApplicationAclRow[] = [
    {
      key: `schema:${profile === 'game_start_0103' ? 'notifications' : 'identity'}`,
      owner: 'phub_beta',
      aclIsNull: false,
      effective: { CREATE: false, USAGE: true },
      acl: [
        ['phub_beta', 'phub_beta', 'CREATE', false],
        ['phub_beta', 'phub_beta', 'USAGE', false],
        ['phub_beta', 'phub_migrator', 'USAGE', false],
      ],
    },
  ];
  for (const table of tables) {
    rows.push({
      key: `table:${table}`,
      owner: 'phub_beta',
      aclIsNull: true,
      effective: { REFERENCES: false },
      acl: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'].map(
        (privilege) => ['phub_beta', 'phub_beta', privilege, false],
      ),
    });
    for (const column of table === 'identity.tenants' ? ['id'] : ['id', 'tenant_id'])
      rows.push({
        key: `column:${table}:${column}`,
        owner: 'phub_beta',
        aclIsNull: true,
        effective: { REFERENCES: false },
        acl: [],
      });
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : 1));
}
export function closedApplicationOperationFixture(
  migrationProfile: ClosedApplicationKind,
): ClosedApplicationOperation {
  const revision = 'a'.repeat(40),
    run = '123456',
    tree = 'b'.repeat(40),
    digest = 'c'.repeat(64);
  const identity = (service: string): ClosedRuntimeIdentity => ({
    id:
      service === 'postgres'
        ? CLOSED_APPLICATION_POSTGRES_CONTAINER
        : (service === 'api' ? '1' : '2').repeat(64),
    image: `${service === 'postgres' ? 'docker.io/library/postgres' : `ghcr.io/z6v6e6r/phub-${service}`}@sha256:${digest}`,
    imageId: `sha256:${digest}`,
    releaseId: service === 'postgres' ? null : `${revision}-${run}-1`,
    revision: service === 'postgres' ? null : revision,
    restarts: 0,
    startedAt: '2026-10-27T07:00:00.000Z',
  });
  const expectedPrivilegePreimage = aclFixture(migrationProfile),
    acl = closedApplicationAclPlan(migrationProfile, expectedPrivilegePreimage);
  return {
    schema: CLOSED_APPLICATION_OPERATION_SCHEMAS[migrationProfile],
    profile: 'beta',
    migrationProfile,
    target: CLOSED_APPLICATION_HOST_TARGET,
    expectedDatabaseTarget: CLOSED_APPLICATION_DATABASE_TARGET,
    catalogVariant: 'SCENARIO_EDITOR_V1',
    controllerSha: revision,
    controllerTree: tree,
    controllerSourceCiRunId: run,
    publishedMigrator: {
      sourceSha: revision,
      sourceTree: tree,
      publicationRunId: run,
      publicationRunAttempt: 1,
      manifestSha256: digest,
      image: `ghcr.io/z6v6e6r/phub-migrator@sha256:${digest}`,
      imageId: `sha256:${digest}`,
    },
    packageDescriptorSha256: digest,
    catalogBuilderSha256: digest,
    expectedPrivilegePreimage,
    aclPreimageSha256: acl.preimageSha256,
    bootstrapSha256: acl.bootstrapSha256,
    cleanupSha256: acl.cleanupSha256,
    expectedApi: identity('api'),
    expectedWorker: identity('worker'),
    expectedPostgres: {
      ...identity('postgres'),
      imageId: 'sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
      image:
        'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
    },
    expectedSecretSetReleaseId: `${revision}-${run}-1`,
    expectedSecretSetFiles: Object.fromEntries(
      ['.release-identity.json', 'api.env', 'migrator.env', 'realtime.env', 'worker.env'].map(
        (name) => [name, digest],
      ),
    ),
    previousMigrationSuccess:
      migrationProfile === 'game_start_0103'
        ? null
        : {
            path: `/opt/phub/timeweb-beta/backups/${revision}-${run}-1-game-start0103-migration/migration-success.json`,
            sha256: digest,
            operationSha256: digest,
          },
    expiresAt: '2026-10-27T08:00:00.000Z',
    confirmation: `MIGRATE_${migrationProfile.toUpperCase()}_ONLY_PRESERVE_PREEXISTING_ACL_NO_APP_DEPLOY_NO_SEND`,
  };
}

export function closedBackupFixture(kind: 'game_start_0103' | 'subject_link_0104') {
  const intent = closedApplicationOperationFixture(kind);
  return {
    schema: CLOSED_APPLICATION_BACKUPS[kind].schema,
    profile: 'beta',
    target: intent.target,
    toolCommit: intent.controllerSha,
    toolFileSha256: 'd'.repeat(64),
    controllerSha: intent.controllerSha,
    toolProofSha256: 'e'.repeat(64),
    toolInstallationSha256: 'f'.repeat(64),
    controllerTree: intent.controllerTree,
    controllerConfigSha256: '1'.repeat(64),
    expectedBoundarySha256: '2'.repeat(64),
    expectedApi: intent.expectedApi,
    expectedPostgres: intent.expectedPostgres,
    expiresAt: intent.expiresAt,
    confirmation: `BACKUP_RESTORE_${kind.toUpperCase()}_PRIVATE_NAMESPACE_KEEP_RUNTIME`,
    releaseId: `${intent.controllerSha}-${intent.controllerSourceCiRunId}-1`,
    controllerSourceCiRunId: intent.controllerSourceCiRunId,
    expectedLedgerSha256: CLOSED_APPLICATION_BACKUPS[kind].ledgerSha256,
    expectedDatabaseTarget: intent.expectedDatabaseTarget,
    packageDescriptorSha256: intent.packageDescriptorSha256,
    catalogBuilderSha256: intent.catalogBuilderSha256,
    catalogVariant: intent.catalogVariant,
    migratorPrefetch: {
      requestSha256: '3'.repeat(64),
      receiptSha256: '4'.repeat(64),
      migratorImage: intent.publishedMigrator.image,
      imageId: intent.publishedMigrator.imageId,
    },
    migrationIntent: intent,
  };
}
