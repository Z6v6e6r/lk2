import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesStagingRoleSplitHostAuthorization,
  canonicalCommunitiesStagingRoleSplitHostAuthorization,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  type CommunitiesStagingRoleSplitHostAuthorization,
} from './communities-staging-role-split-host-authorization.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const execution = {
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  restoreLogin: { name: 'phub_restore', oid: '16384' },
  pgRestoreSha256: sha('pg_restore'),
  canonicalHostAdapterSha256: sha('canonical adapter'),
  cloneOnlyConnectionFactorySha256: sha('connection factory'),
  ddlFenceSha256: sha('ddl fence'),
} as const;
const subjects = {
  CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER: execution.canonicalHostAdapterSha256,
  CLONE_ONLY_CONNECTION_FACTORY: execution.cloneOnlyConnectionFactorySha256,
  CLUSTER_DDL_FENCE: execution.ddlFenceSha256,
  OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS:
    communitiesStagingRoleSplitConnectionSubjectSha256(execution),
  PG_RESTORE_EXECUTABLE_SHA256: execution.pgRestoreSha256,
  RESTORE_LOGIN_ROLE: communitiesStagingRoleSplitRestoreLoginSubjectSha256(execution.restoreLogin),
} as const;

const authorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  status: 'REVIEWED',
  candidateCommitSha: 'a'.repeat(40),
  markerRequestSha256: sha('request'),
  creationReceiptSha256: sha('receipt'),
  execution,
  bindings: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => ({
    code,
    status: 'VERIFIED' as const,
    subjectSha256:
      code in subjects ? subjects[code as keyof typeof subjects] : sha(`subject:${code}`),
    evidenceSha256: sha(`evidence:${code}`),
  })),
  authorizes: {
    restoreExecution: true,
    markerWrite: true,
    evidencePublication: true,
    automaticCleanup: false,
    roleCreation: false,
    roleSplit: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    import: false,
    activation: false,
  },
} as const satisfies CommunitiesStagingRoleSplitHostAuthorization;

describe('CommunitiesStagingRoleSplitHostAuthorization', () => {
  it('canonicalizes the exact independently pinned twelve-binding receipt', () => {
    const canonical = canonicalCommunitiesStagingRoleSplitHostAuthorization(authorization);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(communitiesStagingRoleSplitHostAuthorizationSha256(authorization)).toBe(sha(canonical));
    expect(authorization.bindings.map(({ code }) => code)).toEqual(
      COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
    );
  });

  it.each([
    ['extra key', { ...authorization, extra: true }],
    ['wrong request', { ...authorization, markerRequestSha256: '0' }],
    ['missing binding', { ...authorization, bindings: authorization.bindings.slice(1) }],
    [
      'reordered binding',
      {
        ...authorization,
        bindings: [
          authorization.bindings[1],
          authorization.bindings[0],
          ...authorization.bindings.slice(2),
        ],
      },
    ],
    [
      'unverified binding',
      {
        ...authorization,
        bindings: authorization.bindings.map((binding, index) =>
          index === 0 ? { ...binding, status: 'UNRESOLVED' } : binding,
        ),
      },
    ],
    [
      'cleanup authority',
      {
        ...authorization,
        authorizes: { ...authorization.authorizes, automaticCleanup: true },
      },
    ],
    [
      'restore denied',
      {
        ...authorization,
        authorizes: { ...authorization.authorizes, restoreExecution: false },
      },
    ],
  ])('rejects %s', (_name, invalid) => {
    expect(() =>
      assertCommunitiesStagingRoleSplitHostAuthorization(
        invalid as CommunitiesStagingRoleSplitHostAuthorization,
      ),
    ).toThrow(/HOST_AUTHORIZATION_/u);
  });
});
