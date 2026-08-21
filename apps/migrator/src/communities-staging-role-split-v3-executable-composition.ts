import {
  advanceCommunitiesStagingRoleSplitV3State,
  assertCommunitiesStagingRoleSplitV3CloneCreationAuthorizationBinding,
  assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding,
  assertCommunitiesStagingRoleSplitV3Marker,
  assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding,
  assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  assertCommunitiesStagingRoleSplitV3State,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  communitiesStagingRoleSplitV3Marker,
  communitiesStagingRoleSplitV3MarkerPayloadSha256,
  createCommunitiesStagingRoleSplitV3AttestedEvidence,
  createCommunitiesStagingRoleSplitV3Candidate,
  createCommunitiesStagingRoleSplitV3MarkerEvidence,
  recoverCommunitiesStagingRoleSplitV3,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitV3AttestedEvidence,
  type CommunitiesStagingRoleSplitV3CloneCreationAuthorization,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitV3ExecutionAuthorization,
  type CommunitiesStagingRoleSplitV3MarkerPayload,
  type CommunitiesStagingRoleSplitV3Observation,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  type CommunitiesStagingRoleSplitV3State,
} from '@phub/database';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTABLE_COMPOSITION_VERSION =
  'communities-staging-role-split-v3-executable-composition-v1';

export interface CommunitiesStagingRoleSplitV3ExecutableLease {
  readonly requestSha256: string;
  readonly fencingToken: string;
}

export interface CommunitiesStagingRoleSplitV3VerifiedArtifacts {
  readonly payload: CommunitiesStagingRoleSplitV3MarkerPayload;
  readonly marker: string;
  readonly restoreExecutionEvidenceBinding: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
  readonly ownershipAclAttestation: {
    readonly subjectSha256: string;
    readonly evidenceSha256: string;
  };
  readonly sourceWriteDenialAttestation: {
    readonly subjectSha256: string;
    readonly evidenceSha256: string;
  };
}

export interface CommunitiesStagingRoleSplitV3ExecutableHost {
  readonly subjects: {
    readonly executableCompositionSha256: string;
    readonly stateStoreSha256: string;
    readonly cloneFactorySha256: string;
    readonly archiveCustodySha256: string;
    readonly runnerAdapterSha256: string;
    readonly canonicalHostAdapterSha256: string;
    readonly cloneOnlyConnectionFactorySha256: string;
    readonly ddlFenceSha256: string;
    readonly markerWriterSha256: string;
    readonly ownershipAclAttestorSha256: string;
    readonly sourceWriteDenialAttestorSha256: string;
    readonly evidenceSinkSha256: string;
    readonly externalPhaseAnchorSha256: string;
  };
  acquireLease(requestSha256: string): Promise<CommunitiesStagingRoleSplitV3ExecutableLease>;
  releaseLease(lease: CommunitiesStagingRoleSplitV3ExecutableLease): Promise<void>;
  loadState(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
  ): Promise<CommunitiesStagingRoleSplitV3State | null>;
  createCandidate(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    state: CommunitiesStagingRoleSplitV3State,
  ): Promise<void>;
  advanceState(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    current: CommunitiesStagingRoleSplitV3State,
    next: CommunitiesStagingRoleSplitV3State,
  ): Promise<void>;
  saveVerified(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    current: CommunitiesStagingRoleSplitV3State,
    next: CommunitiesStagingRoleSplitV3State,
    artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts,
  ): Promise<void>;
  loadVerifiedArtifacts(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
  ): Promise<CommunitiesStagingRoleSplitV3VerifiedArtifacts>;
  observeClone(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    expectedCloneDatabaseOid: string | null,
  ): Promise<CommunitiesStagingRoleSplitV3Observation>;
  observeRestoreExecutionEvidence(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    expectedSha256: string,
  ): Promise<CommunitiesStagingRoleSplitV3Observation>;
  observeMarker(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    cloneDatabaseOid: string,
    marker: string,
  ): Promise<CommunitiesStagingRoleSplitV3Observation>;
  observeEvidence(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ): Promise<CommunitiesStagingRoleSplitV3Observation>;
  createClone(lease: CommunitiesStagingRoleSplitV3ExecutableLease): Promise<{
    readonly cloneDatabaseOid: string;
    readonly restoreExecutionEvidenceBinding: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
  }>;
  /**
   * Must atomically persist OWNED -> RESTORE_PENDING under this lease, create a process-local
   * one-shot capability only after successful CAS, bind the already-open archive identity/hash,
   * consume the capability before pg_restore, verify the same archive again, then CAS to RESTORED.
   * A replay from durable RESTORE_PENDING must fail without invoking pg_restore.
   */
  restoreOwned(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    current: CommunitiesStagingRoleSplitV3State,
    pending: CommunitiesStagingRoleSplitV3State,
    restored: CommunitiesStagingRoleSplitV3State,
  ): Promise<void>;
  verifyBindings(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    state: CommunitiesStagingRoleSplitV3State,
  ): Promise<CommunitiesStagingRoleSplitV3VerifiedArtifacts>;
  writeMarker(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    cloneDatabaseOid: string,
    marker: string,
  ): Promise<void>;
  publishEvidence(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ): Promise<void>;
}

