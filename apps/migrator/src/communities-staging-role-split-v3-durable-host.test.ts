/* eslint-disable @typescript-eslint/require-await */
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION,
  advanceCommunitiesStagingRoleSplitV3State,
  canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope,
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
  communitiesStagingRoleSplitV3PreparationEnvelopeSha256,
  communitiesStagingRoleSplitV3RestoreAuthorizationSha256,
  createCommunitiesStagingRoleSplitV3Candidate,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
  type CommunitiesStagingRoleSplitV3State,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  CommunitiesStagingRoleSplitV3DurableHost,
  CommunitiesStagingRoleSplitV3DurableStateStore,
  type CommunitiesStagingRoleSplitV3ArchiveCustody,
  type CommunitiesStagingRoleSplitV3DurableHostConfig,
  type CommunitiesStagingRoleSplitV3DurableHostError,
  type CommunitiesStagingRoleSplitV3DurableStateLease,
} from './communities-staging-role-split-v3-durable-host.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  type CommunitiesStagingRoleSplitDdlFence,
  type CommunitiesStagingRoleSplitDdlFenceLease,
} from './communities-staging-role-split-ddl-fence.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const requestSha256 = sha('request');
const receiptSha256 = sha('receipt');
const evidenceSha256 = sha('evidence');
const cloneDatabaseOid = '45678';
const state = (
  phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED',
): CommunitiesStagingRoleSplitV3State => ({
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
  requestSha256,
  phase,
  cloneDatabaseOid,
  restoreExecutionEvidenceSha256: evidenceSha256,
  markerPayloadSha256: null,
});
function envelope(
  phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED',
  state: CommunitiesStagingRoleSplitV3DurableStateEnvelope['state'],
): CommunitiesStagingRoleSplitV3DurableStateEnvelope {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
    phase,
    requestSha256,
    creationReceiptSha256: receiptSha256,
    restoreExecutionEvidenceSha256: evidenceSha256,
    cloneDatabaseOid,
    state,
  };
}
async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phub-v3-durable-'));
  await chmod(directory, 0o700);
  return {
    directory,
    store: new CommunitiesStagingRoleSplitV3DurableStateStore(
      sha('state-store'),
      directory,
      requestSha256,
      receiptSha256,
    ),
  };
}

describe('CommunitiesStagingRoleSplitV3DurableStateStore', () => {
  it('persists only the exact forward durable sequence with readback', async () => {
    const { store } = await storeFixture();
    const lease = await store.acquire();
    const owned = await store.writeCas(lease, null, envelope('OWNED', state('OWNED')));
    const pending = await store.writeCas(
      lease,
      owned,
      envelope('RESTORE_PENDING', state('RESTORE_PENDING')),
    );
    const restored = await store.writeCas(lease, pending, envelope('RESTORED', state('RESTORED')));
    expect(await store.read(lease)).toBe(restored);
    await store.release(lease);
  });

  it('rejects a phase skip and a second lease without overwriting state', async () => {
    const { store } = await storeFixture();
    const lease = await store.acquire();
    await expect(
      store.writeCas(lease, null, envelope('RESTORE_PENDING', state('RESTORE_PENDING'))),
    ).rejects.toMatchObject({
      code: 'STATE_CAS_MISMATCH',
    } satisfies Partial<CommunitiesStagingRoleSplitV3DurableHostError>);
    await expect(store.acquire()).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
    await store.release(lease);
  });

  it.each([
    [
      'restore evidence',
      () => {
        const restoreExecutionEvidenceSha256 = sha('different evidence');
        return {
          ...envelope('RESTORE_PENDING', {
            ...state('RESTORE_PENDING'),
            restoreExecutionEvidenceSha256,
          }),
          restoreExecutionEvidenceSha256,
        };
      },
    ],
    [
      'clone OID',
      () => {
        const nextCloneDatabaseOid = '45679';
        return {
          ...envelope('RESTORE_PENDING', {
            ...state('RESTORE_PENDING'),
            cloneDatabaseOid: nextCloneDatabaseOid,
          }),
          cloneDatabaseOid: nextCloneDatabaseOid,
        };
      },
    ],
  ] as const)('rejects immutable %s drift across a forward transition', async (_name, next) => {
    const { store } = await storeFixture();
    const lease = await store.acquire();
    const owned = await store.writeCas(lease, null, envelope('OWNED', state('OWNED')));
    await expect(store.writeCas(lease, owned, next())).rejects.toMatchObject({
      code: 'STATE_CAS_MISMATCH',
    } satisfies Partial<CommunitiesStagingRoleSplitV3DurableHostError>);
    expect(await store.read(lease)).toBe(owned);
    await store.release(lease);
  });

  it('uses the shared V2 ceremony lock as the exact exclusion namespace', async () => {
    const { directory, store } = await storeFixture();
    await writeFile(join(directory, 'ceremony.lock'), 'v2\n', { mode: 0o600 });
    await expect(store.acquire()).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
  });

  it('rejects unsafe directory, retained V2 artifacts, symlinks and hardlinks', async () => {
    const unsafe = await storeFixture();
    await chmod(unsafe.directory, 0o755);
    await expect(unsafe.store.acquire()).rejects.toMatchObject({ code: 'STATE_DIRECTORY_UNSAFE' });

    const v2 = await storeFixture();
    await writeFile(join(v2.directory, 'ceremony-state.json'), '{}\n', { mode: 0o600 });
    await expect(v2.store.acquire()).rejects.toMatchObject({ code: 'V2_ARTIFACT_PRESENT' });

    const linked = await storeFixture();
    await symlink('/tmp', join(linked.directory, 'marker-evidence.json'));
    await expect(linked.store.acquire()).rejects.toMatchObject({ code: 'V2_ARTIFACT_PRESENT' });

    const hardLinked = await storeFixture();
    const outside = join(hardLinked.directory, 'outside-state');
    await writeFile(outside, '{}\n', { mode: 0o600 });
    await link(outside, join(hardLinked.directory, 'ceremony-state.json'));
    await expect(hardLinked.store.acquire()).rejects.toMatchObject({ code: 'V2_ARTIFACT_PRESENT' });
  });
});

