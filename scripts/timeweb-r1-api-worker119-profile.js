// One R1 API/Worker upgrade profile. No publication, dispatch, DB connection or activation.
import {
  r1Exact,
  r1Same,
  r1Hash,
  r1Encode,
  r1PackagedInventory,
  r1Stop,
} from './r1-tail-migration-profile.js';
import { r1TailPaths } from './r1-tail-migration-controller.js';
import { validateClosedRuntimeIdentity } from './timeweb-closed-application-profile.js';
import { validateAndroidGateExpectation } from './timeweb-notification-android-gates.js';
export const R1_API_WORKER119_OPERATION = 'PHUB_TIMEWEB_R1_API_WORKER119_OPERATION_V1';
export const R1_API_WORKER119_PLAN = 'PHUB_TIMEWEB_R1_API_WORKER119_PLAN_V1';
export const R1_API_WORKER119_RECEIPT = 'PHUB_TIMEWEB_R1_API_WORKER119_RECEIPT_V1';
export const R1_API_WORKER119_INSTALLED = 'API_WORKER_R1_119';
export const isR1ApiWorker119 = (op) => op?.schema === R1_API_WORKER119_OPERATION;
const H = /^[a-f0-9]{64}$/,
  S = /^[a-f0-9]{40}$/,
  N = /^[1-9][0-9]*$/;
