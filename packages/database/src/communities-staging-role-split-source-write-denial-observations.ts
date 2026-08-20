import { createHash } from 'node:crypto';

import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_SOURCE_CONNECT_ACL_OBSERVATION_VERSION =
  'communities-staging-role-split-source-connect-acl-observation-v1';
export const COMMUNITIES_SOURCE_MEMBERSHIP_OBSERVATION_VERSION =
  'communities-staging-role-split-restore-principal-membership-observation-v1';

export interface CommunitiesSourceConnectAclObservation {
  readonly schemaVersion: typeof COMMUNITIES_SOURCE_CONNECT_ACL_OBSERVATION_VERSION;
  readonly databaseOid: string;
  readonly databaseOwnerOid: string;
  readonly aclState: 'EXPLICIT' | 'NULL_DEFAULT';
  readonly rows: readonly {
    readonly grantorOid: string;
    readonly granteeOid: string;
    readonly privilege: 'CONNECT';
    readonly grantable: boolean;
  }[];
}

export interface CommunitiesSourceMembershipObservation {
  readonly schemaVersion: typeof COMMUNITIES_SOURCE_MEMBERSHIP_OBSERVATION_VERSION;
  readonly principalOid: string;
  readonly rows: readonly {
    readonly roleOid: string;
    readonly memberOid: string;
    readonly grantorOid: string;
    readonly adminOption: boolean;
    readonly inheritOption: boolean;
    readonly setOption: boolean;
  }[];
}

const positiveDecimal = /^[1-9][0-9]*$/;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`SOURCE_WRITE_DENIAL_OBSERVATION_${code}`);
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

function comparePositiveDecimals(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return fail('VALUE_INVALID');
}

function compareAclRows(
  left: CommunitiesSourceConnectAclObservation['rows'][number],
  right: CommunitiesSourceConnectAclObservation['rows'][number],
): number {
  return (
    comparePositiveDecimals(left.granteeOid, right.granteeOid) ||
    comparePositiveDecimals(left.grantorOid, right.grantorOid) ||
    (left.privilege < right.privilege ? -1 : left.privilege > right.privilege ? 1 : 0) ||
    Number(left.grantable) - Number(right.grantable)
  );
}

function compareMembershipRows(
  left: CommunitiesSourceMembershipObservation['rows'][number],
  right: CommunitiesSourceMembershipObservation['rows'][number],
): number {
  return (
    comparePositiveDecimals(left.roleOid, right.roleOid) ||
    comparePositiveDecimals(left.memberOid, right.memberOid) ||
    comparePositiveDecimals(left.grantorOid, right.grantorOid) ||
    Number(left.adminOption) - Number(right.adminOption) ||
    Number(left.inheritOption) - Number(right.inheritOption) ||
    Number(left.setOption) - Number(right.setOption)
  );
}

export function assertCommunitiesSourceConnectAclObservation(
  input: CommunitiesSourceConnectAclObservation,
): void {
  if (
    !hasExactKeys(input, [
      'schemaVersion',
      'databaseOid',
      'databaseOwnerOid',
      'aclState',
      'rows',
    ]) ||
    input.schemaVersion !== COMMUNITIES_SOURCE_CONNECT_ACL_OBSERVATION_VERSION ||
    !positiveDecimal.test(input.databaseOid) ||
    !positiveDecimal.test(input.databaseOwnerOid) ||
    (input.aclState !== 'EXPLICIT' && input.aclState !== 'NULL_DEFAULT') ||
    !input.rows.every(
      (row, index) =>
        hasExactKeys(row, ['grantorOid', 'granteeOid', 'privilege', 'grantable']) &&
        positiveDecimal.test(row.grantorOid) &&
        (positiveDecimal.test(row.granteeOid) || row.granteeOid === '0') &&
        row.privilege === 'CONNECT' &&
        typeof row.grantable === 'boolean' &&
        (index === 0 || compareAclRows(input.rows[index - 1]!, row) < 0),
    )
  ) {
    fail('ACL_INVALID');
  }
}

export function canonicalCommunitiesSourceConnectAclObservation(
  input: CommunitiesSourceConnectAclObservation,
): string {
  assertCommunitiesSourceConnectAclObservation(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesSourceConnectAclObservationSha256(
  input: CommunitiesSourceConnectAclObservation,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesSourceConnectAclObservation(input), 'utf8')
    .digest('hex');
}

export function assertCommunitiesSourceMembershipObservation(
  input: CommunitiesSourceMembershipObservation,
): void {
  if (
    !hasExactKeys(input, ['schemaVersion', 'principalOid', 'rows']) ||
    input.schemaVersion !== COMMUNITIES_SOURCE_MEMBERSHIP_OBSERVATION_VERSION ||
    !positiveDecimal.test(input.principalOid) ||
    !input.rows.every(
      (row, index) =>
        hasExactKeys(row, [
          'roleOid',
          'memberOid',
          'grantorOid',
          'adminOption',
          'inheritOption',
          'setOption',
        ]) &&
        positiveDecimal.test(row.roleOid) &&
        positiveDecimal.test(row.memberOid) &&
        positiveDecimal.test(row.grantorOid) &&
        typeof row.adminOption === 'boolean' &&
        typeof row.inheritOption === 'boolean' &&
        typeof row.setOption === 'boolean' &&
        (row.roleOid === input.principalOid || row.memberOid === input.principalOid) &&
        (index === 0 || compareMembershipRows(input.rows[index - 1]!, row) < 0),
    )
  ) {
    fail('MEMBERSHIP_INVALID');
  }
}

export function canonicalCommunitiesSourceMembershipObservation(
  input: CommunitiesSourceMembershipObservation,
): string {
  assertCommunitiesSourceMembershipObservation(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesSourceMembershipObservationSha256(
  input: CommunitiesSourceMembershipObservation,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesSourceMembershipObservation(input), 'utf8')
    .digest('hex');
}
