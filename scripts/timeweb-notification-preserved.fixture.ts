import {
  NOTIFICATION_MIGRATION_SCHEMA,
  notificationSecretNames,
} from './timeweb-notification-profile.js';
export function notificationMigrationOperation() {
  const revision = '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d';
  const baseline = (service: 'api' | 'worker' | 'postgres') => {
    const digest = {
      api: '47bce1fab22cb47d99fa5391764dd20c8c1f53a31550eab2a759b512a4411839', // gitleaks:allow public OCI image digest
      worker: '72b9a03aaf95afab5711a8f489b56affe0be4d79eb5af513abe4966eb7695416',
      postgres: 'cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
    }[service];
    return {
      id: '1'.repeat(64),
      image:
        (service === 'postgres'
          ? 'docker.io/library/postgres'
          : 'ghcr.io/z6v6e6r/phub-' + service) +
        '@sha256:' +
        digest,
      imageId: 'sha256:' + digest,
      releaseId: service === 'api' ? revision + '-39366813227-1' : null,
      revision: service === 'postgres' ? null : revision,
      restarts: 0,
      startedAt: '2026-10-21T03:25:28.539450145Z',
    };
  };
  return {
    schema: NOTIFICATION_MIGRATION_SCHEMA,
    profile: 'production',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    controllerSha: 'a'.repeat(40),
    controllerTree: 'b'.repeat(40),
    controllerSourceCiRunId: '100',
    candidateSha: 'a'.repeat(40),
    candidateTree: 'b'.repeat(40),
    sourceCiRunId: '100',
    publicationRunId: '200',
    artifactId: '300',
    artifactDigest: 'sha256:' + 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    migratorImage: 'ghcr.io/z6v6e6r/phub-migrator@sha256:' + 'e'.repeat(64),
    packageDescriptorSha256: 'f'.repeat(64),
    catalogsSha256: '9'.repeat(64),
    expectedApi: baseline('api'),
    expectedWorker: baseline('worker'),
    expectedPostgres: baseline('postgres'),
    expectedSecretSetReleaseId: revision + '-39366813227-1',
    expectedSecretSetFiles: Object.fromEntries(
      notificationSecretNames.map((n) => [n, '8'.repeat(64)]),
    ),
    expiresAt: '2026-10-22T12:40:00.000Z',
    confirmation: 'MIGRATE_0099_0100_0101_102_TO_105_PRESERVE_RUNTIME_AND_PROVIDERS',
  };
}
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import frozenMigrationLedger from './fixtures/timeweb-api-worker-ledger-8158ac44.json';
import notificationDescriptor from '../deploy/timeweb/notification-migrations-0099-0101.v1.json';
import { notificationLedgerDigest } from './notification-migration-package.js';
import {
  androidGateSnapshotSha256,
  PRESERVED_NOTIFICATION_ROLLOUT_SCHEMA,
} from './timeweb-notification-android-gates.js';
import { COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS } from './timeweb-notification-completed-migration.js';
import {
  NOTIFICATION_OBSERVATION_POLICY,
  NOTIFICATION_POST_LEDGER,
} from './timeweb-notification-profile.js';
// This fixture models the completed historical 105 release, not the current SQL directory.
const historicalLedger105 = [
  ...frozenMigrationLedger.ledger,
  ...notificationDescriptor.steps.map(({ filename, checksum }) => ({ filename, checksum })),
];
if (
  frozenMigrationLedger.sourceSha !== '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d' ||
  frozenMigrationLedger.sourceTree !== 'b9ef484b4d0a9e5c8913cc2cdd79ee39b1800537' ||
  frozenMigrationLedger.ledger.length !== 102 ||
  notificationLedgerDigest(frozenMigrationLedger.ledger) !==
    notificationDescriptor.initial.sha256 ||
  historicalLedger105.length !== 105 ||
  notificationLedgerDigest(historicalLedger105) !== NOTIFICATION_POST_LEDGER ||
  historicalLedger105.at(-1)?.filename !== '0101_notification_lifecycle_channels.sql' ||
  historicalLedger105.some(({ filename }) => filename === '0102_location_recommendation_photos.sql')
)
  throw new Error('HISTORICAL_NOTIFICATION_FIXTURE_DRIFT');
