import { createHash } from 'node:crypto';

import { communitiesRoleSplitCanonicalJson } from './communities-role-split-input-c.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_VERSION =
  'communities-staging-role-split-trusted-inventory-authorization-request-v1';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES = [
  'CLEAN_CLONE_PROVENANCE',
  'CONNECTION_DESCRIPTOR_CUSTODY',
  'CREDENTIAL_DESCRIPTOR_CUSTODY',
  'INSTALLED_CANDIDATE_RECEIPT_CUSTODY',
  'OUTPUT_DIRECTORY_CUSTODY',
  'OUTPUT_TARGET_ABSENCE',
  'PREPARATION_VERIFICATION_PROVENANCE',
  'PRODUCER_DESCRIPTOR_CUSTODY',
  'PRODUCER_EXECUTABLE_CUSTODY',
  'RUNTIME_BUNDLE_CUSTODY',
] as const;

export type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode =
  (typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES)[number];

export interface CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidencePin {
  readonly code: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode;
  readonly status: 'PINNED_FOR_SEPARATE_REVIEW';
  readonly subjectSha256: string;
  readonly evidenceSha256: string;
  readonly evidencePathSha256: string;
}

const authorityKeys = [
  'inventoryConnection',
  'inventoryRead',
  'artifactWrite',
  'trustedInventoryDesignation',
  'roleCreation',
  'roleSplit',
  'aclMutation',
  'sharedDatabaseMutation',
  'migration',
  'deploy',
  'activation',
] as const;

type FalseAuthorities = {
  readonly [K in (typeof authorityKeys)[number]]: false;
};

export interface CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_VERSION;
  readonly status: 'AUTHORIZATION_REQUEST_REVIEW_ONLY';
  readonly requestIdSha256: string;
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly gateSha256: string;
  readonly gateVerificationSha256: string;
  readonly evidencePins: readonly CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidencePin[];
  readonly policy: {
    readonly singleUse: true;
    readonly maximumAttempts: 1;
    readonly authorizationValiditySeconds: 300;
    readonly requiresDurableConsumptionLedger: true;
    readonly requiresRootOwnedEvidence: true;
    readonly requiresIndependentApprover: true;
    readonly requiresFailClosedClock: true;
  };
  readonly requestedAuthorities: Omit<
    FalseAuthorities,
    'inventoryConnection' | 'inventoryRead' | 'artifactWrite'
  > & {
    readonly inventoryConnection: true;
    readonly inventoryRead: true;
    readonly artifactWrite: true;
  };
  readonly authorizes: FalseAuthorities;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const requestKeys = [
  'schemaVersion',
  'status',
  'requestIdSha256',
  'candidateCommitSha',
  'phase',
  'gateSha256',
  'gateVerificationSha256',
  'evidencePins',
  'policy',
  'requestedAuthorities',
  'authorizes',
] as const;
const evidencePinKeys = [
  'code',
  'status',
  'subjectSha256',
  'evidenceSha256',
  'evidencePathSha256',
] as const;
const policyKeys = [
  'singleUse',
  'maximumAttempts',
  'authorizationValiditySeconds',
  'requiresDurableConsumptionLedger',
  'requiresRootOwnedEvidence',
  'requiresIndependentApprover',
  'requiresFailClosedClock',
] as const;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_${code}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertAuthorities(
  value: Record<(typeof authorityKeys)[number], boolean>,
  allowedTrue: readonly (typeof authorityKeys)[number][],
): void {
  if (
    !exactKeys(value, authorityKeys) ||
    authorityKeys.some((key) => value[key] !== allowedTrue.includes(key))
  )
    fail('AUTHORITY_INVALID');
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
): void {
  if (
    !exactKeys(value, requestKeys) ||
    value.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_VERSION ||
    value.status !== 'AUTHORIZATION_REQUEST_REVIEW_ONLY' ||
    !SHA256.test(value.requestIdSha256) ||
    !COMMIT.test(value.candidateCommitSha) ||
    !(['BEFORE', 'AFTER'] as const).includes(value.phase) ||
    !SHA256.test(value.gateSha256) ||
    !SHA256.test(value.gateVerificationSha256) ||
    !Array.isArray(value.evidencePins) ||
    value.evidencePins.length !==
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.length ||
    !exactKeys(value.policy, policyKeys) ||
    value.policy.singleUse !== true ||
    value.policy.maximumAttempts !== 1 ||
    value.policy.authorizationValiditySeconds !== 300 ||
    value.policy.requiresDurableConsumptionLedger !== true ||
    value.policy.requiresRootOwnedEvidence !== true ||
    value.policy.requiresIndependentApprover !== true ||
    value.policy.requiresFailClosedClock !== true
  )
    fail('INVALID');

  const evidenceHashes = new Set<string>();
  const evidencePathHashes = new Set<string>();
  for (const [
    index,
    expectedCode,
  ] of COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.entries()) {
    const pin: unknown = value.evidencePins[index];
    if (
      !exactKeys(pin, evidencePinKeys) ||
      !isRecord(pin) ||
      pin.code !== expectedCode ||
      pin.status !== 'PINNED_FOR_SEPARATE_REVIEW' ||
      typeof pin.subjectSha256 !== 'string' ||
      !SHA256.test(pin.subjectSha256) ||
      typeof pin.evidenceSha256 !== 'string' ||
      !SHA256.test(pin.evidenceSha256) ||
      typeof pin.evidencePathSha256 !== 'string' ||
      !SHA256.test(pin.evidencePathSha256) ||
      evidenceHashes.has(pin.evidenceSha256) ||
      evidencePathHashes.has(pin.evidencePathSha256)
    )
      fail('EVIDENCE_PIN_INVALID');
    evidenceHashes.add(pin.evidenceSha256);
    evidencePathHashes.add(pin.evidencePathSha256);
  }

  assertAuthorities(value.requestedAuthorities, [
    'inventoryConnection',
    'inventoryRead',
    'artifactWrite',
  ]);
  assertAuthorities(value.authorizes, []);
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
): string {
  assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(value);
  return `${communitiesRoleSplitCanonicalJson(value)}\n`;
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('CANONICAL_INVALID');
  }
  assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(
    parsed as CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
  );
  if (
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(
      parsed as CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
    ) !== text
  )
    fail('CANONICAL_INVALID');
  return parsed as CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest;
}

export function communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(value), 'utf8')
    .digest('hex');
}
