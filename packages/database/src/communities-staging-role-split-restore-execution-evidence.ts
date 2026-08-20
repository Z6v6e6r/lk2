import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  communitiesStagingRoleSplitRestoreExecutionDescriptorSha256,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
} from './communities-staging-role-split-restore-execution-descriptor.js';
import {
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from './communities-staging-role-split-restore-marker.js';
import {
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  type CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
} from './communities-staging-role-split-source-write-denial-attestation.js';
import type {
  CommunitiesSourceConnectAclObservation,
  CommunitiesSourceMembershipObservation,
} from './communities-staging-role-split-source-write-denial-observations.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_EVIDENCE_VERSION =
  'communities-staging-role-split-restore-execution-evidence-v1';

const authorityKeys = [
  'execution',
  'cloneCreation',
  'restore',
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
  'statePersistence',
] as const;

export interface CommunitiesStagingRoleSplitRestoreExecutionEvidence {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_EVIDENCE_VERSION;
  readonly status: 'PREPARATION_ONLY';
  readonly markerRequestSha256: string;
  readonly sourceWriteDenialAttestationSha256: string;
  readonly restoreExecutionDescriptorSha256: string;
  readonly creationReceiptSha256: string;
  readonly cloneDatabaseOid: string;
  readonly systemIdentifier: string;
  readonly postgresMajor: '16';
  readonly restoreRunId: string;
  readonly restoreRunAttempt: string;
  readonly authorizes: Record<(typeof authorityKeys)[number], false>;
}

const evidenceKeys = [
  'schemaVersion',
  'status',
  'markerRequestSha256',
  'sourceWriteDenialAttestationSha256',
  'restoreExecutionDescriptorSha256',
  'creationReceiptSha256',
  'cloneDatabaseOid',
  'systemIdentifier',
  'postgresMajor',
  'restoreRunId',
  'restoreRunAttempt',
  'authorizes',
] as const;
const sha256 = /^[a-f0-9]{64}$/;
const positiveDecimal = /^[1-9][0-9]*$/;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`RESTORE_EXECUTION_EVIDENCE_${code}`);
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
  return fail('VALUE_INVALID');
}

export function assertCommunitiesStagingRoleSplitRestoreExecutionEvidence(
  input: CommunitiesStagingRoleSplitRestoreExecutionEvidence,
): void {
  if (
    !hasExactKeys(input, evidenceKeys) ||
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_EVIDENCE_VERSION ||
    input.status !== 'PREPARATION_ONLY' ||
    ![
      input.markerRequestSha256,
      input.sourceWriteDenialAttestationSha256,
      input.restoreExecutionDescriptorSha256,
      input.creationReceiptSha256,
    ].every((value) => sha256.test(value)) ||
    ![
      input.cloneDatabaseOid,
      input.systemIdentifier,
      input.restoreRunId,
      input.restoreRunAttempt,
    ].every((value) => positiveDecimal.test(value)) ||
    input.postgresMajor !== '16' ||
    !hasExactKeys(input.authorizes, authorityKeys) ||
    !authorityKeys.every((key) => input.authorizes[key] === false)
  )
    fail('BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitRestoreExecutionEvidence(
  input: CommunitiesStagingRoleSplitRestoreExecutionEvidence,
): string {
  assertCommunitiesStagingRoleSplitRestoreExecutionEvidence(input);
  return `${canonicalJson(input)}\n`;
}
export function communitiesStagingRoleSplitRestoreExecutionEvidenceSha256(
  input: CommunitiesStagingRoleSplitRestoreExecutionEvidence,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitRestoreExecutionEvidence(input), 'utf8')
    .digest('hex');
}

/** Acyclic preparation envelope: descriptor pins attestation; evidence only observes both. */
export function assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings(input: {
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
}): void {
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation(input.attestation);
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor(input.descriptor);
  assertCommunitiesStagingRoleSplitRestoreExecutionEvidence(input.evidence);
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
    request: input.request,
    descriptor: input.descriptor,
    attestation: input.attestation,
    connectAclObservation: input.connectAclObservation,
    membershipObservation: input.membershipObservation,
  });
  if (
    !sha256.test(input.creationReceiptSha256) ||
    ![
      input.cloneDatabaseOid,
      input.systemIdentifier,
      input.restoreRunId,
      input.restoreRunAttempt,
    ].every((value) => positiveDecimal.test(value)) ||
    input.evidence.markerRequestSha256 !==
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request) ||
    input.evidence.sourceWriteDenialAttestationSha256 !==
      communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(input.attestation) ||
    input.evidence.restoreExecutionDescriptorSha256 !==
      communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(input.descriptor) ||
    input.descriptor.markerRequestSha256 !== input.evidence.markerRequestSha256 ||
    input.descriptor.sourceWriteDenialEvidenceSha256 !==
      input.evidence.sourceWriteDenialAttestationSha256 ||
    input.descriptor.creationReceiptSha256 !== input.creationReceiptSha256 ||
    input.evidence.creationReceiptSha256 !== input.creationReceiptSha256 ||
    input.descriptor.cloneDatabaseOid !== input.cloneDatabaseOid ||
    input.evidence.cloneDatabaseOid !== input.cloneDatabaseOid ||
    input.request.systemIdentifier !== input.systemIdentifier ||
    input.attestation.systemIdentifier !== input.systemIdentifier ||
    input.evidence.systemIdentifier !== input.systemIdentifier ||
    input.request.postgresMajor !== input.evidence.postgresMajor ||
    input.attestation.postgresMajor !== input.evidence.postgresMajor ||
    input.request.restoreRunId !== input.restoreRunId ||
    input.evidence.restoreRunId !== input.restoreRunId ||
    input.request.restoreRunAttempt !== input.restoreRunAttempt ||
    input.evidence.restoreRunAttempt !== input.restoreRunAttempt
  )
    fail('CROSS_BINDING_INVALID');
}
