import { createHash } from 'node:crypto';

import {
  canonicalCommunitiesStagingRoleSplitHostAuthorization,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitHostBindingCode,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesStagingRoleSplitHostBindingEvidence,
  parseCommunitiesStagingRoleSplitHostAuthorization,
} from './communities-staging-role-split-host-authorization-loader.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const evidence = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [
    code,
    Buffer.from(`evidence:${code}\n`, 'utf8'),
  ]),
) as Record<CommunitiesStagingRoleSplitHostBindingCode, Buffer>;
const execution = {
  cloneDatabaseOid: '45678',
  connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
  restoreLogin: { name: 'phub_restore', oid: '16384' },
  pgRestoreSha256: sha('pg_restore'),
  canonicalHostAdapterSha256: sha('canonical adapter'),
  cloneOnlyConnectionFactorySha256: sha('connection factory'),
  ddlFenceSha256: sha('ddl fence'),
} as const;
const subjects = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [code, sha(`subject:${code}`)]),
) as Record<CommunitiesStagingRoleSplitHostBindingCode, string>;
subjects.CANONICAL_PARTIAL_FAILURE_HOST_ADAPTER = execution.canonicalHostAdapterSha256;
subjects.CLONE_ONLY_CONNECTION_FACTORY = execution.cloneOnlyConnectionFactorySha256;
subjects.CLUSTER_DDL_FENCE = execution.ddlFenceSha256;
subjects.OPERATOR_SELECTED_SOURCE_AND_CLONE_CONNECTIONS =
  communitiesStagingRoleSplitConnectionSubjectSha256(execution);
subjects.PG_RESTORE_EXECUTABLE_SHA256 = execution.pgRestoreSha256;
subjects.RESTORE_LOGIN_ROLE = communitiesStagingRoleSplitRestoreLoginSubjectSha256(
  execution.restoreLogin,
);
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
    subjectSha256: subjects[code],
    evidenceSha256: sha(evidence[code]),
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

describe('communities role-split host authorization loader', () => {
  it('accepts only canonical receipt bytes under an independently supplied digest', () => {
    const bytes = Buffer.from(
      canonicalCommunitiesStagingRoleSplitHostAuthorization(authorization),
      'utf8',
    );
    expect(parseCommunitiesStagingRoleSplitHostAuthorization(bytes, sha(bytes))).toEqual(
      authorization,
    );
    const pretty = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`, 'utf8');
    expect(() => parseCommunitiesStagingRoleSplitHostAuthorization(pretty, sha(pretty))).toThrow(
      /AUTHORIZATION_INVALID/u,
    );
  });

  it('requires all twelve independently custodied evidence byte streams exactly once', () => {
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(authorization, evidence),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(authorization, {
        ...evidence,
        CLUSTER_DDL_FENCE: Buffer.from('changed\n', 'utf8'),
      }),
    ).toThrow(/EVIDENCE_INVALID/u);
    const missing = { ...evidence };
    delete (missing as Partial<typeof missing>).STAGING_KNOWN_HOSTS_PIN;
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(authorization, missing),
    ).toThrow(/EVIDENCE_INVALID/u);
  });
});
