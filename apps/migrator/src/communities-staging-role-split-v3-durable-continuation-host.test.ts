import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  advanceCommunitiesStagingRoleSplitV3State,
  createCommunitiesStagingRoleSplitV3AttestedEvidence,
  createCommunitiesStagingRoleSplitV3MarkerEvidence,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  communitiesStagingRoleSplitV3MarkerPayloadSha256,
  communitiesStagingRoleSplitV3Marker,
  parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
  type CommunitiesStagingRoleSplitV3AttestedEvidence,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  type CommunitiesStagingRoleSplitDdlFence,
} from './communities-staging-role-split-ddl-fence.js';
import {
  CommunitiesStagingRoleSplitV3DurableContinuationHost,
  type CommunitiesStagingRoleSplitV3DurableContinuationHostConfig,
} from './communities-staging-role-split-v3-durable-continuation-host.js';
import { CommunitiesStagingRoleSplitV3DurableStateStore } from './communities-staging-role-split-v3-durable-host.js';
import { runCommunitiesStagingRoleSplitV3ExecutableComposition } from './communities-staging-role-split-v3-executable-composition.js';
import {
  createCommunitiesStagingRoleSplitV3Fixture,
  fixtureSha,
} from './communities-staging-role-split-v3-test-fixtures.js';

const fixture = createCommunitiesStagingRoleSplitV3Fixture();
const fence: CommunitiesStagingRoleSplitDdlFence = {
  acquire(input) {
    return Promise.resolve({
      requestSha256: input.requestSha256,
      systemIdentifier: input.systemIdentifier,
      backendPid: '1',
      fencingToken: fixtureSha('fence-token'),
      advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
    });
  },
  async assertHeld() {},
  async release() {},
};

type HostFixtureOptions = {
  readonly fence?: CommunitiesStagingRoleSplitDdlFence;
  readonly throwAfterWriteAt?: number;
  readonly observeMarker?: () => Promise<'absent' | 'exact' | 'different' | 'unknown'>;
  readonly observeEvidence?: () => Promise<'absent' | 'exact' | 'different' | 'unknown'>;
  readonly writeMarker?: () => Promise<void>;
  readonly publishEvidence?: () => Promise<void>;
};