const OLD = '702625eb669643c52bf69f55bc65c2e3e74f5ef9';
const need = (ok) => {
  if (!ok) r1Stop('API_WORKER119_IDENTITY');
};
const files = [
  'request.json',
  'preparation.json',
  'plan.json',
  'migration-receipt.json',
  'migration-success.json',
  'cleanup.json',
  'role-proof.json',
];
const secretNames = [
  '.release-identity.json',
  'api.env',
  'migrator.env',
  'realtime.env',
  'worker.env',
];
export function validateR1ApiWorker119Operation(op, at) {
  r1Exact(op, [
    'schema',
    'profile',
    'target',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'apiImage',
    'workerImage',
    'publishedMigratorImage',
    'expectedApi',
    'expectedWorker',
    'expectedPostgres',
    'expectedWeb',
    'expectedRealtime',
    'expectedCurrentSecretSetReleaseId',
    'candidateSecretHashes',
    'expectedFcmSource',
    'androidGate',
    'completedTail',
    'expiresAt',
    'confirmation',
  ]);
  need(
    isR1ApiWorker119(op) &&
      op.profile === 'production' &&
      r1Same(op.target, { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 }),
  );
  need(
    S.test(op.controllerSha ?? '') &&
      S.test(op.controllerTree ?? '') &&
      op.controllerSha === op.candidateSha &&
      op.controllerTree === op.candidateTree &&
      op.controllerSourceCiRunId === op.sourceCiRunId,
  );
  for (const key of ['controllerSourceCiRunId', 'sourceCiRunId', 'publicationRunId', 'artifactId'])
    need(N.test(op[key] ?? ''));
  need(/^sha256:[a-f0-9]{64}$/.test(op.artifactDigest ?? '') && H.test(op.manifestSha256 ?? ''));
  for (const service of ['api', 'worker', 'migrator'])
    need(
      new RegExp('^ghcr\\.io/z6v6e6r/phub-' + service + '@sha256:[a-f0-9]{64}$').test(
        op[service === 'migrator' ? 'publishedMigratorImage' : service + 'Image'] ?? '',
      ),
    );
  for (const service of ['api', 'worker', 'postgres'])
    validateClosedRuntimeIdentity(
      op['expected' + service[0].toUpperCase() + service.slice(1)],
      service,
    );
  need(
    op.expectedApi.revision === OLD &&
      op.expectedWorker.revision === OLD &&
      op.expectedApi.imageId ===
        'sha256:9e21147cd07700db19169e0a41b8d4b60873be90741067d17684bc676cd45838' &&
      op.expectedWorker.imageId ===
        'sha256:32d5795114c20d900c22802dec27a3b8200c2bef755c94eba4b2a477152c92ec',
  );
  need(
    op.expectedPostgres.id === 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c',
  );
  for (const [service, key, revision] of [
    ['web', 'expectedWeb', '871cc2f8660ec98ec4b95f50a78aad1e6d1b1cfe'],
    ['realtime', 'expectedRealtime', OLD],
  ]) {
    const row = op[key];
    r1Exact(row, ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']);
    need(
      H.test(row.id ?? '') &&
        new RegExp('^ghcr\\.io/z6v6e6r/phub-' + service + '@sha256:[a-f0-9]{64}$').test(
          row.image ?? '',
        ) &&
        /^sha256:[a-f0-9]{64}$/.test(row.imageId ?? '') &&
        row.revision === revision &&
        Number.isInteger(row.restarts) &&
        row.restarts >= 0 &&
        Number.isFinite(Date.parse(row.startedAt)) &&
        (service === 'web'
          ? new RegExp('^' + revision + '-[1-9][0-9]*-1$').test(row.releaseId ?? '')
          : row.releaseId === null),
    );
  }
  need(/^[a-f0-9]{40}-[1-9][0-9]*-1$/.test(op.expectedCurrentSecretSetReleaseId ?? ''));
  r1Exact(op.candidateSecretHashes, secretNames);
  need(Object.values(op.candidateSecretHashes).every((x) => H.test(x)));
  need(
    ['/dev/null', '/etc/phub/timeweb-beta-fcm/fcm-service-account.json'].includes(
      op.expectedFcmSource,
    ),
  );
  validateAndroidGateExpectation(op.androidGate);
  need(op.expectedFcmSource === '/etc/phub/timeweb-beta-fcm/fcm-service-account.json');
  const ref = op.completedTail;
  r1Exact(ref, ['schema', 'attemptId', 'controllerSha', 'controllerTree', 'files', 'backup']);
  r1TailPaths(ref);
  r1Exact(ref.files, files);
  need(
    ref.schema === 'PHUB_R1_TAIL_COMPLETED_V1' &&
      ref.controllerSha === op.controllerSha &&
      ref.controllerTree === op.controllerTree &&
      Object.values(ref.files).every((x) => H.test(x)),
  );
  r1Exact(ref.backup, [
    'path',
    'sha256',
    'operationSha256',
    'preimageSha256',
    'target',
    'sourceLedgerSha256',
  ]);
  need(
    ['sha256', 'operationSha256', 'preimageSha256', 'sourceLedgerSha256'].every((k) =>
      H.test(ref.backup[k]),
    ) &&
      r1Same(ref.backup.target, {
        databaseName: 'phub_beta',
        systemIdentifier: '7679125609183186977',
      }),
  );
  need(
    typeof ref.backup.path === 'string' &&
      new RegExp(
        '^/opt/phub/timeweb-beta/backups/' +
          op.controllerSha +
          '-' +
          op.sourceCiRunId +
          '-1-r1-tail-pre(?:108|109|11[0-8])-' +
          ref.attemptId +
          '/database-backup-receipt\\.json$',
      ).test(ref.backup.path),
  );
  const expiry = Date.parse(op.expiresAt);
  need(
    Number.isFinite(expiry) &&
      new Date(expiry).toISOString() === op.expiresAt &&
      (at === undefined || (expiry - at >= 1200000 && expiry - at <= 3600000)),
  );
  need(
    op.confirmation ===
      'UPGRADE_R1_API_WORKER_AFTER119_KEEP_WEB_REALTIME_SECRETS_AND_ANDROID_GATES',
  );
  return op;
}
export function validateR1ApiWorker119Manifest(op, manifest) {
  validateR1ApiWorker119Operation(op);
  need(
    manifest.gitCommit === op.controllerSha &&
      manifest.gitTree === op.controllerTree &&
      manifest.schemaVersion === 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2',
  );
  for (const service of ['api', 'worker', 'migrator']) {
    const rows = manifest.images?.filter((r) => r.component === service) ?? [];
    need(
      rows.length === 1 &&
        rows[0].revision === op.controllerSha &&
        'ghcr.io/z6v6e6r/phub-' + service + '@' + rows[0].digest ===
          op[service === 'migrator' ? 'publishedMigratorImage' : service + 'Image'],
    );
  }
  return manifest;
}
export function validateR1ApiWorker119Ledger(applied, packaged) {
  r1PackagedInventory(applied);
  r1PackagedInventory(packaged);
  need(r1Same(applied, packaged));
}
export function r1ApiWorker119MigrationProof(op, completed) {
  validateR1ApiWorker119Operation(op);
  need(
    completed.operation.controllerSha === op.controllerSha &&
      completed.operation.publishedMigrator.image === op.publishedMigratorImage &&
      completed.operation.publishedMigrator.publicationRunId === op.publicationRunId &&
      completed.operation.publishedMigrator.manifestSha256 === op.manifestSha256 &&
      r1Same(completed.operation.expectedPostgres, op.expectedPostgres),
  );
  return {
    completedMigrationSha256: r1Hash(r1Encode(op.completedTail)),
    installedMigratorImage: op.publishedMigratorImage,
    migrationPlanSha256: op.completedTail.files['plan.json'],
    migrationSuccessSha256: op.completedTail.files['migration-success.json'],
    migrationReceiptSha256: op.completedTail.files['migration-receipt.json'],
    catalogSha256: r1Hash(r1Encode(completed.cleanup.catalog)),
    backup: op.completedTail.backup,
    target: op.completedTail.backup.target,
  };
}
