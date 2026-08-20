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
  assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
} from './communities-staging-role-split-v3-durable-restore-authorization.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_CLONE_CREATION_AUTHORIZATION_VERSION =
  'communities-staging-role-split-v3-clone-creation-authorization-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTION_AUTHORIZATION_VERSION =
  'communities-staging-role-split-v3-execution-authorization-v1';

const sha256 = /^[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const positiveDecimal = /^[1-9][0-9]*$/u;
const authorityKeys = [
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
const cloneComponentKeys = [
  'executableCompositionSha256',
  'stateStoreSha256',
  'cloneFactorySha256',
  'ddlFenceSha256',
] as const;
const executionComponentKeys = [
  'executableCompositionSha256',
  'stateStoreSha256',
  'archiveCustodySha256',
  'runnerAdapterSha256',
  'canonicalHostAdapterSha256',
  'cloneOnlyConnectionFactorySha256',
  'ddlFenceSha256',
  'markerWriterSha256',
  'ownershipAclAttestorSha256',
  'sourceWriteDenialAttestorSha256',
  'evidenceSinkSha256',
] as const;

type FalseAuthorities = {
  readonly [K in (typeof authorityKeys)[number]]: false;
};

export interface CommunitiesStagingRoleSplitV3CloneCreationAuthorization {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_CLONE_CREATION_AUTHORIZATION_VERSION;
  readonly status: 'CLONE_CREATION_AUTHORIZED';
  readonly candidateCommitSha: string;
  readonly markerRequestSha256: string;
  readonly components: {
    readonly executableCompositionSha256: string;
    readonly stateStoreSha256: string;
    readonly cloneFactorySha256: string;
    readonly ddlFenceSha256: string;
  };
  readonly authorizes: Omit<FalseAuthorities, 'statePersistence' | 'cloneCreation'> & {
    readonly statePersistence: true;
    readonly cloneCreation: true;
  };
}

export interface CommunitiesStagingRoleSplitV3ExecutionAuthorization {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTION_AUTHORIZATION_VERSION;
  readonly status: 'EXECUTION_AUTHORIZED';
  readonly candidateCommitSha: string;
  readonly markerRequestSha256: string;
  readonly creationReceiptSha256: string;
  readonly restoreExecutionEvidenceSha256: string;
  readonly cloneDatabaseOid: string;
  readonly systemIdentifier: string;
  readonly cloneCreationAuthorizationSha256: string;
  readonly hostAuthorizationSha256: string;
  readonly durableRestoreAuthorizationSha256: string;
  readonly components: {
    readonly executableCompositionSha256: string;
    readonly stateStoreSha256: string;
    readonly archiveCustodySha256: string;
    readonly runnerAdapterSha256: string;
    readonly canonicalHostAdapterSha256: string;
    readonly cloneOnlyConnectionFactorySha256: string;
    readonly ddlFenceSha256: string;
    readonly markerWriterSha256: string;
    readonly ownershipAclAttestorSha256: string;
    readonly sourceWriteDenialAttestorSha256: string;
    readonly evidenceSinkSha256: string;
  };
  readonly authorizes: Omit<
    FalseAuthorities,
    'statePersistence' | 'restoreExecution' | 'markerWrite' | 'evidencePublication'
  > & {
    readonly statePersistence: true;
    readonly restoreExecution: true;
    readonly markerWrite: true;
    readonly evidencePublication: true;
  };
}

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`V3_EXECUTION_AUTHORIZATION_${code}`);
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

function assertAuthorities(
  value: Record<(typeof authorityKeys)[number], boolean>,
  allowedTrue: readonly (typeof authorityKeys)[number][],
): void {
  if (
    !hasExactKeys(value, authorityKeys) ||
    authorityKeys.some((key) => value[key] !== allowedTrue.includes(key))
  )
    fail('AUTHORITY_INVALID');
}

export function assertCommunitiesStagingRoleSplitV3CloneCreationAuthorization(
  input: CommunitiesStagingRoleSplitV3CloneCreationAuthorization,
): void {
  if (
    !hasExactKeys(input, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'markerRequestSha256',
      'components',
      'authorizes',
    ]) ||
    input.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_V3_CLONE_CREATION_AUTHORIZATION_VERSION ||
    input.status !== 'CLONE_CREATION_AUTHORIZED' ||
    !commitSha.test(input.candidateCommitSha) ||
    !sha256.test(input.markerRequestSha256) ||
    !hasExactKeys(input.components, cloneComponentKeys) ||
    cloneComponentKeys.some((key) => !sha256.test(input.components[key]))
  )
    fail('CLONE_SHAPE_INVALID');
  assertAuthorities(input.authorizes, ['statePersistence', 'cloneCreation']);
}

