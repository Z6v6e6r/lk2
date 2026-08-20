import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  assertCommunitiesStagingRoleSplitV3State,
  type CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding,
  type CommunitiesStagingRoleSplitV3State,
} from './communities-staging-role-split-v3-contract.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION =
  'communities-staging-role-split-v3-preparation-envelope-v1';

const sha256 = /^[a-f0-9]{64}$/;
const authorizationKeys = [
  'statePersistence',
  'cloneCreation',
  'restoreExecution',
  'markerWrite',
  'evidencePublication',
  'automaticCleanup',
  'roleCreation',
  'roleSplit',
  'sharedDatabaseMutation',
  'migration',
  'deploy',
  'import',
  'activation',
] as const;
const allowedPhases: readonly string[] = ['CANDIDATE', 'OWNED', 'RESTORE_PENDING'];
const executionEvidenceBindingKeys = [
  'request',
  'attestation',
  'descriptor',
  'evidence',
  'connectAclObservation',
  'membershipObservation',
  'creationReceiptSha256',
  'cloneDatabaseOid',
  'systemIdentifier',
  'restoreRunId',
  'restoreRunAttempt',
  'expectedRestoreExecutionEvidenceSha256',
] as const;

export interface CommunitiesStagingRoleSplitV3PreparationAuthorizations {
  readonly statePersistence: false;
  readonly cloneCreation: false;
  readonly restoreExecution: false;
  readonly markerWrite: false;
  readonly evidencePublication: false;
  readonly automaticCleanup: false;
  readonly roleCreation: false;
  readonly roleSplit: false;
  readonly sharedDatabaseMutation: false;
  readonly migration: false;
  readonly deploy: false;
  readonly import: false;
  readonly activation: false;
}

export interface CommunitiesStagingRoleSplitV3PreparationEnvelope {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION;
  readonly status: 'CODE_ONLY_DISABLED';
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly state: CommunitiesStagingRoleSplitV3State;
  readonly restoreExecutionEvidenceBinding?: CommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding;
  readonly authorizes: CommunitiesStagingRoleSplitV3PreparationAuthorizations;
}

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`V3_PREPARATION_ENVELOPE_${code}`);
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

function assertAuthorizations(value: CommunitiesStagingRoleSplitV3PreparationAuthorizations): void {
  if (
    !hasExactKeys(value, authorizationKeys) ||
    authorizationKeys.some((key) => value[key] !== false)
  )
    fail('AUTHORIZATIONS_INVALID');
}

export function assertCommunitiesStagingRoleSplitV3PreparationEnvelope(
  input: CommunitiesStagingRoleSplitV3PreparationEnvelope,
): void {
  if (!isRecord(input)) fail('SHAPE_INVALID');
  const expectedKeys =
    input.restoreExecutionEvidenceBinding === undefined
      ? ['schemaVersion', 'status', 'requestSha256', 'creationReceiptSha256', 'state', 'authorizes']
      : [
          'schemaVersion',
          'status',
          'requestSha256',
          'creationReceiptSha256',
          'state',
          'restoreExecutionEvidenceBinding',
          'authorizes',
        ];
  if (!hasExactKeys(input, expectedKeys)) fail('SHAPE_INVALID');
  if (
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_PREPARATION_ENVELOPE_VERSION ||
    input.status !== 'CODE_ONLY_DISABLED' ||
    !sha256.test(input.requestSha256) ||
    !sha256.test(input.creationReceiptSha256)
  )
    fail('HEADER_INVALID');
  try {
    assertCommunitiesStagingRoleSplitV3State(input.state);
  } catch {
    fail('STATE_INVALID');
  }
  if (!allowedPhases.includes(input.state.phase)) fail('PHASE_UNSUPPORTED');
  assertAuthorizations(input.authorizes);
  if (input.state.requestSha256 !== input.requestSha256) fail('REQUEST_BINDING_INVALID');

  if (input.state.phase === 'CANDIDATE') {
    if (input.restoreExecutionEvidenceBinding !== undefined) fail('CANDIDATE_BINDING_INVALID');
    return;
  }
  if (input.restoreExecutionEvidenceBinding === undefined) fail('EXECUTION_EVIDENCE_REQUIRED');
  if (!hasExactKeys(input.restoreExecutionEvidenceBinding, executionEvidenceBindingKeys))
    fail('EXECUTION_EVIDENCE_SHAPE_INVALID');
  try {
    assertCommunitiesStagingRoleSplitV3RestoreExecutionEvidenceBinding(
      input.restoreExecutionEvidenceBinding,
    );
  } catch {
    fail('EXECUTION_EVIDENCE_INVALID');
  }
  const binding = input.restoreExecutionEvidenceBinding;
  if (
    binding.evidence.markerRequestSha256 !== input.requestSha256 ||
    binding.creationReceiptSha256 !== input.creationReceiptSha256 ||
    binding.cloneDatabaseOid !== input.state.cloneDatabaseOid ||
    binding.expectedRestoreExecutionEvidenceSha256 !== input.state.restoreExecutionEvidenceSha256
  )
    fail('EXECUTION_EVIDENCE_BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(
  input: CommunitiesStagingRoleSplitV3PreparationEnvelope,
): string {
  assertCommunitiesStagingRoleSplitV3PreparationEnvelope(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitV3PreparationEnvelopeSha256(
  input: CommunitiesStagingRoleSplitV3PreparationEnvelope,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(input), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitV3PreparationEnvelope(
  input: string,
): CommunitiesStagingRoleSplitV3PreparationEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('PARSE_INVALID');
  }
  const envelope = parsed as CommunitiesStagingRoleSplitV3PreparationEnvelope;
  assertCommunitiesStagingRoleSplitV3PreparationEnvelope(envelope);
  if (canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(envelope) !== input)
    fail('CANONICAL_ENCODING_INVALID');
  return envelope;
}
