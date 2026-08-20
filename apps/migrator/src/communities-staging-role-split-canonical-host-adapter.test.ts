/* eslint-disable @typescript-eslint/require-await */
import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  advanceCommunitiesStagingRoleSplitMarkerCeremonyState,
  createCommunitiesStagingRoleSplitMarkerCeremonyCandidate,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { describe, expect, it, vi } from 'vitest';

import {
  CommunitiesStagingRoleSplitCanonicalHostAdapter,
  type CommunitiesStagingRoleSplitCanonicalHostAdapterConfig,
} from './communities-staging-role-split-canonical-host-adapter.js';
import type { CommunitiesStagingRoleSplitMarkerCeremonyHost } from './communities-staging-role-split-marker-ceremony.js';
import { runCommunitiesStagingRoleSplitMarkerCeremony } from './communities-staging-role-split-marker-ceremony.js';
import { COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY } from './communities-staging-role-split-runner-adapter.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const request = {
  restoreDatabase: 'phub_restore_123_4',
  expectedCloneDatabaseOwner: 'phub_restore',
  expectedCloneDatabaseOwnerOid: '16384',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16386',
  systemIdentifier: '7421000000000000000',
  backupBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump',
  backupSha256: sha('archive'),
  backupBytes: '7',
  backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
  backupEvidenceSha256: sha('backup evidence'),
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
  restoreHelperSha256: sha('restore helper'),
  markerWriterSha256: sha('marker writer'),
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
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
const evidenceDigests = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [code, sha(`evidence:${code}`)]),
) as Record<(typeof COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES)[number], string>;
const authorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  status: 'REVIEWED',
  candidateCommitSha: 'a'.repeat(40),
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  creationReceiptSha256: sha('creation receipt'),
  execution,
  bindings: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => ({
    code,
    status: 'VERIFIED' as const,
    subjectSha256: subjects[code],
    evidenceSha256: evidenceDigests[code],
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

const payload = {
  requestSha256: authorization.markerRequestSha256,
  creationReceiptSha256: authorization.creationReceiptSha256,
  restoreDatabase: request.restoreDatabase,
  cloneDatabaseOid: execution.cloneDatabaseOid,
  cloneDatabaseOwner: request.expectedCloneDatabaseOwner,
  cloneDatabaseOwnerOid: request.expectedCloneDatabaseOwnerOid,
  sourceDatabase: request.sourceDatabase,
  sourceDatabaseOid: request.sourceDatabaseOid,
  sourceDatabaseOwner: request.sourceDatabaseOwner,
  sourceDatabaseOwnerOid: request.sourceDatabaseOwnerOid,
  systemIdentifier: request.systemIdentifier,
  backupSha256: request.backupSha256,
  backupBytes: request.backupBytes,
  backupEvidenceSha256: request.backupEvidenceSha256,
  archiveTocSha256: request.archiveTocSha256,
  sourceLedgerSha256: request.sourceLedgerSha256,
  sourceLedgerCount: request.sourceLedgerCount,
  activeRelease: request.activeRelease,
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  postgresMajor: '16',
  objectManifestSha256: request.objectManifestSha256,
  restoreHelperSha256: request.restoreHelperSha256,
  markerWriterSha256: request.markerWriterSha256,
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerPayload;
const marker = communitiesStagingRoleSplitRestoreMarker(payload);
const evidence = {
  schemaVersion: 'communities-role-split-clone-marker-evidence-v2',
  status: 'MARKED',
  requestSha256: payload.requestSha256,
  creationReceiptSha256: payload.creationReceiptSha256,
  markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload),
  markerValueSha256: sha(marker),
  backupSha256: payload.backupSha256,
  sourceLedgerSha256: payload.sourceLedgerSha256,
  sourceLedgerCount: payload.sourceLedgerCount,
  cloneDatabaseOid: payload.cloneDatabaseOid,
  cloneBindingSha256: sha(`${payload.restoreDatabase}\0${payload.cloneDatabaseOid}`),
  sourceBindingSha256: sha(
    `${payload.sourceDatabase}\0${payload.sourceDatabaseOid}\0${payload.systemIdentifier}`,
  ),
  restoreRunId: payload.restoreRunId,
  restoreRunAttempt: payload.restoreRunAttempt,
  restoreHelperSha256: payload.restoreHelperSha256,
  markerWriterSha256: payload.markerWriterSha256,
  bindings: {
    request: true,
    backup: true,
    archiveOwnershipAcl: true,
    sourceStable: true,
    restoredLedger: true,
    cloneIdentity: true,
    markerReadback: true,
  },
  authorizes: {
    roleCreation: false,
    roleSplit: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    import: false,
    activation: false,
  },
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerEvidence;

function fixture(overrides: Partial<CommunitiesStagingRoleSplitCanonicalHostAdapterConfig> = {}) {
  const calls: string[] = [];
  const lease = { requestSha256: authorization.markerRequestSha256, fencingToken: sha('fs lease') };
  const ddlLease = {
    requestSha256: authorization.markerRequestSha256,
    systemIdentifier: request.systemIdentifier,
    backendPid: '1234',
    fencingToken: sha('ddl lease'),
    advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  } as const;
  const delegate = {
    acquireLease: vi.fn(async () => {
      calls.push('delegate:acquire');
      return lease;
    }),
    releaseLease: vi.fn(async () => {
      calls.push('delegate:release');
    }),
    loadState: vi.fn(async () => null),
    createCandidate: vi.fn(async () => undefined),
    advanceState: vi.fn(async () => undefined),
    saveVerified: vi.fn(async () => undefined),
    loadVerifiedArtifacts: vi.fn(async () => ({ payload, marker })),
    observeClone: vi.fn(async () => 'exact' as const),
    observeMarkerPresence: vi.fn(async () => 'absent' as const),
    observeMarker: vi.fn(async () => 'exact' as const),
    observeEvidence: vi.fn(async () => 'absent' as const),
    createClone: vi.fn(async () => ({ cloneDatabaseOid: payload.cloneDatabaseOid })),
    restoreClone: vi.fn(async () => undefined),
    verifyBindings: vi.fn(async () => ({ payload, marker })),
    writeMarker: vi.fn(async () => {
      throw new Error('delegate marker writer must remain disabled');
    }),
    publishEvidence: vi.fn(async () => {
      throw new Error('delegate evidence sink must remain disabled');
    }),
    dropExactClone: vi.fn(async () => {
      throw new Error('automatic cleanup unavailable');
    }),
    clearState: vi.fn(async () => undefined),
  } satisfies CommunitiesStagingRoleSplitMarkerCeremonyHost;
  const fence = {
    subjectSha256: execution.ddlFenceSha256,
    acquire: vi.fn(async () => {
      calls.push('fence:acquire');
      return ddlLease;
    }),
    assertHeld: vi.fn(async () => {
      calls.push('fence:held');
    }),
    release: vi.fn(async () => {
      calls.push('fence:release');
    }),
  };
  const markerWriter = {
    subjectSha256: request.markerWriterSha256,
    write: vi.fn(async () => {
      calls.push('marker:write');
    }),
  };
  const ownershipAclAttestor = {
    subjectSha256: subjects.OWNERSHIP_ACL_ATTESTATION,
    attest: vi.fn(async () => {
      calls.push('attestation');
      return {
        subjectSha256: subjects.OWNERSHIP_ACL_ATTESTATION,
        evidenceSha256: evidenceDigests.OWNERSHIP_ACL_ATTESTATION,
      };
    }),
  };
  const sourceWriteDenialAttestor = {
    subjectSha256: subjects.SOURCE_WRITE_DENIAL_ATTESTATION,
    attest: vi.fn(async () => {
      calls.push('source-write-denial');
      return {
        subjectSha256: subjects.SOURCE_WRITE_DENIAL_ATTESTATION,
        evidenceSha256: evidenceDigests.SOURCE_WRITE_DENIAL_ATTESTATION,
      };
    }),
  };
  const evidenceSink = {
    subjectSha256: subjects.INDEPENDENT_EVIDENCE_SINK,
    observe: vi.fn(async () => 'absent' as const),
    publish: vi.fn(async () => {
      calls.push('evidence:publish');
    }),
  };
  const config = {
    request,
    authorization,
    expectedAuthorizationSha256: communitiesStagingRoleSplitHostAuthorizationSha256(authorization),
    canonicalHostAdapterSha256: execution.canonicalHostAdapterSha256,
    fenceTimeoutMs: 10_000,
    delegate,
    fence,
    markerWriter,
    ownershipAclAttestor,
    sourceWriteDenialAttestor,
    evidenceSink,
    ...overrides,
  } satisfies CommunitiesStagingRoleSplitCanonicalHostAdapterConfig;
  return {
    adapter: new CommunitiesStagingRoleSplitCanonicalHostAdapter(config),
    calls,
    lease,
    ddlLease,
    delegate,
    fence,
    markerWriter,
    ownershipAclAttestor,
    sourceWriteDenialAttestor,
    evidenceSink,
  };
}

describe('CommunitiesStagingRoleSplitCanonicalHostAdapter', () => {
  it('holds the cluster fence across marker and attested independent evidence publication', async () => {
    const current = fixture();
    const lease = await current.adapter.acquireLease(authorization.markerRequestSha256);
    await current.adapter.writeMarker(lease, payload.cloneDatabaseOid, marker);
    await current.adapter.publishEvidence(lease, evidence);
    await current.adapter.releaseLease(lease);
    expect(current.markerWriter.write).toHaveBeenCalledTimes(1);
    expect(current.ownershipAclAttestor.attest).toHaveBeenCalledTimes(1);
    expect(current.evidenceSink.publish).toHaveBeenCalledTimes(1);
    expect(current.calls).toEqual([
      'fence:acquire',
      'fence:held',
      'delegate:acquire',
      'fence:held',
      'marker:write',
      'fence:held',
      'fence:held',
      'attestation',
      'source-write-denial',
      'evidence:publish',
      'fence:held',
      'fence:held',
      'delegate:release',
      'fence:held',
      'fence:release',
    ]);
  });

  it('rejects a self-recomputed or mismatched external authorization pin before fence acquisition', () => {
    expect(() => fixture({ expectedAuthorizationSha256: '0'.repeat(64) })).toThrow(
      'COMMUNITIES_STAGING_ROLE_SPLIT_CANONICAL_HOST_ADAPTER_AUTHORIZATION_INVALID',
    );
  });

  it('blocks evidence publication when attestation does not match both pinned digests', async () => {
    const current = fixture({
      ownershipAclAttestor: {
        subjectSha256: subjects.OWNERSHIP_ACL_ATTESTATION,
        attest: vi.fn(async () => ({
          subjectSha256: subjects.OWNERSHIP_ACL_ATTESTATION,
          evidenceSha256: '0'.repeat(64),
        })),
      },
    });
    const lease = await current.adapter.acquireLease(authorization.markerRequestSha256);
    await expect(current.adapter.publishEvidence(lease, evidence)).rejects.toMatchObject({
      code: 'ATTESTATION_INVALID',
    });
    expect(current.evidenceSink.publish).not.toHaveBeenCalled();
    await current.adapter.releaseLease(lease);
  });

  it('blocks publication when source write-denial evidence is not the pinned evidence', async () => {
    const current = fixture({
      sourceWriteDenialAttestor: {
        subjectSha256: subjects.SOURCE_WRITE_DENIAL_ATTESTATION,
        attest: vi.fn(async () => ({
          subjectSha256: subjects.SOURCE_WRITE_DENIAL_ATTESTATION,
          evidenceSha256: '0'.repeat(64),
        })),
      },
    });
    const lease = await current.adapter.acquireLease(authorization.markerRequestSha256);
    await expect(current.adapter.publishEvidence(lease, evidence)).rejects.toMatchObject({
      code: 'ATTESTATION_INVALID',
    });
    expect(current.evidenceSink.publish).not.toHaveBeenCalled();
    await current.adapter.releaseLease(lease);
  });

  it('exposes only an asserted borrowed fence lease for restore composition', async () => {
    const current = fixture();
    const lease = await current.adapter.acquireLease(authorization.markerRequestSha256);
    await expect(current.adapter.ddlFenceLeaseForRestore(lease)).resolves.toBe(current.ddlLease);
    expect(current.fence.assertHeld).toHaveBeenCalledTimes(2);
    await current.adapter.releaseLease(lease);
  });

  it('rejects duplicate delegate lease tokens without replacing the first cluster lease', async () => {
    const current = fixture();
    const first = await current.adapter.acquireLease(authorization.markerRequestSha256);
    await expect(
      current.adapter.acquireLease(authorization.markerRequestSha256),
    ).rejects.toMatchObject({ code: 'FENCE_UNAVAILABLE' });
    expect(current.fence.release).toHaveBeenCalledTimes(1);
    await expect(current.adapter.ddlFenceLeaseForRestore(first)).resolves.toBe(current.ddlLease);
    await current.adapter.releaseLease(first);
    expect(current.fence.release).toHaveBeenCalledTimes(2);
  });

  it('recovers marker and evidence response loss through canonical readback without retrying writes', async () => {
    const current = fixture();
    let state = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
      advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
        advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
          advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
            createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(
              authorization.markerRequestSha256,
            ),
            'OWNED',
            { cloneDatabaseOid: payload.cloneDatabaseOid },
          ),
          'RESTORE_PENDING',
          { cloneDatabaseOid: payload.cloneDatabaseOid },
        ),
        'RESTORED',
        { cloneDatabaseOid: payload.cloneDatabaseOid },
      ),
      'VERIFIED',
      {
        cloneDatabaseOid: payload.cloneDatabaseOid,
        markerPayloadSha256: evidence.markerPayloadSha256,
      },
    );
    let markerStored = false;
    let evidenceStored = false;
    current.delegate.loadState.mockImplementation((async () => state) as never);
    current.delegate.advanceState.mockImplementation((async (
      _lease: unknown,
      _current: unknown,
      next: typeof state,
    ) => {
      state = next;
    }) as never);
    current.delegate.observeMarker.mockImplementation((async () =>
      markerStored ? 'exact' : 'absent') as never);
    current.markerWriter.write.mockImplementation(async () => {
      markerStored = true;
      throw new Error('marker response lost');
    });
    current.evidenceSink.observe.mockImplementation((async () =>
      evidenceStored ? 'exact' : 'absent') as never);
    current.evidenceSink.publish.mockImplementation(async () => {
      evidenceStored = true;
      throw new Error('evidence response lost');
    });

    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(
        authorization.markerRequestSha256,
        current.adapter,
      ),
    ).rejects.toMatchObject({
      code: 'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_EVIDENCE_WRITE_FAILED',
    });
    expect(state.phase).toBe('MARKED');
    expect(current.markerWriter.write).toHaveBeenCalledTimes(1);
    expect(current.evidenceSink.publish).toHaveBeenCalledTimes(1);

    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(
        authorization.markerRequestSha256,
        current.adapter,
      ),
    ).resolves.toBeUndefined();
    expect(state.phase).toBe('EVIDENCED');
    expect(current.markerWriter.write).toHaveBeenCalledTimes(1);
    expect(current.evidenceSink.publish).toHaveBeenCalledTimes(1);
  });
});