export function assertCommunitiesStagingRoleSplitV3ExecutionAuthorization(
  input: CommunitiesStagingRoleSplitV3ExecutionAuthorization,
): void {
  if (
    !hasExactKeys(input, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'markerRequestSha256',
      'creationReceiptSha256',
      'restoreExecutionEvidenceSha256',
      'cloneDatabaseOid',
      'systemIdentifier',
      'cloneCreationAuthorizationSha256',
      'hostAuthorizationSha256',
      'durableRestoreAuthorizationSha256',
      'components',
      'authorizes',
    ]) ||
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTION_AUTHORIZATION_VERSION ||
    input.status !== 'EXECUTION_AUTHORIZED' ||
    !commitSha.test(input.candidateCommitSha) ||
    ![
      input.markerRequestSha256,
      input.creationReceiptSha256,
      input.restoreExecutionEvidenceSha256,
      input.cloneCreationAuthorizationSha256,
      input.hostAuthorizationSha256,
      input.durableRestoreAuthorizationSha256,
    ].every((value) => sha256.test(value)) ||
    !positiveDecimal.test(input.cloneDatabaseOid) ||
    !/^[0-9]{10,32}$/u.test(input.systemIdentifier) ||
    !hasExactKeys(input.components, executionComponentKeys) ||
    executionComponentKeys.some((key) => !sha256.test(input.components[key]))
  )
    fail('EXECUTION_SHAPE_INVALID');
  assertAuthorities(input.authorizes, [
    'statePersistence',
    'restoreExecution',
    'markerWrite',
    'evidencePublication',
  ]);
}

export function canonicalCommunitiesStagingRoleSplitV3CloneCreationAuthorization(
  input: CommunitiesStagingRoleSplitV3CloneCreationAuthorization,
): string {
  assertCommunitiesStagingRoleSplitV3CloneCreationAuthorization(input);
  return `${canonicalJson(input)}\n`;
}

export function canonicalCommunitiesStagingRoleSplitV3ExecutionAuthorization(
  input: CommunitiesStagingRoleSplitV3ExecutionAuthorization,
): string {
  assertCommunitiesStagingRoleSplitV3ExecutionAuthorization(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256(
  input: CommunitiesStagingRoleSplitV3CloneCreationAuthorization,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3CloneCreationAuthorization(input), 'utf8')
    .digest('hex');
}

export function communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
  input: CommunitiesStagingRoleSplitV3ExecutionAuthorization,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3ExecutionAuthorization(input), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitV3CloneCreationAuthorization(
  input: string,
): CommunitiesStagingRoleSplitV3CloneCreationAuthorization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('CLONE_PARSE_INVALID');
  }
  const authorization = parsed as CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
  assertCommunitiesStagingRoleSplitV3CloneCreationAuthorization(authorization);
  if (canonicalCommunitiesStagingRoleSplitV3CloneCreationAuthorization(authorization) !== input)
    fail('CLONE_CANONICAL_ENCODING_INVALID');
  return authorization;
}

export function parseCommunitiesStagingRoleSplitV3ExecutionAuthorization(
  input: string,
): CommunitiesStagingRoleSplitV3ExecutionAuthorization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('EXECUTION_PARSE_INVALID');
  }
  const authorization = parsed as CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  assertCommunitiesStagingRoleSplitV3ExecutionAuthorization(authorization);
  if (canonicalCommunitiesStagingRoleSplitV3ExecutionAuthorization(authorization) !== input)
    fail('EXECUTION_CANONICAL_ENCODING_INVALID');
  return authorization;
}

function hostBinding(
  authorization: CommunitiesStagingRoleSplitHostAuthorization,
  code:
    'OWNERSHIP_ACL_ATTESTATION' | 'SOURCE_WRITE_DENIAL_ATTESTATION' | 'INDEPENDENT_EVIDENCE_SINK',
): string {
  const binding = authorization.bindings.find((candidate) => candidate.code === code);
  if (binding === undefined) fail('BINDING_INVALID');
  return binding.subjectSha256;
}

