import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitHostAuthorization,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
} from './communities-staging-role-split-host-authorization.js';
import {
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from './communities-staging-role-split-restore-marker.js';
import {
  assertCommunitiesStagingRoleSplitV3PreparationEnvelope,
  communitiesStagingRoleSplitV3PreparationEnvelopeSha256,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
} from './communities-staging-role-split-v3-envelope.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION =
  'communities-staging-role-split-v3-restore-authorization-v1';

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

export interface CommunitiesStagingRoleSplitV3RestoreAuthorization {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION;
  readonly status: 'RESTORE_EXECUTION_AUTHORIZED';
  readonly candidateCommitSha: string;
  readonly markerRequestSha256: string;
  readonly creationReceiptSha256: string;
  readonly preparationEnvelopeSha256: string;
  readonly restoreExecutionEvidenceSha256: string;
  readonly hostAuthorizationSha256: string;
  readonly cloneDatabaseOid: string;
  readonly systemIdentifier: string;
  readonly authorizes: {
    readonly statePersistence: false;
    readonly cloneCreation: false;
    readonly restoreExecution: true;
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
  };
}

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`V3_RESTORE_AUTHORIZATION_${code}`);
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

const sha256 = /^[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const positiveDecimal = /^[1-9][0-9]*$/u;

export function assertCommunitiesStagingRoleSplitV3RestoreAuthorization(
  input: CommunitiesStagingRoleSplitV3RestoreAuthorization,
): void {
  if (
    !hasExactKeys(input, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'markerRequestSha256',
      'creationReceiptSha256',
      'preparationEnvelopeSha256',
      'restoreExecutionEvidenceSha256',
      'hostAuthorizationSha256',
      'cloneDatabaseOid',
      'systemIdentifier',
      'authorizes',
    ]) ||
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_RESTORE_AUTHORIZATION_VERSION ||
    input.status !== 'RESTORE_EXECUTION_AUTHORIZED' ||
    !commitSha.test(input.candidateCommitSha) ||
    ![
      input.markerRequestSha256,
      input.creationReceiptSha256,
      input.preparationEnvelopeSha256,
      input.restoreExecutionEvidenceSha256,
      input.hostAuthorizationSha256,
    ].every((value) => sha256.test(value)) ||
    !positiveDecimal.test(input.cloneDatabaseOid) ||
    !/^[0-9]{10,32}$/u.test(input.systemIdentifier) ||
    !hasExactKeys(input.authorizes, authorizationKeys) ||
    authorizationKeys.some((key) =>
      key === 'restoreExecution' ? input.authorizes[key] !== true : input.authorizes[key] !== false,
    )
  )
    fail('SHAPE_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitV3RestoreAuthorization(
  input: CommunitiesStagingRoleSplitV3RestoreAuthorization,
): string {
  assertCommunitiesStagingRoleSplitV3RestoreAuthorization(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitV3RestoreAuthorizationSha256(
  input: CommunitiesStagingRoleSplitV3RestoreAuthorization,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3RestoreAuthorization(input), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitV3RestoreAuthorization(
  input: string,
): CommunitiesStagingRoleSplitV3RestoreAuthorization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('PARSE_INVALID');
  }
  const authorization = parsed as CommunitiesStagingRoleSplitV3RestoreAuthorization;
  assertCommunitiesStagingRoleSplitV3RestoreAuthorization(authorization);
  if (canonicalCommunitiesStagingRoleSplitV3RestoreAuthorization(authorization) !== input)
    fail('CANONICAL_ENCODING_INVALID');
  return authorization;
}

export function assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding(input: {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly preparationEnvelope: CommunitiesStagingRoleSplitV3PreparationEnvelope;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly restoreAuthorization: CommunitiesStagingRoleSplitV3RestoreAuthorization;
}): void {
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
    assertCommunitiesStagingRoleSplitV3PreparationEnvelope(input.preparationEnvelope);
    assertCommunitiesStagingRoleSplitHostAuthorization(input.hostAuthorization);
    assertCommunitiesStagingRoleSplitV3RestoreAuthorization(input.restoreAuthorization);
  } catch {
    fail('BINDING_INVALID');
  }
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request);
  const envelope = input.preparationEnvelope;
  const binding = envelope.restoreExecutionEvidenceBinding;
  const authorization = input.restoreAuthorization;
  if (
    envelope.state.phase !== 'RESTORE_PENDING' ||
    binding === undefined ||
    authorization.markerRequestSha256 !== requestSha256 ||
    envelope.requestSha256 !== requestSha256 ||
    input.hostAuthorization.markerRequestSha256 !== requestSha256 ||
    authorization.creationReceiptSha256 !== envelope.creationReceiptSha256 ||
    authorization.creationReceiptSha256 !== input.hostAuthorization.creationReceiptSha256 ||
    authorization.preparationEnvelopeSha256 !==
      communitiesStagingRoleSplitV3PreparationEnvelopeSha256(envelope) ||
    authorization.restoreExecutionEvidenceSha256 !==
      envelope.state.restoreExecutionEvidenceSha256 ||
    authorization.restoreExecutionEvidenceSha256 !==
      binding.expectedRestoreExecutionEvidenceSha256 ||
    authorization.hostAuthorizationSha256 !==
      communitiesStagingRoleSplitHostAuthorizationSha256(input.hostAuthorization) ||
    authorization.candidateCommitSha !== input.hostAuthorization.candidateCommitSha ||
    authorization.cloneDatabaseOid !== envelope.state.cloneDatabaseOid ||
    authorization.cloneDatabaseOid !== input.hostAuthorization.execution.cloneDatabaseOid ||
    input.hostAuthorization.execution.connection.host !== binding.descriptor.connection.host ||
    input.hostAuthorization.execution.connection.port !== binding.descriptor.connection.port ||
    input.hostAuthorization.execution.connection.sslMode !==
      binding.descriptor.connection.sslMode ||
    input.hostAuthorization.execution.restoreLogin.name !==
      binding.descriptor.identity.restoreRole.name ||
    input.hostAuthorization.execution.restoreLogin.oid !==
      binding.descriptor.identity.restoreRole.oid ||
    input.hostAuthorization.execution.pgRestoreSha256 !== binding.descriptor.pgRestoreSha256 ||
    authorization.systemIdentifier !== input.request.systemIdentifier ||
    authorization.systemIdentifier !== binding.systemIdentifier ||
    input.hostAuthorization.authorizes.restoreExecution !== true
  )
    fail('BINDING_INVALID');
}
