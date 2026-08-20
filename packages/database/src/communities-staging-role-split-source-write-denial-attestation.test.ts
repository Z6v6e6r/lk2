import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from './index.js';
import { canonicalCommunitiesStagingRoleSplitRestoreExecutionDescriptor } from './communities-staging-role-split-restore-execution-descriptor.js';
import {
  communitiesSourceConnectAclObservationSha256,
  communitiesSourceMembershipObservationSha256,
  type CommunitiesSourceConnectAclObservation,
  type CommunitiesSourceMembershipObservation,
} from './communities-staging-role-split-source-write-denial-observations.js';
import {
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding,
  canonicalCommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  communitiesStagingRoleSplitSourceWriteDenialAttestationSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_SOURCE_WRITE_DENIAL_ATTESTATION_VERSION,
  type CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
} from './communities-staging-role-split-source-write-denial-attestation.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const request = {
  restoreDatabase: 'phub_restore_123_4',
  expectedCloneDatabaseOwner: 'phub_restore',
  expectedCloneDatabaseOwnerOid: '16386',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16384',
  systemIdentifier: '7421000000000000000',
  backupBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump',
  backupSha256: sha('archive'),
  backupBytes: '7',
  backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
  backupEvidenceSha256: sha('evidence'),
  archiveTocSha256: sha('toc'),
  sourceLedgerSha256: communitiesStagingRoleSplitLedgerSha256([
    { filename: '0001_initial.sql', checksum: 'a'.repeat(64) },
  ]),
  sourceLedgerCount: '1',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: '2'.repeat(64),
  markerWriterSha256: '3'.repeat(64),
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;

const connectAclObservation = {
  schemaVersion: 'communities-staging-role-split-source-connect-acl-observation-v1',
  databaseOid: request.sourceDatabaseOid,
  databaseOwnerOid: request.sourceDatabaseOwnerOid,
  aclState: 'EXPLICIT',
  rows: [],
} as const satisfies CommunitiesSourceConnectAclObservation;
const membershipObservation = {
  schemaVersion: 'communities-staging-role-split-restore-principal-membership-observation-v1',
  principalOid: '16386',
  rows: [],
} as const satisfies CommunitiesSourceMembershipObservation;

const attestation = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_SOURCE_WRITE_DENIAL_ATTESTATION_VERSION,
  status: 'SOURCE_CONNECT_DENIED',
  markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
  systemIdentifier: request.systemIdentifier,
  postgresMajor: '16',
  sourceDatabase: {
    name: request.sourceDatabase,
    oid: request.sourceDatabaseOid,
    owner: { name: request.sourceDatabaseOwner, oid: request.sourceDatabaseOwnerOid },
    connectAclObservationSha256:
      communitiesSourceConnectAclObservationSha256(connectAclObservation),
  },
  restorePrincipal: {
    name: 'phub_restore',
    oid: '16386',
    membershipObservationSha256:
      communitiesSourceMembershipObservationSha256(membershipObservation),
    attributes: {
      superuser: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
    },
  },
  checks: { owner: false, effectiveConnect: false, rejectedBeforeQuery: true, sqlState: '42501' },
  authorizes: {
    execution: false,
    cloneCreation: false,
    restore: false,
    markerWrite: false,
    evidencePublication: false,
    automaticCleanup: false,
    roleCreation: false,
    roleSplit: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    import: false,
    activation: false,
  },
} as const satisfies CommunitiesStagingRoleSplitSourceWriteDenialAttestation;

function descriptor(
  sourceWriteDenialEvidenceSha256 = communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(
    attestation,
  ),
): CommunitiesStagingRoleSplitRestoreExecutionDescriptor {
  return {
    schemaVersion: 'communities-staging-role-split-restore-execution-descriptor-v1',
    mode: 'CODE_ONLY_DISABLED',
    markerRequestSha256: communitiesStagingRoleSplitRestoreMarkerRequestSha256(request),
    creationReceiptSha256: sha('receipt'),
    cloneDatabaseOid: '45678',
    connection: { host: '127.0.0.1', port: '5432', sslMode: 'disable' },
    identity: {
      connectionLogin: {
        name: attestation.restorePrincipal.name,
        oid: attestation.restorePrincipal.oid,
      },
      restoreRole: {
        name: attestation.restorePrincipal.name,
        oid: attestation.restorePrincipal.oid,
      },
      relation: 'SAME',
    },
    pgRestoreSha256: sha('pg_restore'),
    pgpassBasename: 'role-split.pgpass',
    sourceWriteDenialEvidenceSha256,
    timeouts: { preflightMs: 10_000, restoreMs: 600_000 },
    authorizes: attestation.authorizes,
  };
}

