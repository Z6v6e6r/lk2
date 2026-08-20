import { createHash } from 'node:crypto';

import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';
import {
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
} from './communities-staging-role-split-restore-marker.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_ATTESTED_EVIDENCE_VERSION =
  'communities-staging-role-split-attested-evidence-v1';

export interface CommunitiesStagingRoleSplitAttestedEvidence {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_ATTESTED_EVIDENCE_VERSION;
  readonly status: 'ATTESTED';
  readonly authorizationSha256: string;
  readonly markerEvidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence;
  readonly ownershipAclAttestation: {
    readonly subjectSha256: string;
    readonly evidenceSha256: string;
  };
  readonly sourceWriteDenialAttestation: {
    readonly subjectSha256: string;
    readonly evidenceSha256: string;
  };
  readonly evidenceSinkSubjectSha256: string;
}

const sha256 = /^[a-f0-9]{64}$/u;
const envelopeKeys = [
  'schemaVersion',
  'status',
  'authorizationSha256',
  'markerEvidence',
  'ownershipAclAttestation',
  'sourceWriteDenialAttestation',
  'evidenceSinkSubjectSha256',
] as const;
const attestationKeys = ['subjectSha256', 'evidenceSha256'] as const;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`ATTESTED_EVIDENCE_${code}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
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
  fail('VALUE_INVALID');
}

function assertAttestation(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, attestationKeys) ||
    typeof value.subjectSha256 !== 'string' ||
    !sha256.test(value.subjectSha256) ||
    typeof value.evidenceSha256 !== 'string' ||
    !sha256.test(value.evidenceSha256)
  )
    fail('ATTESTATION_INVALID');
}

export function assertCommunitiesStagingRoleSplitAttestedEvidenceShape(
  input: CommunitiesStagingRoleSplitAttestedEvidence,
): void {
  if (
    !hasExactKeys(input, envelopeKeys) ||
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_ATTESTED_EVIDENCE_VERSION ||
    input.status !== 'ATTESTED' ||
    !sha256.test(input.authorizationSha256) ||
    !sha256.test(input.evidenceSinkSubjectSha256)
  )
    fail('SHAPE_INVALID');
  assertAttestation(input.ownershipAclAttestation);
  assertAttestation(input.sourceWriteDenialAttestation);
}

export function assertCommunitiesStagingRoleSplitAttestedEvidence(
  input: CommunitiesStagingRoleSplitAttestedEvidence,
  payload: CommunitiesStagingRoleSplitRestoreMarkerPayload,
  marker: string,
): void {
  assertCommunitiesStagingRoleSplitAttestedEvidenceShape(input);
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(payload, marker, input.markerEvidence);
  } catch {
    fail('MARKER_EVIDENCE_INVALID');
  }
}

export function canonicalCommunitiesStagingRoleSplitAttestedEvidence(
  input: CommunitiesStagingRoleSplitAttestedEvidence,
): string {
  assertCommunitiesStagingRoleSplitAttestedEvidenceShape(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitAttestedEvidenceSha256(
  input: CommunitiesStagingRoleSplitAttestedEvidence,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitAttestedEvidence(input), 'utf8')
    .digest('hex');
}
