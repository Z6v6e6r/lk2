import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitV3MarkerEvidence,
  type CommunitiesStagingRoleSplitV3MarkerEvidence,
  type CommunitiesStagingRoleSplitV3MarkerPayload,
} from './communities-staging-role-split-v3-contract.js';
import {
  assertCommunitiesStagingRoleSplitV3ExecutionAuthorization,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  type CommunitiesStagingRoleSplitV3ExecutionAuthorization,
} from './communities-staging-role-split-v3-execution-authorization.js';
import {
  assertCommunitiesStagingRoleSplitHostAuthorization,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
} from './communities-staging-role-split-host-authorization.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_ATTESTED_EVIDENCE_VERSION =
  'communities-staging-role-split-v3-attested-evidence-v2';

const authorityKeys = [
  'roleCreation',
  'roleSplit',
  'sharedDatabaseMutation',
  'migration',
  'deploy',
  'import',
  'activation',
] as const;
const attestationKeys = ['subjectSha256', 'evidenceSha256'] as const;
const envelopeKeys = [
  'schemaVersion',
  'status',
  'executionAuthorizationSha256',
  'hostAuthorizationSha256',
  'markerEvidence',
  'ownershipAclAttestation',
  'sourceWriteDenialAttestation',
  'evidenceSinkSubjectSha256',
  'authorizes',
] as const;
const sha256 = /^[a-f0-9]{64}$/u;

export interface CommunitiesStagingRoleSplitV3AttestedEvidence {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_ATTESTED_EVIDENCE_VERSION;
  readonly status: 'ATTESTED';
  readonly executionAuthorizationSha256: string;
  readonly hostAuthorizationSha256: string;
  readonly markerEvidence: CommunitiesStagingRoleSplitV3MarkerEvidence;
  readonly ownershipAclAttestation: {
    readonly subjectSha256: string;
    readonly evidenceSha256: string;
  };
  readonly sourceWriteDenialAttestation: {
    readonly subjectSha256: string;
    readonly evidenceSha256: string;
  };
  readonly evidenceSinkSubjectSha256: string;
  readonly authorizes: Record<(typeof authorityKeys)[number], false>;
}

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`V3_ATTESTED_EVIDENCE_${code}`);
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

function binding(
  authorization: CommunitiesStagingRoleSplitHostAuthorization,
  code: 'OWNERSHIP_ACL_ATTESTATION' | 'SOURCE_WRITE_DENIAL_ATTESTATION',
): CommunitiesStagingRoleSplitHostAuthorization['bindings'][number] {
  const result = authorization.bindings.find((entry) => entry.code === code);
  if (result === undefined) fail('BINDING_INVALID');
  return result;
}

export function createCommunitiesStagingRoleSplitV3AttestedEvidence(input: {
  readonly payload: CommunitiesStagingRoleSplitV3MarkerPayload;
  readonly marker: string;
  readonly markerEvidence: CommunitiesStagingRoleSplitV3MarkerEvidence;
  readonly executionAuthorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly ownershipAclAttestation: CommunitiesStagingRoleSplitV3AttestedEvidence['ownershipAclAttestation'];
  readonly sourceWriteDenialAttestation: CommunitiesStagingRoleSplitV3AttestedEvidence['sourceWriteDenialAttestation'];
  readonly evidenceSinkSubjectSha256: string;
}): CommunitiesStagingRoleSplitV3AttestedEvidence {
  const evidence: CommunitiesStagingRoleSplitV3AttestedEvidence = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_ATTESTED_EVIDENCE_VERSION,
    status: 'ATTESTED',
    executionAuthorizationSha256: communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
      input.executionAuthorization,
    ),
    hostAuthorizationSha256: communitiesStagingRoleSplitHostAuthorizationSha256(
      input.hostAuthorization,
    ),
    markerEvidence: input.markerEvidence,
    ownershipAclAttestation: input.ownershipAclAttestation,
    sourceWriteDenialAttestation: input.sourceWriteDenialAttestation,
    evidenceSinkSubjectSha256: input.evidenceSinkSubjectSha256,
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
  assertCommunitiesStagingRoleSplitV3AttestedEvidence({ ...input, evidence });
  return evidence;
}