async function hostFixture(options: HostFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'phub-v3-continuation-'));
  await chmod(directory, 0o700);
  const store = new CommunitiesStagingRoleSplitV3DurableStateStore(
    fixture.executionAuthorization.components.stateStoreSha256,
    directory,
    fixture.requestSha256,
    fixture.receiptSha256,
  );
  const seed = await store.acquire();
  const owned = await store.writeCas(seed, null, fixture.ownedEnvelope);
  const pending = await store.writeCas(seed, owned, fixture.restorePendingEnvelope);
  await store.writeCas(seed, pending, fixture.restoredEnvelope);
  await store.release(seed);
  let marker = false;
  let evidence: CommunitiesStagingRoleSplitV3AttestedEvidence | null = null;
  let markerWrites = 0;
  let writes = 0;
  const stateStore =
    options.throwAfterWriteAt === undefined
      ? store
      : ({
          acquire: store.acquire.bind(store),
          release: store.release.bind(store),
          read: store.read.bind(store),
          async writeCas(...input: Parameters<typeof store.writeCas>) {
            const result = await store.writeCas(...input);
            writes += 1;
            if (writes === options.throwAfterWriteAt) throw new Error('response lost after write');
            return result;
          },
        } as unknown as CommunitiesStagingRoleSplitV3DurableStateStore);
  const config: CommunitiesStagingRoleSplitV3DurableContinuationHostConfig = {
    subjects: {
      ...fixture.executionAuthorization.components,
      cloneFactorySha256: fixture.cloneCreationAuthorization.components.cloneFactorySha256,
    },
    requestSha256: fixture.requestSha256,
    creationReceiptSha256: fixture.receiptSha256,
    restoreExecutionEvidenceBinding: fixture.restoreExecutionEvidenceBinding,
    restoredEnvelope: fixture.restoredEnvelope,
    stateStore,
    fence: options.fence ?? fence,
    systemIdentifier: fixture.request.systemIdentifier,
    fenceTimeoutMs: 1_000,
    executionAuthorization: fixture.executionAuthorization,
    hostAuthorization: fixture.hostAuthorization,
    expectedExecutionAuthorizationSha256: communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
      fixture.executionAuthorization,
    ),
    verifyBindings() {
      return Promise.resolve({
        payload: fixture.markerPayload,
        marker: communitiesStagingRoleSplitV3Marker(fixture.markerPayload),
        restoreExecutionEvidenceBinding: fixture.restoreExecutionEvidenceBinding,
        ownershipAclAttestation: {
          subjectSha256: fixture.executionAuthorization.components.ownershipAclAttestorSha256,
          evidenceSha256: fixture.hostAuthorization.bindings.find(
            (binding) => binding.code === 'OWNERSHIP_ACL_ATTESTATION',
          )!.evidenceSha256,
        },
        sourceWriteDenialAttestation: {
          subjectSha256: fixture.executionAuthorization.components.sourceWriteDenialAttestorSha256,
          evidenceSha256: fixture.hostAuthorization.bindings.find(
            (binding) => binding.code === 'SOURCE_WRITE_DENIAL_ATTESTATION',
          )!.evidenceSha256,
        },
      });
    },
    observeClone() {
      return Promise.resolve('exact' as const);
    },
    observeRestoreExecutionEvidence() {
      return Promise.resolve('exact' as const);
    },
    observeMarker() {
      return (
        options.observeMarker?.() ??
        Promise.resolve(marker ? ('exact' as const) : ('absent' as const))
      );
    },
    observeEvidence(candidate) {
      return (
        options.observeEvidence?.() ??
        Promise.resolve(
          evidence === null
            ? 'absent'
            : JSON.stringify(candidate) === JSON.stringify(evidence)
              ? 'exact'
              : 'different',
        )
      );
    },
    writeMarker() {
      markerWrites += 1;
      marker = true;
      return options.writeMarker?.() ?? Promise.resolve();
    },
    publishEvidence(candidate) {
      evidence = candidate;
      return options.publishEvidence?.() ?? Promise.resolve();
    },
  };
  const host = new CommunitiesStagingRoleSplitV3DurableContinuationHost(config);
  return {
    host,
    createHost: () => new CommunitiesStagingRoleSplitV3DurableContinuationHost(config),
    config,
    store,
    marker: () => marker,
    markerWrites: () => markerWrites,
    evidence: () => evidence,
  };
}

async function pendingMarkerFixture(options: HostFixtureOptions = {}) {
  const prepared = await hostFixture(options);
  const lease = await prepared.host.acquireLease(fixture.requestSha256);
  const restored = await prepared.host.loadState(lease);
  if (restored === null || restored.phase !== 'RESTORED') throw new Error('fixture state missing');
  const artifacts = await prepared.host.verifyBindings(lease, restored);
  const verified = advanceCommunitiesStagingRoleSplitV3State(restored, 'VERIFIED', {
    cloneDatabaseOid: restored.cloneDatabaseOid!,
    restoreExecutionEvidenceSha256: restored.restoreExecutionEvidenceSha256!,
    markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(artifacts.payload),
  });
  await prepared.host.saveVerified(lease, restored, verified, artifacts);
  const pending = advanceCommunitiesStagingRoleSplitV3State(verified, 'MARKER_PENDING', {
    cloneDatabaseOid: verified.cloneDatabaseOid!,
    restoreExecutionEvidenceSha256: verified.restoreExecutionEvidenceSha256!,
    markerPayloadSha256: verified.markerPayloadSha256!,
  });
  await prepared.host.advanceState(lease, verified, pending);
  return { ...prepared, lease, artifacts, pending };
}

