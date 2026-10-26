// Data-proof adoption only: this module grants no migration or backup authority.
import { createHash } from 'node:crypto';
const H = /^[a-f0-9]{64}$/,
  S = /^[a-f0-9]{40}$/,
  R = /^[1-9][0-9]*$/;
const fail = (code) => {
  throw Error('NOTIFICATION_COMPLETED_' + code);
};
const hash = (v) => createHash('sha256').update(v).digest('hex');
export const COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS = Object.freeze([
  'packages/database/migrations/0099_local_password_reset_proofs.sql',
  'packages/database/migrations/0100_notification_scenarios.sql',
  'packages/database/migrations/0101_notification_lifecycle_channels.sql',
  'deploy/timeweb/notification-migrations-0099-0101.v1.json',
  'deploy/timeweb/notification-migration-catalogs.v1.json',
  'deploy/timeweb/notification-role-bootstrap-0105.sql',
  'deploy/timeweb/notification-role-bootstrap-0105-inverse.sql',
]);
function exact(v, fields) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    JSON.stringify(Object.keys(v).sort()) !== JSON.stringify([...fields].sort())
  )
    fail('FIELDS');
}
export function validateCompletedNotificationMigration(ref) {
  exact(ref, [
    'schema',
    'operationSha256',
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
    'migratorImage',
    'packageDescriptorSha256',
    'catalogsSha256',
    'migrationPlanSha256',
    'migrationSuccessSha256',
    'migrationReceiptSha256',
    'catalogSha256',
    'target',
    'backup',
    'compatibility',
  ]);
  if (
    ref.schema !== 'PHUB_COMPLETED_NOTIFICATION_MIGRATION_V1' ||
    !['controllerSha', 'controllerTree', 'candidateSha', 'candidateTree'].every((k) =>
      S.test(ref[k] ?? ''),
    ) ||
    ref.controllerSha !== ref.candidateSha ||
    ref.controllerTree !== ref.candidateTree ||
    ref.controllerSourceCiRunId !== ref.sourceCiRunId ||
    !['controllerSourceCiRunId', 'sourceCiRunId', 'publicationRunId', 'artifactId'].every((k) =>
      R.test(ref[k] ?? ''),
    ) ||
    ![
      'operationSha256',
      'manifestSha256',
      'packageDescriptorSha256',
      'catalogsSha256',
      'migrationPlanSha256',
      'migrationSuccessSha256',
      'migrationReceiptSha256',
      'catalogSha256',
    ].every((k) => H.test(ref[k] ?? '')) ||
    !/^sha256:[a-f0-9]{64}$/.test(ref.artifactDigest ?? '') ||
    !/^ghcr\.io\/z6v6e6r\/phub-migrator@sha256:[a-f0-9]{64}$/.test(ref.migratorImage ?? '')
  )
    fail('IDENTITY');
  exact(ref.target, ['databaseName', 'systemIdentifier']);
  if (
    typeof ref.target.databaseName !== 'string' ||
    !ref.target.databaseName ||
    !R.test(ref.target.systemIdentifier ?? '')
  )
    fail('TARGET');
  exact(ref.backup, ['path', 'sha256', 'operationSha256', 'preimageSha256']);
  if (
    ref.backup.path !==
      `/opt/phub/timeweb-beta/backups/${ref.controllerSha}-${ref.controllerSourceCiRunId}-1-notification-pre105/database-backup-receipt.json` ||
    !['sha256', 'operationSha256', 'preimageSha256'].every((k) => H.test(ref.backup[k] ?? ''))
  )
    fail('BACKUP');
  exact(ref.compatibility, COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS);
  if (!Object.values(ref.compatibility).every((v) => H.test(v ?? ''))) fail('COMPATIBILITY');
  return ref;
}
export function assertCompletedNotificationInputs(ref, operation, operationBytes, plan, read) {
  validateCompletedNotificationMigration(ref);
  if (hash(operationBytes) !== ref.operationSha256) fail('OPERATION');
  for (const key of [
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
    'migratorImage',
    'packageDescriptorSha256',
    'catalogsSha256',
  ])
    if (operation[key] !== ref[key]) fail('SOURCE_BINDING');
  if (JSON.stringify(plan.backup) !== JSON.stringify(ref.backup)) fail('BACKUP_BINDING');
  const expected = {
    'deploy/timeweb/notification-migrations-0099-0101.v1.json': operation.packageDescriptorSha256,
    'deploy/timeweb/notification-migration-catalogs.v1.json': operation.catalogsSha256,
    'deploy/timeweb/notification-role-bootstrap-0105.sql': plan.inputs.bootstrapSha256,
    'deploy/timeweb/notification-role-bootstrap-0105-inverse.sql': plan.inputs.inverseSha256,
  };
  const descriptorPath = 'deploy/timeweb/notification-migrations-0099-0101.v1.json';
  const descriptorBytes = read('/opt/phub/timeweb-beta/standard/source/' + descriptorPath, 0o644);
  if (hash(descriptorBytes) !== operation.packageDescriptorSha256) fail('INPUT_DRIFT');
  const descriptor = JSON.parse(descriptorBytes);
  if (!Array.isArray(descriptor.steps) || descriptor.steps.length !== 3) fail('INPUT_DRIFT');
  for (const path of COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS) {
    const want =
      expected[path] ??
      descriptor.steps.find((row) => row.filename === path.split('/').at(-1))?.checksum;
    if (
      !H.test(want ?? '') ||
      ref.compatibility[path] !== want ||
      hash(read('/opt/phub/timeweb-beta/standard/source/' + path, 0o644)) !== want
    )
      fail('INPUT_DRIFT');
  }
  return true;
}
