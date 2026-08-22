import { createHash } from 'node:crypto';

import { communitiesRoleSplitCanonicalJson } from './communities-role-split-input-c.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONNECTION_VERSION =
  'communities-staging-role-split-trusted-inventory-connection-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_VERSION =
  'communities-staging-role-split-trusted-inventory-authorization-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RECEIPT_VERSION =
  'communities-staging-role-split-trusted-inventory-receipt-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const DATABASE = /^phub_restore_[1-9][0-9]*_[1-9][0-9]*$/u;
const ROLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const authorizationKeys = [
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

export interface CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONNECTION_VERSION;
  readonly sourceKind: 'INDEPENDENTLY_SOURCED_CLEAN_CLONE';
  readonly host: 'postgres';
  readonly port: 5432;
  readonly database: string;
  readonly user: string;
  readonly sslMode: 'disable';
  readonly passwordTransport: 'FD_3';
  readonly defaultTransactionReadOnly: true;
  readonly applicationName: 'phub-communities-role-split-input-c-v1';
  readonly connectTimeoutMillis: 10_000;
  readonly statementTimeoutMillis: 30_000;
  readonly lockTimeoutMillis: 5_000;
  readonly markerRequestSha256: string;
  readonly markerEvidenceSha256: string;
  readonly roleMappingSha256: string;
}

export interface CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_VERSION;
  readonly status: 'AUTHORIZED_READ_ONLY_CLEAN_CLONE_INVENTORY';
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly preparationSha256: string;
  readonly connectionDescriptorSha256: string;
  readonly producerExecutableSha256: string;
  readonly outputDirectoryPathSha256: string;
  readonly outputArtifactPathSha256: string;
  readonly outputReceiptPathSha256: string;
  readonly collectionTimeoutMillis: 45_000;
  readonly terminationGraceMillis: 5_000;
  readonly authorizes: {
    readonly inventoryConnection: true;
    readonly inventoryRead: true;
    readonly artifactWrite: true;
    readonly trustedInventoryDesignation: false;
    readonly roleCreation: false;
    readonly roleSplit: false;
    readonly aclMutation: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
}

export interface CommunitiesStagingRoleSplitTrustedInventoryReceipt {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RECEIPT_VERSION;
  readonly status: 'COLLECTED_READ_ONLY_REVIEW_EVIDENCE';
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly preparationSha256: string;
  readonly authorizationSha256: string;
  readonly connectionDescriptorSha256: string;
  readonly producerExecutableSha256: string;
  readonly artifactSha256: string;
  readonly manifestSha256: string;
  readonly outputArtifactPathSha256: string;
  readonly outputReceiptPathSha256: string;
  readonly bindings: {
    readonly preparationVerified: true;
    readonly independentlySourcedCloneClaimBound: true;
    readonly credentialDescriptorValidatorCompleted: true;
    readonly producerDescriptorValidatorCompleted: true;
    readonly processExitedZero: true;
    readonly processStderrEmpty: true;
    readonly readOnlyProducerBoundaryBound: true;
    readonly artifactCanonicalReadback: true;
    readonly receiptCanonicalReadback: true;
  };
  readonly limitations: {
    readonly hostCollaboratorCompositionNotAttested: true;
    readonly independentArtifactPinNotAttested: true;
    readonly organizationalIndependenceNotAttested: true;
    readonly cleanCloneProvenanceSemanticsNotAttested: true;
    readonly trustedInventoryDesignationNotGranted: true;
  };
  readonly authorizes: {
    readonly trustedInventoryDesignation: false;
    readonly roleCreation: false;
    readonly roleSplit: false;
    readonly aclMutation: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
}

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`TRUSTED_INVENTORY_${code}`);
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalText(value: unknown): string {
  return `${communitiesRoleSplitCanonicalJson(value)}\n`;
}

