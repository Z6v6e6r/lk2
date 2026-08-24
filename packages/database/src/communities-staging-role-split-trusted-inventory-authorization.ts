import { createHash } from 'node:crypto';

import { communitiesRoleSplitCanonicalJson } from './communities-role-split-input-c.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';
import {
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from './communities-staging-role-split-trusted-inventory-authorization-request.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_VERSION =
  'communities-staging-role-split-trusted-inventory-authorization-evidence-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_APPROVAL_VERSION =
  'communities-staging-role-split-trusted-inventory-authorization-approval-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_VERSION =
  'communities-staging-role-split-trusted-inventory-authorization-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONSUMPTION_RECEIPT_VERSION =
  'communities-staging-role-split-trusted-inventory-consumption-receipt-v1';

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

type AuthorityKey = (typeof authorityKeys)[number];
type FalseAuthorities = { readonly [K in AuthorityKey]: false };
type RequestedInventoryAuthorities = Omit<
  FalseAuthorities,
  'inventoryConnection' | 'inventoryRead' | 'artifactWrite'
> & {
  readonly inventoryConnection: true;
  readonly inventoryRead: true;
  readonly artifactWrite: true;
};

export interface CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_VERSION;
  readonly status: 'INDEPENDENTLY_ATTESTED';
  readonly code: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceCode;
  readonly requestIdSha256: string;
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly gateSha256: string;
  readonly subjectSha256: string;
  readonly payloadSha256: string;
  readonly evidencePathSha256: string;
  readonly attestorSubjectSha256: string;
  readonly authorizes: FalseAuthorities;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_APPROVAL_VERSION;
  readonly status: 'INDEPENDENTLY_APPROVED';
  readonly approvalIdSha256: string;
  readonly requestSha256: string;
  readonly requestVerificationSha256: string;
  readonly evidenceSetSha256: string;
  readonly issuerSubjectSha256: string;
  readonly approverSubjectSha256: string;
  readonly clockSubjectSha256: string;
  readonly ledgerSubjectSha256: string;
  readonly notBeforeUnixSeconds: string;
  readonly expiresAtUnixSeconds: string;
  readonly maximumAttempts: 1;
  readonly authorizes: FalseAuthorities;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_VERSION;
  readonly status: 'ISSUED_PENDING_SINGLE_USE_CONSUMPTION';
  readonly approvalSha256: string;
  readonly approvalIdSha256: string;
  readonly requestSha256: string;
  readonly requestVerificationSha256: string;
  readonly requestIdSha256: string;
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly gateSha256: string;
  readonly evidenceSetSha256: string;
  readonly issuerSubjectSha256: string;
  readonly approverSubjectSha256: string;
  readonly clockSubjectSha256: string;
  readonly ledgerSubjectSha256: string;
  readonly notBeforeUnixSeconds: string;
  readonly expiresAtUnixSeconds: string;
  readonly maximumAttempts: 1;
  readonly requestedAuthorities: RequestedInventoryAuthorities;
  readonly authorizes: FalseAuthorities;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONSUMPTION_RECEIPT_VERSION;
  readonly status: 'CONSUMED';
  readonly authorizationSha256: string;
  readonly requestIdSha256: string;
  readonly ledgerSubjectSha256: string;
  readonly attempt: 1;
  readonly consumedAtUnixSeconds: string;
  readonly authorizes: FalseAuthorities;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UNIX_SECONDS = /^(0|[1-9][0-9]{0,15})$/u;
const evidenceKeys = [
  'schemaVersion',
  'status',
  'code',
  'requestIdSha256',
  'candidateCommitSha',
  'phase',
  'gateSha256',
  'subjectSha256',
  'payloadSha256',
  'evidencePathSha256',
  'attestorSubjectSha256',
  'authorizes',
] as const;
const approvalKeys = [
  'schemaVersion',
  'status',
  'approvalIdSha256',
  'requestSha256',
  'requestVerificationSha256',
  'evidenceSetSha256',
  'issuerSubjectSha256',
  'approverSubjectSha256',
  'clockSubjectSha256',
  'ledgerSubjectSha256',
  'notBeforeUnixSeconds',
  'expiresAtUnixSeconds',
  'maximumAttempts',
  'authorizes',
] as const;
const authorizationKeys = [
  'schemaVersion',
  'status',
  'approvalSha256',
  'approvalIdSha256',
  'requestSha256',
  'requestVerificationSha256',
  'requestIdSha256',
  'candidateCommitSha',
  'phase',
  'gateSha256',
  'evidenceSetSha256',
  'issuerSubjectSha256',
  'approverSubjectSha256',
  'clockSubjectSha256',
  'ledgerSubjectSha256',
  'notBeforeUnixSeconds',
  'expiresAtUnixSeconds',
  'maximumAttempts',
  'requestedAuthorities',
  'authorizes',
] as const;
const consumptionKeys = [
  'schemaVersion',
  'status',
  'authorizationSha256',
  'requestIdSha256',
  'ledgerSubjectSha256',
  'attempt',
  'consumedAtUnixSeconds',
  'authorizes',
] as const;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`TRUSTED_INVENTORY_AUTHORIZATION_${code}`);
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
  value: Record<AuthorityKey, boolean>,
  allowedTrue: readonly AuthorityKey[],
): void {
  if (
    !exactKeys(value, authorityKeys) ||
    authorityKeys.some((key) => value[key] !== allowedTrue.includes(key))
  )
    fail('AUTHORITY_INVALID');
}