export const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function androidSnapshot() {
  return {
    schema: 'PHUB_ANDROID_GATE_SNAPSHOT_V1',
    runtime: [
      {
        tenantId: 'a1000000-0000-4000-8000-000000000001',
        androidEnabled: true,
        updatedAt: '1792554662.000000',
      },
    ],
    providers: [
      {
        tenantId: 'a1000000-0000-4000-8000-000000000001',
        id: 'a2000000-0000-4000-8000-000000000001',
        channel: 'PUSH',
        platform: 'ANDROID',
        provider: 'FCM',
        appId: 'ru.padlhub.app',
        environment: 'SANDBOX',
        status: 'ACTIVE',
        credentialRefSha256: '9'.repeat(64),
        updatedAt: '1792554660.000000',
      },
    ],
  };
}
export function preservedFixture() {
  const old = notificationMigrationOperation();
  const compatibility = Object.fromEntries(
    COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS.map((path) => [path, sha256(readFileSync(path))]),
  );
  old.packageDescriptorSha256 =
    compatibility['deploy/timeweb/notification-migrations-0099-0101.v1.json']!;
  old.catalogsSha256 = compatibility['deploy/timeweb/notification-migration-catalogs.v1.json']!;
  const backup = {
    path: `/opt/phub/timeweb-beta/backups/${old.controllerSha}-${old.controllerSourceCiRunId}-1-notification-pre105/database-backup-receipt.json`,
    sha256: '1'.repeat(64),
    operationSha256: '2'.repeat(64),
    preimageSha256: '3'.repeat(64),
  };
  const completedMigration = {
    schema: 'PHUB_COMPLETED_NOTIFICATION_MIGRATION_V1',
    operationSha256: sha256(encoded(old)),
    controllerSha: old.controllerSha,
    controllerTree: old.controllerTree,
    controllerSourceCiRunId: old.controllerSourceCiRunId,
    candidateSha: old.candidateSha,
    candidateTree: old.candidateTree,
    sourceCiRunId: old.sourceCiRunId,
    publicationRunId: old.publicationRunId,
    artifactId: old.artifactId,
    artifactDigest: old.artifactDigest,
    manifestSha256: old.manifestSha256,
    migratorImage: old.migratorImage,
    packageDescriptorSha256: old.packageDescriptorSha256,
    catalogsSha256: old.catalogsSha256,
    migrationPlanSha256: '4'.repeat(64),
    migrationSuccessSha256: '5'.repeat(64),
    migrationReceiptSha256: '6'.repeat(64),
    catalogSha256: '7'.repeat(64),
    target: { databaseName: 'synthetic', systemIdentifier: '12345' },
    backup,
    compatibility,
  };
  const op = {
    schema: PRESERVED_NOTIFICATION_ROLLOUT_SCHEMA,
    profile: old.profile,
    target: old.target,
    controllerSha: 'b'.repeat(40),
    controllerTree: 'c'.repeat(40),
    controllerSourceCiRunId: '400',
    candidateSha: 'b'.repeat(40),
    candidateTree: 'c'.repeat(40),
    sourceCiRunId: '400',
    publicationRunId: '500',
    artifactId: '600',
    artifactDigest: 'sha256:' + 'd'.repeat(64),
    manifestSha256: 'e'.repeat(64),
    publishedMigratorImage: 'ghcr.io/z6v6e6r/phub-migrator@sha256:' + 'f'.repeat(64),
    completedMigration,
    androidGate: {
      schema: 'PHUB_ANDROID_GATE_EXPECTATION_V1',
      snapshotSha256: androidGateSnapshotSha256(androidSnapshot()),
      enabledTenantCount: 1,
      activeProviderCount: 1,
    },
    apiImage: 'ghcr.io/z6v6e6r/phub-api@sha256:' + 'a'.repeat(64),
    workerImage: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + 'b'.repeat(64),
    packageDescriptorSha256: old.packageDescriptorSha256,
    catalogsSha256: old.catalogsSha256,
    expectedApi: old.expectedApi,
    expectedWorker: old.expectedWorker,
    expectedPostgres: old.expectedPostgres,
    expectedCurrentSecretSetReleaseId: old.expectedSecretSetReleaseId,
    candidateSecretHashes: old.expectedSecretSetFiles,
    expectedFcmSource: '/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
    migrationPlanSha256: completedMigration.migrationPlanSha256,
    migrationSuccessSha256: completedMigration.migrationSuccessSha256,
    migrationReceiptSha256: completedMigration.migrationReceiptSha256,
    expiresAt: old.expiresAt,
    confirmation: 'DEPLOY_API_WORKER_0105_PRESERVE_EXISTING_ANDROID_AND_COMPLETED_MIGRATION',
  };
  const previousSecrets = {
    releaseId: op.expectedCurrentSecretSetReleaseId,
    device: 1,
    inode: 2,
    files: op.candidateSecretHashes,
  };
  const plan = {
    schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_PLAN_V3',
    operationSha256: sha256(encoded(op)),
    controllerSha: op.controllerSha,
    manifestSha256: op.manifestSha256,
    artifactDigest: op.artifactDigest,
    composeSha256: '1'.repeat(64),
    baselineSha256: '2'.repeat(64),
    baselinePath: `/opt/phub/timeweb-beta/releases/${op.expectedApi.releaseId}/installed-components.env`,
    previous: { api: op.expectedApi, worker: op.expectedWorker },
    candidate: {
      api: {
        image: op.apiImage,
        releaseId: `${op.candidateSha}-${op.publicationRunId}-1`,
        revision: op.candidateSha,
      },
      worker: { image: op.workerImage, releaseId: null, revision: op.candidateSha },
    },
    excluded: [],
    previousSecrets,
    candidateSecrets: previousSecrets,
    credential: {},
    packagedLedger: structuredClone(historicalLedger105),
    unchangedImages: {
      WEB_IMAGE_DIGEST: 'sha256:' + '3'.repeat(64),
      REALTIME_IMAGE_DIGEST: 'sha256:' + '4'.repeat(64),
    },
    createdAt: '2026-10-22T12:00:00.000Z',
    migrationProof: {
      completedMigrationSha256: sha256(encoded(completedMigration)),
      installedMigratorImage: completedMigration.migratorImage,
      migrationPlanSha256: op.migrationPlanSha256,
      migrationSuccessSha256: op.migrationSuccessSha256,
      migrationReceiptSha256: op.migrationReceiptSha256,
      catalogSha256: completedMigration.catalogSha256,
      backup,
      target: completedMigration.target,
    },
    migratorImage: completedMigration.migratorImage,
    fcmCredentialSource: op.expectedFcmSource,
    observationPolicy: NOTIFICATION_OBSERVATION_POLICY,
    androidGate: op.androidGate,
    completedMigrationSha256: sha256(encoded(completedMigration)),
  };
  return { op, old, plan, operationBytes: encoded(op), planBytes: encoded(plan) };
}
