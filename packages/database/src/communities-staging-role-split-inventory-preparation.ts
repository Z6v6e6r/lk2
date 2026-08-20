import { createHash } from 'node:crypto';

import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_VERSION =
  'communities-staging-role-split-inventory-preparation-v1';

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES = [
  'MARKER_REQUEST',
  'MARKER_EVIDENCE',
  'ROLE_MAPPING',
  'INDEPENDENT_SOURCE_PROVENANCE',
  'CONNECTION_DESCRIPTOR',
  'CREDENTIAL_CUSTODY',
  'EXECUTABLE_CUSTODY',
  'OUTPUT_CUSTODY',
] as const;

export type CommunitiesStagingRoleSplitInventoryPreparationInputCode =
  (typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES)[number];

export interface CommunitiesStagingRoleSplitInventoryPreparationInputBinding {
  readonly code: CommunitiesStagingRoleSplitInventoryPreparationInputCode;
  readonly pathSha256: string;
  readonly contentSha256: string;
}

export interface CommunitiesStagingRoleSplitInventoryPreparation {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_VERSION;
  readonly status: 'CODE_ONLY_DISABLED';
  readonly candidateCommitSha: string;
  readonly phase: 'BEFORE' | 'AFTER';
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly cloneDatabaseOid: string;
  readonly sourceDatabaseOid: string;
  readonly systemIdentifier: string;
  readonly inputs: readonly CommunitiesStagingRoleSplitInventoryPreparationInputBinding[];
  readonly outputArtifactPathSha256: string;
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

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const oidPattern = /^[1-9][0-9]*$/u;
const systemIdentifierPattern = /^[0-9]{10,32}$/u;
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

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`INVENTORY_PREPARATION_${code}`);
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

export function assertCommunitiesStagingRoleSplitInventoryPreparation(
  input: CommunitiesStagingRoleSplitInventoryPreparation,
): void {
  if (
    !hasExactKeys(input, [
      'schemaVersion',
      'status',
      'candidateCommitSha',
      'phase',
      'requestSha256',
      'creationReceiptSha256',
      'cloneDatabaseOid',
      'sourceDatabaseOid',
      'systemIdentifier',
      'inputs',
      'outputArtifactPathSha256',
      'authorizes',
    ]) ||
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_VERSION ||
    input.status !== 'CODE_ONLY_DISABLED' ||
    !commitPattern.test(input.candidateCommitSha) ||
    !['BEFORE', 'AFTER'].includes(input.phase) ||
    !sha256Pattern.test(input.requestSha256) ||
    !sha256Pattern.test(input.creationReceiptSha256) ||
    !oidPattern.test(input.cloneDatabaseOid) ||
    !oidPattern.test(input.sourceDatabaseOid) ||
    !systemIdentifierPattern.test(input.systemIdentifier) ||
    !sha256Pattern.test(input.outputArtifactPathSha256) ||
    !Array.isArray(Reflect.get(input, 'inputs')) ||
    input.inputs.length !==
      COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.length ||
    !hasExactKeys(input.authorizes, authorizationKeys) ||
    authorizationKeys.some((key) => input.authorizes[key] !== false)
  )
    fail('SHAPE_INVALID');

  input.inputs.forEach((binding, index) => {
    if (
      !hasExactKeys(binding, ['code', 'pathSha256', 'contentSha256']) ||
      binding.code !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES[index] ||
      !sha256Pattern.test(binding.pathSha256) ||
      !sha256Pattern.test(binding.contentSha256)
    )
      fail('INPUT_BINDING_INVALID');
  });
}

export function canonicalCommunitiesStagingRoleSplitInventoryPreparation(
  input: CommunitiesStagingRoleSplitInventoryPreparation,
): string {
  assertCommunitiesStagingRoleSplitInventoryPreparation(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitInventoryPreparationSha256(
  input: CommunitiesStagingRoleSplitInventoryPreparation,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitInventoryPreparation(input), 'utf8')
    .digest('hex');
}

export function parseCommunitiesStagingRoleSplitInventoryPreparation(
  input: string,
): CommunitiesStagingRoleSplitInventoryPreparation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail('PARSE_INVALID');
  }
  const preparation = parsed as CommunitiesStagingRoleSplitInventoryPreparation;
  assertCommunitiesStagingRoleSplitInventoryPreparation(preparation);
  if (canonicalCommunitiesStagingRoleSplitInventoryPreparation(preparation) !== input)
    fail('CANONICAL_ENCODING_INVALID');
  return preparation;
}
