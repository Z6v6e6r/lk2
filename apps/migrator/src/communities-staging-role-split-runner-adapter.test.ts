/* eslint-disable @typescript-eslint/require-await */
import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitRestoreExecutionEvidence,
  type CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  type CommunitiesSourceConnectAclObservation,
  type CommunitiesSourceMembershipObservation,
} from '@phub/database';
import { describe, expect, it, vi } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  CommunitiesStagingRoleSplitReviewedRunnerAdapter,
  CommunitiesStagingRoleSplitRunnerAdapter,
  assertCommunitiesStagingRoleSplitRunnerAdapterBinding,
  type CommunitiesStagingRoleSplitRestoreArchiveInput,
} from './communities-staging-role-split-runner-adapter.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const request = {
  restoreDatabase: 'phub_restore_123_4',
  expectedCloneDatabaseOwner: 'phub_restore',
  expectedCloneDatabaseOwnerOid: '16386',
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
const attestation = {
  schemaVersion: 'communities-staging-role-split-source-write-denial-attestation-v1',
  status: 'SOURCE_CONNECT_DENIED',
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  systemIdentifier: request.systemIdentifier,
  postgresMajor: '16',
  sourceDatabase: {
    name: request.sourceDatabase,
    oid: request.sourceDatabaseOid,
    owner: { name: request.sourceDatabaseOwner, oid: request.sourceDatabaseOwnerOid },
    connectAclObservationSha256: sha('source connect acl'),
  },
  restorePrincipal: {
    name: 'phub_restore',
    oid: '16386',
    membershipObservationSha256: sha('restore membership'),
    attributes: {
      superuser: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
    },
  },
  checks: { owner: false, effectiveConnect: false, rejectedBeforeQuery: true, sqlState: '42501' },
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
} as const satisfies CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
const connectAclObservation = {
  schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
  databaseOid: request.sourceDatabaseOid,
  databaseOwnerOid: request.sourceDatabaseOwnerOid,
  aclState: 'EXPLICIT',
  rows: [],
} as const satisfies CommunitiesSourceConnectAclObservation;
const membershipObservation = {
  schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
  principalOid: attestation.restorePrincipal.oid,
  rows: [],
} as const satisfies CommunitiesSourceMembershipObservation;
const boundAttestation = {
  ...attestation,
  sourceDatabase: {
    ...attestation.sourceDatabase,
    connectAclObservationSha256:
      communitiesSourceConnectAclObservationSha256(connectAclObservation),
  },
  restorePrincipal: {
    ...attestation.restorePrincipal,
    membershipObservationSha256:
      communitiesSourceMembershipObservationSha256(membershipObservation),
  },
} as const satisfies CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
const descriptor: CommunitiesStagingRoleSplitRestoreExecutionDescriptor = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION,
  mode: 'CODE_ONLY_DISABLED',
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  creationReceiptSha256: '1'.repeat(64),
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  identity: {
    connectionLogin: {
      name: attestation.restorePrincipal.name,
      oid: attestation.restorePrincipal.oid,
    },
    restoreRole: { name: attestation.restorePrincipal.name, oid: attestation.restorePrincipal.oid },
    relation: 'SAME',
  },
  pgRestoreSha256: '4'.repeat(64),
  pgpassBasename: 'role-split.pgpass',
  sourceWriteDenialEvidenceSha256:
    communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(boundAttestation),
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
const restoreExecutionEvidence = {
  schemaVersion: 'communities-staging-role-split-restore-execution-evidence-v1',
  status: 'PREPARATION_ONLY',
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  sourceWriteDenialAttestationSha256: communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(
    {
      ...attestation,
      sourceDatabase: {
        ...attestation.sourceDatabase,
        connectAclObservationSha256:
          communitiesSourceConnectAclObservationSha256(connectAclObservation),
      },
      restorePrincipal: {
        ...attestation.restorePrincipal,
        membershipObservationSha256:
          communitiesSourceMembershipObservationSha256(membershipObservation),
      },
    },
  ),
  restoreExecutionDescriptorSha256:
    communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(descriptor),
  creationReceiptSha256: descriptor.creationReceiptSha256,
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  postgresMajor: '16',
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
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
    statePersistence: false,
  },
} as const satisfies CommunitiesStagingRoleSplitRestoreExecutionEvidence;

