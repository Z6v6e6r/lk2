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
  assertCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
} from './communities-staging-role-split-v3-durable-state-envelope.js';
import {
  assertCommunitiesStagingRoleSplitV3RestoreAuthorization,
  assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding,
  communitiesStagingRoleSplitV3RestoreAuthorizationSha256,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
} from './communities-staging-role-split-v3-restore-authorization.js';
import {
  assertCommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
} from './communities-staging-role-split-v3-envelope.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION =
  'communities-staging-role-split-v3-durable-restore-authorization-v1';

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
const componentKeys = ['durableHostSha256', 'stateStoreSha256', 'archiveCustodySha256'] as const;
const authorizationKeys = [
  'schemaVersion',
  'status',
  'candidateCommitSha',
  'markerRequestSha256',
  'creationReceiptSha256',
  'restoreExecutionEvidenceSha256',
  'cloneDatabaseOid',
  'systemIdentifier',
  'v3RestoreAuthorizationSha256',
  'hostAuthorizationSha256',
  'ownedEnvelopeSha256',
  'restorePendingEnvelopeSha256',
  'restoredEnvelopeSha256',
  'components',
  'authorizes',
] as const;
const sha256 = /^[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const positiveDecimal = /^[1-9][0-9]*$/u;

export interface CommunitiesStagingRoleSplitV3DurableRestoreAuthorization {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION;
  readonly status: 'DURABLE_RESTORE_AUTHORIZED';
  readonly candidateCommitSha: string;
  readonly markerRequestSha256: string;
  readonly creationReceiptSha256: string;
  readonly restoreExecutionEvidenceSha256: string;
  readonly cloneDatabaseOid: string;
  readonly systemIdentifier: string;
  readonly v3RestoreAuthorizationSha256: string;
  readonly hostAuthorizationSha256: string;
  readonly ownedEnvelopeSha256: string;
  readonly restorePendingEnvelopeSha256: string;
  readonly restoredEnvelopeSha256: string;
  readonly components: {
    readonly durableHostSha256: string;
    readonly stateStoreSha256: string;
    readonly archiveCustodySha256: string;
  };
  readonly authorizes: {
    readonly statePersistence: true;
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
  return failCommunitiesStagingRoleSplit(`V3_DURABLE_RESTORE_AUTHORIZATION_${code}`);
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

export function assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(
  input: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
): void {
  if (
    !hasExactKeys(input, authorizationKeys) ||
    input.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_AUTHORIZATION_VERSION ||
    input.status !== 'DURABLE_RESTORE_AUTHORIZED' ||
    !commitSha.test(input.candidateCommitSha) ||
    ![
      input.markerRequestSha256,
      input.creationReceiptSha256,
      input.restoreExecutionEvidenceSha256,
      input.v3RestoreAuthorizationSha256,
      input.hostAuthorizationSha256,
      input.ownedEnvelopeSha256,
      input.restorePendingEnvelopeSha256,
      input.restoredEnvelopeSha256,
    ].every((value) => sha256.test(value)) ||
    !positiveDecimal.test(input.cloneDatabaseOid) ||
    !/^[0-9]{10,32}$/u.test(input.systemIdentifier) ||
    !hasExactKeys(input.components, componentKeys) ||
    !componentKeys.every((key) => sha256.test(input.components[key])) ||
    !hasExactKeys(input.authorizes, authorityKeys) ||
    authorityKeys.some((key) =>
      key === 'statePersistence' || key === 'restoreExecution'
        ? input.authorizes[key] !== true
        : input.authorizes[key] !== false,
    )
  )
    fail('SHAPE_INVALID');
  if (
    input.ownedEnvelopeSha256 === input.restorePendingEnvelopeSha256 ||
    input.restorePendingEnvelopeSha256 === input.restoredEnvelopeSha256 ||
    input.ownedEnvelopeSha256 === input.restoredEnvelopeSha256
  )
    fail('TRANSITION_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(
  input: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
): string {
  assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(
  input: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(input), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(
  input: string,
): CommunitiesStagingRoleSplitV3DurableRestoreAuthorization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('PARSE_INVALID');
  }
  const authorization = parsed as CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;
  assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(authorization);
  if (canonicalCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(authorization) !== input)
    fail('CANONICAL_ENCODING_INVALID');
  return authorization;
}

export function assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding(input: {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly preparationEnvelope: CommunitiesStagingRoleSplitV3PreparationEnvelope;
  readonly restoreAuthorization: CommunitiesStagingRoleSplitV3RestoreAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly ownedEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly restorePendingEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly restoredEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly componentSubjects: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization['components'];
  readonly authorization: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;
}): void {
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
    assertCommunitiesStagingRoleSplitV3PreparationEnvelope(input.preparationEnvelope);
    assertCommunitiesStagingRoleSplitV3RestoreAuthorization(input.restoreAuthorization);
    assertCommunitiesStagingRoleSplitHostAuthorization(input.hostAuthorization);
    assertCommunitiesStagingRoleSplitV3DurableStateEnvelope(input.ownedEnvelope);
    assertCommunitiesStagingRoleSplitV3DurableStateEnvelope(input.restorePendingEnvelope);
    assertCommunitiesStagingRoleSplitV3DurableStateEnvelope(input.restoredEnvelope);
    assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorization(input.authorization);
    assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding({
      request: input.request,
      preparationEnvelope: input.preparationEnvelope,
      hostAuthorization: input.hostAuthorization,
      restoreAuthorization: input.restoreAuthorization,
    });
  } catch {
    fail('BINDING_INVALID');
  }

  const authorization = input.authorization;
  const envelopes = [
    input.ownedEnvelope,
    input.restorePendingEnvelope,
    input.restoredEnvelope,
  ] as const;
  if (
    input.ownedEnvelope.phase !== 'OWNED' ||
    input.restorePendingEnvelope.phase !== 'RESTORE_PENDING' ||
    input.restoredEnvelope.phase !== 'RESTORED' ||
    input.preparationEnvelope.state.phase !== 'RESTORE_PENDING' ||
    input.preparationEnvelope.state.requestSha256 !==
      input.restorePendingEnvelope.state.requestSha256 ||
    input.preparationEnvelope.state.cloneDatabaseOid !==
      input.restorePendingEnvelope.state.cloneDatabaseOid ||
    input.preparationEnvelope.state.restoreExecutionEvidenceSha256 !==
      input.restorePendingEnvelope.state.restoreExecutionEvidenceSha256 ||
    input.preparationEnvelope.state.markerPayloadSha256 !== null ||
    input.preparationEnvelope.requestSha256 !== input.restorePendingEnvelope.requestSha256 ||
    input.preparationEnvelope.creationReceiptSha256 !==
      input.restorePendingEnvelope.creationReceiptSha256 ||
    authorization.markerRequestSha256 !==
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request) ||
    authorization.v3RestoreAuthorizationSha256 !==
      communitiesStagingRoleSplitV3RestoreAuthorizationSha256(input.restoreAuthorization) ||
    authorization.hostAuthorizationSha256 !==
      communitiesStagingRoleSplitHostAuthorizationSha256(input.hostAuthorization) ||
    authorization.ownedEnvelopeSha256 !==
      communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(input.ownedEnvelope) ||
    authorization.restorePendingEnvelopeSha256 !==
      communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(input.restorePendingEnvelope) ||
    authorization.restoredEnvelopeSha256 !==
      communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(input.restoredEnvelope) ||
    authorization.components.durableHostSha256 !== input.componentSubjects.durableHostSha256 ||
    authorization.components.stateStoreSha256 !== input.componentSubjects.stateStoreSha256 ||
    authorization.components.archiveCustodySha256 !==
      input.componentSubjects.archiveCustodySha256 ||
    authorization.candidateCommitSha !== input.restoreAuthorization.candidateCommitSha ||
    authorization.candidateCommitSha !== input.hostAuthorization.candidateCommitSha ||
    authorization.markerRequestSha256 !== input.restoreAuthorization.markerRequestSha256 ||
    authorization.markerRequestSha256 !== input.hostAuthorization.markerRequestSha256 ||
    authorization.creationReceiptSha256 !== input.restoreAuthorization.creationReceiptSha256 ||
    authorization.creationReceiptSha256 !== input.hostAuthorization.creationReceiptSha256 ||
    authorization.restoreExecutionEvidenceSha256 !==
      input.restoreAuthorization.restoreExecutionEvidenceSha256 ||
    authorization.cloneDatabaseOid !== input.restoreAuthorization.cloneDatabaseOid ||
    authorization.cloneDatabaseOid !== input.hostAuthorization.execution.cloneDatabaseOid ||
    authorization.systemIdentifier !== input.restoreAuthorization.systemIdentifier ||
    authorization.systemIdentifier !== input.request.systemIdentifier ||
    input.restoreAuthorization.authorizes.restoreExecution !== true ||
    input.hostAuthorization.authorizes.restoreExecution !== true ||
    envelopes.some(
      (envelope) =>
        envelope.requestSha256 !== authorization.markerRequestSha256 ||
        envelope.creationReceiptSha256 !== authorization.creationReceiptSha256 ||
        envelope.restoreExecutionEvidenceSha256 !== authorization.restoreExecutionEvidenceSha256 ||
        envelope.cloneDatabaseOid !== authorization.cloneDatabaseOid,
    )
  )
    fail('BINDING_INVALID');
}