describe('CommunitiesStagingRoleSplitSourceWriteDenialAttestation', () => {
  it('constructs acyclic canonical evidence and binds it one way to the descriptor', () => {
    const canonical = canonicalCommunitiesStagingRoleSplitSourceWriteDenialAttestation(attestation);
    expect(canonical.startsWith('{"authorizes":')).toBe(true);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(attestation)).toBe(
      '9cf44c3a1a7a9fd7c403f76f891a6857ac002ea77aed972c7743c50cf5762e1b',
    );
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
        request,
        descriptor: descriptor(),
        attestation,
        connectAclObservation,
        membershipObservation,
      }),
    ).not.toThrow();
  });

  it('rejects an execution-descriptor digest key and evidence mutations', () => {
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation({
        ...attestation,
        executionDescriptorSha256: sha('descriptor'),
      } as CommunitiesStagingRoleSplitSourceWriteDenialAttestation),
    ).toThrow(/SOURCE_WRITE_DENIAL_ATTESTATION_SHAPE_INVALID/);
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
        request,
        descriptor: descriptor(),
        attestation: {
          ...attestation,
          sourceDatabase: {
            ...attestation.sourceDatabase,
            connectAclObservationSha256: sha('changed acl'),
          },
        },
        connectAclObservation,
        membershipObservation,
      }),
    ).toThrow(/SOURCE_WRITE_DENIAL_ATTESTATION_CROSS_BINDING_INVALID/);
  });

  it('rejects NULL_DEFAULT source ACLs even when no rows are present', () => {
    const nullDefaultObservation = {
      ...connectAclObservation,
      aclState: 'NULL_DEFAULT',
    } as const satisfies CommunitiesSourceConnectAclObservation;
    const nullDefaultAttestation = {
      ...attestation,
      sourceDatabase: {
        ...attestation.sourceDatabase,
        connectAclObservationSha256:
          communitiesSourceConnectAclObservationSha256(nullDefaultObservation),
      },
    } as const satisfies CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
        request,
        descriptor: descriptor(
          communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(nullDefaultAttestation),
        ),
        attestation: nullDefaultAttestation,
        connectAclObservation: nullDefaultObservation,
        membershipObservation,
      }),
    ).toThrow(/SOURCE_WRITE_DENIAL_ATTESTATION_CROSS_BINDING_INVALID/);
  });

  it.each([
    [
      'dangerous superuser attribute',
      {
        ...attestation,
        restorePrincipal: {
          ...attestation.restorePrincipal,
          attributes: { ...attestation.restorePrincipal.attributes, superuser: true },
        },
      },
    ],
    [
      'effective CONNECT',
      { ...attestation, checks: { ...attestation.checks, effectiveConnect: true } },
    ],
    ['wrong SQLSTATE', { ...attestation, checks: { ...attestation.checks, sqlState: '00000' } }],
    [
      'execution authority',
      { ...attestation, authorizes: { ...attestation.authorizes, execution: true } },
    ],
  ])('rejects unsafe %s attestation values', (_name, invalid) => {
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestation(
        invalid as unknown as CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
      ),
    ).toThrow(/SOURCE_WRITE_DENIAL_ATTESTATION_BINDING_INVALID/);
  });

  const bindingChanges: readonly [
    string,
    () => CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  ][] = [
    ['marker request SHA', () => ({ ...attestation, markerRequestSha256: sha('wrong request') })],
    [
      'source name',
      () => ({
        ...attestation,
        sourceDatabase: { ...attestation.sourceDatabase, name: 'other_source' },
      }),
    ],
    [
      'source OID',
      () => ({ ...attestation, sourceDatabase: { ...attestation.sourceDatabase, oid: '16387' } }),
    ],
    [
      'source owner OID',
      () => ({
        ...attestation,
        sourceDatabase: {
          ...attestation.sourceDatabase,
          owner: { ...attestation.sourceDatabase.owner, oid: '16386' },
        },
      }),
    ],
    [
      'restore principal',
      () => ({
        ...attestation,
        restorePrincipal: { ...attestation.restorePrincipal, oid: '16387' },
      }),
    ],
    ['system identifier', () => ({ ...attestation, systemIdentifier: '7421000000000000001' })],
  ];
  it.each(bindingChanges)('rejects swapped %s bindings', (_name, makeAttestation) => {
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
        request,
        descriptor: descriptor(),
        attestation: makeAttestation(),
        connectAclObservation,
        membershipObservation,
      }),
    ).toThrow(/SOURCE_WRITE_DENIAL_ATTESTATION_(BINDING|CROSS_BINDING)_INVALID/);
  });

  it('permits descriptor differences outside the one-way evidence binding', () => {
    const first = descriptor();
    const second = {
      ...descriptor(),
      pgRestoreSha256: sha('another approved pg_restore'),
      timeouts: { preflightMs: 9_000, restoreMs: 599_000 },
    };
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
        request,
        descriptor: first,
        attestation,
        connectAclObservation,
        membershipObservation,
      }),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
        request,
        descriptor: second,
        attestation,
        connectAclObservation,
        membershipObservation,
      }),
    ).not.toThrow();
  });

  it('leaves the descriptor canonical contract reusable', () => {
    const existingDescriptor = descriptor();
    const canonical =
      canonicalCommunitiesStagingRoleSplitRestoreExecutionDescriptor(existingDescriptor);
    expect(canonical).toContain(
      `"sourceWriteDenialEvidenceSha256":"${communitiesStagingRoleSplitSourceWriteDenialAttestationSha256(attestation)}"`,
    );
    expect(canonical.endsWith('\n')).toBe(true);
  });
});
