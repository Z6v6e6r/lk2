import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  assertCommunitiesStagingRoleSplitRestoreExecutionEvidence,
  assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings,
  canonicalCommunitiesStagingRoleSplitRestoreExecutionEvidence,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreExecutionEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
} from './index.js';
import {
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  type CommunitiesSourceConnectAclObservation,
  type CommunitiesSourceMembershipObservation,
} from './communities-staging-role-split-source-write-denial-observations.js';

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
  creationReceiptSha256: sha('receipt'),
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  identity: {
    connectionLogin: { name: 'phub_restore', oid: '16386' },
    restoreRole: { name: 'phub_restore', oid: '16386' },
    relation: 'SAME',
  },
  pgRestoreSha256: sha('pg_restore'),
  pgpassBasename: 'role-split.pgpass',
  sourceWriteDenialEvidenceSha256:
    communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(attestation),
  timeouts: { preflightMs: 10_000, restoreMs: 600_000 },
  authorizes: attestation.authorizes,
} as const satisfies CommunitiesStagingRoleSplitRestoreExecutionDescriptor;

const evidence = {
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

describe('CommunitiesStagingRoleSplitRestoreExecutionEvidence', () => {
  it('canonicalizes the exact preparation-only V1 evidence and SHA-pins it', () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreExecutionEvidence(evidence);
    expect(canonical).toBe(
      '{"authorizes":{"activation":false,"automaticCleanup":false,"cloneCreation":false,"deploy":false,"evidencePublication":false,"execution":false,"import":false,"markerWrite":false,"migration":false,"restore":false,"roleCreation":false,"roleSplit":false,"sharedDatabaseMutation":false,"statePersistence":false},"cloneDatabaseOid":"45678","creationReceiptSha256":"6f32860910ca0fb2a20c7fda143666b09dbf8db5238195c90a586fb542ff0cad","markerRequestSha256":"bcfaa29cca970b29408445b10e52544b6c6858e3bf2997d976251c061b8e1d76","postgresMajor":"16","restoreExecutionDescriptorSha256":"aecc37457990a4b451bc1404a6a63195ead5d0fba24382cce53468a2305b43cd","restoreRunAttempt":"4","restoreRunId":"123","schemaVersion":"communities-staging-role-split-restore-execution-evidence-v1","sourceWriteDenialAttestationSha256":"9cf44c3a1a7a9fd7c403f76f891a6857ac002ea77aed972c7743c50cf5762e1b","status":"PREPARATION_ONLY","systemIdentifier":"7421000000000000000"}\n',
    );
    expect(communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(evidence)).toBe(
      '6ae81111879704930d466ec2a65ed973f4a6005070947589ad96d45121226197',
    );
  });

  it('binds the acyclic request, attestation, descriptor, and evidence envelope', () => {
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings({
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
      }),
    ).not.toThrow();
  });

  it('rejects a self-consistent digest chain for a different marker request', () => {
    const changedRequest = {
      ...request,
      activeRelease: 'e'.repeat(40),
    } as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
    const changedRequestSha256 =
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(changedRequest);
    const changedAttestation = {
      ...attestation,
      markerRequestSha256: changedRequestSha256,
    } as const satisfies CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
    const changedDescriptor = {
      ...descriptor,
      markerRequestSha256: changedRequestSha256,
      sourceWriteDenialEvidenceSha256:
        communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(changedAttestation),
    } as const satisfies CommunitiesStagingRoleSplitRestoreExecutionDescriptor;
    const changedEvidence = {
      ...evidence,
      markerRequestSha256: changedRequestSha256,
      sourceWriteDenialAttestationSha256:
        communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(changedAttestation),
      restoreExecutionDescriptorSha256:
        communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(changedDescriptor),
    } as const satisfies CommunitiesStagingRoleSplitRestoreExecutionEvidence;

    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings({
        request,
        attestation: changedAttestation,
        descriptor: changedDescriptor,
        evidence: changedEvidence,
        connectAclObservation,
        membershipObservation,
        creationReceiptSha256: descriptor.creationReceiptSha256,
        cloneDatabaseOid: descriptor.cloneDatabaseOid,
        systemIdentifier: request.systemIdentifier,
        restoreRunId: request.restoreRunId,
        restoreRunAttempt: request.restoreRunAttempt,
      }),
    ).toThrow(/SOURCE_WRITE_DENIAL_ATTESTATION_CROSS_BINDING_INVALID/);
  });

  it.each([
    ['extra evidence key', { ...evidence, extra: true }],
    ['wrong status', { ...evidence, status: 'EXECUTED' }],
    [
      'execution authority',
      { ...evidence, authorizes: { ...evidence.authorizes, execution: true } },
    ],
  ])('rejects %s', (_name, invalid) => {
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreExecutionEvidence(
        invalid as CommunitiesStagingRoleSplitRestoreExecutionEvidence,
      ),
    ).toThrow(/RESTORE_EXECUTION_EVIDENCE_(BINDING|SHAPE)_INVALID/);
  });

  it.each([
    ['receipt digest', { creationReceiptSha256: sha('other receipt') }],
    ['clone database OID', { cloneDatabaseOid: '45679' }],
    ['system identifier', { systemIdentifier: '7421000000000000001' }],
    ['restore run identifier', { restoreRunId: '124' }],
    ['restore run attempt', { restoreRunAttempt: '5' }],
    ['marker request digest', { markerRequestSha256: sha('other request') }],
    ['attestation digest', { sourceWriteDenialAttestationSha256: sha('other attestation') }],
    ['descriptor digest', { restoreExecutionDescriptorSha256: sha('other descriptor') }],
  ])('rejects a mutated %s binding', (_name, mutation) => {
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings({
        request,
        attestation,
        descriptor,
        evidence: { ...evidence, ...mutation },
        connectAclObservation,
        membershipObservation,
        creationReceiptSha256: descriptor.creationReceiptSha256,
        cloneDatabaseOid: descriptor.cloneDatabaseOid,
        systemIdentifier: request.systemIdentifier,
        restoreRunId: request.restoreRunId,
        restoreRunAttempt: request.restoreRunAttempt,
      }),
    ).toThrow(/RESTORE_EXECUTION_EVIDENCE_CROSS_BINDING_INVALID/);
  });
});
