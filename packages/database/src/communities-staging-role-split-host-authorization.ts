import { createHash } from 'node:crypto';

import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION =
  'communities-staging-role-split-host-authorization-v1';

export const COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES = [
  'BACKUP_CUSTODY_HANDOFF',
  'CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER',
  'CLONE_ONLY_CONNECTION_FACTORY',
  'CLUSTER_DDL_FENCE',
  'DEDICATED_FORCED_COMMAND_PUBLIC_KEY',
  'INDEPENDENT_EVIDENCE_SINK',
  'OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS',
  'OWNERSHIP_ACL_ATTESTATION',
  'PG_RESTORE_EXECUTABLE_SHA256',
  'RESTORE_LOGIN_ROLE',
  'SOURCE_WRITE_DENIAL_ATTESTATION',
  'STAGING_KNOWN_HOSTS_PIN',
] as const;

export type CommunitiesStagingRoleSplitHostBindingCode =
  (typeof COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES)[number];

type CommunitiesStagingRoleSplitHostBinding = {
  readonly code: CommunitiesStagingRoleSplitHostBindingCode;
  readonly status: 'VERIFIED';
  readonly subjectSha256: string;
  readonly evidenceSha256: string;
};

export interface CommunitiesStagingRoleSplitHostAuthorization {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION;
  readonly status: 'REVIEWED';
  readonly candidateCommitSha: string;
  readonly markerRequestSha256: string;
  readonly creationReceiptSha256: string;
  readonly execution: {
    readonly cloneDatabaseOid: string;
    readonly connection: {
      readonly host: '127.0.0.1' | '::1';
      readonly port: string;
      readonly sslMode: 'disable';
    };
    readonly restoreLogin: { readonly name: string; readonly oid: string };
    readonly pgRestoreSha256: string;
    readonly canonicalHostAdapterSha256: string;
    readonly cloneOnlyConnectionFactorySha256: string;
    readonly ddlFenceSha256: string;
  };
  readonly bindings: readonly CommunitiesStagingRoleSplitHostBinding[];
  readonly authorizes: {
    readonly restoreExecution: true;
    readonly markerWrite: true;
    readonly evidencePublication: true;
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

const sha256 = /^[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const authorizationKeys = [
  'schemaVersion',
  'status',
  'candidateCommitSha',
  'markerRequestSha256',
  'creationReceiptSha256',
  'execution',
  'bindings',
  'authorizes',
] as const;
const executionKeys = [
  'cloneDatabaseOid',
  'connection',
  'restoreLogin',
  'pgRestoreSha256',
  'canonicalHostAdapterSha256',
  'cloneOnlyConnectionFactorySha256',
  'ddlFenceSha256',
] as const;
const connectionKeys = ['host', 'port', 'sslMode'] as const;
const principalKeys = ['name', 'oid'] as const;
const bindingKeys = ['code', 'status', 'subjectSha256', 'evidenceSha256'] as const;
const authorityKeys = [
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
const positiveDecimal = /^[1-9][0-9]*$/u;
const roleName = /^[a-z_][a-z0-9_]{0,62}$/u;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`HOST_AUTHORIZATION_${code}`);
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

export function assertCommunitiesStagingRoleSplitHostAuthorization(
  input: CommunitiesStagingRoleSplitHostAuthorization,
): void {
  const rawBindings: unknown = (input as unknown as Record<string, unknown>).bindings;
  if (
    !hasExactKeys(input, authorizationKeys) ||
    input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION ||
    input.status !== 'REVIEWED' ||
    !commitSha.test(input.candidateCommitSha) ||
    !sha256.test(input.markerRequestSha256) ||
    !sha256.test(input.creationReceiptSha256) ||
    !hasExactKeys(input.execution, executionKeys) ||
    !positiveDecimal.test(input.execution.cloneDatabaseOid) ||
    !hasExactKeys(input.execution.connection, connectionKeys) ||
    !(['127.0.0.1', '::1'] as const).includes(input.execution.connection.host) ||
    !positiveDecimal.test(input.execution.connection.port) ||
    Number(input.execution.connection.port) > 65535 ||
    input.execution.connection.sslMode !== 'disable' ||
    !hasExactKeys(input.execution.restoreLogin, principalKeys) ||
    !roleName.test(input.execution.restoreLogin.name) ||
    !positiveDecimal.test(input.execution.restoreLogin.oid) ||
    ![
      input.execution.pgRestoreSha256,
      input.execution.canonicalHostAdapterSha256,
      input.execution.cloneOnlyConnectionFactorySha256,
      input.execution.ddlFenceSha256,
    ].every((value) => sha256.test(value)) ||
    !Array.isArray(rawBindings) ||
    rawBindings.length !== COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.length ||
    !hasExactKeys(input.authorizes, authorityKeys)
  )
    fail('SHAPE_INVALID');

  const validatedBindings: CommunitiesStagingRoleSplitHostBinding[] = [];
  for (const [index, expectedCode] of COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.entries()) {
    const binding: unknown = rawBindings[index];
    if (
      !isRecord(binding) ||
      !hasExactKeys(binding, bindingKeys) ||
      binding.code !== expectedCode ||
      binding.status !== 'VERIFIED' ||
      typeof binding.subjectSha256 !== 'string' ||
      !sha256.test(binding.subjectSha256) ||
      typeof binding.evidenceSha256 !== 'string' ||
      !sha256.test(binding.evidenceSha256)
    )
      fail('BINDING_INVALID');
    validatedBindings.push(binding as CommunitiesStagingRoleSplitHostBinding);
  }

  const bindingByCode = new Map(validatedBindings.map((entry) => [entry.code, entry]));
  if (
    bindingByCode.get('CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER')?.subjectSha256 !==
      input.execution.canonicalHostAdapterSha256 ||
    bindingByCode.get('CLONE_ONLY_CONNECTION_FACTORY')?.subjectSha256 !==
      input.execution.cloneOnlyConnectionFactorySha256 ||
    bindingByCode.get('CLUSTER_DDL_FENCE')?.subjectSha256 !== input.execution.ddlFenceSha256 ||
    bindingByCode.get('PG_RESTORE_EXECUTABLE_SHA256')?.subjectSha256 !==
      input.execution.pgRestoreSha256 ||
    bindingByCode.get('RESTORE_LOGIN_ROLE')?.subjectSha256 !==
      communitiesStagingRoleSplitRestoreLoginSubjectSha256(input.execution.restoreLogin) ||
    bindingByCode.get('OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS')?.subjectSha256 !==
      communitiesStagingRoleSplitConnectionSubjectSha256(input.execution)
  )
    fail('BINDING_INVALID');

  if (
    input.authorizes.restoreExecution !== true ||
    input.authorizes.markerWrite !== true ||
    input.authorizes.evidencePublication !== true ||
    authorityKeys
      .filter(
        (key) =>
          key !== 'restoreExecution' && key !== 'markerWrite' && key !== 'evidencePublication',
      )
      .some((key) => input.authorizes[key] !== false)
  )
    fail('AUTHORITY_INVALID');
}

export function communitiesStagingRoleSplitRestoreLoginSubjectSha256(
  input: CommunitiesStagingRoleSplitHostAuthorization['execution']['restoreLogin'],
): string {
  return createHash('sha256')
    .update(`${canonicalJson(input)}\n`, 'utf8')
    .digest('hex');
}

export function communitiesStagingRoleSplitConnectionSubjectSha256(
  input: Pick<
    CommunitiesStagingRoleSplitHostAuthorization['execution'],
    'cloneDatabaseOid' | 'connection' | 'restoreLogin'
  >,
): string {
  return createHash('sha256')
    .update(`${canonicalJson(input)}\n`, 'utf8')
    .digest('hex');
}

export function canonicalCommunitiesStagingRoleSplitHostAuthorization(
  input: CommunitiesStagingRoleSplitHostAuthorization,
): string {
  assertCommunitiesStagingRoleSplitHostAuthorization(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitHostAuthorizationSha256(
  input: CommunitiesStagingRoleSplitHostAuthorization,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitHostAuthorization(input), 'utf8')
    .digest('hex');
}
