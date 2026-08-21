import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitV3Marker,
  assertCommunitiesStagingRoleSplitV3MarkerEvidence,
  assertCommunitiesStagingRoleSplitV3MarkerPayload,
  assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding,
  assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  assertCommunitiesStagingRoleSplitV3State,
  canonicalCommunitiesStagingRoleSplitV3MarkerEvidence,
  communitiesStagingRoleSplitV3MarkerPayloadSha256,
  type CommunitiesStagingRoleSplitV3MarkerEvidence,
  type CommunitiesStagingRoleSplitV3MarkerPayload,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  type CommunitiesStagingRoleSplitV3State,
} from './communities-staging-role-split-v3-contract.js';
import { communitiesStagingRoleSplitRestoreMarkerRequestSha256 } from './communities-staging-role-split-restore-marker.js';
import {
  assertCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
} from './communities-staging-role-split-v3-durable-state-envelope.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_VERSION =
  'communities-staging-role-split-v3-durable-continuation-envelope-v2';

export type CommunitiesStagingRoleSplitV3DurableContinuationPhase =
  'VERIFIED' | 'MARKER_PENDING' | 'MARKED' | 'EVIDENCED';

export interface CommunitiesStagingRoleSplitV3DurableContinuationEnvelope {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_VERSION;
  readonly phase: CommunitiesStagingRoleSplitV3DurableContinuationPhase;
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly restoreExecutionEvidenceSha256: string;
  readonly cloneDatabaseOid: string;
  readonly restoredEnvelopeSha256: string;
  readonly previousEnvelopeSha256: string;
  readonly state: CommunitiesStagingRoleSplitV3State;
  readonly artifacts: {
    readonly payload: CommunitiesStagingRoleSplitV3MarkerPayload;
    readonly marker: string;
    readonly markerEvidence: CommunitiesStagingRoleSplitV3MarkerEvidence | null;
    readonly attestedEvidenceSha256: string | null;
  };
}

const sha256 = /^[a-f0-9]{64}$/u;
const positiveDecimal = /^[1-9][0-9]*$/u;
const phases = ['VERIFIED', 'MARKER_PENDING', 'MARKED', 'EVIDENCED'] as const;
const envelopeKeys = [
  'schemaVersion',
  'phase',
  'requestSha256',
  'creationReceiptSha256',
  'restoreExecutionEvidenceSha256',
  'cloneDatabaseOid',
  'restoredEnvelopeSha256',
  'previousEnvelopeSha256',
  'state',
  'artifacts',
] as const;
const artifactKeys = ['payload', 'marker', 'markerEvidence', 'attestedEvidenceSha256'] as const;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`V3_DURABLE_CONTINUATION_ENVELOPE_${code}`);
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
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return fail('VALUE_INVALID');
}

function assertArtifacts(
  phase: CommunitiesStagingRoleSplitV3DurableContinuationPhase,
  artifacts: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope['artifacts'],
): void {
  if (!hasExactKeys(artifacts, artifactKeys) || typeof artifacts.marker !== 'string')
    fail('ARTIFACTS_SHAPE_INVALID');
  try {
    assertCommunitiesStagingRoleSplitV3MarkerPayload(artifacts.payload);
    assertCommunitiesStagingRoleSplitV3Marker(artifacts.payload, artifacts.marker);
  } catch {
    fail('ARTIFACTS_BINDING_INVALID');
  }
  if (['VERIFIED', 'MARKER_PENDING'].includes(phase)) {
    if (artifacts.markerEvidence !== null || artifacts.attestedEvidenceSha256 !== null)
      fail('ARTIFACTS_PHASE_INVALID');
    return;
  }
  if (artifacts.markerEvidence === null) fail('ARTIFACTS_PHASE_INVALID');
  try {
    assertCommunitiesStagingRoleSplitV3MarkerEvidence(
      artifacts.payload,
      artifacts.marker,
      artifacts.markerEvidence,
    );
  } catch {
    fail('ARTIFACTS_BINDING_INVALID');
  }
  if (phase === 'MARKED') {
    if (artifacts.attestedEvidenceSha256 !== null) fail('ARTIFACTS_PHASE_INVALID');
    return;
  }
  if (artifacts.attestedEvidenceSha256 === null || !sha256.test(artifacts.attestedEvidenceSha256))
    fail('ARTIFACTS_PHASE_INVALID');
}

