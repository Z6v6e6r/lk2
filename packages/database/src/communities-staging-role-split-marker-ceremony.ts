import { createHash } from 'node:crypto';

import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_STATE_VERSION =
  'communities-staging-role-split-marker-ceremony-state-v1';

export type CommunitiesStagingRoleSplitMarkerCeremonyPhase =
  'CANDIDATE' | 'OWNED' | 'RESTORED' | 'VERIFIED' | 'MARKER_PENDING' | 'MARKED' | 'EVIDENCED';

export interface CommunitiesStagingRoleSplitMarkerCeremonyState {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_STATE_VERSION;
  readonly requestSha256: string;
  readonly phase: CommunitiesStagingRoleSplitMarkerCeremonyPhase;
  readonly cloneDatabaseOid: string | null;
  readonly markerPayloadSha256: string | null;
}

export type CommunitiesStagingRoleSplitMarkerCeremonyObservation =
  'absent' | 'exact' | 'different' | 'unknown';

export interface CommunitiesStagingRoleSplitMarkerCeremonyObservations {
  readonly clone: CommunitiesStagingRoleSplitMarkerCeremonyObservation;
  readonly marker: CommunitiesStagingRoleSplitMarkerCeremonyObservation | 'not_checked';
  readonly evidence: CommunitiesStagingRoleSplitMarkerCeremonyObservation | 'not_checked';
}

export type CommunitiesStagingRoleSplitMarkerCeremonyRecoveryAction =
  | 'CREATE_CLONE'
  | 'RESTORE_CLONE'
  | 'VERIFY_BINDINGS'
  | 'WRITE_MARKER'
  | 'ADVANCE_MARKED'
  | 'PUBLISH_EVIDENCE'
  | 'ADVANCE_EVIDENCED'
  | 'SUCCESS'
  | 'RETAIN_AND_FAIL';

export type CommunitiesStagingRoleSplitMarkerCeremonyCleanupAction =
  'CLEAR_STATE_AND_RETRY' | 'DROP_EXACT_CLONE_AND_RETRY' | 'RETAIN_AND_FAIL';

const phases = [
  'CANDIDATE',
  'OWNED',
  'RESTORED',
  'VERIFIED',
  'MARKER_PENDING',
  'MARKED',
  'EVIDENCED',
] as const satisfies readonly CommunitiesStagingRoleSplitMarkerCeremonyPhase[];
const sha256 = /^[a-f0-9]{64}$/;
const positiveDecimal = /^[1-9][0-9]*$/;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`MARKER_CEREMONY_${code}`);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

export function assertCommunitiesStagingRoleSplitMarkerCeremonyState(
  state: CommunitiesStagingRoleSplitMarkerCeremonyState,
): void {
  if (
    typeof state !== 'object' ||
    state === null ||
    !hasExactKeys(state, [
      'schemaVersion',
      'requestSha256',
      'phase',
      'cloneDatabaseOid',
      'markerPayloadSha256',
    ]) ||
    state.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_STATE_VERSION ||
    !sha256.test(state.requestSha256) ||
    !phases.includes(state.phase)
  )
    fail('STATE_INVALID');

  if (state.phase === 'CANDIDATE') {
    if (state.cloneDatabaseOid !== null || state.markerPayloadSha256 !== null)
      fail('STATE_INVALID');
    return;
  }
  if (state.cloneDatabaseOid === null || !positiveDecimal.test(state.cloneDatabaseOid))
    fail('STATE_INVALID');
  if (['OWNED', 'RESTORED'].includes(state.phase)) {
    if (state.markerPayloadSha256 !== null) fail('STATE_INVALID');
    return;
  }
  if (state.markerPayloadSha256 === null || !sha256.test(state.markerPayloadSha256))
    fail('STATE_INVALID');
}

export function createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(
  requestSha256: string,
): CommunitiesStagingRoleSplitMarkerCeremonyState {
  const state: CommunitiesStagingRoleSplitMarkerCeremonyState = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_STATE_VERSION,
    requestSha256,
    phase: 'CANDIDATE',
    cloneDatabaseOid: null,
    markerPayloadSha256: null,
  };
  assertCommunitiesStagingRoleSplitMarkerCeremonyState(state);
  return state;
}

