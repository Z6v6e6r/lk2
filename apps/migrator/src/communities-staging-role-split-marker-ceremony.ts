import { createHash } from 'node:crypto';

import {
  advanceCommunitiesStagingRoleSplitMarkerCeremonyState,
  assertCommunitiesStagingRoleSplitMarkerCeremonyState,
  assertCommunitiesStagingRoleSplitRestoreMarker,
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  cleanupCommunitiesStagingRoleSplitMarkerCeremony,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  createCommunitiesStagingRoleSplitMarkerCeremonyCandidate,
  recoverCommunitiesStagingRoleSplitMarkerCeremony,
  type CommunitiesStagingRoleSplitMarkerCeremonyObservation,
  type CommunitiesStagingRoleSplitMarkerCeremonyState,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
} from '@phub/database';

export interface CommunitiesStagingRoleSplitMarkerCeremonyArtifacts {
  readonly payload: CommunitiesStagingRoleSplitRestoreMarkerPayload;
  readonly marker: string;
}

export interface CommunitiesStagingRoleSplitMarkerCeremonyLease {
  readonly requestSha256: string;
  readonly fencingToken: string;
}

export interface CommunitiesStagingRoleSplitMarkerCeremonyHost {
  acquireLease(requestSha256: string): Promise<CommunitiesStagingRoleSplitMarkerCeremonyLease>;
  releaseLease(lease: CommunitiesStagingRoleSplitMarkerCeremonyLease): Promise<void>;
  loadState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyState | null>;
  createCandidate(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    state: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ): Promise<void>;
  advanceState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ): Promise<void>;
  saveVerified(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
    artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  ): Promise<void>;
  loadVerifiedArtifacts(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyArtifacts>;
  observeClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string | null,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation>;
  observeMarkerPresence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string,
  ): Promise<'absent' | 'present' | 'unknown'>;
  observeMarker(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expectedCloneDatabaseOid: string,
    marker: string,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation>;
  observeEvidence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation>;
  createClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  ): Promise<{ readonly cloneDatabaseOid: string }>;
  restoreClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
  ): Promise<void>;
  verifyBindings(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyArtifacts>;
  writeMarker(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
    marker: string,
  ): Promise<void>;
  publishEvidence(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    evidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ): Promise<void>;
  dropExactClone(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    cloneDatabaseOid: string,
  ): Promise<void>;
  clearState(
    lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ): Promise<void>;
}

export class CommunitiesStagingRoleSplitMarkerCeremonyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CommunitiesStagingRoleSplitMarkerCeremonyError';
  }
}

function fail(code: string): never {
  throw new CommunitiesStagingRoleSplitMarkerCeremonyError(
    `COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_${code}`,
  );
}

function assertArtifacts(
  requestSha256: string,
  cloneDatabaseOid: string,
  artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
): void {
  assertCommunitiesStagingRoleSplitRestoreMarker(artifacts.payload, artifacts.marker);
  if (
    artifacts.payload.requestSha256 !== requestSha256 ||
    artifacts.payload.cloneDatabaseOid !== cloneDatabaseOid
  )
    fail('ARTIFACT_BINDING_INVALID');
}

function evidenceAfterExactMarkerReadback(
  payload: CommunitiesStagingRoleSplitRestoreMarkerPayload,
  marker: string,
): CommunitiesStagingRoleSplitRestoreMarkerEvidence {
  const evidence = {
    schemaVersion: 'communities-role-split-clone-marker-evidence-v2',
    status: 'MARKED',
    requestSha256: payload.requestSha256,
    creationReceiptSha256: payload.creationReceiptSha256,
    markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload),
    markerValueSha256: createHash('sha256').update(marker, 'utf8').digest('hex'),
    backupSha256: payload.backupSha256,
    sourceLedgerSha256: payload.sourceLedgerSha256,
    sourceLedgerCount: payload.sourceLedgerCount,
    cloneDatabaseOid: payload.cloneDatabaseOid,
    cloneBindingSha256: createHash('sha256')
      .update(`${payload.restoreDatabase}\0${payload.cloneDatabaseOid}`, 'utf8')
      .digest('hex'),
    sourceBindingSha256: createHash('sha256')
      .update(
        `${payload.sourceDatabase}\0${payload.sourceDatabaseOid}\0${payload.systemIdentifier}`,
        'utf8',
      )
      .digest('hex'),
    restoreRunId: payload.restoreRunId,
    restoreRunAttempt: payload.restoreRunAttempt,
    restoreHelperSha256: payload.restoreHelperSha256,
    markerWriterSha256: payload.markerWriterSha256,
    bindings: {
      request: true,
      backup: true,
      archiveOwnershipAcl: true,
      sourceStable: true,
      restoredLedger: true,
      cloneIdentity: true,
      markerReadback: true,
    },
    authorizes: {
      roleCreation: false,
      roleSplit: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      import: false,
      activation: false,
    },
  } satisfies CommunitiesStagingRoleSplitRestoreMarkerEvidence;
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(payload, marker, evidence);
  return evidence;
}

