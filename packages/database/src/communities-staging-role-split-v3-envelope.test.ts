import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  advanceCommunitiesStagingRoleSplitV3State,
  canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  communitiesStagingRoleSplitV3PreparationEnvelopeSha256,
  createCommunitiesStagingRoleSplitV3Candidate,
  parseCommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
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
} as const;
const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
const connectAclObservation = {
  schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
  databaseOid: request.sourceDatabaseOid,
  databaseOwnerOid: request.sourceDatabaseOwnerOid,
  aclState: 'EXPLICIT',
  rows: [],
} as const;
const membershipObservation = {
  schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
  principalOid: '16386',
  rows: [],
} as const;
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
} as const;
const descriptor = {
  schemaVersion: 'communities-staging-role-split-restore-execution-descriptor-v1',
  mode: 'CODE_ONLY_DISABLED',
  markerRequestSha256: requestSha256,
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
} as const;
const evidence = {
  schemaVersion: 'communities-staging-role-split-restore-execution-evidence-v1',
  status: 'PREPARATION_ONLY',
  markerRequestSha256: requestSha256,
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
} as const;
const binding = {
  request,
  attestation,
  descriptor,
  evidence,
  connectAclObservation,
  membershipObservation,
  creationReceiptSha256: descriptor.creationReceiptSha256,
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  expectedRestoreExecutionEvidenceSha256:
    communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(evidence),
} satisfies CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
const authorizes = {
  statePersistence: false,
  cloneCreation: false,
  restoreExecution: false,
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
} as const;
const candidate = {
  schemaVersion: 'communities-staging-role-split-v3-preparation-envelope-v1',
  status: 'CODE_ONLY_DISABLED',
  requestSha256,
  creationReceiptSha256: descriptor.creationReceiptSha256,
  state: createCommunitiesStagingRoleSplitV3Candidate(requestSha256),
  authorizes,
} as const satisfies CommunitiesStagingRoleSplitV3PreparationEnvelope;
const owned = {
  ...candidate,
  state: advanceCommunitiesStagingRoleSplitV3State(candidate.state, 'OWNED', {
    cloneDatabaseOid: binding.cloneDatabaseOid,
    restoreExecutionEvidenceSha256: binding.expectedRestoreExecutionEvidenceSha256,
    restoreExecutionEvidenceBinding: binding,
  }),
  restoreExecutionEvidenceBinding: binding,
} as const satisfies CommunitiesStagingRoleSplitV3PreparationEnvelope;
const restorePending = {
  ...owned,
  state: advanceCommunitiesStagingRoleSplitV3State(owned.state, 'RESTORE_PENDING', {
    cloneDatabaseOid: binding.cloneDatabaseOid,
    restoreExecutionEvidenceSha256: binding.expectedRestoreExecutionEvidenceSha256,
  }),
} as const satisfies CommunitiesStagingRoleSplitV3PreparationEnvelope;