export function advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
  current: CommunitiesStagingRoleSplitMarkerCeremonyState,
  nextPhase: Exclude<CommunitiesStagingRoleSplitMarkerCeremonyPhase, 'CANDIDATE'>,
  binding: {
    readonly cloneDatabaseOid: string;
    readonly markerPayloadSha256?: string;
  },
): CommunitiesStagingRoleSplitMarkerCeremonyState {
  assertCommunitiesStagingRoleSplitMarkerCeremonyState(current);
  const currentIndex = phases.indexOf(current.phase);
  const nextIndex = phases.indexOf(nextPhase);
  if (nextIndex !== currentIndex + 1) fail('STATE_TRANSITION_INVALID');
  if (current.cloneDatabaseOid !== null && current.cloneDatabaseOid !== binding.cloneDatabaseOid)
    fail('STATE_BINDING_INVALID');
  if (
    current.markerPayloadSha256 !== null &&
    current.markerPayloadSha256 !== binding.markerPayloadSha256
  )
    fail('STATE_BINDING_INVALID');

  const markerPayloadSha256 = ['VERIFIED', 'MARKER_PENDING', 'MARKED', 'EVIDENCED'].includes(
    nextPhase,
  )
    ? (binding.markerPayloadSha256 ?? null)
    : null;
  const next: CommunitiesStagingRoleSplitMarkerCeremonyState = {
    ...current,
    phase: nextPhase,
    cloneDatabaseOid: binding.cloneDatabaseOid,
    markerPayloadSha256,
  };
  assertCommunitiesStagingRoleSplitMarkerCeremonyState(next);
  return next;
}

export function canonicalCommunitiesStagingRoleSplitMarkerCeremonyState(
  state: CommunitiesStagingRoleSplitMarkerCeremonyState,
): string {
  assertCommunitiesStagingRoleSplitMarkerCeremonyState(state);
  return `${state.schemaVersion}\nrequestSha256=${state.requestSha256}\nphase=${state.phase}\ncloneDatabaseOid=${state.cloneDatabaseOid ?? ''}\nmarkerPayloadSha256=${state.markerPayloadSha256 ?? ''}\n`;
}

export function communitiesStagingRoleSplitMarkerCeremonyStateSha256(
  state: CommunitiesStagingRoleSplitMarkerCeremonyState,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitMarkerCeremonyState(state), 'utf8')
    .digest('hex');
}

function assertObservations(
  observations: CommunitiesStagingRoleSplitMarkerCeremonyObservations,
): void {
  const allowed = ['absent', 'exact', 'different', 'unknown', 'not_checked'];
  if (
    !allowed.includes(observations.clone) ||
    !allowed.includes(observations.marker) ||
    !allowed.includes(observations.evidence)
  )
    fail('OBSERVATION_INVALID');
}

export function recoverCommunitiesStagingRoleSplitMarkerCeremony(
  state: CommunitiesStagingRoleSplitMarkerCeremonyState,
  observations: CommunitiesStagingRoleSplitMarkerCeremonyObservations,
): CommunitiesStagingRoleSplitMarkerCeremonyRecoveryAction {
  assertCommunitiesStagingRoleSplitMarkerCeremonyState(state);
  assertObservations(observations);

  if (state.phase === 'CANDIDATE')
    return observations.clone === 'absent' ? 'CREATE_CLONE' : 'RETAIN_AND_FAIL';
  if (observations.clone !== 'exact') return 'RETAIN_AND_FAIL';
  if (state.phase === 'OWNED') return 'RESTORE_CLONE';
  if (state.phase === 'RESTORED') return 'VERIFY_BINDINGS';
  if (state.phase === 'VERIFIED') return 'WRITE_MARKER';
  if (state.phase === 'MARKER_PENDING')
    return observations.marker === 'exact' ? 'ADVANCE_MARKED' : 'RETAIN_AND_FAIL';
  if (state.phase === 'MARKED') {
    if (observations.marker !== 'exact') return 'RETAIN_AND_FAIL';
    if (observations.evidence === 'exact') return 'ADVANCE_EVIDENCED';
    return observations.evidence === 'absent' ? 'PUBLISH_EVIDENCE' : 'RETAIN_AND_FAIL';
  }
  return observations.marker === 'exact' && observations.evidence === 'exact'
    ? 'SUCCESS'
    : 'RETAIN_AND_FAIL';
}

export function cleanupCommunitiesStagingRoleSplitMarkerCeremony(
  state: CommunitiesStagingRoleSplitMarkerCeremonyState,
  observations: Pick<CommunitiesStagingRoleSplitMarkerCeremonyObservations, 'clone' | 'marker'>,
): CommunitiesStagingRoleSplitMarkerCeremonyCleanupAction {
  assertCommunitiesStagingRoleSplitMarkerCeremonyState(state);
  if (state.phase === 'CANDIDATE')
    return observations.clone === 'absent' ? 'CLEAR_STATE_AND_RETRY' : 'RETAIN_AND_FAIL';
  if (['MARKED', 'EVIDENCED'].includes(state.phase)) return 'RETAIN_AND_FAIL';
  if (observations.clone === 'absent') return 'CLEAR_STATE_AND_RETRY';
  if (observations.clone !== 'exact') return 'RETAIN_AND_FAIL';
  if (observations.marker !== 'absent') return 'RETAIN_AND_FAIL';
  return 'DROP_EXACT_CLONE_AND_RETRY';
}
