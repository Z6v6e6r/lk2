import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
  assertCommunitiesStagingRoleSplitV3DurableContinuationChain,
  canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  communitiesStagingRoleSplitV3Marker,
  communitiesStagingRoleSplitV3MarkerPayloadSha256,
  createCommunitiesStagingRoleSplitV3MarkerEvidence,
  parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  type CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  type CommunitiesSourceConnectAclObservation,
  type CommunitiesSourceMembershipObservation,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreExecutionEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
} from './index.js';

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
  backupEvidenceSha256: sha('backup-evidence'),
  archiveTocSha256: sha('toc'),
  sourceLedgerSha256: sha('ledger'),
  sourceLedgerCount: '1',
  activeRelease: 'a'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: sha('helper'),
  markerWriterSha256: sha('writer'),
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
const receiptSha256 = sha('receipt');
const connectAclObservation = {
  schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
  databaseOid: request.sourceDatabaseOid,
  databaseOwnerOid: request.sourceDatabaseOwnerOid,
  aclState: 'EXPLICIT',
  rows: [],
} as const satisfies CommunitiesSourceConnectAclObservation;
const membershipObservation = {
  schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
  principalOid: request.expectedCloneDatabaseOwnerOid,
  rows: [],
} as const satisfies CommunitiesSourceMembershipObservation;
const attestation = {
  schemaVersion: 'communities-staging-role-split-source-write-denial-attestation-v1',
  status: 'SOURCE_CONNECT_DENIED',
  markerRequestSha256: requestSha256,
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
    name: request.expectedCloneDatabaseOwner,
    oid: request.expectedCloneDatabaseOwnerOid,
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
  markerRequestSha256: requestSha256,
  creationReceiptSha256: receiptSha256,
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  identity: {
    connectionLogin: {
      name: request.expectedCloneDatabaseOwner,
      oid: request.expectedCloneDatabaseOwnerOid,
    },
    restoreRole: {
      name: request.expectedCloneDatabaseOwner,
      oid: request.expectedCloneDatabaseOwnerOid,
    },
    relation: 'SAME',
  },
  pgRestoreSha256: sha('pg_restore'),
  pgpassBasename: 'role-split.pgpass',
  sourceWriteDenialEvidenceSha256:
    communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(attestation),
  timeouts: { preflightMs: 10_000, restoreMs: 600_000 },
  authorizes: attestation.authorizes,
} as const satisfies CommunitiesStagingRoleSplitRestoreExecutionDescriptor;
const executionEvidence = {
  schemaVersion: 'communities-staging-role-split-restore-execution-evidence-v1',
  status: 'PREPARATION_ONLY',
  markerRequestSha256: requestSha256,
  sourceWriteDenialAttestationSha256:
    communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(attestation),
  restoreExecutionDescriptorSha256:
    communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(descriptor),
  creationReceiptSha256: receiptSha256,
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  postgresMajor: '16',
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  authorizes: { ...descriptor.authorizes, statePersistence: false },
} as const satisfies CommunitiesStagingRoleSplitRestoreExecutionEvidence;
const restoreEvidenceSha256 =
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(executionEvidence);
const restoreExecutionEvidenceBinding = {
  request,
  attestation,
  descriptor,
  evidence: executionEvidence,
  connectAclObservation,
  membershipObservation,
  creationReceiptSha256: receiptSha256,
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  expectedRestoreExecutionEvidenceSha256: restoreEvidenceSha256,
} as const satisfies CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;

const payload = {
  requestSha256,
  creationReceiptSha256: receiptSha256,
  restoreDatabase: request.restoreDatabase,
  cloneDatabaseOid: '45678',
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
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: request.restoreHelperSha256,
  markerWriterSha256: request.markerWriterSha256,
  restoreExecutionEvidenceSha256: restoreEvidenceSha256,
} as const;
const marker = communitiesStagingRoleSplitV3Marker(payload);
const markerEvidence = createCommunitiesStagingRoleSplitV3MarkerEvidence(payload, marker);
const v2Payload = Object.fromEntries(
  Object.entries(payload).filter(([key]) => key !== 'restoreExecutionEvidenceSha256'),
);

