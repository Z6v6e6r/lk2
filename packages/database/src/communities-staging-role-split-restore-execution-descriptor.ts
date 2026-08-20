import { createHash } from 'node:crypto';

import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION =
  'communities-staging-role-split-restore-execution-descriptor-v1';

export interface CommunitiesStagingRoleSplitRestoreExecutionDescriptor {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION;
  readonly mode: 'CODE_ONLY_DISABLED';
  readonly markerRequestSha256: string;
  readonly creationReceiptSha256: string;
  readonly cloneDatabaseOid: string;
  readonly connection: {
    readonly host: '127.0.0.1' | '::1';
    readonly port: string;
    readonly sslMode: 'disable';
  };
  readonly identity: {
    readonly connectionLogin: { readonly name: string; readonly oid: string };
    readonly restoreRole: { readonly name: string; readonly oid: string };
    readonly relation: 'SAME';
  };
  readonly pgRestoreSha256: string;
  readonly pgpassBasename: string;
  readonly sourceWriteDenialEvidenceSha256: string;
  readonly timeouts: { readonly preflightMs: number; readonly restoreMs: number };
  readonly authorizes: {
    readonly execution: false;
    readonly cloneCreation: false;
    readonly restore: false;
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

const descriptorKeys = [
  'schemaVersion',
  'mode',
  'markerRequestSha256',
  'creationReceiptSha256',
  'cloneDatabaseOid',
  'connection',
  'identity',
  'pgRestoreSha256',
  'pgpassBasename',
  'sourceWriteDenialEvidenceSha256',
  'timeouts',
  'authorizes',
] as const;
const connectionKeys = ['host', 'port', 'sslMode'] as const;
const identityKeys = ['connectionLogin', 'restoreRole', 'relation'] as const;
const principalKeys = ['name', 'oid'] as const;
const timeoutKeys = ['preflightMs', 'restoreMs'] as const;
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
] as const;
const sha256 = /^[a-f0-9]{64}$/;
const positiveDecimal = /^[1-9][0-9]*$/;
const name = /^[a-z_][a-z0-9_]{0,62}$/;
const basename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`RESTORE_EXECUTION_DESCRIPTOR_${code}`);
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

export function assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor(
  input: CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
): void {
  if (!hasExactKeys(input, descriptorKeys)) fail('SHAPE_INVALID');
  if (
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_EXECUTION_DESCRIPTOR_VERSION ||
    input.mode !== 'CODE_ONLY_DISABLED' ||
    ![
      input.markerRequestSha256,
      input.creationReceiptSha256,
      input.pgRestoreSha256,
      input.sourceWriteDenialEvidenceSha256,
    ].every((value) => sha256.test(value)) ||
    !positiveDecimal.test(input.cloneDatabaseOid) ||
    !hasExactKeys(input.connection, connectionKeys) ||
    !(['127.0.0.1', '::1'] as const).includes(input.connection.host) ||
    !positiveDecimal.test(input.connection.port) ||
    Number(input.connection.port) > 65535 ||
    input.connection.sslMode !== 'disable' ||
    !hasExactKeys(input.identity, identityKeys) ||
    !hasExactKeys(input.identity.connectionLogin, principalKeys) ||
    !hasExactKeys(input.identity.restoreRole, principalKeys) ||
    !name.test(input.identity.connectionLogin.name) ||
    !name.test(input.identity.restoreRole.name) ||
    !positiveDecimal.test(input.identity.connectionLogin.oid) ||
    !positiveDecimal.test(input.identity.restoreRole.oid) ||
    input.identity.relation !== 'SAME' ||
    input.identity.connectionLogin.name !== input.identity.restoreRole.name ||
    input.identity.connectionLogin.oid !== input.identity.restoreRole.oid ||
    !basename.test(input.pgpassBasename) ||
    input.pgpassBasename === '.' ||
    input.pgpassBasename === '..' ||
    !hasExactKeys(input.timeouts, timeoutKeys) ||
    !Number.isSafeInteger(input.timeouts.preflightMs) ||
    input.timeouts.preflightMs < 1 ||
    input.timeouts.preflightMs > 60_000 ||
    !Number.isSafeInteger(input.timeouts.restoreMs) ||
    input.timeouts.restoreMs < 1 ||
    input.timeouts.restoreMs > 30 * 60_000 ||
    !hasExactKeys(input.authorizes, authorityKeys) ||
    !authorityKeys.every((key) => input.authorizes[key] === false)
  )
    fail('BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitRestoreExecutionDescriptor(
  input: CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
): string {
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitRestoreExecutionDescriptorSha256(
  input: CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitRestoreExecutionDescriptor(input), 'utf8')
    .digest('hex');
}
