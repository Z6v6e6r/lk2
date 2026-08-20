import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitV3State,
  type CommunitiesStagingRoleSplitV3State,
} from './communities-staging-role-split-v3-contract.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION =
  'communities-staging-role-split-v3-durable-state-envelope-v1';

export type CommunitiesStagingRoleSplitV3DurableStatePhase =
  'OWNED' | 'RESTORE_PENDING' | 'RESTORED';

export interface CommunitiesStagingRoleSplitV3DurableStateEnvelope {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION;
  readonly phase: CommunitiesStagingRoleSplitV3DurableStatePhase;
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly restoreExecutionEvidenceSha256: string;
  readonly cloneDatabaseOid: string;
  readonly state: CommunitiesStagingRoleSplitV3State;
}

const sha256 = /^[a-f0-9]{64}$/u;
const positiveDecimal = /^[1-9][0-9]*$/u;
const phases = ['OWNED', 'RESTORE_PENDING', 'RESTORED'] as const;
const envelopeKeys = [
  'schemaVersion',
  'phase',
  'requestSha256',
  'creationReceiptSha256',
  'restoreExecutionEvidenceSha256',
  'cloneDatabaseOid',
  'state',
] as const;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`V3_DURABLE_STATE_ENVELOPE_${code}`);
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

export function assertCommunitiesStagingRoleSplitV3DurableStateEnvelope(
  input: CommunitiesStagingRoleSplitV3DurableStateEnvelope,
): void {
  if (
    !hasExactKeys(input, envelopeKeys) ||
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION ||
    !phases.includes(input.phase) ||
    ![input.requestSha256, input.creationReceiptSha256, input.restoreExecutionEvidenceSha256].every(
      (value) => sha256.test(value),
    ) ||
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
    input.state.restoreExecutionEvidenceSha256 !== input.restoreExecutionEvidenceSha256 ||
    input.state.markerPayloadSha256 !== null
  )
    fail('STATE_BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(
  input: CommunitiesStagingRoleSplitV3DurableStateEnvelope,
): string {
  assertCommunitiesStagingRoleSplitV3DurableStateEnvelope(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(
  input: CommunitiesStagingRoleSplitV3DurableStateEnvelope,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(input), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitV3DurableStateEnvelope(
  input: string,
): CommunitiesStagingRoleSplitV3DurableStateEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('PARSE_INVALID');
  }
  const envelope = parsed as CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  assertCommunitiesStagingRoleSplitV3DurableStateEnvelope(envelope);
  if (canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(envelope) !== input)
    fail('CANONICAL_ENCODING_INVALID');
  return envelope;
}