export type CommunitiesStagingRoleSplitV3ExecutableCompositionResult =
  | {
      readonly status: 'OWNED_CONTINUATION_REQUIRED';
      readonly state: CommunitiesStagingRoleSplitV3State & { readonly phase: 'OWNED' };
    }
  | {
      readonly status: 'EVIDENCED';
      readonly state: CommunitiesStagingRoleSplitV3State & { readonly phase: 'EVIDENCED' };
    };

export type CommunitiesStagingRoleSplitV3ExecutableCompositionConfig =
  | {
      readonly mode: 'CREATE';
      readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
      readonly expectedCandidateCommitSha: string;
      readonly authorization: CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
      readonly expectedAuthorizationSha256: string;
      readonly host: CommunitiesStagingRoleSplitV3ExecutableHost;
    }
  | {
      readonly mode: 'CONTINUE';
      readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
      readonly cloneCreationAuthorization: CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
      readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
      readonly durableRestoreAuthorization: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;
      readonly authorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
      readonly expectedAuthorizationSha256: string;
      readonly host: CommunitiesStagingRoleSplitV3ExecutableHost;
    };

export class CommunitiesStagingRoleSplitV3ExecutableCompositionError extends Error {
  constructor(
    readonly code:
      | 'AUTHORIZATION_INVALID'
      | 'BINDING_INVALID'
      | 'LEASE_UNAVAILABLE'
      | 'LEASE_INVALID'
      | 'LEASE_RELEASE_FAILED'
      | 'HOST_OPERATION_FAILED'
      | 'REQUEST_CONFLICT'
      | 'MODE_CONFLICT'
      | 'CREATE_OUTCOME_AMBIGUOUS'
      | 'STATE_WRITE_AMBIGUOUS'
      | 'RESTORE_OUTCOME_AMBIGUOUS'
      | 'RESTORE_RECONCILIATION_REQUIRED'
      | 'VERIFICATION_FAILED'
      | 'ARTIFACT_BINDING_INVALID'
      | 'MARKER_OUTCOME_AMBIGUOUS'
      | 'POST_MARKER_OUTCOME_AMBIGUOUS'
      | 'EVIDENCE_WRITE_FAILED'
      | 'STEP_LIMIT_EXCEEDED',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTABLE_COMPOSITION_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3ExecutableCompositionError';
  }
}

function fail(code: CommunitiesStagingRoleSplitV3ExecutableCompositionError['code']): never {
  throw new CommunitiesStagingRoleSplitV3ExecutableCompositionError(code);
}

function exactSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function immutableData<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function immutableHost(
  host: CommunitiesStagingRoleSplitV3ExecutableHost,
): CommunitiesStagingRoleSplitV3ExecutableHost {
  return Object.freeze({
    subjects: immutableData(host.subjects),
    acquireLease: host.acquireLease.bind(host),
    releaseLease: host.releaseLease.bind(host),
    loadState: host.loadState.bind(host),
    createCandidate: host.createCandidate.bind(host),
    advanceState: host.advanceState.bind(host),
    saveVerified: host.saveVerified.bind(host),
    loadVerifiedArtifacts: host.loadVerifiedArtifacts.bind(host),
    observeClone: host.observeClone.bind(host),
    observeRestoreExecutionEvidence: host.observeRestoreExecutionEvidence.bind(host),
    observeMarker: host.observeMarker.bind(host),
    observeEvidence: host.observeEvidence.bind(host),
    createClone: host.createClone.bind(host),
    restoreOwned: host.restoreOwned.bind(host),
    verifyBindings: host.verifyBindings.bind(host),
    writeMarker: host.writeMarker.bind(host),
    publishEvidence: host.publishEvidence.bind(host),
  });
}

function immutableConfig(
  config: CommunitiesStagingRoleSplitV3ExecutableCompositionConfig,
): CommunitiesStagingRoleSplitV3ExecutableCompositionConfig {
  const host = immutableHost(config.host);
  if (config.mode === 'CREATE')
    return Object.freeze({
      mode: config.mode,
      request: immutableData(config.request),
      expectedCandidateCommitSha: config.expectedCandidateCommitSha,
      authorization: immutableData(config.authorization),
      expectedAuthorizationSha256: config.expectedAuthorizationSha256,
      host,
    });
  return Object.freeze({
    mode: config.mode,
    request: immutableData(config.request),
    cloneCreationAuthorization: immutableData(config.cloneCreationAuthorization),
    hostAuthorization: immutableData(config.hostAuthorization),
    durableRestoreAuthorization: immutableData(config.durableRestoreAuthorization),
    authorization: immutableData(config.authorization),
    expectedAuthorizationSha256: config.expectedAuthorizationSha256,
    host,
  });
}

function assertHostSubjects(
  config: CommunitiesStagingRoleSplitV3ExecutableCompositionConfig,
): void {
  const subjects = config.host.subjects;
  if (Object.values(subjects).some((value) => !exactSha256(value))) fail('BINDING_INVALID');
  if (config.mode === 'CREATE') {
    const expected = config.authorization.components;
    if (
      subjects.executableCompositionSha256 !== expected.executableCompositionSha256 ||
      subjects.stateStoreSha256 !== expected.stateStoreSha256 ||
      subjects.cloneFactorySha256 !== expected.cloneFactorySha256 ||
      subjects.ddlFenceSha256 !== expected.ddlFenceSha256 ||
      subjects.externalPhaseAnchorSha256 !== expected.externalPhaseAnchorSha256
    )
      fail('BINDING_INVALID');
    return;
  }
  const expected = config.authorization.components;
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (subjects[key] !== expected[key]) fail('BINDING_INVALID');
  }
}

function assertConfig(config: CommunitiesStagingRoleSplitV3ExecutableCompositionConfig): void {
  if (!exactSha256(config.expectedAuthorizationSha256)) fail('AUTHORIZATION_INVALID');
  try {
    if (config.mode === 'CREATE') {
      if (
        communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256(config.authorization) !==
        config.expectedAuthorizationSha256
      )
        fail('AUTHORIZATION_INVALID');
      assertCommunitiesStagingRoleSplitV3CloneCreationAuthorizationBinding({
        request: config.request,
        expectedCandidateCommitSha: config.expectedCandidateCommitSha,
        expectedComponents: {
          executableCompositionSha256: config.host.subjects.executableCompositionSha256,
          stateStoreSha256: config.host.subjects.stateStoreSha256,
          cloneFactorySha256: config.host.subjects.cloneFactorySha256,
          ddlFenceSha256: config.host.subjects.ddlFenceSha256,
          externalPhaseAnchorSha256: config.host.subjects.externalPhaseAnchorSha256,
        },
        authorization: config.authorization,
      });
    } else {
      if (
        communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(config.authorization) !==
        config.expectedAuthorizationSha256
      )
        fail('AUTHORIZATION_INVALID');
      assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding({
        request: config.request,
        cloneCreationAuthorization: config.cloneCreationAuthorization,
        hostAuthorization: config.hostAuthorization,
        durableRestoreAuthorization: config.durableRestoreAuthorization,
        authorization: config.authorization,
      });
    }
    assertHostSubjects(config);
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitV3ExecutableCompositionError) throw error;
    fail('AUTHORIZATION_INVALID');
  }
}