export function assertCommunitiesStagingRoleSplitV3CloneCreationAuthorizationBinding(input: {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly expectedCandidateCommitSha: string;
  readonly expectedComponents: CommunitiesStagingRoleSplitV3CloneCreationAuthorization['components'];
  readonly authorization: CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
}): void {
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
    assertCommunitiesStagingRoleSplitV3CloneCreationAuthorization(input.authorization);
  } catch {
    fail('BINDING_INVALID');
  }
  if (
    input.authorization.candidateCommitSha !== input.expectedCandidateCommitSha ||
    input.authorization.markerRequestSha256 !==
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request) ||
    canonicalJson(input.authorization.components) !== canonicalJson(input.expectedComponents)
  )
    fail('BINDING_INVALID');
}

export function assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding(input: {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly cloneCreationAuthorization: CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly durableRestoreAuthorization: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;
  readonly authorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
}): void {
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
    assertCommunitiesStagingRoleSplitV3CloneCreationAuthorization(input.cloneCreationAuthorization);
    assertCommunitiesStagingRoleSplitHostAuthorization(input.hostAuthorization);
    assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(
      input.durableRestoreAuthorization,
    );
    assertCommunitiesStagingRoleSplitV3ExecutionAuthorization(input.authorization);
  } catch {
    fail('BINDING_INVALID');
  }
  const authorization = input.authorization;
  const clone = input.cloneCreationAuthorization;
  const host = input.hostAuthorization;
  const durable = input.durableRestoreAuthorization;
  if (
    authorization.markerRequestSha256 !==
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request) ||
    authorization.cloneCreationAuthorizationSha256 !==
      communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256(clone) ||
    authorization.hostAuthorizationSha256 !==
      communitiesStagingRoleSplitHostAuthorizationSha256(host) ||
    authorization.durableRestoreAuthorizationSha256 !==
      communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(durable) ||
    authorization.candidateCommitSha !== host.candidateCommitSha ||
    authorization.candidateCommitSha !== durable.candidateCommitSha ||
    authorization.candidateCommitSha !== clone.candidateCommitSha ||
    authorization.markerRequestSha256 !== clone.markerRequestSha256 ||
    authorization.creationReceiptSha256 !== host.creationReceiptSha256 ||
    authorization.creationReceiptSha256 !== durable.creationReceiptSha256 ||
    authorization.restoreExecutionEvidenceSha256 !== durable.restoreExecutionEvidenceSha256 ||
    authorization.cloneDatabaseOid !== host.execution.cloneDatabaseOid ||
    authorization.cloneDatabaseOid !== durable.cloneDatabaseOid ||
    authorization.systemIdentifier !== input.request.systemIdentifier ||
    authorization.systemIdentifier !== durable.systemIdentifier ||
    authorization.components.executableCompositionSha256 !== durable.components.durableHostSha256 ||
    authorization.components.executableCompositionSha256 !==
      clone.components.executableCompositionSha256 ||
    authorization.components.stateStoreSha256 !== durable.components.stateStoreSha256 ||
    authorization.components.stateStoreSha256 !== clone.components.stateStoreSha256 ||
    authorization.components.archiveCustodySha256 !== durable.components.archiveCustodySha256 ||
    authorization.components.canonicalHostAdapterSha256 !==
      host.execution.canonicalHostAdapterSha256 ||
    authorization.components.cloneOnlyConnectionFactorySha256 !==
      host.execution.cloneOnlyConnectionFactorySha256 ||
    authorization.components.ddlFenceSha256 !== host.execution.ddlFenceSha256 ||
    authorization.components.ddlFenceSha256 !== clone.components.ddlFenceSha256 ||
    authorization.components.markerWriterSha256 !== input.request.markerWriterSha256 ||
    authorization.components.ownershipAclAttestorSha256 !==
      hostBinding(host, 'OWNERSHIP_ACL_ATTESTATION') ||
    authorization.components.sourceWriteDenialAttestorSha256 !==
      hostBinding(host, 'SOURCE_WRITE_DENIAL_ATTESTATION') ||
    authorization.components.evidenceSinkSha256 !== hostBinding(host, 'INDEPENDENT_EVIDENCE_SINK')
  )
    fail('BINDING_INVALID');
}
