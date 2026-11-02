// Exact prefix-specific profiles over the existing namespace owner/ACL backup producer.
import { parseStrictJson } from './strict-json.js';
import { validateR1TailOperation, R1_TAIL_ROOT } from './r1-tail-migration-controller.js';
import {
  R1_TAIL,
  R1_TAIL_TARGET,
  r1Exact,
  r1Hash,
  r1Encode,
  r1Same,
  r1Stop,
} from './r1-tail-migration-profile.js';
import { validateR1TailState } from './r1-tail-migration-state.js';
const HASH = /^[a-f0-9]{64}$/;
export function r1TailBackupDefinition(count) {
  if (!Number.isSafeInteger(count) || count < 108 || count > 118) r1Stop('BACKUP_PREFIX');
  return Object.freeze({
    schema: `PHUB_TIMEWEB_R1_TAIL_PRE${count}_BACKUP_NAMESPACE_V1`,
    kind: 'r1_tail108_119',
    mode: `r1-tail-pre${count}`,
    preCount: count,
    ledgerSha256: R1_TAIL.checkpoints[String(count)],
    receiptSchema: `PHUB_TIMEWEB_R1_TAIL_PRE${count}_BACKUP_RESTORE_V1`,
    terminalSchema: `PHUB_TIMEWEB_R1_TAIL_PRE${count}_BACKUP_TERMINAL_V1`,
    preimageSchema: `PHUB_TIMEWEB_R1_TAIL_PRE${count}_PREIMAGE_V1`,
  });
}
export function r1TailMigrationBinding(op) {
  validateR1TailOperation(op);
  // Backup reference is necessarily filled after backup; expiry is renewable authority only.
  const { backup: _, expiresAt: __, confirmation: ___, ...binding } = op;
  return binding;
}
export function r1TailBackupBindingHash(op) {
  return r1Hash(
    JSON.stringify(r1TailMigrationBinding(op), (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort())
        : value,
    ),
  );
}
export function validateR1TailBackupOperation(value, at) {
  r1Exact(value, [
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
  const op = validateR1TailOperation(value.migrationIntent),
    definition = r1TailBackupDefinition(op.fromCount);
  r1Exact(value.migratorPrefetch, ['requestSha256', 'receiptSha256', 'migratorImage', 'imageId']);
  if (
    value.schema !== definition.schema ||
    value.profile !== 'beta' ||
    value.toolCommit !== op.controllerSha ||
    value.releaseId !== `${op.controllerSha}-${op.controllerSourceCiRunId}-1` ||
    value.expectedLedgerSha256 !== definition.ledgerSha256 ||
    ![
      'toolFileSha256',
      'toolProofSha256',
      'toolInstallationSha256',
      'controllerConfigSha256',
      'expectedBoundarySha256',
    ].every((k) => HASH.test(value[k] ?? '')) ||
    ![
      'profile',
      'target',
      'controllerSha',
      'controllerTree',
      'controllerSourceCiRunId',
      'expectedApi',
      'expectedPostgres',
      'expectedDatabaseTarget',
      'packageDescriptorSha256',
      'catalogBuilderSha256',
      'catalogVariant',
    ].every((k) => r1Same(value[k], op[k])) ||
    !HASH.test(value.migratorPrefetch.requestSha256 ?? '') ||
    !HASH.test(value.migratorPrefetch.receiptSha256 ?? '') ||
    value.migratorPrefetch.migratorImage !== op.publishedMigrator.image ||
    value.migratorPrefetch.imageId !== op.publishedMigrator.imageId
  )
    r1Stop('BACKUP_OPERATION');
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== value.expiresAt ||
    (at !== undefined && (expires - at < 1200000 || expires - at > 3600000)) ||
    value.confirmation !== 'BACKUP_RESTORE_R1_TAIL108_119_PRIVATE_NAMESPACE_KEEP_RUNTIME'
  )
    r1Stop('BACKUP_AUTHORITY');
  return value;
}
export function r1TailBackupDirectory(value) {
  validateR1TailBackupOperation(value);
  return `${R1_TAIL_ROOT}/backups/${value.releaseId}-${r1TailBackupDefinition(value.migrationIntent.fromCount).mode}-${value.migrationIntent.attemptId}`;
}
export function validateR1TailBackupReceipt(
  op,
  raw,
  receiptBytes,
  preimageBytes,
  { now = Date.now(), fresh = true } = {},
) {
  validateR1TailOperation(op);
  const backup = validateR1TailBackupOperation(parseStrictJson(raw));
  const receipt = parseStrictJson(receiptBytes),
    preimage = parseStrictJson(preimageBytes);
  const definition = r1TailBackupDefinition(op.fromCount),
    directory = r1TailBackupDirectory(backup);
  if (
    !r1Same(r1TailMigrationBinding(op), r1TailMigrationBinding(backup.migrationIntent)) ||
    op.backup.operationPath !== directory + '/backup-operation.json' ||
    op.backup.operationSha256 !== r1Hash(raw) ||
    op.backup.receiptSha256 !== r1Hash(receiptBytes) ||
    op.backup.preimageSha256 !== r1Hash(preimageBytes)
  )
    r1Stop('BACKUP_BINDING');
  r1Exact(receipt, [
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
    receipt.baselineReleaseId !== op.expectedApi.releaseId ||
    receipt.backupFile !== directory + '/database.pgcustom' ||
    !HASH.test(receipt.backupSha256 ?? '') ||
    receipt.restoreVerified !== true ||
    receipt.restoreImage !== op.expectedPostgres.image ||
    receipt.sourceLedgerSha256 !== definition.ledgerSha256 ||
    receipt.restoredLedgerSha256 !== definition.ledgerSha256 ||
    receipt.operationSha256 !== r1Hash(raw) ||
    !r1Same(receipt.target, R1_TAIL_TARGET) ||
    receipt.preimageSha256 !== r1Hash(preimageBytes) ||
    receipt.packageDescriptorSha256 !== op.packageDescriptorSha256 ||
    receipt.catalogBuilderSha256 !== op.catalogBuilderSha256 ||
    receipt.catalogVariant !== op.catalogVariant ||
    receipt.migrationProfile !== 'r1_tail108_119' ||
    receipt.migrationBindingSha256 !== r1TailBackupBindingHash(op) ||
    receipt.aclRecovery !== 'ISOLATED_OWNER_ACL_RESTORE_VERIFIED' ||
    !r1Same(receipt.migratorPrefetch, backup.migratorPrefetch) ||
    !HASH.test(receipt.securityPreimageSha256 ?? '') ||
    receipt.securityPreimageSha256 !== receipt.restoredSecuritySha256 ||
    !Number.isFinite(completed) ||
    new Date(completed).toISOString() !== receipt.completedAt ||
    completed > now ||
    (fresh && now - completed > 3600000)
  )
    r1Stop('BACKUP_RECEIPT');
  r1Exact(preimage, ['schema', 'state', 'target', 'security']);
  if (preimage.schema !== definition.preimageSchema || !r1Same(preimage.target, R1_TAIL_TARGET))
    r1Stop('BACKUP_PREIMAGE');
  validateR1TailState(op, preimage.state, 'cleaned', op.fromCount);
  // Match the producer's canonical Python encoding, including non-ASCII escapes.
  const pythonEncode = (value) =>
    Buffer.from(
      (JSON.stringify(value) + '\n').replace(
        /[\u007f-\uffff]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
      ),
    );
  if (
    preimage.security?.schema !== 'PHUB_NOTIFICATION_BACKUP_SECURITY_V1' ||
    !Array.isArray(preimage.security.roles) ||
    receipt.securityPreimageSha256 !== r1Hash(pythonEncode(preimage.security)) ||
    receipt.roleClosureSha256 !== r1Hash(pythonEncode(preimage.security.roles))
  )
    r1Stop('BACKUP_SECURITY');
  return {
    path: directory + '/database-backup-receipt.json',
    sha256: r1Hash(receiptBytes),
    operationSha256: r1Hash(raw),
    preimageSha256: r1Hash(preimageBytes),
    target: R1_TAIL_TARGET,
    sourceLedgerSha256: definition.ledgerSha256,
  };
}