function assertArtifacts(
  state: CommunitiesStagingRoleSplitV3State,
  artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts,
  authorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization,
  hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization,
): void {
  try {
    assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
      artifacts.restoreExecutionEvidenceBinding,
    );
    assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
      state,
      payload: artifacts.payload,
      restoreExecutionEvidenceBinding: artifacts.restoreExecutionEvidenceBinding,
    });
    assertCommunitiesStagingRoleSplitV3Marker(artifacts.payload, artifacts.marker);
  } catch {
    fail('ARTIFACT_BINDING_INVALID');
  }
  if (
    artifacts.payload.requestSha256 !== authorization.markerRequestSha256 ||
    artifacts.payload.creationReceiptSha256 !== authorization.creationReceiptSha256 ||
    artifacts.payload.restoreExecutionEvidenceSha256 !==
      authorization.restoreExecutionEvidenceSha256 ||
    artifacts.payload.cloneDatabaseOid !== authorization.cloneDatabaseOid ||
    artifacts.ownershipAclAttestation.subjectSha256 !==
      authorization.components.ownershipAclAttestorSha256 ||
    artifacts.sourceWriteDenialAttestation.subjectSha256 !==
      authorization.components.sourceWriteDenialAttestorSha256 ||
    !exactSha256(artifacts.ownershipAclAttestation.evidenceSha256) ||
    !exactSha256(artifacts.sourceWriteDenialAttestation.evidenceSha256) ||
    !hostAuthorization.bindings.some(
      (binding) =>
        binding.code === 'OWNERSHIP_ACL_ATTESTATION' &&
        binding.subjectSha256 === artifacts.ownershipAclAttestation.subjectSha256 &&
        binding.evidenceSha256 === artifacts.ownershipAclAttestation.evidenceSha256,
    ) ||
    !hostAuthorization.bindings.some(
      (binding) =>
        binding.code === 'SOURCE_WRITE_DENIAL_ATTESTATION' &&
        binding.subjectSha256 === artifacts.sourceWriteDenialAttestation.subjectSha256 &&
        binding.evidenceSha256 === artifacts.sourceWriteDenialAttestation.evidenceSha256,
    )
  )
    fail('ARTIFACT_BINDING_INVALID');
}

function attestedEvidence(
  artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts,
  authorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization,
  hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization,
): CommunitiesStagingRoleSplitV3AttestedEvidence {
  const markerEvidence = createCommunitiesStagingRoleSplitV3MarkerEvidence(
    artifacts.payload,
    artifacts.marker,
  );
  return createCommunitiesStagingRoleSplitV3AttestedEvidence({
    payload: artifacts.payload,
    marker: artifacts.marker,
    markerEvidence,
    executionAuthorization: authorization,
    hostAuthorization,
    ownershipAclAttestation: artifacts.ownershipAclAttestation,
    sourceWriteDenialAttestation: artifacts.sourceWriteDenialAttestation,
    evidenceSinkSubjectSha256: authorization.components.evidenceSinkSha256,
  });
}