const restoredEnvelope = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
  phase: 'RESTORED',
  requestSha256,
  creationReceiptSha256: receiptSha256,
  restoreExecutionEvidenceSha256: restoreEvidenceSha256,
  cloneDatabaseOid: '45678',
  state: {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
    requestSha256,
    phase: 'RESTORED',
    cloneDatabaseOid: '45678',
    restoreExecutionEvidenceSha256: restoreEvidenceSha256,
    markerPayloadSha256: null,
  },
} as const;
const restoredEnvelopeSha256 =
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(restoredEnvelope);

type MarkerPayload = Parameters<typeof communitiesStagingRoleSplitV3Marker>[0];

function envelope(
  phase: 'VERIFIED' | 'MARKER_PENDING' | 'MARKED' | 'EVIDENCED',
  previousEnvelopeSha256: string,
  currentPayload: MarkerPayload = payload,
): CommunitiesStagingRoleSplitV3DurableContinuationEnvelope {
  const currentMarker = communitiesStagingRoleSplitV3Marker(currentPayload);
  const currentEvidence = createCommunitiesStagingRoleSplitV3MarkerEvidence(
    currentPayload,
    currentMarker,
  );
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_VERSION,
    phase,
    requestSha256,
    creationReceiptSha256: receiptSha256,
    restoreExecutionEvidenceSha256: restoreEvidenceSha256,
    cloneDatabaseOid: '45678',
    restoredEnvelopeSha256,
    previousEnvelopeSha256,
    state: {
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
      requestSha256,
      phase,
      cloneDatabaseOid: '45678',
      restoreExecutionEvidenceSha256: restoreEvidenceSha256,
      markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(currentPayload),
    },
    artifacts: {
      payload: currentPayload,
      marker: currentMarker,
      markerEvidence: ['MARKED', 'EVIDENCED'].includes(phase) ? currentEvidence : null,
      attestedEvidenceSha256: phase === 'EVIDENCED' ? sha('attested-evidence') : null,
    },
  };
}

function chainFor(currentPayload: MarkerPayload = payload) {
  const verified = envelope('VERIFIED', restoredEnvelopeSha256, currentPayload);
  const markerPending = envelope(
    'MARKER_PENDING',
    communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(verified),
    currentPayload,
  );
  const marked = envelope(
    'MARKED',
    communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(markerPending),
    currentPayload,
  );
  const evidenced = envelope(
    'EVIDENCED',
    communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(marked),
    currentPayload,
  );
  return { verified, markerPending, marked, evidenced };
}

function legalChain() {
  return chainFor();
}

function withPayload(
  input: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  nextPayload: typeof payload,
): CommunitiesStagingRoleSplitV3DurableContinuationEnvelope {
  const nextMarker = communitiesStagingRoleSplitV3Marker(nextPayload);
  const nextEvidence = createCommunitiesStagingRoleSplitV3MarkerEvidence(nextPayload, nextMarker);
  return {
    ...input,
    state: {
      ...input.state,
      markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(nextPayload),
    },
    artifacts: {
      payload: nextPayload,
      marker: nextMarker,
      markerEvidence: ['MARKED', 'EVIDENCED'].includes(input.phase) ? nextEvidence : null,
      attestedEvidenceSha256: input.phase === 'EVIDENCED' ? sha('next-attested-evidence') : null,
    },
  };
}

function bindingForCloneOid(
  cloneDatabaseOid: string,
): CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding {
  const changedDescriptor = { ...descriptor, cloneDatabaseOid };
  const changedEvidence = {
    ...executionEvidence,
    restoreExecutionDescriptorSha256:
      communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(changedDescriptor),
    cloneDatabaseOid,
  };
  return {
    ...restoreExecutionEvidenceBinding,
    descriptor: changedDescriptor,
    evidence: changedEvidence,
    cloneDatabaseOid,
    expectedRestoreExecutionEvidenceSha256:
      communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(changedEvidence),
  };
}