async function cleanupBeforeMarker(
  host: CommunitiesStagingRoleSplitMarkerCeremonyHost,
  lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
  state: CommunitiesStagingRoleSplitMarkerCeremonyState,
): Promise<never> {
  const clone = await host.observeClone(lease, state.cloneDatabaseOid);
  const markerPresence =
    state.cloneDatabaseOid === null
      ? 'unknown'
      : await host.observeMarkerPresence(lease, state.cloneDatabaseOid);
  const action = cleanupCommunitiesStagingRoleSplitMarkerCeremony(state, {
    clone,
    marker: markerPresence === 'present' ? 'different' : markerPresence,
  });
  if (action === 'RETAIN_AND_FAIL') fail('OUTCOME_AMBIGUOUS');
  if (action === 'DROP_EXACT_CLONE_AND_RETRY') {
    if (state.cloneDatabaseOid === null) fail('STATE_INVALID');
    await host.dropExactClone(lease, state.cloneDatabaseOid).catch(() => fail('CLEANUP_FAILED'));
    const afterDrop = await host.observeClone(lease, state.cloneDatabaseOid);
    if (afterDrop !== 'absent') fail('CLEANUP_FAILED');
  }
  await host.clearState(lease, state).catch(() => fail('CLEANUP_FAILED'));
  fail('RETRY_REQUIRED');
}

export async function runCommunitiesStagingRoleSplitMarkerCeremony(
  requestSha256: string,
  host: CommunitiesStagingRoleSplitMarkerCeremonyHost,
): Promise<void> {
  let lease: CommunitiesStagingRoleSplitMarkerCeremonyLease;
  try {
    lease = await host.acquireLease(requestSha256);
  } catch {
    fail('LEASE_UNAVAILABLE');
  }
  let primaryError: CommunitiesStagingRoleSplitMarkerCeremonyError | null = null;
  try {
    if (lease.requestSha256 !== requestSha256 || !/^[a-f0-9]{64}$/.test(lease.fencingToken))
      fail('LEASE_INVALID');
    await runWithLease(requestSha256, host, lease);
  } catch (error) {
    primaryError =
      error instanceof CommunitiesStagingRoleSplitMarkerCeremonyError
        ? error
        : new CommunitiesStagingRoleSplitMarkerCeremonyError(
            'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_EXECUTION_FAILED',
          );
  }
  let releaseError: CommunitiesStagingRoleSplitMarkerCeremonyError | null = null;
  try {
    await host.releaseLease(lease);
  } catch {
    releaseError = new CommunitiesStagingRoleSplitMarkerCeremonyError(
      'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_LEASE_RELEASE_FAILED',
    );
  }
  if (primaryError !== null) {
    if (releaseError !== null) primaryError.cause = releaseError;
    throw primaryError;
  }
  if (releaseError !== null) throw releaseError;
}

