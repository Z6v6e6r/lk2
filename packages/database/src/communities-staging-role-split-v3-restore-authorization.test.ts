import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION,
  advanceCommunitiesStagingRoleSplitV3State,
  assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding,
  canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope,
  canonicalCommunitiesStagingRoleSplitV3RestoreAuthorization,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  communitiesStagingRoleSplitV3PreparationEnvelopeSha256,
  communitiesStagingRoleSplitV3RestoreAuthorizationSha256,
  createCommunitiesStagingRoleSplitV3Candidate,
  parseCommunitiesStagingRoleSplitV3RestoreAuthorization,
  type CommunitiesStagingRoleSplitHostAuthorization,
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
  sourceLedgerSha256: sha('ledger\n'),
  sourceLedgerCount: '1',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: sha('restore-helper'),
  markerWriterSha256: sha('marker-writer'),
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
const preparationEnvelope = {
  schemaVersion: 'communities-staging-role-split-v3-preparation-envelope-v1',
  status: 'CODE_ONLY_DISABLED',
  requestSha256,
  creationReceiptSha256: descriptor.creationReceiptSha256,
  state: advanceCommunitiesStagingRoleSplitV3State(
    advanceCommunitiesStagingRoleSplitV3State(
      createCommunitiesStagingRoleSplitV3Candidate(requestSha256),
      'OWNED',
      {
        cloneDatabaseOid: binding.cloneDatabaseOid,
        restoreExecutionEvidenceSha256: binding.expectedRestoreExecutionEvidenceSha256,
        restoreExecutionEvidenceBinding: binding,
      },
    ),
    'RESTORE_PENDING',
    {
      cloneDatabaseOid: binding.cloneDatabaseOid,
      restoreExecutionEvidenceSha256: binding.expectedRestoreExecutionEvidenceSha256,
    },
  ),
  restoreExecutionEvidenceBinding: binding,
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
const execution = {
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
  connection: descriptor.connection,
  restoreLogin: descriptor.identity.restoreRole,
  pgRestoreSha256: descriptor.pgRestoreSha256,
  canonicalHostAdapterSha256: sha('canonical-host-adapter'),
  cloneOnlyConnectionFactorySha256: sha('connection-factory'),
  ddlFenceSha256: sha('ddl-fence'),
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
const hostAuthorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  status: 'REVIEWED',
  candidateCommitSha: 'a'.repeat(40),
  markerRequestSha256: requestSha256,
  creationReceiptSha256: descriptor.creationReceiptSha256,
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
const restoreAuthorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION,
  status: 'RESTORE_EXECUTION_AUTHORIZED',
  candidateCommitSha: hostAuthorization.candidateCommitSha,
  markerRequestSha256: requestSha256,
  creationReceiptSha256: descriptor.creationReceiptSha256,
  preparationEnvelopeSha256:
    communitiesStagingRoleSplitV3PreparationEnvelopeSha256(preparationEnvelope),
  restoreExecutionEvidenceSha256: binding.expectedRestoreExecutionEvidenceSha256,
  hostAuthorizationSha256: communitiesStagingRoleSplitHostAuthorizationSha256(hostAuthorization),
  cloneDatabaseOid: descriptor.cloneDatabaseOid,
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

describe('communitiesStagingRoleSplitV3RestoreAuthorization', () => {
  it('is canonical, independently hashable and bound to RESTORE_PENDING', () => {
    const canonical =
      canonicalCommunitiesStagingRoleSplitV3RestoreAuthorization(restoreAuthorization);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(parseCommunitiesStagingRoleSplitV3RestoreAuthorization(canonical)).toEqual(
      restoreAuthorization,
    );
    expect(communitiesStagingRoleSplitV3RestoreAuthorizationSha256(restoreAuthorization)).toBe(
      'd1965caa66e25def2d161aa1c667215e10600eb2a810bdfbc1f115ad93ab76d4',
    );
    expect(() =>
      assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding({
        request,
        preparationEnvelope,
        hostAuthorization,
        restoreAuthorization,
      }),
    ).not.toThrow();
  });

  it('rejects noncanonical, broadened and cross-bound authorization', () => {
    expect(() =>
      parseCommunitiesStagingRoleSplitV3RestoreAuthorization(JSON.stringify(restoreAuthorization)),
    ).toThrow('V3_RESTORE_AUTHORIZATION_CANONICAL_ENCODING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3RestoreAuthorization({
        ...restoreAuthorization,
        authorizes: { ...restoreAuthorization.authorizes, markerWrite: true },
      } as unknown as CommunitiesStagingRoleSplitV3RestoreAuthorization),
    ).toThrow('V3_RESTORE_AUTHORIZATION_SHAPE_INVALID');
    for (const changed of [
      { ...restoreAuthorization, preparationEnvelopeSha256: sha('wrong-envelope') },
      { ...restoreAuthorization, hostAuthorizationSha256: sha('wrong-host') },
      { ...restoreAuthorization, restoreExecutionEvidenceSha256: sha('wrong-evidence') },
      { ...restoreAuthorization, cloneDatabaseOid: '45679' },
      { ...restoreAuthorization, candidateCommitSha: 'b'.repeat(40) },
    ]) {
      expect(() =>
        assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding({
          request,
          preparationEnvelope,
          hostAuthorization,
          restoreAuthorization: changed,
        }),
      ).toThrow('V3_RESTORE_AUTHORIZATION_BINDING_INVALID');
    }
  });

  it('does not treat OWNED preparation as executable', () => {
    const ownedEnvelope = {
      ...preparationEnvelope,
      state: advanceCommunitiesStagingRoleSplitV3State(
        createCommunitiesStagingRoleSplitV3Candidate(requestSha256),
        'OWNED',
        {
          cloneDatabaseOid: binding.cloneDatabaseOid,
          restoreExecutionEvidenceSha256: binding.expectedRestoreExecutionEvidenceSha256,
          restoreExecutionEvidenceBinding: binding,
        },
      ),
    } satisfies CommunitiesStagingRoleSplitV3PreparationEnvelope;
    const changed = {
      ...restoreAuthorization,
      preparationEnvelopeSha256:
        communitiesStagingRoleSplitV3PreparationEnvelopeSha256(ownedEnvelope),
    };
    expect(() =>
      assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding({
        request,
        preparationEnvelope: ownedEnvelope,
        hostAuthorization,
        restoreAuthorization: changed,
      }),
    ).toThrow('V3_RESTORE_AUTHORIZATION_BINDING_INVALID');
  });

  it('keeps preparation bytes descriptive and non-authorizing', () => {
    const parsed = JSON.parse(
      canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(preparationEnvelope),
    ) as CommunitiesStagingRoleSplitV3PreparationEnvelope;
    expect(Object.values(parsed.authorizes)).toEqual(Array(13).fill(false));
    expect(restoreAuthorization.authorizes.restoreExecution).toBe(true);
    expect(
      Object.entries(restoreAuthorization.authorizes)
        .filter(([key]) => key !== 'restoreExecution')
        .every(([, value]) => value === false),
    ).toBe(true);
  });
});