describe('communitiesStagingRoleSplitV3DurableContinuationEnvelope', () => {
  it('is strict canonical JSON+LF with deterministic hashes for every phase', () => {
    const chain = legalChain();
    const expected = [
      '813909790893bd8f324ef7d4e1bef62a47bf218727b2b47aa875a1af0e3c992c',
      '7e911eea4baeeae6d50991290fb917aa422cb1e447094bc2def972af07e28228',
      'cad3a9542d685b03ac28929f6a8cb79bf79a7f6c379abe1ac27c54bf0bff277b',
      '8ec2479d0f93591e85b3f455657514161b5a9431b40837ba5ed099424528d8d5',
    ];
    for (const value of Object.values(chain)) {
      const canonical = canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(value);
      expect(canonical.endsWith('\n')).toBe(true);
      expect(parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(canonical)).toEqual(
        value,
      );
    }
    expect(
      Object.values(chain).map((value) =>
        communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(value),
      ),
    ).toEqual(expected);
  });

  it('accepts only the full one-way chain from the exact RESTORED envelope', () => {
    const chain = legalChain();
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
        restoredEnvelope,
        restoreExecutionEvidenceBinding,
        ...chain,
      }),
    ).not.toThrow();
    for (const invalid of [
      { ...chain, markerPending: chain.marked },
      { ...chain, verified: { ...chain.verified, restoredEnvelopeSha256: sha('other-restored') } },
      {
        ...chain,
        markerPending: { ...chain.markerPending, previousEnvelopeSha256: restoredEnvelopeSha256 },
      },
      { ...chain, evidenced: { ...chain.evidenced, phase: 'MARKED' as const } },
    ]) {
      expect(() =>
        assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
          restoredEnvelope,
          restoreExecutionEvidenceBinding,
          ...invalid,
        }),
      ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
    }
  });

  it('requires the exact semantically bound RESTORED anchor and every predecessor hash', () => {
    const chain = legalChain();
    const nonRestoredAnchor = {
      ...restoredEnvelope,
      phase: 'OWNED' as const,
      state: { ...restoredEnvelope.state, phase: 'OWNED' as const },
    };
    for (const [position, previousEnvelopeSha256] of [
      ['verified', sha('wrong-verified-previous')],
      ['marked', sha('wrong-marked-previous')],
      ['evidenced', sha('wrong-evidenced-previous')],
    ] as const) {
      expect(() =>
        assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
          restoredEnvelope,
          restoreExecutionEvidenceBinding,
          ...chain,
          [position]: { ...chain[position], previousEnvelopeSha256 },
        }),
      ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
    }
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
        restoredEnvelope: nonRestoredAnchor,
        restoreExecutionEvidenceBinding,
        ...chain,
      }),
    ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
        restoredEnvelope,
        restoreExecutionEvidenceBinding: bindingForCloneOid('45679'),
        ...chain,
      }),
    ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
  });

  it('rejects every immutable chain binding, evidence drift and phase-invalid evidence', () => {
    const chain = legalChain();
    const changes = [
      { ...chain.markerPending, requestSha256: sha('other-request') },
      { ...chain.markerPending, creationReceiptSha256: sha('other-receipt') },
      { ...chain.markerPending, restoreExecutionEvidenceSha256: sha('other-evidence') },
      { ...chain.markerPending, cloneDatabaseOid: '45682' },
      {
        ...chain.markerPending,
        artifacts: { ...chain.markerPending.artifacts, marker: `${marker}x` },
      },
      { ...chain.markerPending, artifacts: { ...chain.markerPending.artifacts, markerEvidence } },
      { ...chain.marked, artifacts: { ...chain.marked.artifacts, markerEvidence: null } },
      {
        ...chain.evidenced,
        artifacts: {
          ...chain.evidenced.artifacts,
          markerEvidence: { ...markerEvidence, markerValueSha256: sha('drift') },
        },
      },
    ];
    for (const markerPending of changes) {
      expect(() =>
        canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(
          markerPending as CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
        ),
      ).toThrow();
    }
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
        restoredEnvelope,
        restoreExecutionEvidenceBinding,
        ...chain,
        evidenced: {
          ...chain.evidenced,
          artifacts: {
            ...chain.evidenced.artifacts,
            markerEvidence: { ...markerEvidence, restoreHelperSha256: sha('other-helper') },
          },
        },
      }),
    ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
  });

  it('rejects each immutable binding at every continuation position', () => {
    const chain = legalChain();
    const positions = ['verified', 'markerPending', 'marked', 'evidenced'] as const;
    const mutations = {
      requestSha256: sha('other-request'),
      creationReceiptSha256: sha('other-receipt'),
      restoreExecutionEvidenceSha256: sha('other-restore-evidence'),
      cloneDatabaseOid: '45682',
    } as const;
    for (const position of positions) {
      for (const [key, value] of Object.entries(mutations)) {
        expect(() =>
          assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
            restoredEnvelope,
            restoreExecutionEvidenceBinding,
            ...chain,
            [position]: { ...chain[position], [key]: value },
          }),
        ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
      }
      for (const artifacts of [
        { ...chain[position].artifacts, payload: { ...payload, sourceLedgerSha256: sha('drift') } },
        { ...chain[position].artifacts, marker: `${marker}x` },
      ]) {
        expect(() =>
          assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
            restoredEnvelope,
            restoreExecutionEvidenceBinding,
            ...chain,
            [position]: { ...chain[position], artifacts },
          }),
        ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
      }
    }
  });

  it('rejects a self-consistent payload/marker/evidence drift at every chain position', () => {
    const chain = legalChain();
    const driftedPayload = { ...payload, sourceLedgerSha256: sha('drifted-ledger') } as const;
    for (const position of ['verified', 'markerPending', 'marked', 'evidenced'] as const) {
      const drifted = withPayload(chain[position], driftedPayload);
      expect(() =>
        canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(drifted),
      ).not.toThrow();
      expect(() =>
        assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
          restoredEnvelope,
          restoreExecutionEvidenceBinding,
          ...chain,
          [position]: drifted,
        }),
      ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
    }
  });

  it('rejects a fully self-consistent alternate chain against the original restore trust anchor', () => {
    const alternatePayload = {
      ...payload,
      sourceLedgerSha256: sha('alternate-source-ledger'),
    } satisfies MarkerPayload;
    const alternate = chainFor(alternatePayload);
    for (const envelope of Object.values(alternate)) {
      expect(() =>
        canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(envelope),
      ).not.toThrow();
    }
    expect(alternate.verified.previousEnvelopeSha256).toBe(restoredEnvelopeSha256);
    expect(alternate.markerPending.previousEnvelopeSha256).toBe(
      communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(alternate.verified),
    );
    expect(alternate.marked.previousEnvelopeSha256).toBe(
      communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(alternate.markerPending),
    );
    expect(alternate.evidenced.previousEnvelopeSha256).toBe(
      communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(alternate.marked),
    );
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableContinuationChain({
        restoredEnvelope,
        restoreExecutionEvidenceBinding,
        ...alternate,
      }),
    ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CHAIN_INVALID');
  });

  it('rejects noncanonical, missing, malformed and explicit V2-shaped artifacts', () => {
    const verified = legalChain().verified;
    expect(() =>
      parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(JSON.stringify(verified)),
    ).toThrow('V3_DURABLE_CONTINUATION_ENVELOPE_CANONICAL_ENCODING_INVALID');
    const missingPrevious = Object.fromEntries(
      Object.entries(verified).filter(([key]) => key !== 'previousEnvelopeSha256'),
    );
    for (const changed of [
      { ...verified, ignored: true },
      missingPrevious,
      { ...verified, artifacts: { payload, marker, markerEvidence: null, extra: true } },
      { ...verified, requestSha256: 'invalid' },
      {
        ...verified,
        schemaVersion: 'communities-staging-role-split-v3-durable-continuation-envelope-v1',
      },
      { ...verified, cloneDatabaseOid: '0' },
      { ...verified, restoredEnvelopeSha256: 'invalid' },
      { ...verified, previousEnvelopeSha256: 'invalid' },
      { ...verified, state: { ...verified.state, phase: 'RESTORED' as const } },
      { ...verified, artifacts: { ...verified.artifacts, payload: v2Payload } },
      {
        ...verified,
        artifacts: {
          ...verified.artifacts,
          marker: `phub-communities-role-split-clone-v2:${'0'.repeat(64)}`,
        },
      },
      {
        ...legalChain().marked,
        artifacts: {
          ...legalChain().marked.artifacts,
          markerEvidence: {
            ...markerEvidence,
            schemaVersion: 'communities-role-split-clone-marker-evidence-v2',
          },
        },
      },
      {
        ...legalChain().evidenced,
        artifacts: {
          ...legalChain().evidenced.artifacts,
          attestedEvidenceSha256: null,
        },
      },
    ]) {
      expect(() =>
        canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(
          changed as unknown as CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
        ),
      ).toThrow();
    }
  });

  it('remains a pure codec without runtime, storage, execution or installation imports', () => {
    const source = readFileSync(
      new URL(
        './communities-staging-role-split-v3-durable-continuation-envelope.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).not.toMatch(
      /node:fs|node:child_process|FileHandle|pg_restore|runner|host|sink|installer|spawn/u,
    );
  });
});
