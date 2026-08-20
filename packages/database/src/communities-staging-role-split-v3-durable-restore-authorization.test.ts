import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION,
  advanceCommunitiesStagingRoleSplitV3State,
  assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding,
  canonicalCommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  communitiesStagingRoleSplitV3PreparationEnvelopeSha256,
  communitiesStagingRoleSplitV3RestoreAuthorizationSha256,
  createCommunitiesStagingRoleSplitV3Candidate,
  parseCommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
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
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: sha('helper'),
  markerWriterSha256: sha('writer'),
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
const receiptSha256 = sha('receipt');
const execution = {
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  restoreLogin: { name: 'phub_restore', oid: '16386' },
  pgRestoreSha256: sha('pg_restore'),
  canonicalHostAdapterSha256: sha('host'),
  cloneOnlyConnectionFactorySha256: sha('factory'),
  ddlFenceSha256: sha('fence'),
} as const;
const subjects = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [code, sha(`subject:${code}`)]),
) as Record<(typeof COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES)[number], string>;
subjects.CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER = execution.canonicalHostAdapterSha256;
subjects.CLONE_ONLY_CONNECTION_FACTORY = execution.cloneOnlyConnectionFactorySha256;
subjects.CLUSTER_DDL_FENCE = execution.ddlFenceSha256;
subjects.PG_RESTORE_EXECUTABLE_SHA256 = execution.pgRestoreSha256;
subjects.RESTORE_LOGIN_ROLE = communitiesStagingRoleSplitRestoreLoginSubjectSha256(
  execution.restoreLogin,
);
subjects.OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS =
  communitiesStagingRoleSplitConnectionSubjectSha256(execution);
const hostAuthorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  status: 'REVIEWED',
  candidateCommitSha: 'a'.repeat(40),
  markerRequestSha256: requestSha256,
  creationReceiptSha256: receiptSha256,
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
const connectAclObservation = {
  schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
  databaseOid: request.sourceDatabaseOid,
  databaseOwnerOid: request.sourceDatabaseOwnerOid,
  aclState: 'EXPLICIT',
  rows: [],
} as const;
const membershipObservation = {
  schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
  principalOid: request.expectedCloneDatabaseOwnerOid,
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
} as const;
const descriptor = {
  schemaVersion: 'communities-staging-role-split-restore-execution-descriptor-v1',
  mode: 'CODE_ONLY_DISABLED',
  markerRequestSha256: requestSha256,
  creationReceiptSha256: receiptSha256,
  cloneDatabaseOid: execution.cloneDatabaseOid,
  connection: execution.connection,
  identity: {
    connectionLogin: execution.restoreLogin,
    restoreRole: execution.restoreLogin,
    relation: 'SAME',
  },
  pgRestoreSha256: execution.pgRestoreSha256,
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
  sourceWriteDenialAttestationSha256: descriptor.sourceWriteDenialEvidenceSha256,
  restoreExecutionDescriptorSha256:
    communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(descriptor),
  creationReceiptSha256: receiptSha256,
  cloneDatabaseOid: execution.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  postgresMajor: '16',
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  authorizes: { ...descriptor.authorizes, statePersistence: false },
} as const;
const evidenceSha256 = communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(evidence);
const restoreExecutionEvidenceBinding = {
  request,
  attestation,
  descriptor,
  evidence,
  connectAclObservation,
  membershipObservation,
  creationReceiptSha256: receiptSha256,
  cloneDatabaseOid: execution.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  expectedRestoreExecutionEvidenceSha256: evidenceSha256,
} satisfies CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
const ownedState = advanceCommunitiesStagingRoleSplitV3State(
  createCommunitiesStagingRoleSplitV3Candidate(requestSha256),
  'OWNED',
  {
    cloneDatabaseOid: execution.cloneDatabaseOid,
    restoreExecutionEvidenceSha256: evidenceSha256,
    restoreExecutionEvidenceBinding,
  },
);
const restorePendingState = advanceCommunitiesStagingRoleSplitV3State(
  ownedState,
  'RESTORE_PENDING',
  { cloneDatabaseOid: execution.cloneDatabaseOid, restoreExecutionEvidenceSha256: evidenceSha256 },
);
const restoredState = advanceCommunitiesStagingRoleSplitV3State(restorePendingState, 'RESTORED', {
  cloneDatabaseOid: execution.cloneDatabaseOid,
  restoreExecutionEvidenceSha256: evidenceSha256,
});
const preparationEnvelope = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION,
  status: 'CODE_ONLY_DISABLED',
  requestSha256,
  creationReceiptSha256: receiptSha256,
  state: restorePendingState,
  restoreExecutionEvidenceBinding,
  authorizes: {
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
  },
} as const satisfies CommunitiesStagingRoleSplitV3PreparationEnvelope;
const restoreAuthorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION,
  status: 'RESTORE_EXECUTION_AUTHORIZED',
  candidateCommitSha: hostAuthorization.candidateCommitSha,
  markerRequestSha256: requestSha256,
  creationReceiptSha256: receiptSha256,
  preparationEnvelopeSha256:
    communitiesStagingRoleSplitV3PreparationEnvelopeSha256(preparationEnvelope),
  restoreExecutionEvidenceSha256: preparationEnvelope.state.restoreExecutionEvidenceSha256,
  hostAuthorizationSha256: communitiesStagingRoleSplitHostAuthorizationSha256(hostAuthorization),
  cloneDatabaseOid: execution.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  authorizes: {
    statePersistence: false,
    cloneCreation: false,
    restoreExecution: true,
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
} as const satisfies CommunitiesStagingRoleSplitV3RestoreAuthorization;
function envelope(
  phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED',
  state: CommunitiesStagingRoleSplitV3DurableStateEnvelope['state'],
) {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
    phase,
    requestSha256,
    creationReceiptSha256: receiptSha256,
    restoreExecutionEvidenceSha256: evidenceSha256,
    cloneDatabaseOid: execution.cloneDatabaseOid,
    state,
  } as const satisfies CommunitiesStagingRoleSplitV3DurableStateEnvelope;
}
const ownedEnvelope = envelope('OWNED', ownedState);
const restorePendingEnvelope = envelope('RESTORE_PENDING', restorePendingState);
const restoredEnvelope = envelope('RESTORED', restoredState);
const authorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION,
  status: 'DURABLE_RESTORE_AUTHORIZED',
  candidateCommitSha: hostAuthorization.candidateCommitSha,
  markerRequestSha256: requestSha256,
  creationReceiptSha256: receiptSha256,
  restoreExecutionEvidenceSha256: evidenceSha256,
  cloneDatabaseOid: execution.cloneDatabaseOid,
  systemIdentifier: request.systemIdentifier,
  v3RestoreAuthorizationSha256:
    communitiesStagingRoleSplitV3RestoreAuthorizationSha256(restoreAuthorization),
  hostAuthorizationSha256: communitiesStagingRoleSplitHostAuthorizationSha256(hostAuthorization),
  ownedEnvelopeSha256: communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(ownedEnvelope),
  restorePendingEnvelopeSha256:
    communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(restorePendingEnvelope),
  restoredEnvelopeSha256: communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(restoredEnvelope),
  components: {
    durableHostSha256: sha('durable-host'),
    stateStoreSha256: sha('state-store'),
    archiveCustodySha256: sha('archive-custody'),
  },
  authorizes: {
    statePersistence: true,
    cloneCreation: false,
    restoreExecution: true,
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
} as const satisfies CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;