const durableRequest = {
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
const durableRequestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(durableRequest);
const durableReceiptSha256 = sha('receipt');
const durableExecution = {
  cloneDatabaseOid: cloneDatabaseOid,
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  restoreLogin: { name: 'phub_restore', oid: '16386' },
  pgRestoreSha256: sha('pg_restore'),
  canonicalHostAdapterSha256: sha('host'),
  cloneOnlyConnectionFactorySha256: sha('factory'),
  ddlFenceSha256: sha('fence'),
} as const;
const durableSubjects = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [code, sha(`subject:${code}`)]),
) as Record<(typeof COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES)[number], string>;
durableSubjects.CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER =
  durableExecution.canonicalHostAdapterSha256;
durableSubjects.CLONE_ONLY_CONNECTION_FACTORY = durableExecution.cloneOnlyConnectionFactorySha256;
durableSubjects.CLUSTER_DDL_FENCE = durableExecution.ddlFenceSha256;
durableSubjects.PG_RESTORE_EXECUTABLE_SHA256 = durableExecution.pgRestoreSha256;
durableSubjects.RESTORE_LOGIN_ROLE = communitiesStagingRoleSplitRestoreLoginSubjectSha256(
  durableExecution.restoreLogin,
);
durableSubjects.OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS =
  communitiesStagingRoleSplitConnectionSubjectSha256(durableExecution);
const durableHostAuthorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  status: 'REVIEWED',
  candidateCommitSha: 'a'.repeat(40),
  markerRequestSha256: durableRequestSha256,
  creationReceiptSha256: durableReceiptSha256,
  execution: durableExecution,
  bindings: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => ({
    code,
    status: 'VERIFIED' as const,
    subjectSha256: durableSubjects[code],
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
const durableConnectAcl = {
  schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
  databaseOid: durableRequest.sourceDatabaseOid,
  databaseOwnerOid: durableRequest.sourceDatabaseOwnerOid,
  aclState: 'EXPLICIT',
  rows: [],
} as const;
const durableMembership = {
  schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
  principalOid: durableRequest.expectedCloneDatabaseOwnerOid,
  rows: [],
} as const;
const durableAttestation = {
  schemaVersion: 'communities-staging-role-split-source-write-denial-attestation-v1',
  status: 'SOURCE_CONNECT_DENIED',
  markerRequestSha256: durableRequestSha256,
  systemIdentifier: durableRequest.systemIdentifier,
  postgresMajor: '16',
  sourceDatabase: {
    name: durableRequest.sourceDatabase,
    oid: durableRequest.sourceDatabaseOid,
    owner: { name: durableRequest.sourceDatabaseOwner, oid: durableRequest.sourceDatabaseOwnerOid },
    connectAclObservationSha256: communitiesSourceConnectAclObservationSha256(durableConnectAcl),
  },
  restorePrincipal: {
    name: durableRequest.expectedCloneDatabaseOwner,
    oid: durableRequest.expectedCloneDatabaseOwnerOid,
    membershipObservationSha256: communitiesSourceMembershipObservationSha256(durableMembership),
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
const durableDescriptor = {
  schemaVersion: 'communities-staging-role-split-restore-execution-descriptor-v1',
  mode: 'CODE_ONLY_DISABLED',
  markerRequestSha256: durableRequestSha256,
  creationReceiptSha256: durableReceiptSha256,
  cloneDatabaseOid,
  connection: durableExecution.connection,
  identity: {
    connectionLogin: durableExecution.restoreLogin,
    restoreRole: durableExecution.restoreLogin,
    relation: 'SAME',
  },
  pgRestoreSha256: durableExecution.pgRestoreSha256,
  pgpassBasename: 'role-split.pgpass',
  sourceWriteDenialEvidenceSha256:
    communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(durableAttestation),
  timeouts: { preflightMs: 10_000, restoreMs: 600_000 },
  authorizes: durableAttestation.authorizes,
} as const;
const durableEvidence = {
  schemaVersion: 'communities-staging-role-split-restore-execution-evidence-v1',
  status: 'PREPARATION_ONLY',
  markerRequestSha256: durableRequestSha256,
  sourceWriteDenialAttestationSha256: durableDescriptor.sourceWriteDenialEvidenceSha256,
  restoreExecutionDescriptorSha256:
    communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(durableDescriptor),
  creationReceiptSha256: durableReceiptSha256,
  cloneDatabaseOid,
  systemIdentifier: durableRequest.systemIdentifier,
  postgresMajor: '16',
  restoreRunId: durableRequest.restoreRunId,
  restoreRunAttempt: durableRequest.restoreRunAttempt,
  authorizes: { ...durableDescriptor.authorizes, statePersistence: false },
} as const;
const durableEvidenceSha256 =
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(durableEvidence);
const durableBinding = {
  request: durableRequest,
  attestation: durableAttestation,
  descriptor: durableDescriptor,
  evidence: durableEvidence,
  connectAclObservation: durableConnectAcl,
  membershipObservation: durableMembership,
  creationReceiptSha256: durableReceiptSha256,
  cloneDatabaseOid,
  systemIdentifier: durableRequest.systemIdentifier,
  restoreRunId: durableRequest.restoreRunId,
  restoreRunAttempt: durableRequest.restoreRunAttempt,
  expectedRestoreExecutionEvidenceSha256: durableEvidenceSha256,
} as const;
const durableOwnedState = advanceCommunitiesStagingRoleSplitV3State(
  createCommunitiesStagingRoleSplitV3Candidate(durableRequestSha256),
  'OWNED',
  {
    cloneDatabaseOid,
    restoreExecutionEvidenceSha256: durableEvidenceSha256,
    restoreExecutionEvidenceBinding: durableBinding,
  },
);
const durablePendingState = advanceCommunitiesStagingRoleSplitV3State(
  durableOwnedState,
  'RESTORE_PENDING',
  { cloneDatabaseOid, restoreExecutionEvidenceSha256: durableEvidenceSha256 },
);
const durableRestoredState = advanceCommunitiesStagingRoleSplitV3State(
  durablePendingState,
  'RESTORED',
  { cloneDatabaseOid, restoreExecutionEvidenceSha256: durableEvidenceSha256 },
);
function durableEnvelope(
  phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED',
  durableState: CommunitiesStagingRoleSplitV3DurableStateEnvelope['state'],
): CommunitiesStagingRoleSplitV3DurableStateEnvelope {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
    phase,
    requestSha256: durableRequestSha256,
    creationReceiptSha256: durableReceiptSha256,
    restoreExecutionEvidenceSha256: durableEvidenceSha256,
    cloneDatabaseOid,
    state: durableState,
  };
}
const durableOwnedEnvelope = durableEnvelope('OWNED', durableOwnedState);
const durablePendingEnvelope = durableEnvelope('RESTORE_PENDING', durablePendingState);
const durableRestoredEnvelope = durableEnvelope('RESTORED', durableRestoredState);
const durablePreparationEnvelope = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION,
  status: 'CODE_ONLY_DISABLED',
  requestSha256: durableRequestSha256,
  creationReceiptSha256: durableReceiptSha256,
  state: durablePendingState,
  restoreExecutionEvidenceBinding: durableBinding,
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
const durableRestoreAuthorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION,
  status: 'RESTORE_EXECUTION_AUTHORIZED',
  candidateCommitSha: durableHostAuthorization.candidateCommitSha,
  markerRequestSha256: durableRequestSha256,
  creationReceiptSha256: durableReceiptSha256,
  preparationEnvelopeSha256: communitiesStagingRoleSplitV3PreparationEnvelopeSha256(
    durablePreparationEnvelope,
  ),
  restoreExecutionEvidenceSha256: durableEvidenceSha256,
  hostAuthorizationSha256:
    communitiesStagingRoleSplitHostAuthorizationSha256(durableHostAuthorization),
  cloneDatabaseOid,
  systemIdentifier: durableRequest.systemIdentifier,
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
const durableComponents = {
  durableHostSha256: sha('durable-host'),
  stateStoreSha256: sha('state-store'),
  archiveCustodySha256: sha('archive-custody'),
} as const;
const durableAuthorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION,
  status: 'DURABLE_RESTORE_AUTHORIZED',
  candidateCommitSha: durableHostAuthorization.candidateCommitSha,
  markerRequestSha256: durableRequestSha256,
  creationReceiptSha256: durableReceiptSha256,
  restoreExecutionEvidenceSha256: durableEvidenceSha256,
  cloneDatabaseOid,
  systemIdentifier: durableRequest.systemIdentifier,
  v3RestoreAuthorizationSha256: communitiesStagingRoleSplitV3RestoreAuthorizationSha256(
    durableRestoreAuthorization,
  ),
  hostAuthorizationSha256:
    communitiesStagingRoleSplitHostAuthorizationSha256(durableHostAuthorization),
  ownedEnvelopeSha256:
    communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(durableOwnedEnvelope),
  restorePendingEnvelopeSha256:
    communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(durablePendingEnvelope),
  restoredEnvelopeSha256:
    communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(durableRestoredEnvelope),
  components: durableComponents,
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

type WriteOutcome =
  | 'succeed'
  | 'throw-after-write'
  | 'throw-after-owned-write'
  | 'throw-after-different-write'
  | 'throw-without-write';

class FakeDurableStateStore extends CommunitiesStagingRoleSplitV3DurableStateStore {
  entry: string | null;
  readonly calls: string[];
  readonly lease = {
    requestSha256: durableRequestSha256,
    creationReceiptSha256: durableReceiptSha256,
    fencingToken: sha('fs-token'),
  } as const satisfies CommunitiesStagingRoleSplitV3DurableStateLease;
  private readonly writeOutcomes: WriteOutcome[];
  private readonly releaseFailure: Error | undefined;

  constructor(input: {
    entry?: string | null;
    writeOutcomes?: readonly WriteOutcome[];
    releaseFailure?: Error;
    requestSha256?: string;
    creationReceiptSha256?: string;
    calls: string[];
  }) {
    super(
      durableComponents.stateStoreSha256,
      '/tmp/phub-test-state',
      input.requestSha256 ?? durableRequestSha256,
      input.creationReceiptSha256 ?? durableReceiptSha256,
    );
    this.entry = input.entry ?? null;
    this.calls = input.calls;
    this.writeOutcomes = [...(input.writeOutcomes ?? [])];
    this.releaseFailure = input.releaseFailure;
  }

  override async acquire(): Promise<CommunitiesStagingRoleSplitV3DurableStateLease> {
    this.calls.push('fs.acquire');
    return this.lease;
  }
  override async release(lease: CommunitiesStagingRoleSplitV3DurableStateLease): Promise<void> {
    expect(lease).toBe(this.lease);
    this.calls.push('fs.release');
    if (this.releaseFailure !== undefined) throw this.releaseFailure;
  }
  override async read(
    lease: CommunitiesStagingRoleSplitV3DurableStateLease,
  ): Promise<string | null> {
    expect(lease).toBe(this.lease);
    this.calls.push('fs.read');
    return this.entry;
  }
  override async writeCas(
    lease: CommunitiesStagingRoleSplitV3DurableStateLease,
    expected: string | null,
    next: CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  ): Promise<string> {
    expect(lease).toBe(this.lease);
    this.calls.push(`fs.cas:${next.phase}`);
    if (this.entry !== expected) throw new Error('unexpected CAS preimage');
    const canonical = canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(next);
    const outcome = this.writeOutcomes.shift() ?? 'succeed';
    if (outcome === 'throw-after-owned-write') {
      this.entry = canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(durableOwnedEnvelope);
    } else if (outcome === 'throw-after-different-write') {
      this.entry =
        canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(durableRestoredEnvelope);
    } else if (outcome !== 'throw-without-write') {
      this.entry = canonical;
    }
    if (outcome !== 'succeed') throw new Error(`response-loss:${outcome}`);
    return canonical;
  }
}

class FakeFence implements CommunitiesStagingRoleSplitDdlFence {
  readonly subjectSha256 = durableExecution.ddlFenceSha256;
  readonly lease = {
    requestSha256: durableRequestSha256,
    systemIdentifier: durableRequest.systemIdentifier,
    backendPid: '4242',
    fencingToken: sha('ddl-token'),
    advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  } as const satisfies CommunitiesStagingRoleSplitDdlFenceLease;
  readonly calls: string[];
  private readonly outcomes: readonly ('held' | 'lost')[];
  private readonly releaseFailure: Error | undefined;
  private assertIndex = 0;

  constructor(
    calls: string[],
    outcomes: readonly ('held' | 'lost')[] = [],
    releaseFailure?: Error,
  ) {
    this.calls = calls;
    this.outcomes = outcomes;
    this.releaseFailure = releaseFailure;
  }
  async acquire(input: {
    readonly requestSha256: string;
    readonly systemIdentifier: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<CommunitiesStagingRoleSplitDdlFenceLease> {
    expect(input).toMatchObject({
      requestSha256: durableRequestSha256,
      systemIdentifier: durableRequest.systemIdentifier,
      timeoutMs: 1_000,
    });
    this.calls.push('ddl.acquire');
    return this.lease;
  }
  async assertHeld(lease: {
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }): Promise<void> {
    expect(lease).toBe(this.lease);
    this.calls.push('ddl.assert');
    if (this.outcomes[this.assertIndex++] === 'lost') throw new Error('fence lost');
  }
  async release(lease: {
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }): Promise<void> {
    expect(lease).toBe(this.lease);
    this.calls.push('ddl.release');
    if (this.releaseFailure !== undefined) throw this.releaseFailure;
  }
}

class FakeArchiveCustody implements CommunitiesStagingRoleSplitV3ArchiveCustody {
  readonly subjectSha256 = durableComponents.archiveCustodySha256;
  readonly calls: string[];
  readonly observation: {
    readonly device: string;
    readonly inode: string;
    readonly bytes: string;
    readonly preSha256: string;
  };
  private readonly closeFailure: Error | undefined;

  constructor(
    calls: string[],
    observation: {
      readonly device: string;
      readonly inode: string;
      readonly bytes: string;
      readonly preSha256: string;
    } = {
      device: '2049',
      inode: '123',
      bytes: durableRequest.backupBytes,
      preSha256: durableRequest.backupSha256,
    },
    closeFailure?: Error,
  ) {
    this.calls = calls;
    this.observation = observation;
    this.closeFailure = closeFailure;
  }
  async acquire(input: {
    readonly requestSha256: string;
    readonly restorePendingEnvelopeSha256: string;
  }): Promise<{
    readonly observation: {
      readonly device: string;
      readonly inode: string;
      readonly bytes: string;
      readonly preSha256: string;
    };
    close(): Promise<void>;
  }> {
    expect(input).toEqual({
      requestSha256: durableRequestSha256,
      restorePendingEnvelopeSha256:
        communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(durablePendingEnvelope),
    });
    this.calls.push('archive.acquire');
    return {
      observation: this.observation,
      close: async () => {
        this.calls.push('archive.close');
        if (this.closeFailure !== undefined) throw this.closeFailure;
      },
    };
  }
}

function durableHostFixture(
  input: {
    entry?: string | null;
    writeOutcomes?: readonly WriteOutcome[];
    fenceOutcomes?: readonly ('held' | 'lost')[];
    observation?: {
      readonly device: string;
      readonly inode: string;
      readonly bytes: string;
      readonly preSha256: string;
    };
    archiveCloseFailure?: Error;
    stateReleaseFailure?: Error;
    fenceReleaseFailure?: Error;
    stateRequestSha256?: string;
    stateReceiptSha256?: string;
    calls?: string[];
  } = {},
) {
  const calls = input.calls ?? [];
  const stateStoreInput: ConstructorParameters<typeof FakeDurableStateStore>[0] = {
    calls,
  };
  if (input.entry !== undefined) stateStoreInput.entry = input.entry;
  if (input.writeOutcomes !== undefined) stateStoreInput.writeOutcomes = input.writeOutcomes;
  if (input.stateReleaseFailure !== undefined)
    stateStoreInput.releaseFailure = input.stateReleaseFailure;
  if (input.stateRequestSha256 !== undefined)
    stateStoreInput.requestSha256 = input.stateRequestSha256;
  if (input.stateReceiptSha256 !== undefined)
    stateStoreInput.creationReceiptSha256 = input.stateReceiptSha256;
  const stateStore = new FakeDurableStateStore(stateStoreInput);
  const fence = new FakeFence(calls, input.fenceOutcomes, input.fenceReleaseFailure);
  const archiveCustody = new FakeArchiveCustody(
    calls,
    input.observation,
    input.archiveCloseFailure,
  );
  const config = {
    request: durableRequest,
    preparationEnvelope: durablePreparationEnvelope,
    restoreAuthorization: durableRestoreAuthorization,
    hostAuthorization: durableHostAuthorization,
    authorization: durableAuthorization,
    expectedAuthorizationSha256:
      communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(durableAuthorization),
    stateStore,
    archiveCustody,
    fence,
    durableHostSha256: durableComponents.durableHostSha256,
    fenceTimeoutMs: 1_000,
    envelopes: {
      owned: durableOwnedEnvelope,
      restorePending: durablePendingEnvelope,
      restored: durableRestoredEnvelope,
    },
  } satisfies CommunitiesStagingRoleSplitV3DurableHostConfig;
  return {
    calls,
    stateStore,
    fence,
    archiveCustody,
    host: new CommunitiesStagingRoleSplitV3DurableHost(config),
  };
}

describe('CommunitiesStagingRoleSplitV3DurableHost', () => {
  it('does not touch collaborators in the constructor and binds a complete, frozen capability', async () => {
    const current = durableHostFixture();
    expect(current.calls).toEqual([]);
    const capability = await current.host.prepare();
    expect(current.calls).toEqual([
      'ddl.acquire',
      'ddl.assert',
      'fs.acquire',
      'fs.read',
      'fs.cas:OWNED',
      'fs.read',
      'ddl.assert',
      'archive.acquire',
      'ddl.assert',
      'fs.cas:RESTORE_PENDING',
      'fs.read',
      'ddl.assert',
    ]);
    expect(capability).toEqual({
      capability: 'V3_DURABLE_PREPARATION_CAPABILITY',
      claims: {
        requestSha256: durableRequestSha256,
        creationReceiptSha256: durableReceiptSha256,
        restoreExecutionEvidenceSha256: durableEvidenceSha256,
        durableAuthorizationSha256:
          communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(durableAuthorization),
        ownedEnvelopeSha256:
          communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(durableOwnedEnvelope),
        restorePendingEnvelopeSha256:
          communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(durablePendingEnvelope),
        cloneDatabaseOid,
        systemIdentifier: durableRequest.systemIdentifier,
        archive: {
          device: '2049',
          inode: '123',
          bytes: '7',
          preSha256: durableRequest.backupSha256,
        },
        ddlFencingTokenSha256: sha(sha('ddl-token')),
        fsFencingTokenSha256: sha(sha('fs-token')),
      },
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.claims)).toBe(true);
    expect(Object.isFrozen(capability.claims.archive)).toBe(true);
  });

  it('reconciles an exact OWNED create response-loss before preparing the pending boundary', async () => {
    const current = durableHostFixture({ writeOutcomes: ['throw-after-write'] });
    await expect(current.host.prepare()).resolves.toMatchObject({
      capability: 'V3_DURABLE_PREPARATION_CAPABILITY',
    });
    expect(current.calls).toEqual([
      'ddl.acquire',
      'ddl.assert',
      'fs.acquire',
      'fs.read',
      'fs.cas:OWNED',
      'fs.read',
      'fs.read',
      'ddl.assert',
      'archive.acquire',
      'ddl.assert',
      'fs.cas:RESTORE_PENDING',
      'fs.read',
      'ddl.assert',
    ]);
  });

  it.each([
    ['absent', 'throw-without-write', 'FENCE_UNAVAILABLE'],
    ['different', 'throw-after-different-write', 'FENCE_UNAVAILABLE'],
  ] as const)('rejects %s OWNED create response-loss', async (_name, outcome, code) => {
    const current = durableHostFixture({ writeOutcomes: [outcome] });
    await expect(current.host.prepare()).rejects.toMatchObject({ code });
    expect(current.calls).toEqual([
      'ddl.acquire',
      'ddl.assert',
      'fs.acquire',
      'fs.read',
      'fs.cas:OWNED',
      'fs.read',
      'fs.release',
      'ddl.release',
    ]);
  });

  it('fails closed if the fence is lost while reconciling a pending CAS response-loss', async () => {
    const current = durableHostFixture({
      writeOutcomes: ['succeed', 'throw-without-write'],
      fenceOutcomes: ['held', 'held', 'held', 'lost'],
    });
    await expect(current.host.prepare()).rejects.toMatchObject({ code: 'FENCE_LOST' });
    expect(current.calls.slice(-3)).toEqual(['archive.close', 'fs.release', 'ddl.release']);
  });

  it('fails closed after pending readback when the mandatory final fence assertion is lost', async () => {
    const current = durableHostFixture({ fenceOutcomes: ['held', 'held', 'held', 'lost'] });
    await expect(current.host.prepare()).rejects.toMatchObject({ code: 'FENCE_LOST' });
    expect(current.calls).toEqual([
      'ddl.acquire',
      'ddl.assert',
      'fs.acquire',
      'fs.read',
      'fs.cas:OWNED',
      'fs.read',
      'ddl.assert',
      'archive.acquire',
      'ddl.assert',
      'fs.cas:RESTORE_PENDING',
      'fs.read',
      'ddl.assert',
      'archive.close',
      'fs.release',
      'ddl.release',
    ]);
  });

  it.each([
    ['exact', 'throw-after-write', true],
    ['owned', 'throw-after-owned-write', false],
    ['different', 'throw-after-different-write', false],
    ['absent', 'throw-without-write', false],
  ] as const)(
    'handles %s RESTORE_PENDING CAS response-loss exactly',
    async (_name, outcome, allowed) => {
      const current = durableHostFixture({ writeOutcomes: ['succeed', outcome] });
      if (allowed) {
        await expect(current.host.prepare()).resolves.toMatchObject({
          capability: 'V3_DURABLE_PREPARATION_CAPABILITY',
        });
        expect(current.stateStore.entry).toBe(
          canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(durablePendingEnvelope),
        );
        return;
      }
      await expect(current.host.prepare()).rejects.toMatchObject({ code: 'FENCE_UNAVAILABLE' });
      expect(current.calls.slice(-3)).toEqual(['archive.close', 'fs.release', 'ddl.release']);
    },
  );

  it.each([
    ['pending', canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(durablePendingEnvelope)],
    [
      'restored',
      canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(durableRestoredEnvelope),
    ],
  ] as const)(
    'refuses %s entry state without archive custody or capability issuance',
    async (_name, entry) => {
      const current = durableHostFixture({ entry });
      await expect(current.host.prepare()).rejects.toMatchObject({ code: 'STATE_CAS_MISMATCH' });
      expect(current.calls).toEqual([
        'ddl.acquire',
        'ddl.assert',
        'fs.acquire',
        'fs.read',
        'fs.release',
        'ddl.release',
      ]);
    },
  );

  it.each([
    ['before filesystem state', ['lost'], ['ddl.assert', 'ddl.release']],
    ['after OWNED state', ['held', 'lost'], ['fs.release', 'ddl.release']],
    [
      'after archive custody',
      ['held', 'held', 'lost'],
      ['archive.close', 'fs.release', 'ddl.release'],
    ],
  ] as const)('fails closed when the fence is lost %s', async (_name, fenceOutcomes, cleanup) => {
    const current = durableHostFixture({ fenceOutcomes });
    await expect(current.host.prepare()).rejects.toMatchObject({ code: 'FENCE_LOST' });
    expect(current.calls.slice(-cleanup.length)).toEqual(cleanup);
  });

  it.each([
    ['bytes', { device: '2049', inode: '123', bytes: '8', preSha256: durableRequest.backupSha256 }],
    ['hash', { device: '2049', inode: '123', bytes: '7', preSha256: sha('wrong') }],
    [
      'device',
      { device: 'not-a-device', inode: '123', bytes: '7', preSha256: durableRequest.backupSha256 },
    ],
    ['inode', { device: '2049', inode: '0', bytes: '7', preSha256: durableRequest.backupSha256 }],
  ] as const)(
    'rejects archive custody %s mismatch before RESTORE_PENDING',
    async (_name, observation) => {
      const current = durableHostFixture({ observation });
      await expect(current.host.prepare()).rejects.toMatchObject({
        code: 'ARCHIVE_CUSTODY_INVALID',
      });
      expect(current.stateStore.entry).toBe(
        canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(durableOwnedEnvelope),
      );
      expect(current.calls).not.toContain('fs.cas:RESTORE_PENDING');
      expect(current.calls.slice(-3)).toEqual(['archive.close', 'fs.release', 'ddl.release']);
    },
  );

  it('rejects forged, cloned and reused capabilities without releasing another invocation', async () => {
    const current = durableHostFixture();
    const capability = await current.host.prepare();
    const forged = { ...capability };
    await expect(current.host.abandon(forged)).rejects.toMatchObject({
      code: 'CAPABILITY_INVALID',
    });
    await current.host.abandon(capability);
    await expect(current.host.abandon(capability)).rejects.toMatchObject({
      code: 'CAPABILITY_INVALID',
    });
    expect(current.calls.slice(-3)).toEqual(['archive.close', 'fs.release', 'ddl.release']);
  });

  it('rejects a capability from another host without consuming the originating host capability', async () => {
    const origin = durableHostFixture();
    const foreign = durableHostFixture();
    const capability = await origin.host.prepare();
    await expect(foreign.host.abandon(capability)).rejects.toMatchObject({
      code: 'CAPABILITY_INVALID',
    });
    expect(foreign.calls).toEqual([]);
    await expect(origin.host.abandon(capability)).resolves.toBeUndefined();
    expect(origin.calls.slice(-3)).toEqual(['archive.close', 'fs.release', 'ddl.release']);
  });

  it.each([
    ['request', { stateRequestSha256: sha('wrong-request') }],
    ['receipt', { stateReceiptSha256: sha('wrong-receipt') }],
  ] as const)(
    'rejects a mismatched state-store %s binding before collaborator access',
    (_name, input) => {
      const calls: string[] = [];
      expect(() => durableHostFixture({ ...input, calls })).toThrow(/BINDING_INVALID/u);
      expect(calls).toEqual([]);
    },
  );

  it('releases archive, filesystem, then DDL fence and preserves the first cleanup failure', async () => {
    const archiveFailure = new Error('archive-close');
    const stateFailure = new Error('state-release');
    const fenceFailure = new Error('fence-release');
    const current = durableHostFixture({
      archiveCloseFailure: archiveFailure,
      stateReleaseFailure: stateFailure,
      fenceReleaseFailure: fenceFailure,
    });
    const capability = await current.host.prepare();
    await expect(current.host.abandon(capability)).rejects.toBe(archiveFailure);
    expect(current.calls.slice(-3)).toEqual(['archive.close', 'fs.release', 'ddl.release']);
  });

  it.each([
    ['archive', { archiveCloseFailure: new Error('archive-close') }],
    ['filesystem', { stateReleaseFailure: new Error('state-release') }],
    ['ddl', { fenceReleaseFailure: new Error('ddl-release') }],
    [
      'all',
      {
        archiveCloseFailure: new Error('archive-close'),
        stateReleaseFailure: new Error('state-release'),
        fenceReleaseFailure: new Error('ddl-release'),
      },
    ],
  ] as const)(
    'reports incomplete cleanup after a primary prepare failure when %s cleanup fails',
    async (_name, failures) => {
      const current = durableHostFixture({
        observation: {
          device: '2049',
          inode: '123',
          bytes: '8',
          preSha256: durableRequest.backupSha256,
        },
        ...failures,
      });
      await expect(current.host.prepare()).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      expect(current.calls.slice(-3)).toEqual(['archive.close', 'fs.release', 'ddl.release']);
    },
  );
});