function assertWindow(notBefore: string, expiresAt: string): void {
  if (!UNIX_SECONDS.test(notBefore) || !UNIX_SECONDS.test(expiresAt)) fail('TIME_INVALID');
  const start = BigInt(notBefore);
  const end = BigInt(expiresAt);
  if (end <= start || end - start > 300n) fail('TIME_INVALID');
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical<T>(value: T, assertion: (input: T) => void): string {
  assertion(value);
  return `${communitiesRoleSplitCanonicalJson(value)}\n`;
}

function parseCanonical<T>(
  text: string,
  assertion: (input: T) => void,
  canonicalizer: (input: T) => string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('CANONICAL_INVALID');
  }
  assertion(value as T);
  if (canonicalizer(value as T) !== text) fail('CANONICAL_INVALID');
  return value as T;
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
): void {
  if (
    !exactKeys(value, evidenceKeys) ||
    value.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_VERSION ||
    value.status !== 'INDEPENDENTLY_ATTESTED' ||
    !COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.includes(
      value.code,
    ) ||
    ![
      value.requestIdSha256,
      value.gateSha256,
      value.subjectSha256,
      value.payloadSha256,
      value.evidencePathSha256,
      value.attestorSubjectSha256,
    ].every((entry) => SHA256.test(entry)) ||
    !COMMIT.test(value.candidateCommitSha) ||
    !(['BEFORE', 'AFTER'] as const).includes(value.phase) ||
    value.payloadSha256 === value.subjectSha256 ||
    value.attestorSubjectSha256 === value.subjectSha256
  )
    fail('EVIDENCE_INVALID');
  assertAuthorities(value.authorizes, []);
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
): void {
  if (
    !exactKeys(value, approvalKeys) ||
    value.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_APPROVAL_VERSION ||
    value.status !== 'INDEPENDENTLY_APPROVED' ||
    ![
      value.approvalIdSha256,
      value.requestSha256,
      value.requestVerificationSha256,
      value.evidenceSetSha256,
      value.issuerSubjectSha256,
      value.approverSubjectSha256,
      value.clockSubjectSha256,
      value.ledgerSubjectSha256,
    ].every((entry) => SHA256.test(entry)) ||
    new Set([
      value.issuerSubjectSha256,
      value.approverSubjectSha256,
      value.clockSubjectSha256,
      value.ledgerSubjectSha256,
    ]).size !== 4 ||
    value.maximumAttempts !== 1
  )
    fail('APPROVAL_INVALID');
  assertWindow(value.notBeforeUnixSeconds, value.expiresAtUnixSeconds);
  assertAuthorities(value.authorizes, []);
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryAuthorization(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
): void {
  if (
    !exactKeys(value, authorizationKeys) ||
    value.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_VERSION ||
    value.status !== 'ISSUED_PENDING_SINGLE_USE_CONSUMPTION' ||
    ![
      value.approvalSha256,
      value.approvalIdSha256,
      value.requestSha256,
      value.requestVerificationSha256,
      value.requestIdSha256,
      value.gateSha256,
      value.evidenceSetSha256,
      value.issuerSubjectSha256,
      value.approverSubjectSha256,
      value.clockSubjectSha256,
      value.ledgerSubjectSha256,
    ].every((entry) => SHA256.test(entry)) ||
    !COMMIT.test(value.candidateCommitSha) ||
    !(['BEFORE', 'AFTER'] as const).includes(value.phase) ||
    value.maximumAttempts !== 1
  )
    fail('INVALID');
  assertWindow(value.notBeforeUnixSeconds, value.expiresAtUnixSeconds);
  assertAuthorities(value.requestedAuthorities, [
    'inventoryConnection',
    'inventoryRead',
    'artifactWrite',
  ]);
  assertAuthorities(value.authorizes, []);
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt(
  value: CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
): void {
  if (
    !exactKeys(value, consumptionKeys) ||
    value.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONSUMPTION_RECEIPT_VERSION ||
    value.status !== 'CONSUMED' ||
    ![value.authorizationSha256, value.requestIdSha256, value.ledgerSubjectSha256].every((entry) =>
      SHA256.test(entry),
    ) ||
    value.attempt !== 1 ||
    !UNIX_SECONDS.test(value.consumedAtUnixSeconds)
  )
    fail('CONSUMPTION_INVALID');
  assertAuthorities(value.authorizes, []);
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
): string {
  return canonical(value, assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence);
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
): string {
  return canonical(value, assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval);
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
): string {
  return canonical(value, assertCommunitiesStagingRoleSplitTrustedInventoryAuthorization);
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt(
  value: CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
): string {
  return canonical(value, assertCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt);
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence {
  return parseCanonical(
    text,
    assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  );
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval {
  return parseCanonical(
    text,
    assertCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  );
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  return parseCanonical(
    text,
    assertCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  );
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt {
  return parseCanonical(
    text,
    assertCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
    canonicalCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
  );
}

export function communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
): string {
  return digestText(
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(value),
  );
}

export function communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
): string {
  return digestText(
    canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(value),
  );
}

export function communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
): string {
  return digestText(canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(value));
}

export function communitiesStagingRoleSplitTrustedInventoryConsumptionReceiptSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
): string {
  return digestText(canonicalCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt(value));
}

export function communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSetSha256(
  request: CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
): string {
  return digestText(
    `${communitiesRoleSplitCanonicalJson({
      schemaVersion:
        'communities-staging-role-split-trusted-inventory-authorization-evidence-set-v1',
      requestSha256: communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(request),
      evidencePins: request.evidencePins,
    })}\n`,
  );
}
