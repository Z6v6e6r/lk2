import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import descriptor from '../deploy/timeweb/closed-application-migrations-0103-0104.v1.json' with { type: 'json' };
import {
  CLOSED_APPLICATION_DATABASE_TARGET,
  CLOSED_APPLICATION_HOST_TARGET,
  validateClosedApplicationOperation,
  validateClosedApplicationState,
} from './timeweb-closed-application-profile.js';

export const CLOSED_APPLICATION_BACKUPS = Object.freeze({
  game_start_0103: Object.freeze({
    schema: 'PHUB_TIMEWEB_GAME_START_PRE0103_BACKUP_NAMESPACE_V1',
    mode: 'game-start-pre0103',
    preCount: 106,
    ledgerSha256: 'ff74c193b5e5253f929818b1550d0e5c0264a9818cb0ee5437d49d5aa043904e',
    receiptSchema: 'PHUB_TIMEWEB_GAME_START_PRE0103_BACKUP_RESTORE_V1',
    terminalSchema: 'PHUB_TIMEWEB_GAME_START_PRE0103_BACKUP_TERMINAL_V1',
    supervisorSchema: 'PHUB_GAME_START_PRE0103_SUPERVISOR_AUTHORITY_V1',
    preimageSchema: 'PHUB_TIMEWEB_GAME_START_PRE0103_PREIMAGE_V1',
  }),
  subject_link_0104: Object.freeze({
    schema: 'PHUB_TIMEWEB_SUBJECT_LINK_PRE0104_BACKUP_NAMESPACE_V1',
    mode: 'subject-link-pre0104',
    preCount: 107,
    ledgerSha256: '6146219b31e4720016bb81a0018f76609c7fc515603e4aac405f6a2342e66d77',
    receiptSchema: 'PHUB_TIMEWEB_SUBJECT_LINK_PRE0104_BACKUP_RESTORE_V1',
    terminalSchema: 'PHUB_TIMEWEB_SUBJECT_LINK_PRE0104_BACKUP_TERMINAL_V1',
    supervisorSchema: 'PHUB_SUBJECT_LINK_PRE0104_SUPERVISOR_AUTHORITY_V1',
    preimageSchema: 'PHUB_TIMEWEB_SUBJECT_LINK_PRE0104_PREIMAGE_V1',
  }),
});
const HASH = /^[a-f0-9]{64}$/,
  ROOT = '/opt/phub/timeweb-beta';
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort())
      : item,
  );