const execution = {
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  restoreLogin: {
    name: request.expectedCloneDatabaseOwner,
    oid: request.expectedCloneDatabaseOwnerOid,
  },
  pgRestoreSha256: sha('pg_restore'),
  canonicalHostAdapterSha256: sha('canonical adapter'),
  cloneOnlyConnectionFactorySha256: sha('connection factory'),
  ddlFenceSha256: sha('ddl fence'),
} as const;
const subjects = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [code, sha(`subject:${code}`)]),
) as Record<(typeof COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES)[number], string>;
subjects.CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER = execution.canonicalHostAdapterSha256;
subjects.CLONE_ONLY_CONNECTION_FACTORY = execution.cloneOnlyConnectionFactorySha256;
subjects.CLUSTER_DDL_FENCE = execution.ddlFenceSha256;
subjects.OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS =
  communitiesStagingRoleSplitConnectionSubjectSha256(execution);
subjects.PG_RESTORE_EXECUTABLE_SHA256 = execution.pgRestoreSha256;
subjects.RESTORE_LOGIN_ROLE = communitiesStagingRoleSplitRestoreLoginSubjectSha256(
  execution.restoreLogin,
);
const authorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  status: 'REVIEWED',
  candidateCommitSha: 'a'.repeat(40),
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  creationReceiptSha256: '1'.repeat(64),
  execution,
  bindings: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => ({
    code,
    status: 'VERIFIED' as const,
    subjectSha256: subjects[code],
    evidenceSha256: sha(`evidence:${code}`),
  })),
  authorizes: {
    restoreExecution: true,
    markerWrite: true,
    evidencePublication: true,
    automaticCleanup: false,
    roleCreation: false,
    roleSplit: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    import: false,
    activation: false,
  },
} as const satisfies CommunitiesStagingRoleSplitHostAuthorization;

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
  it('accepts only the nominal binding synchronously', () => {
    const fixture = input();
    const config = {
      request,
      descriptor,
      sourceWriteDenialAttestation: boundAttestation,
      connectAclObservation,
      membershipObservation,
      restoreExecutionEvidence,
      creationReceiptSha256: descriptor.creationReceiptSha256,
    } as const;
    expect(() =>
      assertCommunitiesStagingRoleSplitRunnerAdapterBinding(config, fixture.value),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitRunnerAdapterBinding(config, {
        request,
        cloneDatabaseOid: '45679',
      }),
    ).toThrow(/EXECUTION_NOT_AUTHORIZED/);
  });

  it('rejects before touching the archive or invoking a fence/collaborator', async () => {
    const adapter = new CommunitiesStagingRoleSplitRunnerAdapter({
      request,
      descriptor,
      sourceWriteDenialAttestation: boundAttestation,
      connectAclObservation,
      membershipObservation,
      restoreExecutionEvidence,
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
    readonly sourceWriteDenialAttestation?: CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
    readonly restoreExecutionEvidence?: CommunitiesStagingRoleSplitRestoreExecutionEvidence;
    readonly input?: Partial<CommunitiesStagingRoleSplitRestoreArchiveInput>;
  };
  const failureCases: readonly [string, FailureCase][] = [
    ['request SHA', { descriptor: { ...descriptor, markerRequestSha256: '0'.repeat(64) } }],
    ['receipt SHA', { creationReceiptSha256: '0'.repeat(64) }],
    ['callback clone OID', { input: { cloneDatabaseOid: '45679' } }],
    [
      'execution evidence descriptor digest',
      {
        restoreExecutionEvidence: {
          ...restoreExecutionEvidence,
          restoreExecutionDescriptorSha256: '0'.repeat(64),
        },
      },
    ],
    [
      'execution evidence receipt',
      {
        restoreExecutionEvidence: {
          ...restoreExecutionEvidence,
          creationReceiptSha256: '0'.repeat(64),
        },
      },
    ],
    [
      'execution evidence system/run binding',
      {
        restoreExecutionEvidence: { ...restoreExecutionEvidence, restoreRunAttempt: '5' },
      },
    ],
    [
      'source write denial attestation',
      {
        sourceWriteDenialAttestation: {
          ...boundAttestation,
          checks: { ...boundAttestation.checks, effectiveConnect: true },
        } as unknown as CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
      },
    ],
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
        sourceWriteDenialAttestation: change.sourceWriteDenialAttestation ?? boundAttestation,
        connectAclObservation,
        membershipObservation,
        restoreExecutionEvidence: change.restoreExecutionEvidence ?? restoreExecutionEvidence,
        creationReceiptSha256: change.creationReceiptSha256 ?? descriptor.creationReceiptSha256,
      });
      await expect(adapter.restoreArchive(fixture.value)).rejects.toMatchObject({
        code: 'EXECUTION_NOT_AUTHORIZED',
      });
      expect(fixture.archiveTouched).not.toHaveBeenCalled();
    }
  });
});