describe('communitiesStagingRoleSplitV3DurableRestoreAuthorization', () => {
  it('canonically authorizes only the exact forward envelope sequence', () => {
    const canonical =
      canonicalCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(authorization);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(parseCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(canonical)).toEqual(
      authorization,
    );
    expect(communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(authorization)).toBe(
      'e84fd7d53f9812990b81a9f77f42ffbb883d4412a0268d1459bc436dc1a040f4',
    );
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding({
        request,
        preparationEnvelope,
        restoreAuthorization,
        hostAuthorization,
        ownedEnvelope,
        restorePendingEnvelope,
        restoredEnvelope,
        componentSubjects: authorization.components,
        authorization,
      }),
    ).not.toThrow();
  });

  it('rejects broadening, every independent binding mutation, and phase reversal', () => {
    for (const changed of [
      { ...authorization, authorizes: { ...authorization.authorizes, markerWrite: true } },
      {
        ...authorization,
        components: { ...authorization.components, stateStoreSha256: sha('other') },
      },
      { ...authorization, v3RestoreAuthorizationSha256: sha('other') },
      { ...authorization, hostAuthorizationSha256: sha('other') },
      { ...authorization, ownedEnvelopeSha256: authorization.restorePendingEnvelopeSha256 },
      { ...authorization, restorePendingEnvelopeSha256: sha('other') },
      { ...authorization, restoredEnvelopeSha256: sha('other') },
      { ...authorization, candidateCommitSha: 'b'.repeat(40) },
      { ...authorization, markerRequestSha256: sha('other') },
      { ...authorization, creationReceiptSha256: sha('other') },
      { ...authorization, restoreExecutionEvidenceSha256: sha('other') },
      { ...authorization, cloneDatabaseOid: '45679' },
      { ...authorization, systemIdentifier: '7421000000000000001' },
    ])
      expect(() =>
        assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding({
          request,
          preparationEnvelope,
          restoreAuthorization,
          hostAuthorization,
          ownedEnvelope,
          restorePendingEnvelope,
          restoredEnvelope,
          componentSubjects: authorization.components,
          authorization:
            changed as unknown as CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
        }),
      ).toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding({
        request,
        preparationEnvelope,
        restoreAuthorization,
        hostAuthorization,
        ownedEnvelope: restorePendingEnvelope,
        restorePendingEnvelope: ownedEnvelope,
        restoredEnvelope,
        componentSubjects: authorization.components,
        authorization,
      }),
    ).toThrow('V3_DURABLE_RESTORE_AUTHORIZATION_BINDING_INVALID');

    const restoreAuthorizationWithWrongHost = {
      ...restoreAuthorization,
      hostAuthorizationSha256: sha('wrong-host-authorization'),
    };
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding({
        request,
        preparationEnvelope,
        restoreAuthorization: restoreAuthorizationWithWrongHost,
        hostAuthorization,
        ownedEnvelope,
        restorePendingEnvelope,
        restoredEnvelope,
        componentSubjects: authorization.components,
        authorization: {
          ...authorization,
          v3RestoreAuthorizationSha256: communitiesStagingRoleSplitV3RestoreAuthorizationSha256(
            restoreAuthorizationWithWrongHost,
          ),
        },
      }),
    ).toThrow('V3_DURABLE_RESTORE_AUTHORIZATION_BINDING_INVALID');

    const preparationEnvelopeWithWrongState = {
      ...preparationEnvelope,
      state: { ...preparationEnvelope.state, cloneDatabaseOid: '45679' },
    } as unknown as CommunitiesStagingRoleSplitV3PreparationEnvelope;
    expect(() =>
      assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding({
        request,
        preparationEnvelope: preparationEnvelopeWithWrongState,
        restoreAuthorization,
        hostAuthorization,
        ownedEnvelope,
        restorePendingEnvelope,
        restoredEnvelope,
        componentSubjects: authorization.components,
        authorization,
      }),
    ).toThrow('V3_DURABLE_RESTORE_AUTHORIZATION_BINDING_INVALID');
  });

  it('rejects noncanonical bytes and stays contract-only without runtime imports', () => {
    expect(() =>
      parseCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(JSON.stringify(authorization)),
    ).toThrow('V3_DURABLE_RESTORE_AUTHORIZATION_CANONICAL_ENCODING_INVALID');
    const source = readFileSync(
      fileURLToPath(
        new URL(
          './communities-staging-role-split-v3-durable-restore-authorization.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    expect(source).not.toMatch(
      /node:fs|node:child_process|FileHandle|pg_restore|runner|lease|path|spawn/u,
    );
  });
});