const same = (a, b) => canonical(a) === canonical(b);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => {
  throw Error(`CLOSED_APPLICATION_BACKUP_${code}`);
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    fail('SHAPE');
};
export function closedApplicationMigrationBinding(operation) {
  validateClosedApplicationOperation(operation);
  // A fresh migration expiry/confirmation does not change what the backup protects.
  const { expiresAt: _, confirmation: __, ...binding } = operation;
  return binding;
}
export function validateClosedApplicationBackupOperation(value, at) {
  exact(value, [
    'schema',
    'profile',
    'target',
    'toolCommit',
    'toolFileSha256',
    'controllerSha',
    'toolProofSha256',
    'toolInstallationSha256',
    'controllerTree',
    'controllerConfigSha256',
    'expectedBoundarySha256',
    'expectedApi',
    'expectedPostgres',
    'expiresAt',
    'confirmation',
    'releaseId',
    'controllerSourceCiRunId',
    'expectedLedgerSha256',
    'expectedDatabaseTarget',
    'packageDescriptorSha256',
    'catalogBuilderSha256',
    'catalogVariant',
    'migratorPrefetch',
    'migrationIntent',
  ]);
  const intent = validateClosedApplicationOperation(value.migrationIntent),
    profile = intent.migrationProfile,
    definition = CLOSED_APPLICATION_BACKUPS[profile];
  exact(value.migratorPrefetch, ['requestSha256', 'receiptSha256', 'migratorImage', 'imageId']);
  if (
    value.schema !== definition.schema ||
    value.profile !== 'beta' ||
    !same(value.target, CLOSED_APPLICATION_HOST_TARGET) ||
    !same(value.expectedDatabaseTarget, CLOSED_APPLICATION_DATABASE_TARGET) ||
    value.toolCommit !== intent.controllerSha ||
    value.controllerSha !== intent.controllerSha ||
    value.controllerTree !== intent.controllerTree ||
    value.controllerSourceCiRunId !== intent.controllerSourceCiRunId ||
    value.releaseId !== `${intent.controllerSha}-${intent.controllerSourceCiRunId}-1` ||
    value.expectedLedgerSha256 !== definition.ledgerSha256 ||
    descriptor.checkpoints[String(definition.preCount)].ledgerSha256 !== definition.ledgerSha256 ||
    value.packageDescriptorSha256 !== intent.packageDescriptorSha256 ||
    value.catalogBuilderSha256 !== intent.catalogBuilderSha256 ||
    value.catalogVariant !== intent.catalogVariant ||
    !same(value.expectedApi, intent.expectedApi) ||
    !same(value.expectedPostgres, intent.expectedPostgres) ||
    ![
      'toolFileSha256',
      'toolProofSha256',
      'toolInstallationSha256',
      'controllerConfigSha256',
      'expectedBoundarySha256',
    ].every((key) => HASH.test(value[key] ?? '')) ||
    !HASH.test(value.migratorPrefetch.requestSha256 ?? '') ||
    !HASH.test(value.migratorPrefetch.receiptSha256 ?? '') ||
    value.migratorPrefetch.migratorImage !== intent.publishedMigrator.image ||
    value.migratorPrefetch.imageId !== intent.publishedMigrator.imageId
  )
    fail('OPERATION');
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== value.expiresAt ||
    (at !== undefined && (expires - at < 1200000 || expires - at > 3600000)) ||
    value.confirmation !== `BACKUP_RESTORE_${profile.toUpperCase()}_PRIVATE_NAMESPACE_KEEP_RUNTIME`
  )
    fail('AUTHORITY');
  return value;
}
export function closedApplicationBackupDirectory(operation) {
  validateClosedApplicationBackupOperation(operation);
  return `${ROOT}/backups/${operation.releaseId}-${CLOSED_APPLICATION_BACKUPS[operation.migrationIntent.migrationProfile].mode}`;
}
export function validateClosedApplicationBackupReceipt(
  operation,
  backup,
  backupBytes,
  receiptBytes,
  preimageBytes,
  { now = Date.now(), fresh = true } = {},
) {
  validateClosedApplicationOperation(operation);
  validateClosedApplicationBackupOperation(backup);
  const receipt = parseStrictJson(receiptBytes),
    preimage = parseStrictJson(preimageBytes);
  if (!same(parseStrictJson(backupBytes), backup)) fail('OPERATION_BYTES');
  const profile = operation.migrationProfile,
    definition = CLOSED_APPLICATION_BACKUPS[profile],
    directory = closedApplicationBackupDirectory(backup);
  if (
    !same(
      closedApplicationMigrationBinding(operation),
      closedApplicationMigrationBinding(backup.migrationIntent),
    )
  )
    fail('MIGRATION_BINDING');
  exact(receipt, [
    'schema',
    'baselineReleaseId',
    'completedAt',
    'backupFile',
    'backupSha256',
    'restoreVerified',
    'restoreImage',
    'restoredLedgerSha256',
    'sourceLedgerSha256',
    'operationSha256',
    'target',
    'preimageSha256',
    'packageDescriptorSha256',
    'aclRecovery',
    'securityPreimageSha256',
    'restoredSecuritySha256',
    'roleClosureSha256',
    'migratorPrefetch',
    'migrationProfile',
    'catalogVariant',
    'catalogBuilderSha256',
    'migrationBindingSha256',
  ]);
  const completed = Date.parse(receipt.completedAt);
  if (
    receipt.schema !== definition.receiptSchema ||
    receipt.baselineReleaseId !== operation.expectedApi.releaseId ||
    receipt.backupFile !== `${directory}/database.pgcustom` ||
    !HASH.test(receipt.backupSha256 ?? '') ||
    receipt.restoreVerified !== true ||
    receipt.restoreImage !== operation.expectedPostgres.image ||
    receipt.sourceLedgerSha256 !== definition.ledgerSha256 ||
    receipt.restoredLedgerSha256 !== definition.ledgerSha256 ||
    receipt.operationSha256 !== hash(backupBytes) ||
    !same(receipt.target, CLOSED_APPLICATION_DATABASE_TARGET) ||
    receipt.preimageSha256 !== hash(preimageBytes) ||
    receipt.packageDescriptorSha256 !== operation.packageDescriptorSha256 ||
    receipt.catalogBuilderSha256 !== operation.catalogBuilderSha256 ||
    receipt.catalogVariant !== operation.catalogVariant ||
    receipt.migrationProfile !== profile ||
    receipt.migrationBindingSha256 !==
      hash(canonical(closedApplicationMigrationBinding(operation))) ||
    receipt.aclRecovery !== 'ISOLATED_OWNER_ACL_RESTORE_VERIFIED' ||
    !same(receipt.migratorPrefetch, backup.migratorPrefetch) ||
    !['securityPreimageSha256', 'restoredSecuritySha256', 'roleClosureSha256'].every((key) =>
      HASH.test(receipt[key] ?? ''),
    ) ||
    receipt.securityPreimageSha256 !== receipt.restoredSecuritySha256 ||
    !Number.isFinite(completed) ||
    new Date(completed).toISOString() !== receipt.completedAt ||
    now < completed ||
    (fresh && now - completed > 3600000)
  )
    fail('RECEIPT');
  exact(preimage, ['schema', 'state', 'target', 'security']);
  if (
    preimage.schema !== definition.preimageSchema ||
    !same(preimage.target, CLOSED_APPLICATION_DATABASE_TARGET)
  )
    fail('PREIMAGE');
  validateClosedApplicationState(operation, preimage.state, 'pre');
  const security = preimage.security;
  const pythonEncoded = (value) =>
    Buffer.from(
      (JSON.stringify(value) + '\n').replace(
        /[\u007f-\uffff]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
      ),
    );
  if (
    !security ||
    security.schema !== 'PHUB_NOTIFICATION_BACKUP_SECURITY_V1' ||
    !Array.isArray(security.objects) ||
    !Array.isArray(security.roles) ||
    receipt.securityPreimageSha256 !== hash(pythonEncoded(security)) ||
    receipt.roleClosureSha256 !== hash(pythonEncoded(security.roles))
  )
    fail('SECURITY_PREIMAGE');
  return {
    path: `${directory}/database-backup-receipt.json`,
    sha256: hash(receiptBytes),
    operationSha256: hash(backupBytes),
    preimageSha256: hash(preimageBytes),
    target: CLOSED_APPLICATION_DATABASE_TARGET,
    migrationProfile: profile,
    sourceLedgerSha256: definition.ledgerSha256,
    catalogVariant: operation.catalogVariant,
  };
}
export function closedApplicationBackupBindingSha256(operation) {
  return hash(canonical(closedApplicationMigrationBinding(operation)));
}