async function markedFixture(options: HostFixtureOptions = {}) {
  const prepared = await pendingMarkerFixture(options);
  await prepared.host.writeMarker(
    prepared.lease,
    prepared.pending.cloneDatabaseOid!,
    prepared.artifacts.marker,
  );
  expect(
    await prepared.host.observeMarker(
      prepared.lease,
      prepared.pending.cloneDatabaseOid!,
      prepared.artifacts.marker,
    ),
  ).toBe('exact');
  const marked = advanceCommunitiesStagingRoleSplitV3State(prepared.pending, 'MARKED', {
    cloneDatabaseOid: prepared.pending.cloneDatabaseOid!,
    restoreExecutionEvidenceSha256: prepared.pending.restoreExecutionEvidenceSha256!,
    markerPayloadSha256: prepared.pending.markerPayloadSha256!,
  });
  await prepared.host.advanceState(prepared.lease, prepared.pending, marked);
  return { ...prepared, marked };
}

function attestedEvidence(
  artifacts: Awaited<ReturnType<typeof pendingMarkerFixture>>['artifacts'],
) {
  return createCommunitiesStagingRoleSplitV3AttestedEvidence({
    payload: artifacts.payload,
    marker: artifacts.marker,
    markerEvidence: createCommunitiesStagingRoleSplitV3MarkerEvidence(
      artifacts.payload,
      artifacts.marker,
    ),
    executionAuthorization: fixture.executionAuthorization,
    hostAuthorization: fixture.hostAuthorization,
    ownershipAclAttestation: artifacts.ownershipAclAttestation,
    sourceWriteDenialAttestation: artifacts.sourceWriteDenialAttestation,
    evidenceSinkSubjectSha256: fixture.executionAuthorization.components.evidenceSinkSha256,
  });
}