describe('CommunitiesStagingRoleSplitReviewedRunnerAdapter', () => {
  const target = {
    database: request.restoreDatabase,
    databaseOid: execution.cloneDatabaseOid,
    sourceDatabase: request.sourceDatabase,
    systemIdentifier: request.systemIdentifier,
    postgresMajor: '16',
    connectionUser: request.expectedCloneDatabaseOwner,
    connectionUserOid: request.expectedCloneDatabaseOwnerOid,
    restoreRole: request.expectedCloneDatabaseOwner,
    restoreRoleOid: request.expectedCloneDatabaseOwnerOid,
    ...execution.connection,
  } as const;

  function reviewed(overrides: Record<string, unknown> = {}) {
    const lease = {
      requestSha256: authorization.markerRequestSha256,
      systemIdentifier: request.systemIdentifier,
      backendPid: '1234',
      fencingToken: sha('fence-token'),
      advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
    } as const;
    const fence = {
      acquire: vi.fn(async () => lease),
      assertHeld: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const preflight = vi.fn();
    const config = {
      request,
      creationReceiptSha256: authorization.creationReceiptSha256,
      authorization,
      expectedAuthorizationSha256:
        communitiesStagingRoleSplitHostAuthorizationSha256(authorization),
      componentSha256: {
        canonicalHostAdapter: execution.canonicalHostAdapterSha256,
      },
      target,
      expectedPgRestoreSha256: subjects.PG_RESTORE_EXECUTABLE_SHA256,
      preflightTimeoutMs: 10_000,
      restoreTimeoutMs: 600_000,
      fenceTimeoutMs: 10_000,
      connectionFactory: {
        subjectSha256: execution.cloneOnlyConnectionFactorySha256,
        preflight,
      },
      fence: { ...fence, subjectSha256: execution.ddlFenceSha256 },
      passwordFile: {} as never,
      executableFile: {} as never,
      ...overrides,
    };
    return {
      adapter: new CommunitiesStagingRoleSplitReviewedRunnerAdapter(config),
      fence,
      lease,
      preflight,
    };
  }

  it('requires a future durable V3 execution-evidence contract before touching collaborators', async () => {
    const archiveTouched = vi.fn();
    const archiveFile = new Proxy({} as never, {
      get() {
        archiveTouched();
        return undefined;
      },
    });
    const current = reviewed();

    await expect(
      current.adapter.restoreArchive({
        archiveFile,
        cloneDatabaseOid: target.databaseOid,
        request,
      }),
    ).rejects.toMatchObject({ code: 'V3_EXECUTION_EVIDENCE_REQUIRED' });

    expect(archiveTouched).not.toHaveBeenCalled();
    expect(current.preflight).not.toHaveBeenCalled();
    expect(current.fence.acquire).not.toHaveBeenCalled();
    expect(current.fence.assertHeld).not.toHaveBeenCalled();
    expect(current.fence.release).not.toHaveBeenCalled();
  });

  it('rejects an independently pinned authorization mismatch before acquiring the fence', () => {
    expect(() => reviewed({ expectedAuthorizationSha256: '0'.repeat(64) })).toThrow(
      'COMMUNITIES_STAGING_ROLE_SPLIT_REVIEWED_RUNNER_ADAPTER_AUTHORIZATION_INVALID',
    );
  });

  it('does not inspect even a borrowed canonical fence before V3 exists', async () => {
    const base = reviewed();
    const current = reviewed({ externalFenceLease: base.lease });
    await expect(
      current.adapter.restoreArchive({
        archiveFile: {} as never,
        cloneDatabaseOid: target.databaseOid,
        request,
      }),
    ).rejects.toMatchObject({ code: 'V3_EXECUTION_EVIDENCE_REQUIRED' });
    expect(current.preflight).not.toHaveBeenCalled();
    expect(current.fence.acquire).not.toHaveBeenCalled();
    expect(current.fence.assertHeld).not.toHaveBeenCalled();
    expect(current.fence.release).not.toHaveBeenCalled();
  });
});
