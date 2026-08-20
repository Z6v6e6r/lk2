import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
} from './communities-staging-role-split-restore-execution-descriptor.js';
import {
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from './communities-staging-role-split-restore-marker.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';
import {
  assertCommunitiesSourceConnectAclObservation,
  assertCommunitiesSourceMembershipObservation,
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  type CommunitiesSourceConnectAclObservation,
  type CommunitiesSourceMembershipObservation,
} from './communities-staging-role-split-source-write-denial-observations.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_SOURCE_WRITE_DENIAL_ATTESTATION_VERSION =
  'communities-staging-role-split-source-write-denial-attestation-v1';

export interface CommunitiesStagingRoleSplitSourceWriteDenialAttestation {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_SOURCE_WRITE_DENIAL_ATTESTATION_VERSION;
  readonly status: 'SOURCE_CONNECT_DENIED';
  readonly markerRequestSha256: string;
  readonly systemIdentifier: string;
  readonly postgresMajor: '16';
  readonly sourceDatabase: {
    readonly name: string;
    readonly oid: string;
    readonly owner: { readonly name: string; readonly oid: string };
    readonly connectAclObservationSha256: string;
  };
  readonly restorePrincipal: {
    readonly name: string;
    readonly oid: string;
    readonly membershipObservationSha256: string;
    readonly attributes: {
      readonly superuser: false;
      readonly createRole: false;
      readonly createDatabase: false;
      readonly replication: false;
      readonly bypassRls: false;
    };
  };
  readonly checks: {
    readonly owner: false;
    readonly effectiveConnect: false;
    readonly rejectedBeforeQuery: true;
    readonly sqlState: '42501';
  };
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

const attestationKeys = [
  'schemaVersion',
  'status',
  'markerRequestSha256',
  'systemIdentifier',
  'postgresMajor',
  'sourceDatabase',
  'restorePrincipal',
  'checks',
  'authorizes',
] as const;
const sourceDatabaseKeys = ['name', 'oid', 'owner', 'connectAclObservationSha256'] as const;
const principalKeys = ['name', 'oid'] as const;
const restorePrincipalKeys = ['name', 'oid', 'membershipObservationSha256', 'attributes'] as const;
const attributesKeys = [
  'superuser',
  'createRole',
  'createDatabase',
  'replication',
  'bypassRls',
] as const;
const checksKeys = ['owner', 'effectiveConnect', 'rejectedBeforeQuery', 'sqlState'] as const;
const authorizesKeys = [
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
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`SOURCE_WRITE_DENIAL_ATTESTATION_${code}`);
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
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return fail('VALUE_INVALID');
}

export function assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation(
  input: CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
): void {
  if (!hasExactKeys(input, attestationKeys)) fail('SHAPE_INVALID');
  if (
    input.schemaVersion !==
      COMMUNITIES_STAGING_ROLE_SPLIT_SOURCE_WRITE_DENIAL_ATTESTATION_VERSION ||
    input.status !== 'SOURCE_CONNECT_DENIED' ||
    !sha256.test(input.markerRequestSha256) ||
    !positiveDecimal.test(input.systemIdentifier) ||
    input.postgresMajor !== '16' ||
    !hasExactKeys(input.sourceDatabase, sourceDatabaseKeys) ||
    !identifier.test(input.sourceDatabase.name) ||
    !positiveDecimal.test(input.sourceDatabase.oid) ||
    !hasExactKeys(input.sourceDatabase.owner, principalKeys) ||
    !identifier.test(input.sourceDatabase.owner.name) ||
    !positiveDecimal.test(input.sourceDatabase.owner.oid) ||
    !sha256.test(input.sourceDatabase.connectAclObservationSha256) ||
    !hasExactKeys(input.restorePrincipal, restorePrincipalKeys) ||
    !identifier.test(input.restorePrincipal.name) ||
    !positiveDecimal.test(input.restorePrincipal.oid) ||
    !sha256.test(input.restorePrincipal.membershipObservationSha256) ||
    !hasExactKeys(input.restorePrincipal.attributes, attributesKeys) ||
    !attributesKeys.every((key) => input.restorePrincipal.attributes[key] === false) ||
    !hasExactKeys(input.checks, checksKeys) ||
    input.checks.owner !== false ||
    input.checks.effectiveConnect !== false ||
    input.checks.rejectedBeforeQuery !== true ||
    input.checks.sqlState !== '42501' ||
    !hasExactKeys(input.authorizes, authorizesKeys) ||
    !authorizesKeys.every((key) => input.authorizes[key] === false)
  )
    fail('BINDING_INVALID');
}

export function canonicalCommunitiesStagingRoleSplitSourceWriteDenialAttestation(
  input: CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
): string {
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation(input);
  return `${canonicalJson(input)}\n`;
}

export function communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(
  input: CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
): string {
  return createHash('sha256')
    .update(canonicalCommunitiesStagingRoleSplitSourceWriteDenialAttestation(input), 'utf8')
    .digest('hex');
}

export function assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding(input: {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly descriptor: CommunitiesStagingRoleSplitRestoreExecutionDescriptor;
  readonly attestation: CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
  readonly connectAclObservation: CommunitiesSourceConnectAclObservation;
  readonly membershipObservation: CommunitiesSourceMembershipObservation;
}): void {
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor(input.descriptor);
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation(input.attestation);
  assertCommunitiesSourceConnectAclObservation(input.connectAclObservation);
  assertCommunitiesSourceMembershipObservation(input.membershipObservation);
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request);
  const attestationSha256 = communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(
    input.attestation,
  );
  if (
    input.descriptor.markerRequestSha256 !== requestSha256 ||
    input.attestation.markerRequestSha256 !== requestSha256 ||
    input.descriptor.sourceWriteDenialEvidenceSha256 !== attestationSha256 ||
    input.attestation.sourceDatabase.connectAclObservationSha256 !==
      communitiesSourceConnectAclObservationSha256(input.connectAclObservation) ||
    input.attestation.restorePrincipal.membershipObservationSha256 !==
      communitiesSourceMembershipObservationSha256(input.membershipObservation) ||
    input.connectAclObservation.databaseOid !== input.request.sourceDatabaseOid ||
    input.connectAclObservation.databaseOwnerOid !== input.request.sourceDatabaseOwnerOid ||
    input.connectAclObservation.aclState !== 'EXPLICIT' ||
    input.membershipObservation.principalOid !== input.descriptor.identity.restoreRole.oid ||
    input.membershipObservation.rows.length !== 0 ||
    input.connectAclObservation.rows.some(
      (row) =>
        row.granteeOid === '0' || row.granteeOid === input.descriptor.identity.restoreRole.oid,
    ) ||
    input.attestation.systemIdentifier !== input.request.systemIdentifier ||
    input.attestation.postgresMajor !== input.request.postgresMajor ||
    input.attestation.sourceDatabase.name !== input.request.sourceDatabase ||
    input.attestation.sourceDatabase.oid !== input.request.sourceDatabaseOid ||
    input.attestation.sourceDatabase.owner.name !== input.request.sourceDatabaseOwner ||
    input.attestation.sourceDatabase.owner.oid !== input.request.sourceDatabaseOwnerOid ||
    input.attestation.restorePrincipal.name !== input.descriptor.identity.connectionLogin.name ||
    input.attestation.restorePrincipal.oid !== input.descriptor.identity.connectionLogin.oid ||
    input.attestation.restorePrincipal.name !== input.descriptor.identity.restoreRole.name ||
    input.attestation.restorePrincipal.oid !== input.descriptor.identity.restoreRole.oid ||
    input.attestation.restorePrincipal.oid === input.request.sourceDatabaseOwnerOid
  )
    fail('CROSS_BINDING_INVALID');
}
