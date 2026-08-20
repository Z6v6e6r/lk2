import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_EVIDENCE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
  advanceCommunitiesStagingRoleSplitV3State,
  assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding,
  canonicalCommunitiesStagingRoleSplitV3MarkerEvidence,
  canonicalCommunitiesStagingRoleSplitV3MarkerPayload,
  canonicalCommunitiesStagingRoleSplitV3State,
  cleanupCommunitiesStagingRoleSplitV3,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  communitiesStagingRoleSplitV3Marker,
  communitiesStagingRoleSplitV3MarkerEvidenceSha256,
  communitiesStagingRoleSplitV3MarkerPayloadSha256,
  communitiesStagingRoleSplitV3StateSha256,
  createCommunitiesStagingRoleSplitV3Candidate,
  createCommunitiesStagingRoleSplitV3MarkerEvidence,
  recoverCommunitiesStagingRoleSplitV3,
  type CommunitiesSourceConnectAclObservation,
  type CommunitiesSourceMembershipObservation,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreExecutionEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  type CommunitiesStagingRoleSplitV3MarkerPayload,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  type CommunitiesStagingRoleSplitV3State,
} from './index.js';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
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
  backupSha256: hash('archive'),
  backupBytes: '7',
  backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
  backupEvidenceSha256: hash('backup-evidence'),
  archiveTocSha256: hash('toc'),
  sourceLedgerSha256: hash('ledger\n'),
  sourceLedgerCount: '1',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: hash('restore-helper'),
  markerWriterSha256: hash('marker-writer'),
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
const connectAclObservation = {
  schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
  databaseOid: request.sourceDatabaseOid,
  databaseOwnerOid: request.sourceDatabaseOwnerOid,
  aclState: 'EXPLICIT',
  rows: [],
} as const satisfies CommunitiesSourceConnectAclObservation;
const membershipObservation = {
  schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
  principalOid: '16386',
  rows: [],
} as const satisfies CommunitiesSourceMembershipObservation;
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
    connectAclObservationSha256:
      communitiesSourceConnectAclObservationSha256(connectAclObservation),
  },
  restorePrincipal: {
    name: 'phub_restore',
    oid: '16386',
    membershipObservationSha256:
      communitiesSourceMembershipObservationSha256(membershipObservation),
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
const descriptor = {
  schemaVersion: 'communities-staging-role-split-restore-execution-descriptor-v1',
  mode: 'CODE_ONLY_DISABLED',
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  creationReceiptSha256: hash('receipt'),
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  identity: {
    connectionLogin: { name: 'phub_restore', oid: '16386' },
    restoreRole: { name: 'phub_restore', oid: '16386' },
    relation: 'SAME',
  },
  pgRestoreSha256: hash('pg_restore'),
  pgpassBasename: 'role-split.pgpass',
  sourceWriteDenialEvidenceSha256:
    communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(attestation),
  timeouts: { preflightMs: 10_000, restoreMs: 600_000 },
  authorizes: attestation.authorizes,
} as const satisfies CommunitiesStagingRoleSplitRestoreExecutionDescriptor;
const executionEvidence = {
  schemaVersion: 'communities-staging-role-split-restore-execution-evidence-v1',
  status: 'PREPARATION_ONLY',
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  sourceWriteDenialAttestationSha256:
    communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(attestation),
  restoreExecutionDescriptorSha256:
    communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(descriptor),
  creationReceiptSha256: descriptor.creationReceiptSha256,
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  postgresMajor: '16',
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  authorizes: { ...descriptor.authorizes, statePersistence: false },
} as const satisfies CommunitiesStagingRoleSplitRestoreExecutionEvidence;
const executionEvidenceSha256 =
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(executionEvidence);
const executionBinding = {
  request,
  attestation,
  descriptor,
  evidence: executionEvidence,
  connectAclObservation,
  membershipObservation,
  creationReceiptSha256: descriptor.creationReceiptSha256,
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  expectedRestoreExecutionEvidenceSha256: executionEvidenceSha256,
} satisfies CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;

function bindingForRequest(
  changedRequest: CommunitiesStagingRoleSplitRestoreMarkerRequest,
): CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding {
  const markerRequestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(changedRequest);
  const changedAttestation = { ...attestation, markerRequestSha256 };
  const changedDescriptor = {
    ...descriptor,
    markerRequestSha256,
    sourceWriteDenialEvidenceSha256:
      communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(changedAttestation),
  };
  const changedEvidence = {
    ...executionEvidence,
    markerRequestSha256,
    sourceWriteDenialAttestationSha256:
      communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(changedAttestation),
    restoreExecutionDescriptorSha256:
      communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(changedDescriptor),
  };
  return {
    ...executionBinding,
    request: changedRequest,
    attestation: changedAttestation,
    descriptor: changedDescriptor,
    evidence: changedEvidence,
    expectedRestoreExecutionEvidenceSha256:
      communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(changedEvidence),
  };
}

const payload = {
  requestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  creationReceiptSha256: descriptor.creationReceiptSha256,
  restoreExecutionEvidenceSha256: executionEvidenceSha256,
  restoreDatabase: request.restoreDatabase,
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
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
} as const satisfies CommunitiesStagingRoleSplitV3MarkerPayload;

function allStates(): CommunitiesStagingRoleSplitV3State[] {
  const result = [
    createCommunitiesStagingRoleSplitV3Candidate(payload.requestSha256),
  ] as CommunitiesStagingRoleSplitV3State[];
  for (const phase of [
    'OWNED',
    'RESTORE_PENDING',
    'RESTORED',
    'VERIFIED',
    'MARKER_PENDING',
    'MARKED',
    'EVIDENCED',
  ] as const) {
    result.push(
      advanceCommunitiesStagingRoleSplitV3State(result.at(-1)!, phase, {
        cloneDatabaseOid: payload.cloneDatabaseOid,
        restoreExecutionEvidenceSha256: executionEvidenceSha256,
        markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(payload),
        ...(phase === 'OWNED' ? { restoreExecutionEvidenceBinding: executionBinding } : {}),
      }),
    );
  }
  return result;
}

describe('Communities role-split V3 contract', () => {
  it('pins V3 state bytes, ordered transitions, and the evidence edge from OWNED', () => {
    const states = allStates();
    expect(states.map((state) => state.phase)).toEqual([
      'CANDIDATE',
      'OWNED',
      'RESTORE_PENDING',
      'RESTORED',
      'VERIFIED',
      'MARKER_PENDING',
      'MARKED',
      'EVIDENCED',
    ]);
    expect(canonicalCommunitiesStagingRoleSplitV3State(states[1]!)).toBe(
      `${COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION}\nrequestSha256=${payload.requestSha256}\nphase=OWNED\ncloneDatabaseOid=${payload.cloneDatabaseOid}\nrestoreExecutionEvidenceSha256=${executionEvidenceSha256}\nmarkerPayloadSha256=\n`,
    );
    expect(communitiesStagingRoleSplitV3StateSha256(states[1]!)).toBe(
      '7eed65a7f596309546998909d083b6451b6be4d32762fb5e64d26b9ba402305e',
    );
    expect(() =>
      advanceCommunitiesStagingRoleSplitV3State(states[0]!, 'OWNED', {
        cloneDatabaseOid: payload.cloneDatabaseOid,
        restoreExecutionEvidenceSha256: executionEvidenceSha256,
      }),
    ).toThrow(/V3_CONTRACT_RESTORE_EXECUTION_EVIDENCE_REQUIRED/);
    expect(() =>
      advanceCommunitiesStagingRoleSplitV3State(states[0]!, 'OWNED', {
        cloneDatabaseOid: payload.cloneDatabaseOid,
        restoreExecutionEvidenceSha256: hash('wrong evidence'),
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).toThrow(/V3_CONTRACT_RESTORE_EXECUTION_EVIDENCE_BINDING_INVALID/);
    for (const changedRequest of [
      { ...request, expectedCloneDatabaseOwner: 'other_restore' },
      { ...request, expectedCloneDatabaseOwnerOid: '16387' },
    ]) {
      const changedBinding = bindingForRequest(changedRequest);
      const changedCandidate = createCommunitiesStagingRoleSplitV3Candidate(
        communitiesStagingRoleSplitRestoreMarkerRequestSha256(changedRequest),
      );
      expect(() =>
        advanceCommunitiesStagingRoleSplitV3State(changedCandidate, 'OWNED', {
          cloneDatabaseOid: payload.cloneDatabaseOid,
          restoreExecutionEvidenceSha256: changedBinding.expectedRestoreExecutionEvidenceSha256,
          restoreExecutionEvidenceBinding: changedBinding,
        }),
      ).toThrow(/V3_CONTRACT_RESTORE_EXECUTION_EVIDENCE_BINDING_INVALID/);
    }
  });

  it('pins V3 marker bytes and evidence without leaking source identity fields', () => {
    const states = allStates();
    expect(() =>
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: states[4]!,
        payload,
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: states[3]!,
        payload,
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: states[2]!,
        payload,
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).toThrow(/V3_CONTRACT_MARKER_PAYLOAD_BINDING_INVALID/);
    expect(() =>
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: { ...states[4]!, markerPayloadSha256: hash('different state payload') },
        payload,
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).toThrow(/V3_CONTRACT_MARKER_PAYLOAD_BINDING_INVALID/);
    const wrongRequestSha256 = hash('different request');
    expect(() =>
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: { ...states[3]!, requestSha256: wrongRequestSha256 },
        payload: { ...payload, requestSha256: wrongRequestSha256 },
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).toThrow(/V3_CONTRACT_MARKER_PAYLOAD_BINDING_INVALID/);
    const marker = communitiesStagingRoleSplitV3Marker(payload);
    const evidence = createCommunitiesStagingRoleSplitV3MarkerEvidence(payload, marker);
    const canonicalPayload = canonicalCommunitiesStagingRoleSplitV3MarkerPayload(payload);
    const canonicalEvidence = canonicalCommunitiesStagingRoleSplitV3MarkerEvidence(
      payload,
      marker,
      evidence,
    );
    expect(canonicalPayload).toContain(
      `creationReceiptSha256=${payload.creationReceiptSha256}\nrestoreExecutionEvidenceSha256=${executionEvidenceSha256}\nrestoreDatabase=`,
    );
    expect(marker).toBe(
      `phub-communities-role-split-clone-v3:${communitiesStagingRoleSplitV3MarkerPayloadSha256(payload)}`,
    );
    expect(evidence.schemaVersion).toBe(COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_EVIDENCE_VERSION);
    expect(Object.values(evidence.authorizes)).toEqual(Array(7).fill(false));
    expect(canonicalEvidence).not.toContain(request.sourceDatabase);
    expect(canonicalEvidence).not.toContain(request.systemIdentifier);
    expect(communitiesStagingRoleSplitV3MarkerPayloadSha256(payload)).toBe(
      '236ecc7cdc109ce366c7b04dfd54681ed7f6c8e587d462b9fcd08b71b97cab77',
    );
    expect(communitiesStagingRoleSplitV3MarkerEvidenceSha256(payload, marker, evidence)).toBe(
      '94bbb9f8fe6bd2228f4e6ff3f86af5fca23a2e13c4e6d684c5cc623bc3e62cca',
    );
    expect(() =>
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: states[3]!,
        payload: { ...payload, restoreExecutionEvidenceSha256: hash('different') },
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).toThrow(/V3_CONTRACT_MARKER_PAYLOAD_BINDING_INVALID/);
    expect(() =>
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: states[3]!,
        payload: { ...payload, backupSha256: hash('different archive') },
        restoreExecutionEvidenceBinding: executionBinding,
      }),
    ).toThrow(/V3_CONTRACT_MARKER_PAYLOAD_BINDING_INVALID/);
  });

  it('rejects V2-shaped or mutated state, payload, marker, and evidence', () => {
    const states = allStates();
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3State({
        ...states[1]!,
        schemaVersion: 'communities-staging-role-split-marker-ceremony-state-v2',
      } as unknown as CommunitiesStagingRoleSplitV3State),
    ).toThrow(/V3_CONTRACT_STATE_VERSION_INVALID/);
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3MarkerPayload({
        ...payload,
        restoreExecutionEvidenceSha256: undefined,
      } as unknown as CommunitiesStagingRoleSplitV3MarkerPayload),
    ).toThrow(/V3_CONTRACT_MARKER_PAYLOAD/);
    const marker = communitiesStagingRoleSplitV3Marker(payload);
    expect(() =>
      createCommunitiesStagingRoleSplitV3MarkerEvidence(
        payload,
        marker.replace('clone-v3:', 'clone-v2:'),
      ),
    ).toThrow(/V3_CONTRACT_MARKER_BINDING_INVALID/);
    const evidence = createCommunitiesStagingRoleSplitV3MarkerEvidence(payload, marker);
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3MarkerEvidence(payload, marker, {
        ...evidence,
        restoreExecutionEvidenceSha256: hash('different'),
      }),
    ).toThrow(/V3_CONTRACT_MARKER_EVIDENCE_BINDING_INVALID/);
  });

  it('fails closed on evidence drift during recovery and cleanup', () => {
    const [, owned, pending, , , markerPending, marked, evidenced] = allStates();
    expect(
      recoverCommunitiesStagingRoleSplitV3(owned!, {
        clone: 'exact',
        restoreExecutionEvidence: 'exact',
        marker: 'not_checked',
        markerEvidence: 'not_checked',
      }),
    ).toBe('RESTORE_CLONE');
    for (const observation of ['absent', 'different', 'unknown', 'not_checked'] as const) {
      expect(
        recoverCommunitiesStagingRoleSplitV3(owned!, {
          clone: 'exact',
          restoreExecutionEvidence: observation,
          marker: 'not_checked',
          markerEvidence: 'not_checked',
        }),
      ).toBe('RETAIN_AND_FAIL');
    }
    expect(
      recoverCommunitiesStagingRoleSplitV3(pending!, {
        clone: 'exact',
        restoreExecutionEvidence: 'exact',
        marker: 'not_checked',
        markerEvidence: 'not_checked',
      }),
    ).toBe('RETAIN_AND_FAIL');
    expect(
      recoverCommunitiesStagingRoleSplitV3(markerPending!, {
        clone: 'exact',
        restoreExecutionEvidence: 'exact',
        marker: 'exact',
        markerEvidence: 'not_checked',
      }),
    ).toBe('ADVANCE_MARKED');
    expect(
      recoverCommunitiesStagingRoleSplitV3(marked!, {
        clone: 'exact',
        restoreExecutionEvidence: 'exact',
        marker: 'exact',
        markerEvidence: 'absent',
      }),
    ).toBe('PUBLISH_EVIDENCE');
    expect(
      recoverCommunitiesStagingRoleSplitV3(evidenced!, {
        clone: 'exact',
        restoreExecutionEvidence: 'exact',
        marker: 'exact',
        markerEvidence: 'exact',
      }),
    ).toBe('SUCCESS');
    expect(
      cleanupCommunitiesStagingRoleSplitV3(owned!, {
        clone: 'exact',
        restoreExecutionEvidence: 'absent',
        marker: 'absent',
      }),
    ).toBe('RETAIN_AND_FAIL');
    expect(
      cleanupCommunitiesStagingRoleSplitV3(owned!, {
        clone: 'absent',
        restoreExecutionEvidence: 'exact',
        marker: 'absent',
      }),
    ).toBe('RETAIN_AND_FAIL');
    expect(
      cleanupCommunitiesStagingRoleSplitV3(pending!, {
        clone: 'exact',
        restoreExecutionEvidence: 'exact',
        marker: 'absent',
      }),
    ).toBe('RETAIN_AND_FAIL');
  });
});