function parseCanonical<T>(text: string, assertValue: (value: T) => void): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('CANONICAL_INVALID');
  }
  assertValue(parsed as T);
  if (canonicalText(parsed) !== text) fail('CANONICAL_INVALID');
  return parsed as T;
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
  value: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
): void {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'sourceKind',
      'host',
      'port',
      'database',
      'user',
      'sslMode',
      'passwordTransport',
      'defaultTransactionReadOnly',
      'applicationName',
      'connectTimeoutMillis',
      'statementTimeoutMillis',
      'lockTimeoutMillis',
      'markerRequestSha256',
      'markerEvidenceSha256',
      'roleMappingSha256',
    ]) ||
    value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONNECTION_VERSION ||
    value.sourceKind !== 'INDEPENDENTLY_SOURCED_CLEAN_CLONE' ||
    value.host !== 'postgres' ||
    value.port !== 5432 ||
    !DATABASE.test(value.database) ||
    !ROLE.test(value.user) ||
    value.sslMode !== 'disable' ||
    value.passwordTransport !== 'FD_3' ||
    value.defaultTransactionReadOnly !== true ||
    value.applicationName !== 'phub-communities-role-split-input-c-v1' ||
    value.connectTimeoutMillis !== 10_000 ||
    value.statementTimeoutMillis !== 30_000 ||
    value.lockTimeoutMillis !== 5_000 ||
    !SHA256.test(value.markerRequestSha256) ||
    !SHA256.test(value.markerEvidenceSha256) ||
    !SHA256.test(value.roleMappingSha256)
  )
    fail('CONNECTION_DESCRIPTOR_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
  value: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
): string {
  assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(value);
  return canonicalText(value);
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor {
  return parseCanonical(
    text,
    assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
  );
}

export function communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
): string {
  return sha256(canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(value));
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryAuthorization(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
): void {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'phase',
      'preparationSha256',
      'connectionDescriptorSha256',
      'producerExecutableSha256',
      'outputDirectoryPathSha256',
      'outputArtifactPathSha256',
      'outputReceiptPathSha256',
      'collectionTimeoutMillis',
      'terminationGraceMillis',
      'authorizes',
    ]) ||
    value.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_VERSION ||
    value.status !== 'AUTHORIZED_READ_ONLY_CLEAN_CLONE_INVENTORY' ||
    !COMMIT.test(value.candidateCommitSha) ||
    !['BEFORE', 'AFTER'].includes(value.phase) ||
    !SHA256.test(value.preparationSha256) ||
    !SHA256.test(value.connectionDescriptorSha256) ||
    !SHA256.test(value.producerExecutableSha256) ||
    !SHA256.test(value.outputDirectoryPathSha256) ||
    !SHA256.test(value.outputArtifactPathSha256) ||
    !SHA256.test(value.outputReceiptPathSha256) ||
    value.collectionTimeoutMillis !== 45_000 ||
    value.terminationGraceMillis !== 5_000 ||
    !exactKeys(value.authorizes, authorizationKeys) ||
    value.authorizes.inventoryConnection !== true ||
    value.authorizes.inventoryRead !== true ||
    value.authorizes.artifactWrite !== true ||
    value.authorizes.trustedInventoryDesignation !== false ||
    value.authorizes.roleCreation !== false ||
    value.authorizes.roleSplit !== false ||
    value.authorizes.aclMutation !== false ||
    value.authorizes.sharedDatabaseMutation !== false ||
    value.authorizes.migration !== false ||
    value.authorizes.deploy !== false ||
    value.authorizes.activation !== false
  )
    fail('AUTHORIZATION_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
): string {
  assertCommunitiesStagingRoleSplitTrustedInventoryAuthorization(value);
  return canonicalText(value);
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  return parseCanonical(text, assertCommunitiesStagingRoleSplitTrustedInventoryAuthorization);
}

export function communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
): string {
  return sha256(canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(value));
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryReceipt(
  value: CommunitiesStagingRoleSplitTrustedInventoryReceipt,
): void {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'phase',
      'preparationSha256',
      'authorizationSha256',
      'connectionDescriptorSha256',
      'producerExecutableSha256',
      'artifactSha256',
      'manifestSha256',
      'outputArtifactPathSha256',
      'outputReceiptPathSha256',
      'bindings',
      'limitations',
      'authorizes',
    ]) ||
    value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_RECEIPT_VERSION ||
    value.status !== 'COLLECTED_READ_ONLY_REVIEW_EVIDENCE' ||
    !COMMIT.test(value.candidateCommitSha) ||
    !['BEFORE', 'AFTER'].includes(value.phase) ||
    [
      value.preparationSha256,
      value.authorizationSha256,
      value.connectionDescriptorSha256,
      value.producerExecutableSha256,
      value.artifactSha256,
      value.manifestSha256,
      value.outputArtifactPathSha256,
      value.outputReceiptPathSha256,
    ].some((entry) => !SHA256.test(entry)) ||
    !exactKeys(value.bindings, [
      'preparationVerified',
      'independentlySourcedCloneClaimBound',
      'credentialDescriptorValidatorCompleted',
      'producerDescriptorValidatorCompleted',
      'processExitedZero',
      'processStderrEmpty',
      'readOnlyProducerBoundaryBound',
      'artifactCanonicalReadback',
      'receiptCanonicalReadback',
    ]) ||
    Object.values(value.bindings).some((entry) => entry !== true) ||
    !exactKeys(value.limitations, [
      'hostCollaboratorCompositionNotAttested',
      'independentArtifactPinNotAttested',
      'organizationalIndependenceNotAttested',
      'cleanCloneProvenanceSemanticsNotAttested',
      'trustedInventoryDesignationNotGranted',
    ]) ||
    Object.values(value.limitations).some((entry) => entry !== true) ||
    !exactKeys(value.authorizes, [
      'trustedInventoryDesignation',
      'roleCreation',
      'roleSplit',
      'aclMutation',
      'sharedDatabaseMutation',
      'migration',
      'deploy',
      'activation',
    ]) ||
    Object.values(value.authorizes).some((entry) => entry !== false)
  )
    fail('RECEIPT_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt(
  value: CommunitiesStagingRoleSplitTrustedInventoryReceipt,
): string {
  assertCommunitiesStagingRoleSplitTrustedInventoryReceipt(value);
  return canonicalText(value);
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryReceipt(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryReceipt {
  return parseCanonical(text, assertCommunitiesStagingRoleSplitTrustedInventoryReceipt);
}

export function communitiesStagingRoleSplitTrustedInventoryReceiptSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryReceipt,
): string {
  return sha256(canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt(value));
}
