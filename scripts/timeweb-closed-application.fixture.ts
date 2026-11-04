import {
  CLOSED_R1_OPERATION_SCHEMAS,
  type ClosedPackageFamily,
} from './closed-application-package-family.js';
import { createHash } from 'node:crypto';
import inventory from '../deploy/timeweb/r1-tail108-119.v1.json';
import descriptor from '../deploy/timeweb/closed-application-migrations-0103-0104.v1.json';
import { closedApplicationProductionPaths } from './timeweb-api-worker-migration.js';
import {
  closedApplicationBackupBindingSha256,
  closedApplicationBackupDefinition,
  closedApplicationBackupDirectory,
} from './timeweb-closed-application-backup.js';
import {
  CLOSED_APPLICATION_DATABASE_TARGET,
  CLOSED_APPLICATION_POSTGRES_CONTAINER,
  CLOSED_APPLICATION_HOST_TARGET,
  CLOSED_APPLICATION_OPERATION_SCHEMAS,
  closedApplicationInputDigests,
  closedApplicationRoleProbeSource,
  closedApplicationSchemas,
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
  family: ClosedPackageFamily = 'HISTORICAL108',
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
    schema: (family === 'R1_PACKAGE119'
      ? CLOSED_R1_OPERATION_SCHEMAS
      : CLOSED_APPLICATION_OPERATION_SCHEMAS)[migrationProfile],
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

export function closedBackupFixture(
  kind: 'game_start_0103' | 'subject_link_0104',
  family: ClosedPackageFamily = 'HISTORICAL108',
) {
  const intent = closedApplicationOperationFixture(kind, family),
    definition = closedApplicationBackupDefinition(intent);
  return {
    schema: definition.schema,
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
    expectedLedgerSha256: definition.ledgerSha256,
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

/** Synthetic transport/custody fixture only. Consumers must explicitly mock the
 * unchanged catalog golden-row boundary for catalog:[]. No DB/restore is run;
 * operation, generation, binding, hashes, plan, receipt and path checks stay real. */
export function closedApplicationCustodyFixture(kind: ClosedApplicationKind, generation?: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const base = closedBackupFixture(kind, 'R1_PACKAGE119');
  const operation = {
    ...base.migrationIntent,
    ...(generation === undefined ? {} : { backupGeneration: generation }),
  };
  const definition = closedApplicationBackupDefinition(operation),
    schemas = closedApplicationSchemas(kind);
  const state = (phase: 'pre' | 'bootstrap' | 'post' | 'cleanup') => {
    const count = ['pre', 'bootstrap'].includes(phase)
      ? definition.preCount
      : definition.preCount + 1;
    const acl = closedApplicationAclPlan(kind, operation.expectedPrivilegePreimage);
    const tables =
      count >= 107
        ? [
            'notifications.legacy_game_reminder_source_status',
            'notifications.legacy_game_reminder_sources',
            'notifications.legacy_game_reminder_recipients',
          ]
        : [];
    if (count === 108) tables.push('identity.external_subject_link_commands');
    return {
      schema: 'PHUB_CLOSED_APPLICATION_DATABASE_STATE_V1',
      migrationProfile: kind,
      phase,
      target: operation.expectedDatabaseTarget,
      rolesSafe: true,
      ledger: inventory.inventory.slice(0, count),
      catalog: [],
      acl: ['bootstrap', 'post'].includes(phase) ? acl.bootstrap : acl.preimage,
      newTableRows: Object.fromEntries(tables.map((name) => [name, 0])),
      hazards: { migrationLockHeld: false, longTransactions: 0, conflictingLocks: 0 },
      footprint: ['notifications.scenario_contexts', 'notifications.scenario_runs'].map((name) => ({
        name,
        bytes: 0,
        rows: 0,
      })),
      gameStartDuplicates: 0,
    };
  };
  const prestate = state('pre'),
    paths = closedApplicationProductionPaths(operation);
  const prefix = kind === 'game_start_0103' ? 'PHUB_GAME_START_0103' : 'PHUB_SUBJECT_LINK_0104';
  const prefetchRequestBytes = encode({
    schema: prefix + '_PREFETCH_OPERATION_V1',
    migrationIntent: operation,
    expiresAt: operation.expiresAt,
    confirmation: `PULL_${kind.toUpperCase()}_MIGRATOR_ONLY_NO_DATABASE_MUTATION`,
  });
  const input = { runtimeSha256: '1'.repeat(64), secretSetSha256: '2'.repeat(64), prestate };
  const prefetchIntentBytes = encode({
    schema: prefix + '_PREFETCH_INTENT_V1',
    requestBase64: prefetchRequestBytes.toString('base64'),
    input,
    retainedImageIds: [],
  });
  const prefetchReceiptBytes = encode({
    schema: prefix + '_PREFETCH_RECEIPT_V1',
    requestSha256: hash(prefetchRequestBytes),
    migrationBindingSha256: closedApplicationBackupBindingSha256(operation),
    intentSha256: hash(prefetchIntentBytes),
    imageId: operation.publishedMigrator.imageId,
    input,
    retainedImageIds: [],
  });
  const toolBytes = Buffer.from('SYNTHETIC BACKUP TOOL'),
    installationBytes = Buffer.from('SYNTHETIC INSTALLATION');
  const backup = {
    ...base,
    migrationIntent: operation,
    toolFileSha256: hash(toolBytes),
    toolInstallationSha256: hash(installationBytes),
    migratorPrefetch: {
      requestSha256: hash(prefetchRequestBytes),
      receiptSha256: hash(prefetchReceiptBytes),
      migratorImage: operation.publishedMigrator.image,
      imageId: operation.publishedMigrator.imageId,
    },
  };
  const directory = closedApplicationBackupDirectory(backup),
    backupBytes = encode(backup);
  const security = { schema: 'PHUB_NOTIFICATION_BACKUP_SECURITY_V1', objects: [], roles: [] };
  const preimageBytes = encode({
    schema: definition.preimageSchema,
    state: prestate,
    target: operation.expectedDatabaseTarget,
    security,
  });
  const receipt = {
    schema: definition.receiptSchema,
    baselineReleaseId: operation.expectedApi.releaseId,
    completedAt: '2026-10-27T07:30:00.000Z',
    backupFile: directory + '/database.pgcustom',
    backupSha256: '9'.repeat(64),
    restoreVerified: true,
    restoreImage: operation.expectedPostgres.image,
    restoredLedgerSha256: definition.ledgerSha256,
    sourceLedgerSha256: definition.ledgerSha256,
    operationSha256: hash(backupBytes),
    target: operation.expectedDatabaseTarget,
    preimageSha256: hash(preimageBytes),
    packageDescriptorSha256: operation.packageDescriptorSha256,
    aclRecovery: 'ISOLATED_OWNER_ACL_RESTORE_VERIFIED',
    securityPreimageSha256: hash(encode(security)),
    restoredSecuritySha256: hash(encode(security)),
    roleClosureSha256: hash(encode(security.roles)),
    migratorPrefetch: backup.migratorPrefetch,
    migrationProfile: kind,
    catalogVariant: operation.catalogVariant,
    catalogBuilderSha256: operation.catalogBuilderSha256,
    migrationBindingSha256: closedApplicationBackupBindingSha256(operation),
  };
  const receiptBytes = encode(receipt),
    backupProof = {
      path: directory + '/database-backup-receipt.json',
      sha256: hash(receiptBytes),
      operationSha256: hash(backupBytes),
      preimageSha256: hash(preimageBytes),
      target: operation.expectedDatabaseTarget,
      migrationProfile: kind,
      sourceLedgerSha256: definition.ledgerSha256,
      catalogVariant: operation.catalogVariant,
    };
  const terminalBytes = encode({
    schema: definition.terminalSchema,
    operationSha256: hash(backupBytes),
    receiptSha256: hash(receiptBytes),
    preimageSha256: hash(preimageBytes),
    target: operation.expectedDatabaseTarget,
    sourceLedgerSha256: definition.ledgerSha256,
    storageCleanupVerified: true,
    reconciled: true,
    migratorPrefetch: backup.migratorPrefetch,
    migrationProfile: kind,
    catalogVariant: operation.catalogVariant,
    catalogBuilderSha256: operation.catalogBuilderSha256,
    migrationBindingSha256: closedApplicationBackupBindingSha256(operation),
  });
  const operationBytes = encode(operation),
    checkpoint = descriptor.checkpoints[definition.preCount === 106 ? '106' : '107'];
  const postCheckpoint = descriptor.checkpoints[definition.preCount === 106 ? '107' : '108'];
  const runtime = (identity: ClosedRuntimeIdentity) => ({
    identity,
    status: 'running',
    health: 'healthy',
    fingerprint: '3'.repeat(64),
  });
  const plan = {
    schema: schemas.plan,
    operationSha256: hash(operationBytes),
    controllerSha: operation.controllerSha,
    controllerTree: operation.controllerTree,
    controllerSourceCiRunId: operation.controllerSourceCiRunId,
    publishedMigrator: operation.publishedMigrator,
    imageId: operation.publishedMigrator.imageId,
    preLedgerSha256: checkpoint.ledgerSha256,
    postLedgerSha256: postCheckpoint.ledgerSha256,
    secretSet: {
      releaseId: operation.expectedSecretSetReleaseId,
      device: 1,
      inode: 1,
      files: operation.expectedSecretSetFiles,
    },
    runtime: {
      api: runtime(operation.expectedApi),
      worker: runtime(operation.expectedWorker),
      postgres: operation.expectedPostgres,
      controllerConfigSha256: '4'.repeat(64),
      excluded: [runtime(operation.expectedPostgres)],
    },
    backup: backupProof,
    inputs: closedApplicationInputDigests(operation),
    roleProbeSourceSha256: hash(closedApplicationRoleProbeSource(kind)),
    preimage: prestate,
  };
  const files = new Map<string, Buffer>([
    [directory + '/backup-operation.json', backupBytes],
    [directory + '/database-backup-receipt.json', receiptBytes],
    [directory + '/preimage-proof.json', preimageBytes],
    ['/opt/phub/timeweb-beta/operator/database-backup-restore.json', backupBytes],
    [
      `/opt/phub/timeweb-beta/operator/tools/${operation.controllerSha}/control-timeweb-database-backup.py`,
      toolBytes,
    ],
    [
      `/opt/phub/timeweb-beta/operator/tools/${operation.controllerSha}/installation-receipt.json`,
      installationBytes,
    ],
    [paths.prefetchRequestPath, prefetchRequestBytes],
    [paths.prefetchRoot + '/intent.json', prefetchIntentBytes],
    [paths.prefetchRoot + '/receipt.json', prefetchReceiptBytes],
  ]);
  return {
    operation,
    operationBytes,
    backup,
    backupBytes,
    directory,
    receipt,
    receiptBytes,
    preimageBytes,
    backupProof,
    terminalBytes,
    plan,
    planBytes: encode(plan),
    state,
    paths,
    files,
    prefetchRequestBytes,
    prefetchIntentBytes,
    prefetchReceiptBytes,
    input,
  };
}