describe('V3 durable continuation host', () => {
  it('persists the exact continuation and only dispatches marker after the pending CAS', async () => {
    const prepared = await hostFixture();
    const result = await runCommunitiesStagingRoleSplitV3ExecutableComposition({
      mode: 'CONTINUE',
      request: fixture.request,
      cloneCreationAuthorization: fixture.cloneCreationAuthorization,
      hostAuthorization: fixture.hostAuthorization,
      durableRestoreAuthorization: fixture.durableRestoreAuthorization,
      authorization: fixture.executionAuthorization,
      expectedAuthorizationSha256: communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
        fixture.executionAuthorization,
      ),
      host: prepared.host,
    });
    expect(result.status).toBe('EVIDENCED');
    expect(prepared.marker()).toBe(true);
    expect(prepared.evidence()).not.toBeNull();
  });

  it('does not recreate a marker capability after a MARKER_PENDING restart', async () => {
    const prepared = await hostFixture();
    const lease = await prepared.host.acquireLease(fixture.requestSha256);
    const restored = await prepared.host.loadState(lease);
    expect(restored?.phase).toBe('RESTORED');
    if (restored === null || restored.phase !== 'RESTORED')
      throw new Error('fixture state missing');
    const artifacts = await prepared.host.verifyBindings(lease, restored);
    const verified = advanceCommunitiesStagingRoleSplitV3State(restored, 'VERIFIED', {
      cloneDatabaseOid: restored.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: restored.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(artifacts.payload),
    });
    await prepared.host.saveVerified(lease, restored, verified, artifacts);
    const pending = advanceCommunitiesStagingRoleSplitV3State(verified, 'MARKER_PENDING', {
      cloneDatabaseOid: verified.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: verified.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: verified.markerPayloadSha256!,
    });
    await prepared.host.advanceState(lease, verified, pending);
    await prepared.host.writeMarker(lease, pending.cloneDatabaseOid!, artifacts.marker);
    await prepared.host.releaseLease(lease);

    const restarted = prepared.createHost();
    const result = await runCommunitiesStagingRoleSplitV3ExecutableComposition({
      mode: 'CONTINUE',
      request: fixture.request,
      cloneCreationAuthorization: fixture.cloneCreationAuthorization,
      hostAuthorization: fixture.hostAuthorization,
      durableRestoreAuthorization: fixture.durableRestoreAuthorization,
      authorization: fixture.executionAuthorization,
      expectedAuthorizationSha256: communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
        fixture.executionAuthorization,
      ),
      host: restarted,
    });
    expect(result.status).toBe('EVIDENCED');
    expect(prepared.markerWrites()).toBe(1);
  });

  it('rejects a MARKED CAS until the exact marker was observed', async () => {
    const prepared = await hostFixture();
    const lease = await prepared.host.acquireLease(fixture.requestSha256);
    const restored = await prepared.host.loadState(lease);
    expect(restored?.phase).toBe('RESTORED');
    if (restored === null || restored.phase !== 'RESTORED')
      throw new Error('fixture state missing');
    const artifacts = await prepared.host.verifyBindings(lease, restored);
    const verified = advanceCommunitiesStagingRoleSplitV3State(restored, 'VERIFIED', {
      cloneDatabaseOid: restored.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: restored.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(artifacts.payload),
    });
    await prepared.host.saveVerified(lease, restored, verified, artifacts);
    const pending = advanceCommunitiesStagingRoleSplitV3State(verified, 'MARKER_PENDING', {
      cloneDatabaseOid: verified.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: verified.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: verified.markerPayloadSha256!,
    });
    await prepared.host.advanceState(lease, verified, pending);
    const marked = advanceCommunitiesStagingRoleSplitV3State(pending, 'MARKED', {
      cloneDatabaseOid: pending.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: pending.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: pending.markerPayloadSha256!,
    });

    await expect(prepared.host.advanceState(lease, pending, marked)).rejects.toMatchObject({
      code: 'STATE_AMBIGUOUS',
    });
    await prepared.host.releaseLease(lease);
  });

  it('requires a same-preimage one-shot marker capability', async () => {
    const prepared = await pendingMarkerFixture();
    await prepared.host.writeMarker(
      prepared.lease,
      prepared.pending.cloneDatabaseOid!,
      prepared.artifacts.marker,
    );
    await expect(
      prepared.host.writeMarker(
        prepared.lease,
        prepared.pending.cloneDatabaseOid!,
        prepared.artifacts.marker,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await prepared.host.releaseLease(prepared.lease);
  });

  it('does not mint a marker transition token for absent, different, or unknown readback', async () => {
    for (const observation of ['absent', 'different', 'unknown'] as const) {
      const prepared = await pendingMarkerFixture();
      await prepared.host.writeMarker(
        prepared.lease,
        prepared.pending.cloneDatabaseOid!,
        prepared.artifacts.marker,
      );
      const mutated = new CommunitiesStagingRoleSplitV3DurableContinuationHost({
        ...prepared.config,
        observeMarker: () => Promise.resolve(observation),
      });
      await prepared.host.releaseLease(prepared.lease);
      const lease = await mutated.acquireLease(fixture.requestSha256);
      const state = await mutated.loadState(lease);
      if (state === null || state.phase !== 'MARKER_PENDING') throw new Error('state missing');
      expect(
        await mutated.observeMarker(lease, state.cloneDatabaseOid!, prepared.artifacts.marker),
      ).toBe(observation);
      const marked = advanceCommunitiesStagingRoleSplitV3State(state, 'MARKED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        restoreExecutionEvidenceSha256: state.restoreExecutionEvidenceSha256!,
        markerPayloadSha256: state.markerPayloadSha256!,
      });
      await expect(mutated.advanceState(lease, state, marked)).rejects.toMatchObject({
        code: 'STATE_AMBIGUOUS',
      });
      await mutated.releaseLease(lease);
    }
  });

  it('requires absent then exact evidence observation and consumes the publish capability once', async () => {
    const prepared = await markedFixture();
    const evidence = prepared.evidence();
    expect(evidence).toBeNull();
    const candidate = attestedEvidence(prepared.artifacts);
    expect(await prepared.host.observeEvidence(prepared.lease, candidate)).toBe('absent');
    await prepared.host.publishEvidence(prepared.lease, candidate);
    await expect(prepared.host.publishEvidence(prepared.lease, candidate)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(await prepared.host.observeEvidence(prepared.lease, candidate)).toBe('exact');
    const evidenced = advanceCommunitiesStagingRoleSplitV3State(prepared.marked, 'EVIDENCED', {
      cloneDatabaseOid: prepared.marked.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: prepared.marked.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: prepared.marked.markerPayloadSha256!,
    });
    await prepared.host.advanceState(prepared.lease, prepared.marked, evidenced);
    await prepared.host.releaseLease(prepared.lease);
  });

  it('rejects EVIDENCED before exact evidence readback', async () => {
    const prepared = await markedFixture();
    const evidenced = advanceCommunitiesStagingRoleSplitV3State(prepared.marked, 'EVIDENCED', {
      cloneDatabaseOid: prepared.marked.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: prepared.marked.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: prepared.marked.markerPayloadSha256!,
    });
    await expect(
      prepared.host.advanceState(prepared.lease, prepared.marked, evidenced),
    ).rejects.toMatchObject({
      code: 'STATE_AMBIGUOUS',
    });
    await prepared.host.releaseLease(prepared.lease);
  });

  it('refuses create, clone, and restore operations at the continuation-only boundary', async () => {
    const prepared = await hostFixture();
    const lease = await prepared.host.acquireLease(fixture.requestSha256);
    await expect(
      prepared.host.createCandidate(lease, fixture.ownedEnvelope.state),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await expect(prepared.host.createClone(lease)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      prepared.host.restoreOwned(
        lease,
        fixture.ownedEnvelope.state,
        fixture.restorePendingEnvelope.state,
        fixture.restoredEnvelope.state,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await prepared.host.releaseLease(lease);
  });

  it('rejects stale, cross-host, and wrong-request leases', async () => {
    const prepared = await hostFixture();
    const lease = await prepared.host.acquireLease(fixture.requestSha256);
    await expect(
      prepared.host.loadState({ ...lease, requestSha256: fixtureSha('wrong-request') }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    const other = await hostFixture();
    await expect(other.host.loadState(lease)).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await prepared.host.releaseLease(lease);
    await expect(prepared.host.loadState(lease)).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  });

  it('takes a construction-time snapshot of callbacks and bindings', async () => {
    const prepared = await hostFixture();
    const original = prepared.config.observeMarker;
    (prepared.config as { observeMarker: () => Promise<'different'> }).observeMarker = () =>
      Promise.resolve('different');
    const lease = await prepared.host.acquireLease(fixture.requestSha256);
    const restored = await prepared.host.loadState(lease);
    expect(restored?.phase).toBe('RESTORED');
    expect(prepared.host.subjects).toEqual(prepared.config.subjects);
    expect(prepared.config.observeMarker).not.toBe(original);
    await prepared.host.releaseLease(lease);
  });

  it('accepts a response-loss CAS only when the exact verified continuation was persisted', async () => {
    const prepared = await hostFixture({ throwAfterWriteAt: 1 });
    const lease = await prepared.host.acquireLease(fixture.requestSha256);
    const restored = await prepared.host.loadState(lease);
    if (restored === null || restored.phase !== 'RESTORED')
      throw new Error('fixture state missing');
    const artifacts = await prepared.host.verifyBindings(lease, restored);
    const verified = advanceCommunitiesStagingRoleSplitV3State(restored, 'VERIFIED', {
      cloneDatabaseOid: restored.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: restored.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(artifacts.payload),
    });
    await prepared.host.saveVerified(lease, restored, verified, artifacts);
    expect((await prepared.host.loadState(lease))?.phase).toBe('VERIFIED');
    await prepared.host.releaseLease(lease);
  });

  it('accepts response loss after the exact MARKER_PENDING CAS without replaying the marker', async () => {
    const prepared = await pendingMarkerFixture({ throwAfterWriteAt: 2 });
    expect((await prepared.host.loadState(prepared.lease))?.phase).toBe('MARKER_PENDING');
    await prepared.host.writeMarker(
      prepared.lease,
      prepared.pending.cloneDatabaseOid!,
      prepared.artifacts.marker,
    );
    expect(prepared.markerWrites()).toBe(1);
    await prepared.host.releaseLease(prepared.lease);
  });

  it('binds exact marker OID and bytes and rejects a mismatched evidence payload', async () => {
    const pending = await pendingMarkerFixture();
    await expect(
      pending.host.writeMarker(
        pending.lease,
        fixtureSha('wrong-write-oid'),
        pending.artifacts.marker,
      ),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await expect(
      pending.host.writeMarker(
        pending.lease,
        pending.pending.cloneDatabaseOid!,
        'wrong-write-marker',
      ),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(pending.markerWrites()).toBe(0);
    await pending.host.writeMarker(
      pending.lease,
      pending.pending.cloneDatabaseOid!,
      pending.artifacts.marker,
    );
    await expect(
      pending.host.observeMarker(pending.lease, fixtureSha('wrong-oid'), pending.artifacts.marker),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await expect(
      pending.host.observeMarker(pending.lease, pending.pending.cloneDatabaseOid!, 'wrong-marker'),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await pending.host.releaseLease(pending.lease);

    const marked = await markedFixture();
    const evidence = attestedEvidence(marked.artifacts);
    await expect(
      marked.host.observeEvidence(marked.lease, {
        ...evidence,
        evidenceSinkSubjectSha256: fixtureSha('wrong-evidence-sink'),
      }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await marked.host.releaseLease(marked.lease);
  });

  it('state store rejects continuation predecessor, restored-anchor, payload, and marker drift', async () => {
    const prepared = await markedFixture();
    await prepared.host.releaseLease(prepared.lease);
    const lease = await prepared.store.acquire();
    const bytes = await prepared.store.read(lease);
    if (bytes === null) throw new Error('continuation state missing');
    const current = parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(bytes);
    const evidenced = advanceCommunitiesStagingRoleSplitV3State(current.state, 'EVIDENCED', {
      cloneDatabaseOid: current.state.cloneDatabaseOid!,
      restoreExecutionEvidenceSha256: current.state.restoreExecutionEvidenceSha256!,
      markerPayloadSha256: current.state.markerPayloadSha256!,
    });
    const next = { ...current, phase: 'EVIDENCED' as const, state: evidenced };
    await expect(
      prepared.store.writeCas(lease, bytes, {
        ...next,
        previousEnvelopeSha256: fixtureSha('wrong-predecessor'),
      }),
    ).rejects.toMatchObject({ code: 'STATE_CAS_MISMATCH' });
    await expect(
      prepared.store.writeCas(lease, bytes, {
        ...next,
        restoredEnvelopeSha256: fixtureSha('wrong-restored-anchor'),
      }),
    ).rejects.toMatchObject({ code: 'STATE_CAS_MISMATCH' });
    await expect(
      prepared.store.writeCas(lease, bytes, {
        ...next,
        artifacts: {
          ...next.artifacts,
          payload: { ...next.artifacts.payload, requestSha256: fixtureSha('wrong-payload') },
        },
      }),
    ).rejects.toMatchObject({
      code: 'COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_ARTIFACTS_BINDING_INVALID',
    });
    await expect(
      prepared.store.writeCas(lease, bytes, {
        ...next,
        artifacts: { ...next.artifacts, marker: 'wrong-marker' },
      }),
    ).rejects.toMatchObject({
      code: 'COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_ARTIFACTS_BINDING_INVALID',
    });
    await prepared.store.release(lease);
  });

  it('fails closed when the DDL fence is lost after lease acquisition', async () => {
    let held = true;
    const prepared = await hostFixture({
      fence: {
        ...fence,
        assertHeld() {
          return held ? Promise.resolve() : Promise.reject(new Error('fence lost'));
        },
      },
    });
    const lease = await prepared.host.acquireLease(fixture.requestSha256);
    held = false;
    await expect(prepared.host.loadState(lease)).rejects.toMatchObject({ code: 'FENCE_LOST' });
    held = true;
    await prepared.host.releaseLease(lease);
  });

  it('retries only the incomplete cleanup stage and disables the lease while releasing', async () => {
    const prepared = await hostFixture();
    const events: string[] = [];
    let stateReleaseFails = true;
    const stateStore = {
      acquire: prepared.store.acquire.bind(prepared.store),
      read: prepared.store.read.bind(prepared.store),
      writeCas: prepared.store.writeCas.bind(prepared.store),
      async release(lease: Parameters<typeof prepared.store.release>[0]) {
        events.push('fs');
        if (stateReleaseFails) {
          stateReleaseFails = false;
          throw new Error('state release unavailable');
        }
        await prepared.store.release(lease);
      },
    } as unknown as CommunitiesStagingRoleSplitV3DurableStateStore;
    const stagedFence: CommunitiesStagingRoleSplitDdlFence = {
      ...fence,
      release() {
        events.push('ddl');
        return Promise.resolve();
      },
    };
    const host = new CommunitiesStagingRoleSplitV3DurableContinuationHost({
      ...prepared.config,
      stateStore,
      fence: stagedFence,
    });
    const lease = await host.acquireLease(fixture.requestSha256);

    await expect(host.releaseLease(lease)).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await expect(host.loadState(lease)).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await expect(host.releaseLease(lease)).resolves.toBeUndefined();
    expect(events).toEqual(['fs', 'ddl', 'fs']);
  });

  it('surfaces incomplete DDL cleanup when filesystem lease acquisition fails', async () => {
    const prepared = await hostFixture();
    const host = new CommunitiesStagingRoleSplitV3DurableContinuationHost({
      ...prepared.config,
      stateStore: {
        acquire: () => Promise.reject(new Error('filesystem lease unavailable')),
        release: prepared.store.release.bind(prepared.store),
        read: prepared.store.read.bind(prepared.store),
        writeCas: prepared.store.writeCas.bind(prepared.store),
      } as unknown as CommunitiesStagingRoleSplitV3DurableStateStore,
      fence: {
        ...fence,
        release: () => Promise.reject(new Error('DDL release unconfirmed')),
      },
    });

    await expect(host.acquireLease(fixture.requestSha256)).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
  });

  it('releases a misbound DDL lease before refusing filesystem custody', async () => {
    let releases = 0;
    const prepared = await hostFixture({
      fence: {
        ...fence,
        acquire(input) {
          return Promise.resolve({
            requestSha256: fixtureSha('foreign-request'),
            systemIdentifier: input.systemIdentifier,
            backendPid: '1',
            fencingToken: fixtureSha('foreign-fence'),
            advisoryKey: COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
          });
        },
        release() {
          releases += 1;
          return Promise.resolve();
        },
      },
    });

    await expect(prepared.host.acquireLease(fixture.requestSha256)).rejects.toMatchObject({
      code: 'FENCE_LOST',
    });
    expect(releases).toBe(1);
    const untouched = await prepared.store.acquire();
    await prepared.store.release(untouched);
  });

  it('releases a DDL lease that is lost before filesystem acquisition', async () => {
    let releases = 0;
    const prepared = await hostFixture({
      fence: {
        ...fence,
        assertHeld: () => Promise.reject(new Error('fence lost before filesystem lease')),
        release() {
          releases += 1;
          return Promise.resolve();
        },
      },
    });

    await expect(prepared.host.acquireLease(fixture.requestSha256)).rejects.toMatchObject({
      code: 'FENCE_LOST',
    });
    expect(releases).toBe(1);
    const untouched = await prepared.store.acquire();
    await prepared.store.release(untouched);
  });
});