export async function runCommunitiesStagingRoleSplitV3ExecutableComposition(
  inputConfig: CommunitiesStagingRoleSplitV3ExecutableCompositionConfig,
): Promise<CommunitiesStagingRoleSplitV3ExecutableCompositionResult> {
  let config: CommunitiesStagingRoleSplitV3ExecutableCompositionConfig;
  try {
    config = immutableConfig(inputConfig);
  } catch {
    fail('AUTHORIZATION_INVALID');
  }
  assertConfig(config);
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(config.request);
  let lease: CommunitiesStagingRoleSplitV3ExecutableLease;
  try {
    lease = immutableData(await config.host.acquireLease(requestSha256));
  } catch {
    fail('LEASE_UNAVAILABLE');
  }
  let primary: unknown = null;
  let result: CommunitiesStagingRoleSplitV3ExecutableCompositionResult | null = null;
  try {
    assertConfig(config);
    if (lease.requestSha256 !== requestSha256 || !exactSha256(lease.fencingToken))
      fail('LEASE_INVALID');
    result =
      config.mode === 'CREATE'
        ? await runCreateWithLease(config, lease, requestSha256)
        : await runContinueWithLease(config, lease, requestSha256);
  } catch (error) {
    primary =
      error instanceof CommunitiesStagingRoleSplitV3ExecutableCompositionError
        ? error
        : new CommunitiesStagingRoleSplitV3ExecutableCompositionError('HOST_OPERATION_FAILED');
  }
  try {
    await config.host.releaseLease(lease);
  } catch {
    if (primary === null) fail('LEASE_RELEASE_FAILED');
  }
  if (primary instanceof Error) throw primary;
  if (primary !== null) fail('BINDING_INVALID');
  if (result === null) fail('BINDING_INVALID');
  return result;
}

async function loadOrCreateCandidate(
  host: CommunitiesStagingRoleSplitV3ExecutableHost,
  lease: CommunitiesStagingRoleSplitV3ExecutableLease,
  requestSha256: string,
): Promise<CommunitiesStagingRoleSplitV3State> {
  let state = await host.loadState(lease);
  if (state === null) {
    state = createCommunitiesStagingRoleSplitV3Candidate(requestSha256);
    await host.createCandidate(lease, state).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
  }
  try {
    assertCommunitiesStagingRoleSplitV3State(state);
  } catch {
    fail('BINDING_INVALID');
  }
  if (state.requestSha256 !== requestSha256) fail('REQUEST_CONFLICT');
  return state;
}

async function runCreateWithLease(
  config: Extract<CommunitiesStagingRoleSplitV3ExecutableCompositionConfig, { mode: 'CREATE' }>,
  lease: CommunitiesStagingRoleSplitV3ExecutableLease,
  requestSha256: string,
): Promise<CommunitiesStagingRoleSplitV3ExecutableCompositionResult> {
  const state = await loadOrCreateCandidate(config.host, lease, requestSha256);
  if (state.phase === 'OWNED')
    return {
      status: 'OWNED_CONTINUATION_REQUIRED',
      state: state as typeof state & { phase: 'OWNED' },
    };
  if (state.phase !== 'CANDIDATE') fail('MODE_CONFLICT');
  const clone = await config.host.observeClone(lease, null);
  if (clone !== 'absent') fail('CREATE_OUTCOME_AMBIGUOUS');
  let created: Awaited<ReturnType<CommunitiesStagingRoleSplitV3ExecutableHost['createClone']>>;
  try {
    created = immutableData(await config.host.createClone(lease));
    assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
      created.restoreExecutionEvidenceBinding,
    );
  } catch {
    fail('CREATE_OUTCOME_AMBIGUOUS');
  }
  const owned = advanceCommunitiesStagingRoleSplitV3State(state, 'OWNED', {
    cloneDatabaseOid: created.cloneDatabaseOid,
    restoreExecutionEvidenceSha256:
      created.restoreExecutionEvidenceBinding.expectedRestoreExecutionEvidenceSha256,
    restoreExecutionEvidenceBinding: created.restoreExecutionEvidenceBinding,
  });
  await config.host.advanceState(lease, state, owned).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
  return {
    status: 'OWNED_CONTINUATION_REQUIRED',
    state: owned as typeof owned & { phase: 'OWNED' },
  };
}

