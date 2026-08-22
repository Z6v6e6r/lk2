import { createHash } from 'node:crypto';

import { communitiesRoleSplitCanonicalJson } from './communities-role-split-input-c.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_VERSION =
  'communities-staging-role-split-trusted-inventory-gate-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
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

export interface CommunitiesStagingRoleSplitTrustedInventoryGate {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_VERSION;
  readonly status: 'PREPARED_FOR_SEPARATE_AUTHORIZATION_REVIEW';
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly installedCandidateReceiptSha256: string;
  readonly runtimeBundleSha256: string;
  readonly preparationSha256: string;
  readonly preparationVerificationSha256: string;
  readonly connectionDescriptorSha256: string;
  readonly producerExecutableSha256: string;
  readonly credentialDescriptorPathSha256: string;
  readonly producerDescriptorPathSha256: string;
  readonly outputDirectoryPathSha256: string;
  readonly outputArtifactPathSha256: string;
  readonly outputReceiptPathSha256: string;
  readonly markerRequestPathSha256: string;
  readonly markerEvidencePathSha256: string;
  readonly roleMappingPathSha256: string;
  readonly runtimeWiringVersion: 'communities-staging-role-split-trusted-inventory-runtime-wiring-v1';
  readonly collectionTimeoutMillis: 45_000;
  readonly terminationGraceMillis: 5_000;
  readonly authorizes: {
    readonly inventoryConnection: false;
    readonly inventoryRead: false;
    readonly artifactWrite: false;
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
  return failCommunitiesStagingRoleSplit(`TRUSTED_INVENTORY_GATE_${code}`);
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

function canonicalText(value: unknown): string {
  return `${communitiesRoleSplitCanonicalJson(value)}\n`;
}

export function assertCommunitiesStagingRoleSplitTrustedInventoryGate(
  value: CommunitiesStagingRoleSplitTrustedInventoryGate,
): void {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'phase',
      'installedCandidateReceiptSha256',
      'runtimeBundleSha256',
      'preparationSha256',
      'preparationVerificationSha256',
      'connectionDescriptorSha256',
      'producerExecutableSha256',
      'credentialDescriptorPathSha256',
      'producerDescriptorPathSha256',
      'outputDirectoryPathSha256',
      'outputArtifactPathSha256',
      'outputReceiptPathSha256',
      'markerRequestPathSha256',
      'markerEvidencePathSha256',
      'roleMappingPathSha256',
      'runtimeWiringVersion',
      'collectionTimeoutMillis',
      'terminationGraceMillis',
      'authorizes',
    ]) ||
    value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_VERSION ||
    value.status !== 'PREPARED_FOR_SEPARATE_AUTHORIZATION_REVIEW' ||
    !COMMIT.test(value.candidateCommitSha) ||
    !['BEFORE', 'AFTER'].includes(value.phase) ||
    [
      value.installedCandidateReceiptSha256,
      value.runtimeBundleSha256,
      value.preparationSha256,
      value.preparationVerificationSha256,
      value.connectionDescriptorSha256,
      value.producerExecutableSha256,
      value.credentialDescriptorPathSha256,
      value.producerDescriptorPathSha256,
      value.outputDirectoryPathSha256,
      value.outputArtifactPathSha256,
      value.outputReceiptPathSha256,
      value.markerRequestPathSha256,
      value.markerEvidencePathSha256,
      value.roleMappingPathSha256,
    ].some((entry) => !SHA256.test(entry)) ||
    value.runtimeWiringVersion !==
      'communities-staging-role-split-trusted-inventory-runtime-wiring-v1' ||
    value.collectionTimeoutMillis !== 45_000 ||
    value.terminationGraceMillis !== 5_000 ||
    !exactKeys(value.authorizes, authorizationKeys) ||
    authorizationKeys.some((key) => value.authorizes[key] !== false)
  )
    fail('INVALID');
}

export function canonicalCommunitiesStagingRoleSplitTrustedInventoryGate(
  value: CommunitiesStagingRoleSplitTrustedInventoryGate,
): string {
  assertCommunitiesStagingRoleSplitTrustedInventoryGate(value);
  return canonicalText(value);
}

export function parseCommunitiesStagingRoleSplitTrustedInventoryGate(
  text: string,
): CommunitiesStagingRoleSplitTrustedInventoryGate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('CANONICAL_INVALID');
  }
  assertCommunitiesStagingRoleSplitTrustedInventoryGate(
    parsed as CommunitiesStagingRoleSplitTrustedInventoryGate,
  );
  if (canonicalText(parsed) !== text) fail('CANONICAL_INVALID');
  return parsed as CommunitiesStagingRoleSplitTrustedInventoryGate;
}

export function communitiesStagingRoleSplitTrustedInventoryGateSha256(
  value: CommunitiesStagingRoleSplitTrustedInventoryGate,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitTrustedInventoryGate(value), 'utf8')
    .digest('hex');
}
