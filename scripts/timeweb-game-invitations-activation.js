import { createHash } from 'node:crypto';
import {
  GAME_INVITATIONS_0120,
  validateGameInvitations0120Request,
} from './timeweb-game-invitations-migration.js';
import { parseStrictJson } from './strict-json.js';

export const GAME_INVITATIONS_ACTIVATION = Object.freeze({
  schema: 'PHUB_TIMEWEB_API_WEB_GAME_INVITATIONS_0120_DIRECT_V2',
  application: '53af9f2e114de228a9b26fcbcf7ef7e284bd85f4',
  tree: 'e9504e533b4ec4c7b444ff197e1ddc128ca0553a',
  suffix: '_GAME_INVITATIONS_0120_DIRECT',
  rolloutReceipt: 'PHUB_TIMEWEB_API_WEB_GAME_INVITATIONS_0120_DIRECT_RECEIPT_V2',
  observation: 'PHUB_TIMEWEB_API_WEB_GAME_INVITATIONS_0120_DIRECT_OBSERVATION_V2',
  backupSchema: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_FRESH_BACKUP_V1',
  backupReceipt: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_FRESH_DUMP_V1',
  backupPolicy: 'GAME_INVITATIONS_0120_INTEGRITY_ONLY_V1',
  migrationReceipt: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_RECEIPT_V1',
});

export const GAME_INVITATIONS_MONITORING_STATUS = Object.freeze({
  providerMonitoringStatus: 'NOT_COLLECTED_EXPLICIT_OVERRIDE',
  alertTestStatus: 'NOT_TESTED_EXPLICIT_OVERRIDE',
  ownerMessageSha256: GAME_INVITATIONS_0120.restoreMessageSha256,
});

const tailFiles = new Map([
  ['scripts/control-timeweb-database-backup.py', 'M'],
  ['scripts/test-timeweb-database-backup.py', 'M'],
  ['scripts/run-timeweb-standard-delivery.js', 'M'],
  ['scripts/timeweb-api-web-upgrade.d.ts', 'M'],
  ['scripts/timeweb-api-web-upgrade.js', 'M'],
  ['scripts/timeweb-api-web-upgrade.test.ts', 'M'],
  ['scripts/timeweb-game-invitations-migration.js', 'M'],
  ['scripts/timeweb-game-invitations-activation.js', 'A'],
  ['scripts/timeweb-game-invitations-activation.d.ts', 'A'],
  ['scripts/timeweb-game-invitations-activation.test.ts', 'A'],
  ['docs/runbooks/timeweb-game-invitations-0120.md', 'M'],
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = (reason) => {
  throw new Error(`game_invitations_activation_${reason}`);
};

export function validateGameInvitationsActivationTail(anchorTree, entries) {
  if (
    anchorTree !== GAME_INVITATIONS_ACTIVATION.tree ||
    entries.length !== tailFiles.size ||
    new Set(entries.map(({ path }) => path)).size !== entries.length ||
    entries.some(
      ({ path, status, newMode, oldMode, newType, oldType, newOid, oldOid }) =>
        tailFiles.get(path) !== status ||
        newMode !== '100644' ||
        newType !== 'blob' ||
        !sha.test(newOid) ||
        (status === 'M'
          ? oldMode !== '100644' || oldType !== 'blob' || !sha.test(oldOid) || oldOid === newOid
          : status !== 'A' ||
            oldMode !== '000000' ||
            oldType !== null ||
            oldOid !== '0'.repeat(40)),
    )
  )
    fail('source');
}

export function validateGameInvitationsActivationInputs(op) {
  if (
    op.schema !== GAME_INVITATIONS_ACTIVATION.schema ||
    op.ownerMessageSha256 !== GAME_INVITATIONS_MONITORING_STATUS.ownerMessageSha256 ||
    !uuid.test(op.migrationAttemptId ?? '') ||
    !digest.test(op.migrationReceiptSha256 ?? '') ||
    [op.expectedApi, op.expectedWeb].some(
      (entry) => entry?.releaseId !== GAME_INVITATIONS_0120.baselineReleaseId,
    )
  )
    fail('input');
}

export function validateGameInvitationsActivationMigration(op, proof) {
  const receipt = parseStrictJson(proof.receiptBytes);
  const request = validateGameInvitations0120Request(parseStrictJson(proof.requestBytes), {
    controllerSha: op.controllerSha,
    owner: proof.owner,
  });
  if (
    hash(proof.receiptBytes) !== op.migrationReceiptSha256 ||
    hash(proof.backupOperationBytes) !== op.backupOperationSha256 ||
    hash(proof.backupReceiptBytes) !== request.retainedBackupReceiptSha256 ||
    receipt.schema !== GAME_INVITATIONS_ACTIVATION.migrationReceipt ||
    receipt.state !== 'COMMITTED' ||
    receipt.attemptId !== op.migrationAttemptId ||
    request.attemptId !== op.migrationAttemptId ||
    request.backupReleaseId !== `${op.candidateSha}-${op.publicationRunId}-1` ||
    request.postgresContainerId !== proof.postgresId ||
    request.expiresAt !== op.expiresAt ||
    receipt.migrationSha256 !== GAME_INVITATIONS_0120.checksum ||
    hash(proof.requestBytes) !== receipt.requestSha256 ||
    !digest.test(receipt.catalogSha256 ?? '')
  )
    fail('migration_receipt');
  const backupOperation = parseStrictJson(proof.backupOperationBytes);
  const backupReceipt = parseStrictJson(proof.backupReceiptBytes);
  if (
    backupOperation.schema !== GAME_INVITATIONS_ACTIVATION.backupSchema ||
    backupOperation.expectedPostgres?.id !== proof.postgresId ||
    backupOperation.expectedPostgres?.startedAt !== proof.postgresStartedAt ||
    backupOperation.expectedLedgerSha256 !== GAME_INVITATIONS_0120.backupLedger ||
    backupReceipt.schema !== GAME_INVITATIONS_ACTIVATION.backupReceipt ||
    backupReceipt.operationSha256 !== op.backupOperationSha256 ||
    backupReceipt.policySha256 !== request.externalRestoreDecision.backupDecisionSha256 ||
    backupReceipt.sourceLedgerSha256 !== GAME_INVITATIONS_0120.backupLedger
  )
    fail('migration_backup');
  return receipt.catalogSha256;
}

export function validateGameInvitationsActivationReadback(readback, catalogSha256) {
  if (readback?.state !== 'COMMITTED' || readback.catalogSha256 !== catalogSha256)
    fail('migration_readback');
}