async function runWithLease(
  requestSha256: string,
  host: CommunitiesStagingRoleSplitMarkerCeremonyHost,
  lease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
): Promise<void> {
  let state = await host.loadState(lease);
  if (state === null) {
    state = createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(requestSha256);
    await host.createCandidate(lease, state);
  }
  assertCommunitiesStagingRoleSplitMarkerCeremonyState(state);
  if (state.requestSha256 !== requestSha256) fail('REQUEST_CONFLICT');

  for (let step = 0; step < 12; step += 1) {
    if (state.phase === 'CANDIDATE') {
      const clone = await host.observeClone(lease, null);
      const action = recoverCommunitiesStagingRoleSplitMarkerCeremony(state, {
        clone,
        marker: 'not_checked',
        evidence: 'not_checked',
      });
      if (action !== 'CREATE_CLONE') fail('CREATE_OUTCOME_AMBIGUOUS');
      let cloneDatabaseOid: string;
      try {
        ({ cloneDatabaseOid } = await host.createClone(lease));
      } catch {
        fail('CREATE_OUTCOME_AMBIGUOUS');
      }
      const owned = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(state, 'OWNED', {
        cloneDatabaseOid,
      });
      await host.advanceState(lease, state, owned).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = owned;
      continue;
    }

    if (state.phase === 'OWNED') {
      const clone = await host.observeClone(lease, state.cloneDatabaseOid);
      if (
        recoverCommunitiesStagingRoleSplitMarkerCeremony(state, {
          clone,
          marker: 'not_checked',
          evidence: 'not_checked',
        }) !== 'RESTORE_CLONE'
      )
        fail('CLONE_OUTCOME_AMBIGUOUS');
      const pending = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
        state,
        'RESTORE_PENDING',
        { cloneDatabaseOid: state.cloneDatabaseOid! },
      );
      await host.advanceState(lease, state, pending).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = pending;
      try {
        await host.restoreClone(lease, state.cloneDatabaseOid!);
      } catch {
        fail('RESTORE_OUTCOME_AMBIGUOUS');
      }
      const restored = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(state, 'RESTORED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
      });
      await host.advanceState(lease, state, restored).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = restored;
      continue;
    }

    if (state.phase === 'RESTORE_PENDING') fail('RESTORE_OUTCOME_AMBIGUOUS');

    if (state.phase === 'RESTORED') {
      let artifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts;
      try {
        artifacts = await host.verifyBindings(lease, state.cloneDatabaseOid!);
        assertArtifacts(requestSha256, state.cloneDatabaseOid!, artifacts);
      } catch {
        return cleanupBeforeMarker(host, lease, state);
      }
      const markerPayloadSha256 = communitiesStagingRoleSplitRestoreMarkerPayloadSha256(
        artifacts.payload,
      );
      const verified = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(state, 'VERIFIED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        markerPayloadSha256,
      });
      await host
        .saveVerified(lease, state, verified, artifacts)
        .catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = verified;
      continue;
    }

    const artifacts = await host
      .loadVerifiedArtifacts(lease)
      .catch(() => fail('ARTIFACTS_REQUIRED'));
    assertArtifacts(requestSha256, state.cloneDatabaseOid!, artifacts);
    if (
      communitiesStagingRoleSplitRestoreMarkerPayloadSha256(artifacts.payload) !==
      state.markerPayloadSha256
    )
      fail('ARTIFACT_BINDING_INVALID');

    if (state.phase === 'VERIFIED') {
      const pending = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
        state,
        'MARKER_PENDING',
        {
          cloneDatabaseOid: state.cloneDatabaseOid!,
          markerPayloadSha256: state.markerPayloadSha256,
        },
      );
      await host.advanceState(lease, state, pending).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = pending;
      try {
        await host.writeMarker(lease, state.cloneDatabaseOid!, artifacts.marker);
      } catch {
        // The readback below is authoritative after a lost command response.
      }
      continue;
    }

    if (state.phase === 'MARKER_PENDING') {
      const clone = await host.observeClone(lease, state.cloneDatabaseOid);
      const marker = await host.observeMarker(lease, state.cloneDatabaseOid!, artifacts.marker);
      const action = recoverCommunitiesStagingRoleSplitMarkerCeremony(state, {
        clone,
        marker,
        evidence: 'not_checked',
      });
      if (action === 'RETAIN_AND_FAIL') {
        if (clone === 'exact' && marker === 'absent')
          return cleanupBeforeMarker(host, lease, state);
        fail('MARKER_OUTCOME_AMBIGUOUS');
      }
      if (action !== 'ADVANCE_MARKED') fail('STATE_INVALID');
      const marked = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(state, 'MARKED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        markerPayloadSha256: state.markerPayloadSha256,
      });
      await host.advanceState(lease, state, marked).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = marked;
      continue;
    }

    if (state.phase === 'MARKED') {
      const evidence = evidenceAfterExactMarkerReadback(artifacts.payload, artifacts.marker);
      const clone = await host.observeClone(lease, state.cloneDatabaseOid);
      const marker = await host.observeMarker(lease, state.cloneDatabaseOid!, artifacts.marker);
      const evidenceObservation = await host.observeEvidence(lease, evidence);
      const action = recoverCommunitiesStagingRoleSplitMarkerCeremony(state, {
        clone,
        marker,
        evidence: evidenceObservation,
      });
      if (action === 'RETAIN_AND_FAIL') fail('POST_MARKER_OUTCOME_AMBIGUOUS');
      if (action === 'PUBLISH_EVIDENCE') {
        await host.publishEvidence(lease, evidence).catch(() => fail('EVIDENCE_WRITE_FAILED'));
        continue;
      }
      if (action !== 'ADVANCE_EVIDENCED') fail('STATE_INVALID');
      const evidenced = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(state, 'EVIDENCED', {
        cloneDatabaseOid: state.cloneDatabaseOid!,
        markerPayloadSha256: state.markerPayloadSha256,
      });
      await host.advanceState(lease, state, evidenced).catch(() => fail('STATE_WRITE_AMBIGUOUS'));
      state = evidenced;
      continue;
    }

    const evidence = evidenceAfterExactMarkerReadback(artifacts.payload, artifacts.marker);
    const clone = await host.observeClone(lease, state.cloneDatabaseOid);
    const marker = await host.observeMarker(lease, state.cloneDatabaseOid!, artifacts.marker);
    const evidenceObservation = await host.observeEvidence(lease, evidence);
    if (
      recoverCommunitiesStagingRoleSplitMarkerCeremony(state, {
        clone,
        marker,
        evidence: evidenceObservation,
      }) !== 'SUCCESS'
    )
      fail('POST_MARKER_OUTCOME_AMBIGUOUS');
    return;
  }
  fail('STEP_LIMIT_EXCEEDED');
}
