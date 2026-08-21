/**
 * Unwired continuation-only adapter for the V3 executable composition.
 *
 * This owns only the durable RESTORED -> EVIDENCED journal.  All observations
 * and side effects are injected; it deliberately has no PostgreSQL, marker or
 * evidence implementation and rejects the create/restore half of the host.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  assertCommunitiesStagingRoleSplitV3AttestedEvidence,
  canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_VERSION,
  assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  createCommunitiesStagingRoleSplitV3MarkerEvidence,
  parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  parseCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  communitiesStagingRoleSplitV3AttestedEvidenceSha256,
  communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitV3AttestedEvidence,
  type CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3ExecutionAuthorization,
  type CommunitiesStagingRoleSplitV3MarkerPayload,
  type CommunitiesStagingRoleSplitV3Observation,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  type CommunitiesStagingRoleSplitV3State,
} from '@phub/database';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  type CommunitiesStagingRoleSplitDdlFence,
  type CommunitiesStagingRoleSplitDdlFenceLease,
} from './communities-staging-role-split-ddl-fence.js';
import type {
  CommunitiesStagingRoleSplitV3DurableStateLease,
  CommunitiesStagingRoleSplitV3DurableStateStore,
} from './communities-staging-role-split-v3-durable-host.js';
import type {
  CommunitiesStagingRoleSplitV3ExecutableHost,
  CommunitiesStagingRoleSplitV3ExecutableLease,
  CommunitiesStagingRoleSplitV3VerifiedArtifacts,
} from './communities-staging-role-split-v3-executable-composition.js';

const continuationVersion = COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_VERSION;
const sha256 = /^[a-f0-9]{64}$/u;
export class CommunitiesStagingRoleSplitV3DurableContinuationHostError extends Error {
  constructor(
    readonly code:
      'BINDING_INVALID' | 'FENCE_LOST' | 'STATE_AMBIGUOUS' | 'UNAVAILABLE' | 'CLEANUP_INCOMPLETE',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_HOST_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3DurableContinuationHostError';
  }
}
function fail(code: CommunitiesStagingRoleSplitV3DurableContinuationHostError['code']): never {
  throw new CommunitiesStagingRoleSplitV3DurableContinuationHostError(code);
}
const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
};
const freeze = <T>(value: T): T => deepFreeze(structuredClone(value));

export interface CommunitiesStagingRoleSplitV3DurableContinuationHostConfig {
  readonly subjects: CommunitiesStagingRoleSplitV3ExecutableHost['subjects'];
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly restoreExecutionEvidenceBinding: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
  readonly restoredEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly stateStore: CommunitiesStagingRoleSplitV3DurableStateStore;
  readonly fence: CommunitiesStagingRoleSplitDdlFence;
  readonly systemIdentifier: string;
  readonly fenceTimeoutMs: number;
  readonly executionAuthorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly expectedExecutionAuthorizationSha256: string;
  readonly verifyBindings: () => Promise<CommunitiesStagingRoleSplitV3VerifiedArtifacts>;
  readonly observeClone: (
    expectedOid: string | null,
  ) => Promise<CommunitiesStagingRoleSplitV3Observation>;
  readonly observeRestoreExecutionEvidence: (
    expectedSha256: string,
  ) => Promise<CommunitiesStagingRoleSplitV3Observation>;
  readonly observeMarker: (
    cloneDatabaseOid: string,
    marker: string,
  ) => Promise<CommunitiesStagingRoleSplitV3Observation>;
  readonly observeEvidence: (
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ) => Promise<CommunitiesStagingRoleSplitV3Observation>;
  readonly writeMarker: (cloneDatabaseOid: string, marker: string) => Promise<void>;
  readonly publishEvidence: (
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ) => Promise<void>;
}

type Held = {
  readonly fs: CommunitiesStagingRoleSplitV3DurableStateLease;
  readonly ddl: CommunitiesStagingRoleSplitDdlFenceLease;
  verifiedPreimage: string | null;
  markerDispatchPreimageSha256: string | null;
  markerObservationPreimageSha256: string | null;
  evidencePublishPreimageSha256: string | null;
  evidenceObservationPreimageSha256: string | null;
  evidenceObservationSha256: string | null;
  releasing: boolean;
  fsReleased: boolean;
  ddlReleased: boolean;
};

export class CommunitiesStagingRoleSplitV3DurableContinuationHost implements CommunitiesStagingRoleSplitV3ExecutableHost {
  readonly subjects;
  private readonly config: CommunitiesStagingRoleSplitV3DurableContinuationHostConfig;
  private readonly stateStore: Pick<
    CommunitiesStagingRoleSplitV3DurableStateStore,
    'acquire' | 'release' | 'read' | 'writeCas'
  >;
  private readonly fence: Pick<
    CommunitiesStagingRoleSplitDdlFence,
    'acquire' | 'assertHeld' | 'release'
  >;
  private readonly leases = new Map<string, Held>();
  constructor(config: CommunitiesStagingRoleSplitV3DurableContinuationHostConfig) {
    this.config = Object.freeze({
      ...config,
      subjects: Object.freeze({ ...config.subjects }),
      restoredEnvelope: freeze(config.restoredEnvelope),
      restoreExecutionEvidenceBinding: freeze(config.restoreExecutionEvidenceBinding),
      executionAuthorization: freeze(config.executionAuthorization),
      hostAuthorization: freeze(config.hostAuthorization),
      verifyBindings: config.verifyBindings.bind(config),
      observeClone: config.observeClone.bind(config),
      observeRestoreExecutionEvidence: config.observeRestoreExecutionEvidence.bind(config),
      observeMarker: config.observeMarker.bind(config),
      observeEvidence: config.observeEvidence.bind(config),
      writeMarker: config.writeMarker.bind(config),
      publishEvidence: config.publishEvidence.bind(config),
    });
    this.stateStore = Object.freeze({
      acquire: config.stateStore.acquire.bind(config.stateStore),
      release: config.stateStore.release.bind(config.stateStore),
      read: config.stateStore.read.bind(config.stateStore),
      writeCas: config.stateStore.writeCas.bind(config.stateStore),
    });
    this.fence = Object.freeze({
      acquire: config.fence.acquire.bind(config.fence),
      assertHeld: config.fence.assertHeld.bind(config.fence),
      release: config.fence.release.bind(config.fence),
    });
    this.subjects = this.config.subjects;
    try {
      assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
        config.restoreExecutionEvidenceBinding,
      );
      if (
        !sha256.test(config.requestSha256) ||
        !sha256.test(config.creationReceiptSha256) ||
        !Object.values(config.subjects).every((v) => sha256.test(v)) ||
        config.restoredEnvelope.phase !== 'RESTORED' ||
        config.restoredEnvelope.requestSha256 !== config.requestSha256 ||
        config.restoredEnvelope.creationReceiptSha256 !== config.creationReceiptSha256 ||
        config.expectedExecutionAuthorizationSha256 !==
          communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
            config.executionAuthorization,
          ) ||
        config.executionAuthorization.markerRequestSha256 !== config.requestSha256 ||
        config.executionAuthorization.creationReceiptSha256 !== config.creationReceiptSha256 ||
        config.executionAuthorization.restoreExecutionEvidenceSha256 !==
          config.restoredEnvelope.restoreExecutionEvidenceSha256 ||
        config.executionAuthorization.cloneDatabaseOid !==
          config.restoredEnvelope.cloneDatabaseOid ||
        config.executionAuthorization.systemIdentifier !== config.systemIdentifier ||
        config.executionAuthorization.hostAuthorizationSha256 !==
          communitiesStagingRoleSplitHostAuthorizationSha256(config.hostAuthorization) ||
        communitiesStagingRoleSplitRestoreMarkerRequestSha256(
          config.restoreExecutionEvidenceBinding.request,
        ) !== config.requestSha256 ||
        config.restoreExecutionEvidenceBinding.creationReceiptSha256 !==
          config.creationReceiptSha256 ||
        config.restoreExecutionEvidenceBinding.expectedRestoreExecutionEvidenceSha256 !==
          config.restoredEnvelope.restoreExecutionEvidenceSha256 ||
        config.restoreExecutionEvidenceBinding.cloneDatabaseOid !==
          config.restoredEnvelope.cloneDatabaseOid ||
        config.restoreExecutionEvidenceBinding.systemIdentifier !== config.systemIdentifier ||
        Object.entries(config.executionAuthorization.components).some(
          ([key, value]) =>
            config.subjects[
              key as keyof CommunitiesStagingRoleSplitV3ExecutableHost['subjects']
            ] !== value,
        ) ||
        !Number.isSafeInteger(config.fenceTimeoutMs) ||
        config.fenceTimeoutMs < 1 ||
        config.fenceTimeoutMs > 60_000
      )
        fail('BINDING_INVALID');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitV3DurableContinuationHostError) throw error;
      fail('BINDING_INVALID');
    }
  }
  private async held(lease: CommunitiesStagingRoleSplitV3ExecutableLease): Promise<Held> {
    const held = this.leases.get(lease.fencingToken);
    if (!held || held.releasing || lease.requestSha256 !== this.config.requestSha256)
      fail('BINDING_INVALID');
    await this.fence.assertHeld(held.ddl).catch(() => fail('FENCE_LOST'));
    return held;
  }
  private async read(held: Held): Promise<{
    readonly bytes: string;
    readonly envelope:
      | CommunitiesStagingRoleSplitV3DurableStateEnvelope
      | CommunitiesStagingRoleSplitV3DurableContinuationEnvelope;
  }> {
    await this.fence.assertHeld(held.ddl).catch(() => fail('FENCE_LOST'));
    const bytes = await this.stateStore.read(held.fs);
    await this.fence.assertHeld(held.ddl).catch(() => fail('FENCE_LOST'));
    if (bytes === null) fail('STATE_AMBIGUOUS');
    try {
      const schemaVersion = (JSON.parse(bytes) as { schemaVersion?: unknown }).schemaVersion;
      if (schemaVersion === continuationVersion)
        return {
          bytes,
          envelope: parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(bytes),
        };
      return { bytes, envelope: parseCommunitiesStagingRoleSplitV3DurableStateEnvelope(bytes) };
    } catch {
      /* converted below */
    }
    fail('STATE_AMBIGUOUS');
  }
  private async readContinuation(held: Held): Promise<{
    readonly bytes: string;
    readonly envelope: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope;
  }> {
    await this.fence.assertHeld(held.ddl).catch(() => fail('FENCE_LOST'));
    const bytes = await this.stateStore.read(held.fs);
    await this.fence.assertHeld(held.ddl).catch(() => fail('FENCE_LOST'));
    if (bytes === null) fail('STATE_AMBIGUOUS');
    try {
      return {
        bytes,
        envelope: parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(bytes),
      };
    } catch {
      fail('STATE_AMBIGUOUS');
    }
  }
  private continuation(
    phase: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope['phase'],
    state: CommunitiesStagingRoleSplitV3State,
    artifacts: {
      payload: CommunitiesStagingRoleSplitV3MarkerPayload;
      marker: string;
      markerEvidence: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope['artifacts']['markerEvidence'];
      attestedEvidenceSha256: string | null;
    },
    previousEnvelopeSha256: string,
  ): CommunitiesStagingRoleSplitV3DurableContinuationEnvelope {
    return {
      schemaVersion: continuationVersion,
      phase,
      requestSha256: this.config.requestSha256,
      creationReceiptSha256: this.config.creationReceiptSha256,
      restoreExecutionEvidenceSha256: this.config.restoredEnvelope.restoreExecutionEvidenceSha256,
      cloneDatabaseOid: this.config.restoredEnvelope.cloneDatabaseOid,
      restoredEnvelopeSha256: communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(
        this.config.restoredEnvelope,
      ),
      previousEnvelopeSha256,
      state,
      artifacts,
    };
  }
  async acquireLease(requestSha256: string): Promise<CommunitiesStagingRoleSplitV3ExecutableLease> {
    if (requestSha256 !== this.config.requestSha256) fail('BINDING_INVALID');
    const ddl = await this.fence
      .acquire({
        requestSha256,
        systemIdentifier: this.config.systemIdentifier,
        timeoutMs: this.config.fenceTimeoutMs,
        signal: AbortSignal.timeout(this.config.fenceTimeoutMs),
      })
      .catch(() => fail('FENCE_LOST'));
    const invalidDdlLease =
      ddl.requestSha256 !== requestSha256 ||
      ddl.systemIdentifier !== this.config.systemIdentifier ||
      !/^[1-9][0-9]*$/u.test(ddl.backendPid) ||
      !sha256.test(ddl.fencingToken) ||
      ddl.advisoryKey !== COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
    if (invalidDdlLease) {
      try {
        await this.fence.release(ddl);
      } catch {
        fail('CLEANUP_INCOMPLETE');
      }
      fail('FENCE_LOST');
    }
    try {
      await this.fence.assertHeld(ddl);
    } catch {
      try {
        await this.fence.release(ddl);
      } catch {
        fail('CLEANUP_INCOMPLETE');
      }
      fail('FENCE_LOST');
    }
    let fs: CommunitiesStagingRoleSplitV3DurableStateLease;
    try {
      fs = await this.stateStore.acquire();
    } catch {
      try {
        await this.fence.release(ddl);
      } catch {
        fail('CLEANUP_INCOMPLETE');
      }
      fail('STATE_AMBIGUOUS');
    }
    const token = fs.fencingToken;
    this.leases.set(token, {
      fs,
      ddl,
      verifiedPreimage: null,
      markerDispatchPreimageSha256: null,
      markerObservationPreimageSha256: null,
      evidencePublishPreimageSha256: null,
      evidenceObservationPreimageSha256: null,
      evidenceObservationSha256: null,
      releasing: false,
      fsReleased: false,
      ddlReleased: false,
    });
    return Object.freeze({ requestSha256, fencingToken: token });
  }
  async releaseLease(lease: CommunitiesStagingRoleSplitV3ExecutableLease): Promise<void> {
    const held = this.leases.get(lease.fencingToken);
    if (!held) fail('BINDING_INVALID');
    held.releasing = true;
    let primary: unknown;
    if (!held.fsReleased) {
      try {
        await this.stateStore.release(held.fs);
        held.fsReleased = true;
      } catch (error) {
        primary = error;
      }
    }
    if (!held.ddlReleased) {
      try {
        await this.fence.release(held.ddl);
        held.ddlReleased = true;
      } catch (error) {
        primary ??= error;
      }
    }
    if (held.fsReleased && held.ddlReleased) this.leases.delete(lease.fencingToken);
    if (primary) fail('CLEANUP_INCOMPLETE');
  }
  async loadState(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
  ): Promise<CommunitiesStagingRoleSplitV3State | null> {
    const held = await this.held(lease);
    return (await this.read(held)).envelope.state;
  }
  async saveVerified(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    current: CommunitiesStagingRoleSplitV3State,
    next: CommunitiesStagingRoleSplitV3State,
    artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts,
  ): Promise<void> {
    const held = await this.held(lease);
    const read = await this.read(held);
    if (
      read.envelope.state.phase !== 'RESTORED' ||
      !isDeepStrictEqual(read.envelope.state, current) ||
      held.verifiedPreimage !== read.bytes
    )
      fail('STATE_AMBIGUOUS');
    held.verifiedPreimage = null;
    const nextEnvelope = this.continuation(
      'VERIFIED',
      next,
      {
        payload: artifacts.payload,
        marker: artifacts.marker,
        markerEvidence: null,
        attestedEvidenceSha256: null,
      },
      communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(this.config.restoredEnvelope),
    );
    const exact = canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(nextEnvelope);
    try {
      await this.stateStore.writeCas(held.fs, read.bytes, nextEnvelope);
    } catch {
      await this.held(lease);
      const observed = await this.stateStore.read(held.fs);
      await this.held(lease);
      if (observed !== exact) fail('STATE_AMBIGUOUS');
    }
    await this.held(lease);
  }
  async loadVerifiedArtifacts(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
  ): Promise<CommunitiesStagingRoleSplitV3VerifiedArtifacts> {
    const held = await this.held(lease);
    const { envelope } = await this.readContinuation(held);
    const verified = await this.config.verifyBindings();
    if (
      verified.payload.requestSha256 !== envelope.artifacts.payload.requestSha256 ||
      verified.marker !== envelope.artifacts.marker
    )
      fail('BINDING_INVALID');
    await this.held(lease);
    return freeze({
      payload: envelope.artifacts.payload,
      marker: envelope.artifacts.marker,
      restoreExecutionEvidenceBinding: this.config.restoreExecutionEvidenceBinding,
      ownershipAclAttestation: verified.ownershipAclAttestation,
      sourceWriteDenialAttestation: verified.sourceWriteDenialAttestation,
    });
  }
  async advanceState(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    current: CommunitiesStagingRoleSplitV3State,
    next: CommunitiesStagingRoleSplitV3State,
  ): Promise<void> {
    const held = await this.held(lease);
    const read = await this.readContinuation(held);
    if (!isDeepStrictEqual(read.envelope.state, current)) fail('STATE_AMBIGUOUS');
    let markerBeforePending: 'absent' | 'exact' | null = null;
    if (current.phase === 'VERIFIED' && next.phase === 'MARKER_PENDING') {
      const observation = await this.config.observeMarker(
        read.envelope.cloneDatabaseOid,
        read.envelope.artifacts.marker,
      );
      await this.held(lease);
      const confirmed = await this.readContinuation(held);
      if (confirmed.bytes !== read.bytes || (observation !== 'absent' && observation !== 'exact'))
        fail('STATE_AMBIGUOUS');
      markerBeforePending = observation;
    }
    const markerEvidence =
      next.phase === 'MARKED' && read.envelope.artifacts.markerEvidence === null
        ? createCommunitiesStagingRoleSplitV3MarkerEvidence(
            read.envelope.artifacts.payload,
            read.envelope.artifacts.marker,
          )
        : next.phase === 'MARKED' || next.phase === 'EVIDENCED'
          ? read.envelope.artifacts.markerEvidence
          : null;
    if ((next.phase === 'MARKED' || next.phase === 'EVIDENCED') && markerEvidence === null)
      fail('STATE_AMBIGUOUS');
    const attestedEvidenceSha256 =
      next.phase === 'EVIDENCED' ? held.evidenceObservationSha256 : null;
    if (next.phase === 'EVIDENCED' && attestedEvidenceSha256 === null) fail('STATE_AMBIGUOUS');
    const envelope = this.continuation(
      next.phase as CommunitiesStagingRoleSplitV3DurableContinuationEnvelope['phase'],
      next,
      { ...read.envelope.artifacts, markerEvidence, attestedEvidenceSha256 },
      communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(read.envelope),
    );
    const exact = canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(envelope);
    const currentSha256 = communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(
      read.envelope,
    );
    if (current.phase === 'MARKER_PENDING' && next.phase === 'MARKED') {
      if (held.markerObservationPreimageSha256 !== currentSha256) fail('STATE_AMBIGUOUS');
      held.markerObservationPreimageSha256 = null;
    }
    if (current.phase === 'MARKED' && next.phase === 'EVIDENCED') {
      if (held.evidenceObservationPreimageSha256 !== currentSha256) fail('STATE_AMBIGUOUS');
      held.evidenceObservationPreimageSha256 = null;
      held.evidenceObservationSha256 = null;
    }
    try {
      await this.stateStore.writeCas(held.fs, read.bytes, envelope);
    } catch {
      await this.held(lease);
      const observed = await this.stateStore.read(held.fs);
      await this.held(lease);
      if (observed !== exact) fail('STATE_AMBIGUOUS');
    }
    await this.held(lease);
    if (current.phase === 'VERIFIED' && next.phase === 'MARKER_PENDING') {
      held.markerDispatchPreimageSha256 =
        markerBeforePending === 'absent'
          ? communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(envelope)
          : null;
      held.markerObservationPreimageSha256 = null;
    }
  }
  async observeClone(lease: CommunitiesStagingRoleSplitV3ExecutableLease, expected: string | null) {
    await this.held(lease);
    const result = await this.config.observeClone(expected);
    await this.held(lease);
    return result;
  }
  async observeRestoreExecutionEvidence(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    expected: string,
  ) {
    await this.held(lease);
    const result = await this.config.observeRestoreExecutionEvidence(expected);
    await this.held(lease);
    return result;
  }
  async observeMarker(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    oid: string,
    marker: string,
  ) {
    const held = await this.held(lease);
    const current = await this.readContinuation(held);
    if (!['MARKER_PENDING', 'MARKED', 'EVIDENCED'].includes(current.envelope.phase))
      fail('STATE_AMBIGUOUS');
    if (oid !== current.envelope.cloneDatabaseOid || marker !== current.envelope.artifacts.marker)
      fail('BINDING_INVALID');
    const result = await this.config.observeMarker(oid, marker);
    await this.held(lease);
    const confirmed = await this.readContinuation(held);
    if (confirmed.bytes !== current.bytes) fail('STATE_AMBIGUOUS');
    held.markerObservationPreimageSha256 =
      current.envelope.phase === 'MARKER_PENDING' && result === 'exact'
        ? communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(current.envelope)
        : null;
    return result;
  }
  async observeEvidence(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ) {
    const held = await this.held(lease);
    const current = await this.readContinuation(held);
    if (!['MARKED', 'EVIDENCED'].includes(current.envelope.phase)) fail('STATE_AMBIGUOUS');
    try {
      assertCommunitiesStagingRoleSplitV3AttestedEvidence({
        payload: current.envelope.artifacts.payload,
        marker: current.envelope.artifacts.marker,
        executionAuthorization: this.config.executionAuthorization,
        hostAuthorization: this.config.hostAuthorization,
        evidence,
      });
    } catch {
      fail('BINDING_INVALID');
    }
    const evidenceSha256 = communitiesStagingRoleSplitV3AttestedEvidenceSha256({
      payload: current.envelope.artifacts.payload,
      marker: current.envelope.artifacts.marker,
      executionAuthorization: this.config.executionAuthorization,
      hostAuthorization: this.config.hostAuthorization,
      evidence,
    });
    if (
      current.envelope.phase === 'EVIDENCED' &&
      current.envelope.artifacts.attestedEvidenceSha256 !== evidenceSha256
    )
      fail('BINDING_INVALID');
    const result = await this.config.observeEvidence(evidence);
    await this.held(lease);
    const confirmed = await this.readContinuation(held);
    if (confirmed.bytes !== current.bytes) fail('STATE_AMBIGUOUS');
    const currentSha256 = communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(
      current.envelope,
    );
    held.evidencePublishPreimageSha256 =
      current.envelope.phase === 'MARKED' && result === 'absent' ? currentSha256 : null;
    held.evidenceObservationPreimageSha256 = result === 'exact' ? currentSha256 : null;
    held.evidenceObservationSha256 =
      current.envelope.phase === 'MARKED' && result === 'exact' ? evidenceSha256 : null;
    return result;
  }
  async verifyBindings(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    state: CommunitiesStagingRoleSplitV3State,
  ) {
    const held = await this.held(lease);
    const current = await this.read(held);
    if (
      current.envelope.state.phase !== 'RESTORED' ||
      !isDeepStrictEqual(current.envelope.state, state) ||
      current.bytes !==
        canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(this.config.restoredEnvelope)
    )
      fail('STATE_AMBIGUOUS');
    const result = await this.config.verifyBindings();
    await this.held(lease);
    const confirmed = await this.read(held);
    if (confirmed.bytes !== current.bytes) fail('STATE_AMBIGUOUS');
    held.verifiedPreimage = current.bytes;
    return freeze(result);
  }
  async writeMarker(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    oid: string,
    marker: string,
  ) {
    const held = await this.held(lease);
    const current = await this.readContinuation(held);
    const currentSha256 = communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(
      current.envelope,
    );
    if (
      current.envelope.phase !== 'MARKER_PENDING' ||
      oid !== current.envelope.cloneDatabaseOid ||
      marker !== current.envelope.artifacts.marker
    )
      fail('BINDING_INVALID');
    if (held.markerDispatchPreimageSha256 !== currentSha256) fail('UNAVAILABLE');
    held.markerDispatchPreimageSha256 = null;
    await this.config.writeMarker(oid, marker);
    await this.held(lease);
  }
  async publishEvidence(
    lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ) {
    const held = await this.held(lease);
    const current = await this.readContinuation(held);
    const currentSha256 = communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(
      current.envelope,
    );
    if (current.envelope.phase !== 'MARKED' || held.evidencePublishPreimageSha256 !== currentSha256)
      fail('UNAVAILABLE');
    try {
      assertCommunitiesStagingRoleSplitV3AttestedEvidence({
        payload: current.envelope.artifacts.payload,
        marker: current.envelope.artifacts.marker,
        executionAuthorization: this.config.executionAuthorization,
        hostAuthorization: this.config.hostAuthorization,
        evidence,
      });
    } catch {
      fail('BINDING_INVALID');
    }
    held.evidencePublishPreimageSha256 = null;
    await this.config.publishEvidence(evidence);
    await this.held(lease);
  }
  createCandidate(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    _state: CommunitiesStagingRoleSplitV3State,
  ): Promise<void> {
    void _lease;
    void _state;
    return Promise.reject(
      new CommunitiesStagingRoleSplitV3DurableContinuationHostError('UNAVAILABLE'),
    );
  }
  createClone(_lease: CommunitiesStagingRoleSplitV3ExecutableLease): Promise<never> {
    void _lease;
    return Promise.reject(
      new CommunitiesStagingRoleSplitV3DurableContinuationHostError('UNAVAILABLE'),
    );
  }
  restoreOwned(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    _current: CommunitiesStagingRoleSplitV3State,
    _pending: CommunitiesStagingRoleSplitV3State,
    _restored: CommunitiesStagingRoleSplitV3State,
  ): Promise<void> {
    void _lease;
    void _current;
    void _pending;
    void _restored;
    return Promise.reject(
      new CommunitiesStagingRoleSplitV3DurableContinuationHostError('UNAVAILABLE'),
    );
  }
}