describe('communitiesStagingRoleSplitV3PreparationEnvelope', () => {
  it('has canonical golden candidate and OWNED bytes with all authority disabled', () => {
    const candidateBytes = canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(candidate);
    const ownedBytes = canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(owned);

    expect(candidateBytes.endsWith('\n')).toBe(true);
    expect(ownedBytes.endsWith('\n')).toBe(true);
    expect(parseCommunitiesStagingRoleSplitV3PreparationEnvelope(candidateBytes)).toEqual(
      candidate,
    );
    expect(parseCommunitiesStagingRoleSplitV3PreparationEnvelope(ownedBytes)).toEqual(owned);
    expect(
      parseCommunitiesStagingRoleSplitV3PreparationEnvelope(
        canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(restorePending),
      ),
    ).toEqual(restorePending);
    expect(communitiesStagingRoleSplitV3PreparationEnvelopeSha256(candidate)).toBe(
      '8c05281aa909e0d48a4a026a727a5bfb3233f66d22eb258e64bf515239043608',
    );
    expect(communitiesStagingRoleSplitV3PreparationEnvelopeSha256(owned)).toBe(
      '98b4ddb1487a58b61e81f6f7ac05f0706b68f078a26998b0fbcf2ae845a27aec',
    );
  });

  it('rejects V2, extra keys, noncanonical bytes and candidate binding', () => {
    expect(() =>
      parseCommunitiesStagingRoleSplitV3PreparationEnvelope(
        `${JSON.stringify({ ...candidate, schemaVersion: 'communities-role-split-marker-pg-host-state-v2' })}\n`,
      ),
    ).toThrow('V3_PREPARATION_ENVELOPE');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...candidate,
        extra: true,
      } as unknown as CommunitiesStagingRoleSplitV3PreparationEnvelope),
    ).toThrow('V3_PREPARATION_ENVELOPE_SHAPE_INVALID');
    expect(() =>
      parseCommunitiesStagingRoleSplitV3PreparationEnvelope(`${JSON.stringify(candidate)}\n`),
    ).toThrow('V3_PREPARATION_ENVELOPE_CANONICAL_ENCODING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...candidate,
        restoreExecutionEvidenceBinding: binding,
      }),
    ).toThrow('V3_PREPARATION_ENVELOPE_CANDIDATE_BINDING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...candidate,
        requestSha256: hash('different-request'),
      }),
    ).toThrow('V3_PREPARATION_ENVELOPE_REQUEST_BINDING_INVALID');
    expect(() => parseCommunitiesStagingRoleSplitV3PreparationEnvelope('null\n')).toThrow(
      'V3_PREPARATION_ENVELOPE_SHAPE_INVALID',
    );
    expect(() => parseCommunitiesStagingRoleSplitV3PreparationEnvelope('true\n')).toThrow(
      'V3_PREPARATION_ENVELOPE_SHAPE_INVALID',
    );
  });

  it('rejects OWNED binding absence, drift and any authority', () => {
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...candidate,
        state: owned.state,
      }),
    ).toThrow('V3_PREPARATION_ENVELOPE_EXECUTION_EVIDENCE_REQUIRED');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...owned,
        restoreExecutionEvidenceBinding: { ...binding, cloneDatabaseOid: '45679' },
      }),
    ).toThrow('V3_PREPARATION_ENVELOPE_EXECUTION_EVIDENCE_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...owned,
        restoreExecutionEvidenceBinding: { ...binding, extra: true },
      } as unknown as CommunitiesStagingRoleSplitV3PreparationEnvelope),
    ).toThrow('V3_PREPARATION_ENVELOPE_EXECUTION_EVIDENCE_SHAPE_INVALID');
    const ownedObject = JSON.parse(
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(owned),
    ) as Record<string, unknown>;
    const parsedBinding = ownedObject.restoreExecutionEvidenceBinding as Record<string, unknown>;
    expect(() =>
      parseCommunitiesStagingRoleSplitV3PreparationEnvelope(
        `${JSON.stringify({
          ...ownedObject,
          restoreExecutionEvidenceBinding: { ...parsedBinding, extra: true },
        })}\n`,
      ),
    ).toThrow('V3_PREPARATION_ENVELOPE_EXECUTION_EVIDENCE_SHAPE_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...owned,
        creationReceiptSha256: hash('receipt-drift'),
      }),
    ).toThrow('V3_PREPARATION_ENVELOPE_EXECUTION_EVIDENCE_BINDING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...owned,
        state: { ...owned.state, cloneDatabaseOid: '45679' },
      }),
    ).toThrow('V3_PREPARATION_ENVELOPE_EXECUTION_EVIDENCE_BINDING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...owned,
        state: { ...owned.state, restoreExecutionEvidenceSha256: hash('evidence-drift') },
      }),
    ).toThrow('V3_PREPARATION_ENVELOPE_EXECUTION_EVIDENCE_BINDING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({
        ...owned,
        authorizes: { ...authorizes, statePersistence: true },
      } as unknown as CommunitiesStagingRoleSplitV3PreparationEnvelope),
    ).toThrow('V3_PREPARATION_ENVELOPE_AUTHORIZATIONS_INVALID');
  });

  it('rejects later V3 phases even when their binding remains valid', () => {
    const restored = advanceCommunitiesStagingRoleSplitV3State(restorePending.state, 'RESTORED', {
      cloneDatabaseOid: binding.cloneDatabaseOid,
      restoreExecutionEvidenceSha256: binding.expectedRestoreExecutionEvidenceSha256,
    });

    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope({ ...owned, state: restored }),
    ).toThrow('V3_PREPARATION_ENVELOPE_PHASE_UNSUPPORTED');
  });

  it('contains no host, filesystem, lease, fence, PG, runner or transition API', async () => {
    const source = await readFile(
      new URL('./communities-staging-role-split-v3-envelope.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/node:(?:fs|path|child_process)|from ['"]pg['"]/u);
    expect(source).not.toMatch(
      /acquireLease|releaseLease|writeCas|pg_restore|restoreArchive|createClone|\b(?:open|rename|unlink|query|spawn|exec|transition)\b/u,
    );
  });
});