export function assertCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(
  input: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
): void {
  if (
    !hasExactKeys(input, envelopeKeys) ||
    input.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_CONTINUATION_ENVELOPE_VERSION ||
    !phases.includes(input.phase) ||
    ![
      input.requestSha256,
      input.creationReceiptSha256,
      input.restoreExecutionEvidenceSha256,
      input.restoredEnvelopeSha256,
      input.previousEnvelopeSha256,
    ].every((value) => sha256.test(value)) ||
    !positiveDecimal.test(input.cloneDatabaseOid)
  )
    fail('SHAPE_INVALID');
  try {
    assertCommunitiesStagingRoleSplitV3State(input.state);
  } catch {
    fail('STATE_INVALID');
  }
  if (
    input.state.phase !== input.phase ||
    input.state.requestSha256 !== input.requestSha256 ||
    input.state.cloneDatabaseOid !== input.cloneDatabaseOid ||
    input.state.restoreExecutionEvidenceSha256 !== input.restoreExecutionEvidenceSha256
  )
    fail('STATE_BINDING_INVALID');
  assertArtifacts(input.phase, input.artifacts);
  if (
    input.state.markerPayloadSha256 !==
      communitiesStagingRoleSplitV3MarkerPayloadSha256(input.artifacts.payload) ||
    input.artifacts.payload.requestSha256 !== input.requestSha256 ||
    input.artifacts.payload.creationReceiptSha256 !== input.creationReceiptSha256 ||
    input.artifacts.payload.restoreExecutionEvidenceSha256 !==
      input.restoreExecutionEvidenceSha256 ||
    input.artifacts.payload.cloneDatabaseOid !== input.cloneDatabaseOid
  )
    fail('ARTIFACTS_BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(
  input: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
): string {
  assertCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(
  input: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(input), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(
  input: string,
): CommunitiesStagingRoleSplitV3DurableContinuationEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('PARSE_INVALID');
  }
  const envelope = parsed as CommunitiesStagingRoleSplitV3DurableContinuationEnvelope;
  assertCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(envelope);
  if (canonicalCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(envelope) !== input)
    fail('CANONICAL_ENCODING_INVALID');
  return envelope;
}

export function assertCommunitiesStagingRoleSplitV3DurableContinuationChain(input: {
  readonly restoredEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly restoreExecutionEvidenceBinding: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
  readonly verified: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope;
  readonly markerPending: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope;
  readonly marked: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope;
  readonly evidenced: CommunitiesStagingRoleSplitV3DurableContinuationEnvelope;
}): void {
  try {
    assertCommunitiesStagingRoleSplitV3DurableStateEnvelope(input.restoredEnvelope);
    assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
      input.restoreExecutionEvidenceBinding,
    );
    assertCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(input.verified);
    assertCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(input.markerPending);
    assertCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(input.marked);
    assertCommunitiesStagingRoleSplitV3DurableContinuationEnvelope(input.evidenced);
  } catch {
    fail('CHAIN_INVALID');
  }
  if (input.restoredEnvelope.phase !== 'RESTORED') fail('CHAIN_INVALID');
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(
    input.restoreExecutionEvidenceBinding.request,
  );
  if (
    input.restoredEnvelope.requestSha256 !== requestSha256 ||
    input.restoredEnvelope.creationReceiptSha256 !==
      input.restoreExecutionEvidenceBinding.creationReceiptSha256 ||
    input.restoredEnvelope.restoreExecutionEvidenceSha256 !==
      input.restoreExecutionEvidenceBinding.expectedRestoreExecutionEvidenceSha256 ||
    input.restoredEnvelope.cloneDatabaseOid !==
      input.restoreExecutionEvidenceBinding.cloneDatabaseOid ||
    input.restoreExecutionEvidenceBinding.systemIdentifier !==
      input.restoreExecutionEvidenceBinding.request.systemIdentifier
  )
    fail('CHAIN_INVALID');
  const restoredEnvelopeSha256 = communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(
    input.restoredEnvelope,
  );
  const chain = [input.verified, input.markerPending, input.marked, input.evidenced] as const;
  const expectedPhases = ['VERIFIED', 'MARKER_PENDING', 'MARKED', 'EVIDENCED'] as const;
  const immutable = input.verified;
  for (const [index, envelope] of chain.entries()) {
    try {
      assertCommunitiesStagingRoleSplitV3MarkerPayloadBinding({
        state: envelope.state,
        payload: envelope.artifacts.payload,
        restoreExecutionEvidenceBinding: input.restoreExecutionEvidenceBinding,
      });
    } catch {
      fail('CHAIN_INVALID');
    }
    if (
      envelope.phase !== expectedPhases[index] ||
      envelope.requestSha256 !== input.restoredEnvelope.requestSha256 ||
      envelope.creationReceiptSha256 !== input.restoredEnvelope.creationReceiptSha256 ||
      envelope.restoreExecutionEvidenceSha256 !==
        input.restoredEnvelope.restoreExecutionEvidenceSha256 ||
      envelope.cloneDatabaseOid !== input.restoredEnvelope.cloneDatabaseOid ||
      envelope.restoredEnvelopeSha256 !== restoredEnvelopeSha256 ||
      envelope.requestSha256 !== immutable.requestSha256 ||
      envelope.creationReceiptSha256 !== immutable.creationReceiptSha256 ||
      envelope.restoreExecutionEvidenceSha256 !== immutable.restoreExecutionEvidenceSha256 ||
      envelope.cloneDatabaseOid !== immutable.cloneDatabaseOid ||
      canonicalJson(envelope.artifacts.payload) !== canonicalJson(immutable.artifacts.payload) ||
      envelope.artifacts.marker !== immutable.artifacts.marker
    )
      fail('CHAIN_INVALID');
    const precedingEnvelope = index === 0 ? undefined : chain[index - 1];
    if (index !== 0 && precedingEnvelope === undefined) fail('CHAIN_INVALID');
    const previous =
      precedingEnvelope === undefined
        ? restoredEnvelopeSha256
        : communitiesStagingRoleSplitV3DurableContinuationEnvelopeSha256(precedingEnvelope);
    if (envelope.previousEnvelopeSha256 !== previous) fail('CHAIN_INVALID');
  }
  if (
    input.marked.artifacts.markerEvidence === null ||
    input.evidenced.artifacts.markerEvidence === null ||
    canonicalCommunitiesStagingRoleSplitV3MarkerEvidence(
      input.marked.artifacts.payload,
      input.marked.artifacts.marker,
      input.marked.artifacts.markerEvidence,
    ) !==
      canonicalCommunitiesStagingRoleSplitV3MarkerEvidence(
        input.evidenced.artifacts.payload,
        input.evidenced.artifacts.marker,
        input.evidenced.artifacts.markerEvidence,
      )
  )
    fail('CHAIN_INVALID');
  if (input.evidenced.artifacts.attestedEvidenceSha256 === null) fail('CHAIN_INVALID');
}