export function assertCommunitiesStagingRoleSplitV3AttestedEvidence(input: {
  readonly payload: CommunitiesStagingRoleSplitV3MarkerPayload;
  readonly marker: string;
  readonly executionAuthorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly evidence: CommunitiesStagingRoleSplitV3AttestedEvidence;
}): void {
  const evidence = input.evidence;
  if (
    !hasExactKeys(evidence, envelopeKeys) ||
    evidence.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_ATTESTED_EVIDENCE_VERSION ||
    evidence.status !== 'ATTESTED' ||
    !hasExactKeys(evidence.ownershipAclAttestation, attestationKeys) ||
    !hasExactKeys(evidence.sourceWriteDenialAttestation, attestationKeys) ||
    !hasExactKeys(evidence.authorizes, authorityKeys) ||
    authorityKeys.some((key) => evidence.authorizes[key] !== false) ||
    ![
      evidence.executionAuthorizationSha256,
      evidence.hostAuthorizationSha256,
      evidence.ownershipAclAttestation.subjectSha256,
      evidence.ownershipAclAttestation.evidenceSha256,
      evidence.sourceWriteDenialAttestation.subjectSha256,
      evidence.sourceWriteDenialAttestation.evidenceSha256,
      evidence.evidenceSinkSubjectSha256,
    ].every((value) => sha256.test(value))
  )
    fail('SHAPE_INVALID');
  try {
    assertCommunitiesStagingRoleSplitV3ExecutionAuthorization(input.executionAuthorization);
    assertCommunitiesStagingRoleSplitHostAuthorization(input.hostAuthorization);
    assertCommunitiesStagingRoleSplitV3MarkerEvidence(
      input.payload,
      input.marker,
      evidence.markerEvidence,
    );
  } catch {
    fail('BINDING_INVALID');
  }
  const authorization = input.executionAuthorization;
  const hostAuthorizationSha256 = communitiesStagingRoleSplitHostAuthorizationSha256(
    input.hostAuthorization,
  );
  const ownershipAclBinding = binding(input.hostAuthorization, 'OWNERSHIP_ACL_ATTESTATION');
  const sourceWriteDenialBinding = binding(
    input.hostAuthorization,
    'SOURCE_WRITE_DENIAL_ATTESTATION',
  );
  if (
    evidence.executionAuthorizationSha256 !==
      communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(authorization) ||
    evidence.hostAuthorizationSha256 !== hostAuthorizationSha256 ||
    authorization.hostAuthorizationSha256 !== hostAuthorizationSha256 ||
    input.hostAuthorization.markerRequestSha256 !== authorization.markerRequestSha256 ||
    input.hostAuthorization.creationReceiptSha256 !== authorization.creationReceiptSha256 ||
    input.hostAuthorization.execution.cloneDatabaseOid !== authorization.cloneDatabaseOid ||
    evidence.markerEvidence.requestSha256 !== authorization.markerRequestSha256 ||
    evidence.markerEvidence.creationReceiptSha256 !== authorization.creationReceiptSha256 ||
    evidence.markerEvidence.restoreExecutionEvidenceSha256 !==
      authorization.restoreExecutionEvidenceSha256 ||
    evidence.markerEvidence.cloneDatabaseOid !== authorization.cloneDatabaseOid ||
    evidence.ownershipAclAttestation.subjectSha256 !==
      authorization.components.ownershipAclAttestorSha256 ||
    evidence.ownershipAclAttestation.subjectSha256 !== ownershipAclBinding.subjectSha256 ||
    evidence.ownershipAclAttestation.evidenceSha256 !== ownershipAclBinding.evidenceSha256 ||
    evidence.sourceWriteDenialAttestation.subjectSha256 !==
      authorization.components.sourceWriteDenialAttestorSha256 ||
    evidence.sourceWriteDenialAttestation.subjectSha256 !==
      sourceWriteDenialBinding.subjectSha256 ||
    evidence.sourceWriteDenialAttestation.evidenceSha256 !==
      sourceWriteDenialBinding.evidenceSha256 ||
    evidence.evidenceSinkSubjectSha256 !== authorization.components.evidenceSinkSha256
  )
    fail('BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitV3AttestedEvidence(input: {
  readonly payload: CommunitiesStagingRoleSplitV3MarkerPayload;
  readonly marker: string;
  readonly executionAuthorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly evidence: CommunitiesStagingRoleSplitV3AttestedEvidence;
}): string {
  assertCommunitiesStagingRoleSplitV3AttestedEvidence(input);
  return `${canonicalJson(input.evidence)}\n`;
}

export function communitiesStagingRoleSplitV3AttestedEvidenceSha256(input: {
  readonly payload: CommunitiesStagingRoleSplitV3MarkerPayload;
  readonly marker: string;
  readonly executionAuthorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly evidence: CommunitiesStagingRoleSplitV3AttestedEvidence;
}): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitV3AttestedEvidence(input), 'utf8')
    .digest('hex');
}
