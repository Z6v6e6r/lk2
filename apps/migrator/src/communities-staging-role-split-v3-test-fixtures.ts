import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_CLONE_CREATION_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTION_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION,
  advanceCommunitiesStagingRoleSplitV3State,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256,
  communitiesStagingRoleSplitV3PreparationEnvelopeSha256,
  communitiesStagingRoleSplitV3RestoreAuthorizationSha256,
  createCommunitiesStagingRoleSplitV3Candidate,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitV3CloneCreationAuthorization,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3ExecutionAuthorization,
  type CommunitiesStagingRoleSplitV3MarkerPayload,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
} from '@phub/database';

export const fixtureSha = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export function createCommunitiesStagingRoleSplitV3Fixture() {
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
    backupSha256: fixtureSha('archive'),
    backupBytes: '7',
    backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
    backupEvidenceSha256: fixtureSha('backup-evidence'),
    archiveTocSha256: fixtureSha('toc'),
    sourceLedgerSha256: fixtureSha('ledger'),
    sourceLedgerCount: '1',
    activeRelease: 'f'.repeat(40),
    restoreRunId: '123',
    restoreRunAttempt: '4',
    postgresMajor: '16',
    objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
    restoreHelperSha256: fixtureSha('helper'),
    markerWriterSha256: fixtureSha('writer'),
  } as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
  const receiptSha256 = fixtureSha('receipt');
  const execution = {
    cloneDatabaseOid: '45678',
    connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
    restoreLogin: { name: 'phub_restore', oid: '16386' },
    pgRestoreSha256: fixtureSha('pg_restore'),
    canonicalHostAdapterSha256: fixtureSha('host'),
    cloneOnlyConnectionFactorySha256: fixtureSha('factory'),
    ddlFenceSha256: fixtureSha('fence'),
  } as const;
  const subjects = Object.fromEntries(
    COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [
      code,
      fixtureSha(`subject:${code}`),
    ]),
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
      evidenceSha256: fixtureSha(`evidence:${code}`),
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
  const sourceWriteDenialAttestation = {
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
    sourceWriteDenialEvidenceSha256: communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(
      sourceWriteDenialAttestation,
    ),
    timeouts: { preflightMs: 10_000, restoreMs: 600_000 },
    authorizes: sourceWriteDenialAttestation.authorizes,
  } as const;
  const restoreExecutionEvidence = {
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
  const evidenceSha256 =
    communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(restoreExecutionEvidence);
  const restoreExecutionEvidenceBinding = {
    request,
    attestation: sourceWriteDenialAttestation,
    descriptor,
    evidence: restoreExecutionEvidence,
    connectAclObservation,
    membershipObservation,
    creationReceiptSha256: receiptSha256,
    cloneDatabaseOid: execution.cloneDatabaseOid,
    systemIdentifier: request.systemIdentifier,
    restoreRunId: request.restoreRunId,
    restoreRunAttempt: request.restoreRunAttempt,
    expectedRestoreExecutionEvidenceSha256: evidenceSha256,
  } satisfies CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
  const candidateState = createCommunitiesStagingRoleSplitV3Candidate(requestSha256);
  const ownedState = advanceCommunitiesStagingRoleSplitV3State(candidateState, 'OWNED', {
    cloneDatabaseOid: execution.cloneDatabaseOid,
    restoreExecutionEvidenceSha256: evidenceSha256,
    restoreExecutionEvidenceBinding,
  });
  const restorePendingState = advanceCommunitiesStagingRoleSplitV3State(
    ownedState,
    'RESTORE_PENDING',
    {
      cloneDatabaseOid: execution.cloneDatabaseOid,
      restoreExecutionEvidenceSha256: evidenceSha256,
    },
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
    restoreExecutionEvidenceSha256: evidenceSha256,
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
  const envelope = (
    phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED',
    state: CommunitiesStagingRoleSplitV3DurableStateEnvelope['state'],
  ) =>
    ({
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
      phase,
      requestSha256,
      creationReceiptSha256: receiptSha256,
      restoreExecutionEvidenceSha256: evidenceSha256,
      cloneDatabaseOid: execution.cloneDatabaseOid,
      state,
    }) as const satisfies CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  const ownedEnvelope = envelope('OWNED', ownedState);
  const restorePendingEnvelope = envelope('RESTORE_PENDING', restorePendingState);
  const restoredEnvelope = envelope('RESTORED', restoredState);
  const durableRestoreAuthorization = {
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
    restoredEnvelopeSha256:
      communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(restoredEnvelope),
    components: {
      durableHostSha256: fixtureSha('durable-host'),
      stateStoreSha256: fixtureSha('state-store'),
      archiveCustodySha256: fixtureSha('archive-custody'),
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
  const executionComponents = {
    executableCompositionSha256: durableRestoreAuthorization.components.durableHostSha256,
    stateStoreSha256: durableRestoreAuthorization.components.stateStoreSha256,
    archiveCustodySha256: durableRestoreAuthorization.components.archiveCustodySha256,
    runnerAdapterSha256: fixtureSha('runner-adapter'),
    canonicalHostAdapterSha256: execution.canonicalHostAdapterSha256,
    cloneOnlyConnectionFactorySha256: execution.cloneOnlyConnectionFactorySha256,
    ddlFenceSha256: execution.ddlFenceSha256,
    markerWriterSha256: request.markerWriterSha256,
    ownershipAclAttestorSha256: subjects.OWNERSHIP_ACL_ATTESTATION,
    sourceWriteDenialAttestorSha256: subjects.SOURCE_WRITE_DENIAL_ATTESTATION,
    evidenceSinkSha256: subjects.INDEPENDENT_EVIDENCE_SINK,
    externalPhaseAnchorSha256: fixtureSha('external-phase-anchor'),
  } as const;
  const cloneCreationAuthorization = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_CLONE_CREATION_AUTHORIZATION_VERSION,
    status: 'CLONE_CREATION_AUTHORIZED',
    candidateCommitSha: hostAuthorization.candidateCommitSha,
    markerRequestSha256: requestSha256,
    components: {
      executableCompositionSha256: executionComponents.executableCompositionSha256,
      stateStoreSha256: executionComponents.stateStoreSha256,
      cloneFactorySha256: fixtureSha('clone-factory'),
      ddlFenceSha256: executionComponents.ddlFenceSha256,
      externalPhaseAnchorSha256: executionComponents.externalPhaseAnchorSha256,
    },
    authorizes: {
      statePersistence: true,
      cloneCreation: true,
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
  } as const satisfies CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
  const executionAuthorization = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTION_AUTHORIZATION_VERSION,
    status: 'EXECUTION_AUTHORIZED',
    candidateCommitSha: hostAuthorization.candidateCommitSha,
    markerRequestSha256: requestSha256,
    creationReceiptSha256: receiptSha256,
    restoreExecutionEvidenceSha256: evidenceSha256,
    cloneDatabaseOid: execution.cloneDatabaseOid,
    systemIdentifier: request.systemIdentifier,
    cloneCreationAuthorizationSha256: communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256(
      cloneCreationAuthorization,
    ),
    hostAuthorizationSha256: communitiesStagingRoleSplitHostAuthorizationSha256(hostAuthorization),
    durableRestoreAuthorizationSha256:
      communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(durableRestoreAuthorization),
    components: executionComponents,
    authorizes: {
      statePersistence: true,
      cloneCreation: false,
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
  } as const satisfies CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  const markerPayload = {
    requestSha256,
    creationReceiptSha256: receiptSha256,
    restoreExecutionEvidenceSha256: evidenceSha256,
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
    postgresMajor: request.postgresMajor,
    objectManifestSha256: request.objectManifestSha256,
    restoreHelperSha256: request.restoreHelperSha256,
    markerWriterSha256: request.markerWriterSha256,
  } as const satisfies CommunitiesStagingRoleSplitV3MarkerPayload;
  return {
    request,
    requestSha256,
    receiptSha256,
    hostAuthorization,
    sourceWriteDenialAttestation,
    restoreExecutionEvidenceBinding,
    candidateState,
    ownedState,
    restorePendingState,
    restoredState,
    preparationEnvelope,
    restoreAuthorization,
    ownedEnvelope,
    restorePendingEnvelope,
    restoredEnvelope,
    durableRestoreAuthorization,
    executionAuthorization,
    cloneCreationAuthorization,
    markerPayload,
  };
}