async function runContinueWithLease(
  config: Extract<CommunitiesStagingRoleSplitV3ExecutableCompositionConfig, { mode: 'CONTINUE' }>,
  lease: CommunitiesStagingRoleSplitV3ExecutableLease,
  requestSha256: string,
): Promise<CommunitiesStagingRoleSplitV3ExecutableCompositionResult> {
  let state = await config.host.loadState(lease);
  if (state === null) fail('MODE_CONFLICT');
  try {
    assertCommunitiesStagingRoleSplitV3State(state);
  } catch {
    fail('BINDING_INVALID');
  }
  if (state.requestSha256 !== requestSha256) fail('REQUEST_CONFLICT');
  if (state.phase === 'CANDIDATE') fail('MODE_CONFLICT');
  if (
    state.cloneDatabaseOid !== config.authorization.cloneDatabaseOid ||
    state.restoreExecutionEvidenceSha256 !== config.authorization.restoreExecutionEvidenceSha256
  )
    fail('BINDING_INVALID');

  for (let step = 0; step < 12; step += 1) {
    if (state.phase === 'OWNED') {
      const clone = await config.host.observeClone(lease, state.cloneDatabaseOid);
      const restoreExecutionEvidence = await config.host.observeRestoreExecutionEvidence(
        lease,
        state.restoreExecutionEvidenceSha256!,
      );
      const action = recoverCommunitiesStagingRoleSplitV3(state, {
        clone,
        restoreExecutionEvidence,
        marker: 'not_checked',
        markerEvidence: 'not_checked',
      });
      if (action !== 'RESTORE_CLONE') fail('RESTORE_RECONCILIATION_REQUIRED');
      const pending = advanceCommunitiesStagingRoleSplitV3State(state, 'RESTORE_PENDING', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        restoreExecutionEvidenceSha256: state.restoreExecutionEvidenceSha256!,
      });
      const restored = advanceCommunitiesStagingRoleSplitV3State(pending, 'RESTORED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        restoreExecutionEvidenceSha256: state.restoreExecutionEvidenceSha256!,
      });
      await config.host
        .restoreOwned(lease, state, pending, restored)
        .catch(() => fail('RESTORE_OUTCOME_AMBIGUOUS'));
      state = restored;
      continue;
    }

    if (state.phase === 'RESTORE_PENDING') fail('RESTORE_RECONCILIATION_REQUIRED');

    if (state.phase === 'RESTORED') {
      let artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts;
      try {
        artifacts = immutableData(await config.host.verifyBindings(lease, state));
        assertArtifacts(state, artifacts, config.authorization, config.hostAuthorization);
      } catch {
        fail('VERIFICATION_FAILED');
      }
      const verified = advanceCommunitiesStagingRoleSplitV3State(state, 'VERIFIED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        restoreExecutionEvidenceSha256: state.restoreExecutionEvidenceSha256!,
        markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(artifacts.payload),
      });
      await config.host
        .saveVerified(lease, state, verified, artifacts)
        .catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = verified;
      continue;
    }

    const loadedArtifacts = await config.host
      .loadVerifiedArtifacts(lease)
      .catch(() => fail('ARTIFACT_BINDING_INVALID'));
    let artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts;
    try {
      artifacts = immutableData(loadedArtifacts);
    } catch {
      fail('ARTIFACT_BINDING_INVALID');
    }
    assertArtifacts(state, artifacts, config.authorization, config.hostAuthorization);
    if (
      state.markerPayloadSha256 !==
      communitiesStagingRoleSplitV3MarkerPayloadSha256(artifacts.payload)
    )
      fail('ARTIFACT_BINDING_INVALID');

    if (state.phase === 'VERIFIED') {
      const pending = advanceCommunitiesStagingRoleSplitV3State(state, 'MARKER_PENDING', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        restoreExecutionEvidenceSha256: state.restoreExecutionEvidenceSha256!,
        markerPayloadSha256: state.markerPayloadSha256,
      });
      await config.host
        .advanceState(lease, state, pending)
        .catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = pending;
      try {
        await config.host.writeMarker(lease, state.cloneDatabaseOid!, artifacts.marker);
      } catch {
        // Exact readback below is authoritative after response loss.
      }
      continue;
    }

    const clone = await config.host.observeClone(lease, state.cloneDatabaseOid);
    const restoreExecutionEvidence = await config.host.observeRestoreExecutionEvidence(
      lease,
      state.restoreExecutionEvidenceSha256!,
    );
    const marker = await config.host.observeMarker(
      lease,
      state.cloneDatabaseOid!,
      artifacts.marker,
    );

    if (state.phase === 'MARKER_PENDING') {
      const action = recoverCommunitiesStagingRoleSplitV3(state, {
        clone,
        restoreExecutionEvidence,
        marker,
        markerEvidence: 'not_checked',
      });
      if (action !== 'ADVANCE_MARKED') fail('MARKER_OUTCOME_AMBIGUOUS');
      const marked = advanceCommunitiesStagingRoleSplitV3State(state, 'MARKED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        restoreExecutionEvidenceSha256: state.restoreExecutionEvidenceSha256!,
        markerPayloadSha256: state.markerPayloadSha256,
      });
      await config.host
        .advanceState(lease, state, marked)
        .catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = marked;
      continue;
    }

    const evidence = attestedEvidence(artifacts, config.authorization, config.hostAuthorization);
    const evidenceObservation = await config.host.observeEvidence(lease, evidence);
    const action = recoverCommunitiesStagingRoleSplitV3(state, {
      clone,
      restoreExecutionEvidence,
      marker,
      markerEvidence: evidenceObservation,
    });
    if (state.phase === 'MARKED') {
      if (action === 'PUBLISH_EVIDENCE') {
        await config.host
          .publishEvidence(lease, evidence)
          .catch(() => fail('EVIDENCE_WRITE_FAILED'));
        continue;
      }
      if (action !== 'ADVANCE_EVIDENCED') fail('POST_MARKER_OUTCOME_AMBIGUOUS');
      const evidenced = advanceCommunitiesStagingRoleSplitV3State(state, 'EVIDENCED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        restoreExecutionEvidenceSha256: state.restoreExecutionEvidenceSha256!,
        markerPayloadSha256: state.markerPayloadSha256,
      });
      await config.host
        .advanceState(lease, state, evidenced)
        .catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = evidenced;
      continue;
    }

    if (action !== 'SUCCESS') fail('POST_MARKER_OUTCOME_AMBIGUOUS');
    return {
      status: 'EVIDENCED',
      state: state as typeof state & { phase: 'EVIDENCED' },
    };
  }
  fail('STEP_LIMIT_EXCEEDED');
}

export function communitiesStagingRoleSplitV3ExpectedMarker(
  payload: CommunitiesStagingRoleSplitV3MarkerPayload,
): string {
  return communitiesStagingRoleSplitV3Marker(payload);
}

export {
  CommunitiesStagingRoleSplitV3DurableRestoreCoordinator,
  CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError,
} from './communities-staging-role-split-v3-durable-restore-coordinator.js';
export type {
  CommunitiesStagingRoleSplitV3ArchiveCustody,
  CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorConfig,
  CommunitiesStagingRoleSplitV3DurableStateStore,
  CommunitiesStagingRoleSplitV3HeldFence,
  CommunitiesStagingRoleSplitV3RestoreRunner,
  CommunitiesStagingRoleSplitV3StateCasResult,
} from './communities-staging-role-split-v3-durable-restore-coordinator.js';
