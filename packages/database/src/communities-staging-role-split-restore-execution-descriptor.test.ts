import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  canonicalCommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
} from './communities-staging-role-split-restore-execution-descriptor.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const descriptor = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION,
  mode: 'CODE_ONLY_DISABLED',
  markerRequestSha256: sha('request'),
  creationReceiptSha256: sha('receipt'),
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  identity: {
    connectionLogin: { name: 'phub_restore', oid: '16384' },
    restoreRole: { name: 'phub_restore', oid: '16384' },
    relation: 'SAME',
  },
  pgRestoreSha256: sha('pg_restore'),
  pgpassBasename: 'role-split.pgpass',
  sourceWriteDenialEvidenceSha256: sha('source denial'),
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
} as const satisfies CommunitiesStagingRoleSplitRestoreExecutionDescriptor;

describe('CommunitiesStagingRoleSplitRestoreExecutionDescriptor', () => {
  it('canonicalizes and SHA-pins the exact V1 descriptor', () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreExecutionDescriptor(descriptor);
    expect(canonical.startsWith('{"authorizes":')).toBe(true);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(descriptor)).toBe(
      sha(canonical),
    );
  });

  it.each([
    ['extra key', { ...descriptor, extra: true }],
    [
      'missing key',
      Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== 'pgpassBasename')),
    ],
    [
      'execution authority',
      { ...descriptor, authorizes: { ...descriptor.authorizes, execution: true } },
    ],
    ['clone OID', { ...descriptor, cloneDatabaseOid: '0' }],
    [
      'remote host',
      { ...descriptor, connection: { ...descriptor.connection, host: 'db.example' } },
    ],
    ['TLS mode', { ...descriptor, connection: { ...descriptor.connection, sslMode: 'require' } }],
    [
      'role mismatch',
      {
        ...descriptor,
        identity: { ...descriptor.identity, restoreRole: { name: 'other_role', oid: '16384' } },
      },
    ],
    [
      'OID mismatch',
      {
        ...descriptor,
        identity: { ...descriptor.identity, restoreRole: { name: 'phub_restore', oid: '16385' } },
      },
    ],
    ['path basename', { ...descriptor, pgpassBasename: '../pgpass' }],
    ['preflight timeout', { ...descriptor, timeouts: { ...descriptor.timeouts, preflightMs: 0 } }],
    [
      'restore timeout',
      { ...descriptor, timeouts: { ...descriptor.timeouts, restoreMs: 1_800_001 } },
    ],
  ])('rejects %s', (_name, invalid) => {
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor(
        invalid as CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
      ),
    ).toThrow(/RESTORE_EXECUTION_DESCRIPTOR_/);
  });
});
