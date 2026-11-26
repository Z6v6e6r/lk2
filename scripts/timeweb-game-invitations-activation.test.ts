import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateApiWebOperation } from './timeweb-api-web-upgrade.js';
import {
  GAME_INVITATIONS_ACTIVATION as profile,
  validateGameInvitationsActivationMigration as verify,
  validateGameInvitationsActivationReadback,
  validateGameInvitationsActivationTail,
} from './timeweb-game-invitations-activation.js';
import { GAME_INVITATIONS_0120 as migration } from './timeweb-game-invitations-migration.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const h = (digit: string) => digit.repeat(64);
const candidate = 'a'.repeat(40);
const publicationRunId = '12345';
const attempt = '10000000-0000-4000-8000-000000000001';
const expiresAt = '2026-11-26T16:59:00.000Z';
const postgresId = h('d');
const postgresStartedAt = '2026-08-28T16:49:17.916395698Z';
const owner = 'test-operator';
const catalog = h('b');
const backupOperationBytes = bytes({
  schema: profile.backupSchema,
  expectedPostgres: { id: postgresId, startedAt: postgresStartedAt },
  expectedLedgerSha256: migration.backupLedger,
});
const backupReceiptBytes = bytes({
  schema: profile.backupReceipt,
  operationSha256: sha(backupOperationBytes),
  policySha256: h('f'),
  sourceLedgerSha256: migration.backupLedger,
});
const requestBytes = bytes({
  schema: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_REQUEST_V1',
  attemptId: attempt,
  controllerSha: candidate,
  migrationSourceSha: candidate,
  postgresContainerId: postgresId,
  expiresAt,
  backupReleaseId: candidate + '-' + publicationRunId + '-1',
  retainedBackupReceiptSha256: sha(backupReceiptBytes),
  externalRestoreDecision: {
    status: migration.restoreDecision,
    owner,
    referenceSha256: migration.restoreMessageSha256,
    backupDecisionSha256: h('f'),
  },
});
const receipt = {
  schema: profile.migrationReceipt,
  state: 'COMMITTED',
  attemptId: attempt,
  migrationSha256: migration.checksum,
  requestSha256: sha(requestBytes),
  catalogSha256: catalog,
};
const proof = {
  receiptBytes: bytes(receipt),
  requestBytes,
  backupOperationBytes,
  backupReceiptBytes,
  postgresId,
  postgresStartedAt,
  owner,
};

const previous = (service: string) => ({
  id: h('b'),
  image: 'ghcr.io/z6v6e6r/phub-' + service + '@sha256:' + h('e'),
  releaseId: migration.baselineReleaseId,
});
const operation = {
  schema: profile.schema,
  target: 'lk2.padlhub.su',
  profile: 'production',
  controllerSha: candidate,
  candidateSha: candidate,
  candidateTree: 'b'.repeat(40),
  sourceCiRunId: '1',
  publicationRunId,
  artifactId: '2',
  artifactDigest: 'sha256:' + h('c'),
  manifestSha256: h('3'),
  migrationAttemptId: attempt,
  migrationReceiptSha256: sha(proof.receiptBytes),
  backupOperationSha256: sha(backupOperationBytes),
  expectedApi: previous('api'),
  expectedWeb: previous('web'),
  expiresAt,
  confirmation: 'DEPLOY_API_WEB_AAAAAAAAAAAA_FROM_DD73C7E02E81_DD73C7E02E81_GAME_INVITATIONS_0120',
};

it('binds only the reviewed product tree and regular controller changes', () => {
  const entry = {
    path: 'scripts/timeweb-game-invitations-activation.js',
    status: 'A',
    newMode: '100644',
    oldMode: '000000',
    newOid: candidate,
    oldOid: '0'.repeat(40),
    newType: 'blob',
    oldType: null,
  };
  const closure = [
    entry,
    ...['.d.ts', '.test.ts'].map((suffix) => ({
      ...entry,
      path: `scripts/timeweb-game-invitations-activation${suffix}`,
    })),
    ...[
      'scripts/control-timeweb-database-backup.py',
      'scripts/test-timeweb-database-backup.py',
      'scripts/run-timeweb-standard-delivery.js',
      'scripts/timeweb-api-web-upgrade.d.ts',
      'scripts/timeweb-api-web-upgrade.js',
      'scripts/timeweb-api-web-upgrade.test.ts',
      'scripts/timeweb-game-invitations-migration.js',
      'docs/runbooks/timeweb-game-invitations-0120.md',
    ].map((path) => ({
      ...entry,
      path,
      status: 'M',
      oldMode: '100644',
      oldOid: 'b'.repeat(40),
      oldType: 'blob',
    })),
  ];
  expect(() => validateGameInvitationsActivationTail(profile.tree, closure)).not.toThrow();
  for (const bad of [
    [
      { ...entry, path: 'packages/database/migrations/0120_game_friend_invitations.sql' },
      ...closure.slice(1),
    ],
    [{ ...entry, path: 'apps/api/src/app.ts' }, ...closure.slice(1)],
    [{ ...entry, newMode: '120000', newType: 'symlink' }, ...closure.slice(1)],
    [entry, entry, ...closure.slice(2)],
    closure.slice(1),
  ])
    expect(() => validateGameInvitationsActivationTail(profile.tree, bad)).toThrow('source');
  expect(() => validateGameInvitationsActivationTail(candidate, closure)).toThrow('source');
});

it('admits an exact production API/Web operation without a monitoring waiver field', () => {
  expect(validateApiWebOperation(operation)).toEqual(operation);
  for (const bad of [
    { ...operation, profile: 'beta' },
    { ...operation, controllerSha: 'd'.repeat(40) },
    { ...operation, migrationAttemptId: '../previous' },
    { ...operation, expectedWeb: { ...operation.expectedWeb, releaseId: candidate + '-99-1' } },
    { ...operation, monitoringWaiver: true },
    { ...operation, confirmation: operation.confirmation.replace(profile.suffix, '') },
  ])
    expect(() => validateApiWebOperation(bad)).toThrow();
});

it('requires the committed migration and original backup on the same PostgreSQL target', () => {
  expect(verify(operation, proof)).toBe(catalog);
  const rolledBack = bytes({ ...receipt, state: 'ROLLED_BACK' });
  expect(() =>
    verify(
      { ...operation, migrationReceiptSha256: sha(rolledBack) },
      { ...proof, receiptBytes: rolledBack },
    ),
  ).toThrow('migration_receipt');
  expect(() => verify(operation, { ...proof, postgresId: h('2') })).toThrow('migration_receipt');
  expect(() => verify(operation, { ...proof, postgresStartedAt: 'other' })).toThrow(
    'migration_backup',
  );
  expect(() => verify(operation, { ...proof, requestBytes: bytes({}) })).toThrow();
  expect(() => verify(operation, { ...proof, backupReceiptBytes: bytes({}) })).toThrow(
    'migration_receipt',
  );
  expect(() => verify({ ...operation, expiresAt: '2026-11-26T17:00:00.000Z' }, proof)).toThrow(
    'migration_receipt',
  );
  expect(() =>
    validateGameInvitationsActivationReadback(
      { state: 'COMMITTED', catalogSha256: catalog },
      catalog,
    ),
  ).not.toThrow();
  expect(() =>
    validateGameInvitationsActivationReadback(
      { state: 'PREIMAGE', catalogSha256: catalog },
      catalog,
    ),
  ).toThrow('migration_readback');
  expect(() =>
    validateGameInvitationsActivationReadback(
      { state: 'COMMITTED', catalogSha256: h('1') },
      catalog,
    ),
  ).toThrow('migration_readback');
});
