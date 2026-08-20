import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings,
  communitiesStagingRoleSplitRestoreExecutionEvidenceSha256,
  type CommunitiesStagingRoleSplitRestoreExecutionEvidence,
} from './communities-staging-role-split-restore-execution-evidence.js';
import type { CommunitiesStagingRoleSplitRestoreExecutionDescriptor } from './communities-staging-role-split-restore-execution-descriptor.js';
import {
  assertCommunitiesStagingRoleSplitRestoreMarkerPayload,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from './communities-staging-role-split-restore-marker.js';
import type { CommunitiesStagingRoleSplitSourceWriteDenialAttestation } from './communities-staging-role-split-source-write-denial-attestation.js';
import type {
  CommunitiesSourceConnectAclObservation,
  CommunitiesSourceMembershipObservation,
} from './communities-staging-role-split-source-write-denial-observations.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION =
  'communities-staging-role-split-marker-ceremony-state-v3';
export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_VERSION =
  'PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_V3';
export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_PREFIX =
  'phub-communities-role-split-clone-v3:';
export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_EVIDENCE_VERSION =
  'communities-role-split-clone-marker-evidence-v3';

export type CommunitiesStagingRoleSplitV3Phase =
  | 'CANDIDATE'
  | 'OWNED'
  | 'RESTORE_PENDING'
  | 'RESTORED'
  | 'VERIFIED'
  | 'MARKER_PENDING'
  | 'MARKED'
  | 'EVIDENCED';

export interface CommunitiesStagingRoleSplitV3State {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION;
  readonly requestSha256: string;
  readonly phase: CommunitiesStagingRoleSplitV3Phase;
  readonly cloneDatabaseOid: string | null;
  readonly restoreExecutionEvidenceSha256: string | null;
  readonly markerPayloadSha256: string | null;
}

export interface CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly attestation: CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
  readonly descriptor: CommunitiesStagingRoleSplitRestoreExecutionDescriptor;
  readonly evidence: CommunitiesStagingRoleSplitRestoreExecutionEvidence;
  readonly connectAclObservation: CommunitiesSourceConnectAclObservation;
  readonly membershipObservation: CommunitiesSourceMembershipObservation;
  readonly creationReceiptSha256: string;
  readonly cloneDatabaseOid: string;
  readonly systemIdentifier: string;
  readonly restoreRunId: string;
  readonly restoreRunAttempt: string;
  readonly expectedRestoreExecutionEvidenceSha256: string;
}

export interface CommunitiesStagingRoleSplitV3MarkerPayload extends CommunitiesStagingRoleSplitRestoreMarkerPayload {
  readonly restoreExecutionEvidenceSha256: string;
}

const authorityKeys = [
  'roleCreation',
  'roleSplit',
  'sharedDatabaseMutation',
  'migration',
  'deploy',
  'import',
  'activation',
] as const;
const bindingKeys = [
  'request',
  'restoreExecutionEvidence',
  'backup',
  'archiveOwnershipAcl',
  'sourceStable',
  'restoredLedger',
  'cloneIdentity',
  'markerReadback',
] as const;

export interface CommunitiesStagingRoleSplitV3MarkerEvidence {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_EVIDENCE_VERSION;
  readonly status: 'MARKED';
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly restoreExecutionEvidenceSha256: string;
  readonly markerPayloadSha256: string;
  readonly markerValueSha256: string;
  readonly backupSha256: string;
  readonly sourceLedgerSha256: string;
  readonly sourceLedgerCount: string;
  readonly cloneDatabaseOid: string;
  readonly cloneBindingSha256: string;
  readonly sourceBindingSha256: string;
  readonly restoreRunId: string;
  readonly restoreRunAttempt: string;
  readonly restoreHelperSha256: string;
  readonly markerWriterSha256: string;
  readonly bindings: Record<(typeof bindingKeys)[number], true>;
  readonly authorizes: Record<(typeof authorityKeys)[number], false>;
}

export type CommunitiesStagingRoleSplitV3Observation = 'absent' | 'exact' | 'different' | 'unknown';
export interface CommunitiesStagingRoleSplitV3Observations {
  readonly clone: CommunitiesStagingRoleSplitV3Observation;
  readonly restoreExecutionEvidence: CommunitiesStagingRoleSplitV3Observation | 'not_checked';
  readonly marker: CommunitiesStagingRoleSplitV3Observation | 'not_checked';
  readonly markerEvidence: CommunitiesStagingRoleSplitV3Observation | 'not_checked';
}
export type CommunitiesStagingRoleSplitV3RecoveryAction =
  | 'CREATE_CLONE'
  | 'RESTORE_CLONE'
  | 'VERIFY_BINDINGS'
  | 'WRITE_MARKER'
  | 'ADVANCE_MARKED'
  | 'PUBLISH_EVIDENCE'
  | 'ADVANCE_EVIDENCED'
  | 'SUCCESS'
  | 'RETAIN_AND_FAIL';
