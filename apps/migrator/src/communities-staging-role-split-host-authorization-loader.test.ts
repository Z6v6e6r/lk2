import { createHash } from 'node:crypto';

import {
  canonicalCommunitiesStagingRoleSplitHostBindingEvidence,
  canonicalCommunitiesStagingRoleSplitHostAuthorization,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_EVIDENCE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES,
  communitiesStagingRoleSplitConnectionSubjectSha256,
  communitiesStagingRoleSplitExecutionSubjectSha256,
  communitiesStagingRoleSplitRestoreLoginSubjectSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitHostBindingEvidence as HostBindingEvidence,
  type CommunitiesStagingRoleSplitHostBindingCode,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesStagingRoleSplitHostBindingEvidence,
  parseCommunitiesStagingRoleSplitHostAuthorization,
} from './communities-staging-role-split-host-authorization-loader.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
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
const candidateCommitSha = 'a'.repeat(40);
const markerRequestSha256 = sha('request');
const creationReceiptSha256 = sha('receipt');
const evidencePaths = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [
    code,
    `/run/phub/role-split/${code}.json`,
  ]),
) as Record<CommunitiesStagingRoleSplitHostBindingCode, string>;
const bindingEvidence = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => {
    const envelope = {
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_EVIDENCE_VERSION,
      code,
      candidateCommitSha,
      markerRequestSha256,
      creationReceiptSha256,
      executionSubjectSha256: communitiesStagingRoleSplitExecutionSubjectSha256(execution),
      subjectSha256: subjects[code],
      payloadSha256: sha(`payload:${code}`),
      evidencePathSha256: sha(`${evidencePaths[code]}\n`),
    } as const satisfies HostBindingEvidence;
    return [code, envelope];
  }),
) as Record<CommunitiesStagingRoleSplitHostBindingCode, HostBindingEvidence>;
const evidence = Object.fromEntries(
  COMMUNITIES_STAGING_ROLE_SPLIT_HOST_BINDING_CODES.map((code) => [
    code,
    Buffer.from(
      canonicalCommunitiesStagingRoleSplitHostBindingEvidence(bindingEvidence[code]),
      'utf8',
    ),
  ]),
) as Record<CommunitiesStagingRoleSplitHostBindingCode, Buffer>;
const authorization = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_HOST_AUTHORIZATION_VERSION,
  status: 'REVIEWED',
  candidateCommitSha,
  markerRequestSha256,
  creationReceiptSha256,
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
      assertCommunitiesStagingRoleSplitHostBindingEvidence(authorization, evidence, evidencePaths),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(
        authorization,
        { ...evidence, CLUSTER_DDL_FENCE: Buffer.from('changed\n', 'utf8') },
        evidencePaths,
      ),
    ).toThrow(/EVIDENCE_INVALID/u);
    const missing = { ...evidence };
    delete (missing as Partial<typeof missing>).STAGING_KNOWN_HOSTS_PIN;
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(authorization, missing, evidencePaths),
    ).toThrow(/EVIDENCE_INVALID/u);
  });

  it('rejects canonically re-signed evidence from a different request context', () => {
    const changed = {
      ...bindingEvidence.BACKUP_CUSTODY_HANDOFF,
      markerRequestSha256: sha('other request'),
    };
    const changedBytes = Buffer.from(
      canonicalCommunitiesStagingRoleSplitHostBindingEvidence(changed),
      'utf8',
    );
    const changedAuthorization = {
      ...authorization,
      bindings: authorization.bindings.map((binding) =>
        binding.code === 'BACKUP_CUSTODY_HANDOFF'
          ? { ...binding, evidenceSha256: sha(changedBytes) }
          : binding,
      ),
    };
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(
        changedAuthorization,
        { ...evidence, BACKUP_CUSTODY_HANDOFF: changedBytes },
        evidencePaths,
      ),
    ).toThrow(/EVIDENCE_INVALID/u);
  });

  it('rejects legacy opaque evidence even when its digest is copied into the authorization', () => {
    const opaque = Buffer.from('legacy opaque evidence\n', 'utf8');
    const changedAuthorization = {
      ...authorization,
      bindings: authorization.bindings.map((binding) =>
        binding.code === 'BACKUP_CUSTODY_HANDOFF'
          ? { ...binding, evidenceSha256: sha(opaque) }
          : binding,
      ),
    };
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(
        changedAuthorization,
        { ...evidence, BACKUP_CUSTODY_HANDOFF: opaque },
        evidencePaths,
      ),
    ).toThrow(/EVIDENCE_INVALID/u);
  });

  it('rejects an evidence file moved out of its independently reviewed custody path', () => {
    expect(() =>
      assertCommunitiesStagingRoleSplitHostBindingEvidence(authorization, evidence, {
        ...evidencePaths,
        INDEPENDENT_EVIDENCE_SINK: '/tmp/copied-evidence.json',
      }),
    ).toThrow(/EVIDENCE_INVALID/u);
  });
});
