import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { describe, expect, it, vi } from 'vitest';

import {
  CommunitiesStagingRoleSplitRunnerAdapter,
  type CommunitiesStagingRoleSplitRestoreArchiveInput,
} from './communities-staging-role-split-runner-adapter.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const request = {
  restoreDatabase: 'phub_restore_123_4',
  expectedCloneDatabaseOwner: 'phub_restore',
  expectedCloneDatabaseOwnerOid: '16384',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16384',
  systemIdentifier: '7421000000000000000',
  backupBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump',
  backupSha256: sha('archive'),
  backupBytes: '7',
  backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
  backupEvidenceSha256: sha('evidence'),
  archiveTocSha256: sha('toc'),
  sourceLedgerSha256: communitiesStagingRoleSplitLedgerSha256([
    { filename: '0001_initial.sql', checksum: 'a'.repeat(64) },
  ]),
  sourceLedgerCount: '1',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: '2'.repeat(64),
  markerWriterSha256: '3'.repeat(64),
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
const descriptor: CommunitiesStagingRoleSplitRestoreExecutionDescriptor = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION,
  mode: 'CODE_ONLY_DISABLED',
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  creationReceiptSha256: '1'.repeat(64),
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  identity: {
    connectionLogin: { name: 'phub_restore', oid: '16384' },
    restoreRole: { name: 'phub_restore', oid: '16384' },
    relation: 'SAME',
  },
  pgRestoreSha256: '4'.repeat(64),
  pgpassBasename: 'role-split.pgpass',
  sourceWriteDenialEvidenceSha256: '5'.repeat(64),
  timeouts: { preflightMs: 10_000, restoreMs: 600_000 },
  authorizes: {
    execution: false,
    cloneCreation: false,
    restore: false,
    markerWrite: false,
    evidencePublication: false,
    automaticCleanup: false,
    roleCreation: false,
    roleSplit: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    import: false,
    activation: false,
  },
};

function input(overrides: Partial<CommunitiesStagingRoleSplitRestoreArchiveInput> = {}) {
  const archiveTouched = vi.fn(() => {
    throw new Error('archive must remain unopened');
  });
  return {
    value: {
      archiveFile: {
        get fd() {
          return archiveTouched();
        },
      } as never,
      cloneDatabaseOid: '45678',
      request,
      ...overrides,
    } satisfies CommunitiesStagingRoleSplitRestoreArchiveInput,
    archiveTouched,
  };
}

describe('CommunitiesStagingRoleSplitRunnerAdapter', () => {
  it('rejects before touching the archive or invoking a fence/collaborator', async () => {
    const adapter = new CommunitiesStagingRoleSplitRunnerAdapter({
      request,
      descriptor,
      creationReceiptSha256: descriptor.creationReceiptSha256,
    });
    const fixture = input();
    await expect(adapter.restoreArchive(fixture.value)).rejects.toMatchObject({
      code: 'EXECUTION_NOT_AUTHORIZED',
    });
    expect(fixture.archiveTouched).not.toHaveBeenCalled();
  });

  type FailureCase = {
    readonly descriptor?: CommunitiesStagingRoleSplitRestoreExecutionDescriptor;
    readonly creationReceiptSha256?: string;
    readonly input?: Partial<CommunitiesStagingRoleSplitRestoreArchiveInput>;
  };
  const failureCases: readonly [string, FailureCase][] = [
    ['request SHA', { descriptor: { ...descriptor, markerRequestSha256: '0'.repeat(64) } }],
    ['receipt SHA', { creationReceiptSha256: '0'.repeat(64) }],
    ['callback clone OID', { input: { cloneDatabaseOid: '45679' } }],
    [
      'restore role binding',
      {
        descriptor: {
          ...descriptor,
          identity: { ...descriptor.identity, restoreRole: { name: 'wrong_role', oid: '16384' } },
        },
      },
    ],
    [
      'disabled authority changed',
      {
        descriptor: {
          ...descriptor,
          authorizes: {
            ...descriptor.authorizes,
            restore: true,
          } as unknown as CommunitiesStagingRoleSplitRestoreExecutionDescriptor['authorizes'],
        },
      },
    ],
  ];
  it('fails closed for every binding mismatch before execution', async () => {
    for (const [, change] of failureCases) {
      const fixture = input(change.input);
      const adapter = new CommunitiesStagingRoleSplitRunnerAdapter({
        request,
        descriptor: change.descriptor ?? descriptor,
        creationReceiptSha256: change.creationReceiptSha256 ?? descriptor.creationReceiptSha256,
      });
      await expect(adapter.restoreArchive(fixture.value)).rejects.toMatchObject({
        code: 'EXECUTION_NOT_AUTHORIZED',
      });
      expect(fixture.archiveTouched).not.toHaveBeenCalled();
    }
  });
});