export type CommunitiesStagingRoleSplitV3CleanupAction =
  'CLEAR_STATE_AND_RETRY' | 'DROP_EXACT_CLONE_AND_RETRY' | 'RETAIN_AND_FAIL';

const phases = [
  'CANDIDATE',
  'OWNED',
  'RESTORE_PENDING',
  'RESTORED',
  'VERIFIED',
  'MARKER_PENDING',
  'MARKED',
  'EVIDENCED',
] as const satisfies readonly CommunitiesStagingRoleSplitV3Phase[];
const sha256 = /^[a-f0-9]{64}$/;
const positiveDecimal = /^[1-9][0-9]*$/;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`V3_CONTRACT_${code}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function canonicalJson(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return fail('MARKER_EVIDENCE_BINDING_INVALID');
}

export function assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
  input: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
): void {
  if (!sha256.test(input.expectedRestoreExecutionEvidenceSha256))
    fail('RESTORE_EXECUTION_EVIDENCE_BINDING_INVALID');
  try {
    assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings(input);
  } catch {
    fail('RESTORE_EXECUTION_EVIDENCE_BINDING_INVALID');
  }
  if (
    communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(input.evidence) !==
    input.expectedRestoreExecutionEvidenceSha256
  )
    fail('RESTORE_EXECUTION_EVIDENCE_BINDING_INVALID');
  if (
    input.descriptor.identity.relation !== 'SAME' ||
    input.descriptor.identity.connectionLogin.name !== input.request.expectedCloneDatabaseOwner ||
    input.descriptor.identity.connectionLogin.oid !== input.request.expectedCloneDatabaseOwnerOid ||
    input.descriptor.identity.restoreRole.name !== input.request.expectedCloneDatabaseOwner ||
    input.descriptor.identity.restoreRole.oid !== input.request.expectedCloneDatabaseOwnerOid
  )
    fail('RESTORE_EXECUTION_EVIDENCE_BINDING_INVALID');
}

export function assertCommunitiesStagingRoleSplitV3State(
  state: CommunitiesStagingRoleSplitV3State,
): void {
  if (
    !hasExactKeys(state, [
      'schemaVersion',
      'requestSha256',
      'phase',
      'cloneDatabaseOid',
      'restoreExecutionEvidenceSha256',
      'markerPayloadSha256',
    ])
  )
    fail('STATE_SHAPE_INVALID');
  if (state.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION)
    fail('STATE_VERSION_INVALID');
  if (!sha256.test(state.requestSha256) || !phases.includes(state.phase))
    fail('STATE_BINDING_INVALID');
  if (state.phase === 'CANDIDATE') {
    if (
      state.cloneDatabaseOid !== null ||
      state.restoreExecutionEvidenceSha256 !== null ||
      state.markerPayloadSha256 !== null
    )
      fail('STATE_BINDING_INVALID');
    return;
  }
  if (
    state.cloneDatabaseOid === null ||
    !positiveDecimal.test(state.cloneDatabaseOid) ||
    state.restoreExecutionEvidenceSha256 === null ||
    !sha256.test(state.restoreExecutionEvidenceSha256)
  )
    fail('RESTORE_EXECUTION_EVIDENCE_REQUIRED');
  if (['OWNED', 'RESTORE_PENDING', 'RESTORED'].includes(state.phase)) {
    if (state.markerPayloadSha256 !== null) fail('STATE_BINDING_INVALID');
  } else if (state.markerPayloadSha256 === null || !sha256.test(state.markerPayloadSha256)) {
    fail('STATE_BINDING_INVALID');
  }
}

export function createCommunitiesStagingRoleSplitV3Candidate(
  requestSha256: string,
): CommunitiesStagingRoleSplitV3State {
  const state: CommunitiesStagingRoleSplitV3State = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
    requestSha256,
    phase: 'CANDIDATE',
    cloneDatabaseOid: null,
    restoreExecutionEvidenceSha256: null,
    markerPayloadSha256: null,
  };
  assertCommunitiesStagingRoleSplitV3State(state);
  return state;
}

export function advanceCommunitiesStagingRoleSplitV3State(
  current: CommunitiesStagingRoleSplitV3State,
  nextPhase: Exclude<CommunitiesStagingRoleSplitV3Phase, 'CANDIDATE'>,
  binding: {
    readonly cloneDatabaseOid: string;
    readonly restoreExecutionEvidenceSha256: string;
    readonly markerPayloadSha256?: string;
    readonly restoreExecutionEvidenceBinding?: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
  },
): CommunitiesStagingRoleSplitV3State {
  assertCommunitiesStagingRoleSplitV3State(current);
  if (phases.indexOf(nextPhase) !== phases.indexOf(current.phase) + 1)
    fail('STATE_TRANSITION_INVALID');
  if (current.phase === 'CANDIDATE') {
    if (binding.restoreExecutionEvidenceBinding === undefined)
      fail('RESTORE_EXECUTION_EVIDENCE_REQUIRED');
    assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
      binding.restoreExecutionEvidenceBinding,
    );
    if (
      binding.restoreExecutionEvidenceBinding.expectedRestoreExecutionEvidenceSha256 !==
        binding.restoreExecutionEvidenceSha256 ||
      binding.restoreExecutionEvidenceBinding.cloneDatabaseOid !== binding.cloneDatabaseOid ||
      binding.restoreExecutionEvidenceBinding.evidence.markerRequestSha256 !== current.requestSha256
    )
      fail('RESTORE_EXECUTION_EVIDENCE_BINDING_INVALID');
  }
  if (
    (current.cloneDatabaseOid !== null && current.cloneDatabaseOid !== binding.cloneDatabaseOid) ||
    (current.restoreExecutionEvidenceSha256 !== null &&
      current.restoreExecutionEvidenceSha256 !== binding.restoreExecutionEvidenceSha256) ||
    (current.markerPayloadSha256 !== null &&
      current.markerPayloadSha256 !== binding.markerPayloadSha256)
  )
    fail('STATE_BINDING_INVALID');
  const markerPayloadSha256 = ['VERIFIED', 'MARKER_PENDING', 'MARKED', 'EVIDENCED'].includes(
    nextPhase,
  )
    ? (binding.markerPayloadSha256 ?? null)
    : null;
  const next = {
    ...current,
    phase: nextPhase,
    cloneDatabaseOid: binding.cloneDatabaseOid,
    restoreExecutionEvidenceSha256: binding.restoreExecutionEvidenceSha256,
    markerPayloadSha256,
  } satisfies CommunitiesStagingRoleSplitV3State;
  assertCommunitiesStagingRoleSplitV3State(next);
  return next;
}

export function canonicalCommunitiesStagingRoleSplitV3State(
  state: CommunitiesStagingRoleSplitV3State,
): string {
  assertCommunitiesStagingRoleSplitV3State(state);
  return `${state.schemaVersion}\nrequestSha256=${state.requestSha256}\nphase=${state.phase}\ncloneDatabaseOid=${state.cloneDatabaseOid ?? ''}\nrestoreExecutionEvidenceSha256=${state.restoreExecutionEvidenceSha256 ?? ''}\nmarkerPayloadSha256=${state.markerPayloadSha256 ?? ''}\n`;
}
export function communitiesStagingRoleSplitV3StateSha256(
  state: CommunitiesStagingRoleSplitV3State,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3State(state), 'utf8')
    .digest('hex');
}

function assertObservations(observations: CommunitiesStagingRoleSplitV3Observations): void {
  const allowed = ['absent', 'exact', 'different', 'unknown', 'not_checked'];
  if (
    !allowed.includes(observations.clone) ||
    !allowed.includes(observations.restoreExecutionEvidence) ||
    !allowed.includes(observations.marker) ||
    !allowed.includes(observations.markerEvidence)
  )
    fail('OBSERVATION_INVALID');
}
export function recoverCommunitiesStagingRoleSplitV3(
  state: CommunitiesStagingRoleSplitV3State,
  observations: CommunitiesStagingRoleSplitV3Observations,
): CommunitiesStagingRoleSplitV3RecoveryAction {
  assertCommunitiesStagingRoleSplitV3State(state);
  assertObservations(observations);
  if (state.phase === 'CANDIDATE')
    return observations.clone === 'absent' ? 'CREATE_CLONE' : 'RETAIN_AND_FAIL';
  if (observations.clone !== 'exact' || observations.restoreExecutionEvidence !== 'exact')
    return 'RETAIN_AND_FAIL';
  if (state.phase === 'OWNED') return 'RESTORE_CLONE';
  if (state.phase === 'RESTORE_PENDING') return 'RETAIN_AND_FAIL';
  if (state.phase === 'RESTORED') return 'VERIFY_BINDINGS';
  if (state.phase === 'VERIFIED') return 'WRITE_MARKER';
  if (state.phase === 'MARKER_PENDING')
    return observations.marker === 'exact' ? 'ADVANCE_MARKED' : 'RETAIN_AND_FAIL';
  if (state.phase === 'MARKED') {
    if (observations.marker !== 'exact') return 'RETAIN_AND_FAIL';
    if (observations.markerEvidence === 'exact') return 'ADVANCE_EVIDENCED';
    return observations.markerEvidence === 'absent' ? 'PUBLISH_EVIDENCE' : 'RETAIN_AND_FAIL';
  }
  return observations.marker === 'exact' && observations.markerEvidence === 'exact'
    ? 'SUCCESS'
    : 'RETAIN_AND_FAIL';
}
export function cleanupCommunitiesStagingRoleSplitV3(
  state: CommunitiesStagingRoleSplitV3State,
  observations: Pick<
    CommunitiesStagingRoleSplitV3Observations,
    'clone' | 'restoreExecutionEvidence' | 'marker'
  >,
): CommunitiesStagingRoleSplitV3CleanupAction {
  assertCommunitiesStagingRoleSplitV3State(state);
  if (state.phase === 'CANDIDATE')
    return observations.clone === 'absent' ? 'CLEAR_STATE_AND_RETRY' : 'RETAIN_AND_FAIL';
  if (['RESTORE_PENDING', 'MARKED', 'EVIDENCED'].includes(state.phase)) return 'RETAIN_AND_FAIL';
  if (
    observations.clone !== 'exact' ||
    observations.restoreExecutionEvidence !== 'exact' ||
    observations.marker !== 'absent'
  )
    return 'RETAIN_AND_FAIL';
  return 'DROP_EXACT_CLONE_AND_RETRY';
}

const payloadKeys = [
  'requestSha256',
  'creationReceiptSha256',
  'restoreExecutionEvidenceSha256',
  'restoreDatabase',
  'cloneDatabaseOid',
  'cloneDatabaseOwner',
  'cloneDatabaseOwnerOid',
  'sourceDatabase',
  'sourceDatabaseOid',
  'sourceDatabaseOwner',
  'sourceDatabaseOwnerOid',
  'systemIdentifier',
  'backupSha256',
  'backupBytes',
  'backupEvidenceSha256',
  'archiveTocSha256',
  'sourceLedgerSha256',
  'sourceLedgerCount',
  'activeRelease',
  'restoreRunId',
  'restoreRunAttempt',
  'postgresMajor',
  'objectManifestSha256',
  'restoreHelperSha256',
  'markerWriterSha256',
] as const;
export function assertCommunitiesStagingRoleSplitV3MarkerPayload(
  input: CommunitiesStagingRoleSplitV3MarkerPayload,
): void {
  if (!hasExactKeys(input, payloadKeys)) fail('MARKER_PAYLOAD_SHAPE_INVALID');
  const { restoreExecutionEvidenceSha256, ...v2Payload } = input;
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerPayload(v2Payload);
  } catch {
    fail('MARKER_PAYLOAD_BINDING_INVALID');
  }
  if (!sha256.test(restoreExecutionEvidenceSha256)) fail('MARKER_PAYLOAD_BINDING_INVALID');
}
export function assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding(input: {
  readonly state: CommunitiesStagingRoleSplitV3State;
  readonly payload: CommunitiesStagingRoleSplitV3MarkerPayload;
  readonly restoreExecutionEvidenceBinding: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
}): void {
  assertCommunitiesStagingRoleSplitV3State(input.state);
  assertCommunitiesStagingRoleSplitV3MarkerPayload(input.payload);
  assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
    input.restoreExecutionEvidenceBinding,
  );
  const request = input.restoreExecutionEvidenceBinding.request;
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
  const descriptor = input.restoreExecutionEvidenceBinding.descriptor;
  const markerPayloadSha256 = communitiesStagingRoleSplitV3MarkerPayloadSha256(input.payload);
  if (
    ['CANDIDATE', 'OWNED', 'RESTORE_PENDING'].includes(input.state.phase) ||
    input.state.requestSha256 !== requestSha256 ||
    input.payload.requestSha256 !== requestSha256 ||
    input.state.requestSha256 !== input.payload.requestSha256 ||
    input.state.cloneDatabaseOid !== input.payload.cloneDatabaseOid ||
    input.state.restoreExecutionEvidenceSha256 !== input.payload.restoreExecutionEvidenceSha256 ||
    input.restoreExecutionEvidenceBinding.expectedRestoreExecutionEvidenceSha256 !==
      input.payload.restoreExecutionEvidenceSha256 ||
    input.restoreExecutionEvidenceBinding.creationReceiptSha256 !==
      input.payload.creationReceiptSha256 ||
    input.restoreExecutionEvidenceBinding.cloneDatabaseOid !== input.payload.cloneDatabaseOid ||
    input.restoreExecutionEvidenceBinding.systemIdentifier !== input.payload.systemIdentifier ||
    input.restoreExecutionEvidenceBinding.restoreRunId !== input.payload.restoreRunId ||
    input.restoreExecutionEvidenceBinding.restoreRunAttempt !== input.payload.restoreRunAttempt
  )
    fail('MARKER_PAYLOAD_BINDING_INVALID');
  if (input.state.phase !== 'RESTORED' && input.state.markerPayloadSha256 !== markerPayloadSha256)
    fail('MARKER_PAYLOAD_BINDING_INVALID');
  if (
    input.payload.restoreDatabase !== request.restoreDatabase ||
    input.payload.cloneDatabaseOwner !== request.expectedCloneDatabaseOwner ||
    input.payload.cloneDatabaseOwnerOid !== request.expectedCloneDatabaseOwnerOid ||
    input.payload.sourceDatabase !== request.sourceDatabase ||
    input.payload.sourceDatabaseOid !== request.sourceDatabaseOid ||
    input.payload.sourceDatabaseOwner !== request.sourceDatabaseOwner ||
    input.payload.sourceDatabaseOwnerOid !== request.sourceDatabaseOwnerOid ||
    input.payload.systemIdentifier !== request.systemIdentifier ||
    input.payload.backupSha256 !== request.backupSha256 ||
    input.payload.backupBytes !== request.backupBytes ||
    input.payload.backupEvidenceSha256 !== request.backupEvidenceSha256 ||
    input.payload.archiveTocSha256 !== request.archiveTocSha256 ||
    input.payload.sourceLedgerSha256 !== request.sourceLedgerSha256 ||
    input.payload.sourceLedgerCount !== request.sourceLedgerCount ||
    input.payload.activeRelease !== request.activeRelease ||
    input.payload.restoreRunId !== request.restoreRunId ||
    input.payload.restoreRunAttempt !== request.restoreRunAttempt ||
    input.payload.postgresMajor !== request.postgresMajor ||
    input.payload.objectManifestSha256 !== request.objectManifestSha256 ||
    input.payload.restoreHelperSha256 !== request.restoreHelperSha256 ||
    input.payload.markerWriterSha256 !== request.markerWriterSha256
  )
    fail('MARKER_PAYLOAD_BINDING_INVALID');
  if (
    descriptor.identity.relation !== 'SAME' ||
    descriptor.identity.connectionLogin.name !== request.expectedCloneDatabaseOwner ||
    descriptor.identity.connectionLogin.oid !== request.expectedCloneDatabaseOwnerOid ||
    descriptor.identity.restoreRole.name !== request.expectedCloneDatabaseOwner ||
    descriptor.identity.restoreRole.oid !== request.expectedCloneDatabaseOwnerOid
  )
    fail('MARKER_PAYLOAD_BINDING_INVALID');
}
export function canonicalCommunitiesStagingRoleSplitV3MarkerPayload(
  input: CommunitiesStagingRoleSplitV3MarkerPayload,
): string {
  assertCommunitiesStagingRoleSplitV3MarkerPayload(input);
  return `${COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_VERSION}\n${payloadKeys
    .map((key) => `${key}=${input[key]}`)
    .join('\n')}\n`;
}
export function communitiesStagingRoleSplitV3MarkerPayloadSha256(
  input: CommunitiesStagingRoleSplitV3MarkerPayload,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3MarkerPayload(input), 'utf8')
    .digest('hex');
}
export function communitiesStagingRoleSplitV3Marker(
  input: CommunitiesStagingRoleSplitV3MarkerPayload,
): string {
  return `${COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_PREFIX}${communitiesStagingRoleSplitV3MarkerPayloadSha256(input)}`;
}
export function assertCommunitiesStagingRoleSplitV3Marker(
  input: CommunitiesStagingRoleSplitV3MarkerPayload,
  marker: string,
): void {
  if (marker !== communitiesStagingRoleSplitV3Marker(input)) fail('MARKER_BINDING_INVALID');
}

const evidenceKeys = [
  'schemaVersion',
  'status',
  'requestSha256',
  'creationReceiptSha256',
  'restoreExecutionEvidenceSha256',
  'markerPayloadSha256',
  'markerValueSha256',
  'backupSha256',
  'sourceLedgerSha256',
  'sourceLedgerCount',
  'cloneDatabaseOid',
  'cloneBindingSha256',
  'sourceBindingSha256',
  'restoreRunId',
  'restoreRunAttempt',
  'restoreHelperSha256',
  'markerWriterSha256',
  'bindings',
  'authorizes',
] as const;
export function createCommunitiesStagingRoleSplitV3MarkerEvidence(
  payload: CommunitiesStagingRoleSplitV3MarkerPayload,
  marker: string,
): CommunitiesStagingRoleSplitV3MarkerEvidence {
  assertCommunitiesStagingRoleSplitV3Marker(payload, marker);
  const evidence: CommunitiesStagingRoleSplitV3MarkerEvidence = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_EVIDENCE_VERSION,
    status: 'MARKED',
    requestSha256: payload.requestSha256,
    creationReceiptSha256: payload.creationReceiptSha256,
    restoreExecutionEvidenceSha256: payload.restoreExecutionEvidenceSha256,
    markerPayloadSha256: communitiesStagingRoleSplitV3MarkerPayloadSha256(payload),
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
      restoreExecutionEvidence: true,
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
  };
  assertCommunitiesStagingRoleSplitV3MarkerEvidence(payload, marker, evidence);
  return evidence;
}
export function assertCommunitiesStagingRoleSplitV3MarkerEvidence(
  payload: CommunitiesStagingRoleSplitV3MarkerPayload,
  marker: string,
  evidence: CommunitiesStagingRoleSplitV3MarkerEvidence,
): void {
  if (
    !hasExactKeys(evidence, evidenceKeys) ||
    !hasExactKeys(evidence.bindings, bindingKeys) ||
    !hasExactKeys(evidence.authorizes, authorityKeys)
  )
    fail('MARKER_EVIDENCE_SHAPE_INVALID');
  if (
    evidence.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_EVIDENCE_VERSION ||
    evidence.status !== 'MARKED'
  )
    fail('MARKER_EVIDENCE_VERSION_INVALID');
  assertCommunitiesStagingRoleSplitV3Marker(payload, marker);
  const expected = createCommunitiesStagingRoleSplitV3MarkerEvidenceUnchecked(payload, marker);
  if (
    canonicalJson(evidence) !== canonicalJson(expected) ||
    bindingKeys.some((key) => evidence.bindings[key] !== true) ||
    authorityKeys.some((key) => evidence.authorizes[key] !== false)
  )
    fail('MARKER_EVIDENCE_BINDING_INVALID');
}
function createCommunitiesStagingRoleSplitV3MarkerEvidenceUnchecked(
  payload: CommunitiesStagingRoleSplitV3MarkerPayload,
  marker: string,
): CommunitiesStagingRoleSplitV3MarkerEvidence {
  const markerPayloadSha256 = communitiesStagingRoleSplitV3MarkerPayloadSha256(payload);
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_MARKER_EVIDENCE_VERSION,
    status: 'MARKED',
    requestSha256: payload.requestSha256,
    creationReceiptSha256: payload.creationReceiptSha256,
    restoreExecutionEvidenceSha256: payload.restoreExecutionEvidenceSha256,
    markerPayloadSha256,
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
      restoreExecutionEvidence: true,
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
  };
}
export function canonicalCommunitiesStagingRoleSplitV3MarkerEvidence(
  payload: CommunitiesStagingRoleSplitV3MarkerPayload,
  marker: string,
  evidence: CommunitiesStagingRoleSplitV3MarkerEvidence,
): string {
  assertCommunitiesStagingRoleSplitV3MarkerEvidence(payload, marker, evidence);
  return `${canonicalJson(evidence)}\n`;
}
export function communitiesStagingRoleSplitV3MarkerEvidenceSha256(
  payload: CommunitiesStagingRoleSplitV3MarkerPayload,
  marker: string,
  evidence: CommunitiesStagingRoleSplitV3MarkerEvidence,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3MarkerEvidence(payload, marker, evidence), 'utf8')
    .digest('hex');
}
