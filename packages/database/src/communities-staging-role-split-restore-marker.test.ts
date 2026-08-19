import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesStagingRoleSplitRestoreMarker,
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  canonicalCommunitiesStagingRoleSplitLedger,
  canonicalCommunitiesStagingRoleSplitRestoreMarkerPayload,
  communitiesStagingRoleSplitLedgerSha256,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_VERSION,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
} from './communities-staging-role-split-restore-marker.js';
import { COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256 } from './communities-staging-role-split.js';

const sha = (value: string) => value.repeat(64);
const payload = {
  requestSha256: sha('a'),
  restoreDatabase: 'phub_restore_123_4',
  cloneDatabaseOid: '45678',
  cloneDatabaseOwner: 'phub_staging',
  cloneDatabaseOwnerOid: '16384',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16384',
  systemIdentifier: '7421000000000000000',
  backupSha256: sha('b'),
  backupBytes: '1048576',
  backupEvidenceSha256: sha('c'),
  archiveTocSha256: sha('d'),
  sourceLedgerSha256: sha('e'),
  sourceLedgerCount: '91',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: sha('2'),
  markerWriterSha256: sha('3'),
} satisfies CommunitiesStagingRoleSplitRestoreMarkerPayload;

const expectedCanonical = `${COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_VERSION}
requestSha256=${sha('a')}
restoreDatabase=phub_restore_123_4
cloneDatabaseOid=45678
cloneDatabaseOwner=phub_staging
cloneDatabaseOwnerOid=16384
sourceDatabase=phub_staging
sourceDatabaseOid=16385
sourceDatabaseOwner=phub_staging
sourceDatabaseOwnerOid=16384
systemIdentifier=7421000000000000000
backupSha256=${sha('b')}
backupBytes=1048576
backupEvidenceSha256=${sha('c')}
archiveTocSha256=${sha('d')}
sourceLedgerSha256=${sha('e')}
sourceLedgerCount=91
activeRelease=${'f'.repeat(40)}
restoreRunId=123
restoreRunAttempt=4
postgresMajor=16
objectManifestSha256=${COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256}
restoreHelperSha256=${sha('2')}
markerWriterSha256=${sha('3')}
`;

const evidence = {
  schemaVersion: 'communities-role-split-clone-marker-evidence-v1',
  status: 'MARKED',
  requestSha256: payload.requestSha256,
  markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload),
  markerValueSha256: createHash('sha256')
    .update(communitiesStagingRoleSplitRestoreMarker(payload), 'utf8')
    .digest('hex'),
  backupSha256: payload.backupSha256,
  sourceLedgerSha256: payload.sourceLedgerSha256,
  sourceLedgerCount: payload.sourceLedgerCount,
  cloneDatabaseOid: payload.cloneDatabaseOid,
  cloneBindingSha256: createHash('sha256')
    .update(`${payload.restoreDatabase}\0${payload.cloneDatabaseOid}`, 'utf8')
    .digest('hex'),
  sourceBindingSha256: createHash('sha256')
    .update(
      `${payload.sourceDatabase}\0${payload.sourceDatabaseOid}\0${payload.systemIdentifier}`,
      'utf8',
    )
    .digest('hex'),
  restoreRunId: payload.restoreRunId,
  restoreRunAttempt: payload.restoreRunAttempt,
  restoreHelperSha256: payload.restoreHelperSha256,
  markerWriterSha256: payload.markerWriterSha256,
  bindings: {
    request: true,
    backup: true,
    archiveOwnershipAcl: true,
    sourceStable: true,
    restoredLedger: true,
    cloneIdentity: true,
    markerReadback: true,
  },
  authorizes: {
    roleCreation: false,
    roleSplit: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    import: false,
    activation: false,
  },
} satisfies CommunitiesStagingRoleSplitRestoreMarkerEvidence;

describe('Communities staging role-split restore marker contract', () => {
  it('has exact line ordering, terminal LF and a pinned golden digest', () => {
    expect(canonicalCommunitiesStagingRoleSplitRestoreMarkerPayload(payload)).toBe(
      expectedCanonical,
    );
    expect(communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload)).toBe(
      '3c36a4526f2ff694914654d026eb593be9211cd01c2344f2267b2f6cd9c7cd79',
    );
    expect(communitiesStagingRoleSplitRestoreMarker(payload)).toMatch(
      /^phub-communities-role-split-clone-v1:[a-f0-9]{64}$/,
    );
  });

  it.each([
    ['restore database', { restoreDatabase: 'phub_restore_123_5' }],
    ['clone OID', { cloneDatabaseOid: '0' }],
    ['source OID collision', { sourceDatabaseOid: '45678' }],
    ['source database', { sourceDatabase: 'phub_restore_123_4' }],
    ['system identifier', { systemIdentifier: '-1' }],
    ['run attempt', { restoreRunAttempt: '00' }],
    ['backup digest', { backupSha256: sha('A') }],
    ['ledger count', { sourceLedgerCount: '-1' }],
    ['empty ledger count', { sourceLedgerCount: '0' }],
    ['release', { activeRelease: sha('f') }],
    ['PostgreSQL major', { postgresMajor: '17' }],
    ['object manifest', { objectManifestSha256: sha('1') }],
  ])('rejects an invalid %s binding', (_label, override) => {
    expect(() =>
      communitiesStagingRoleSplitRestoreMarker({
        ...payload,
        ...override,
      } as CommunitiesStagingRoleSplitRestoreMarkerPayload),
    ).toThrow(/^COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_/);
  });

  it('rejects a marker not derived from the exact payload', () => {
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreMarker(
        payload,
        `phub-communities-role-split-clone-v1:${sha('9')}`,
      ),
    ).toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_BINDING_INVALID');
  });

  it('accepts only fully bound non-authorizing redacted evidence', () => {
    const marker = communitiesStagingRoleSplitRestoreMarker(payload);
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(payload, marker, evidence),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(payload, marker, {
        ...evidence,
        authorizes: { ...evidence.authorizes, migration: true },
      } as unknown as CommunitiesStagingRoleSplitRestoreMarkerEvidence),
    ).toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_EVIDENCE_INVALID');
    expect(JSON.stringify(evidence)).not.toContain(payload.sourceDatabase);
    expect(JSON.stringify(evidence)).not.toContain(payload.systemIdentifier);
  });

  it('canonicalizes the ledger in filename order with one terminal LF', () => {
    const entries = [
      { filename: '0002_second.sql', checksum: sha('b') },
      { filename: '0001_first.sql', checksum: sha('a') },
    ];
    expect(canonicalCommunitiesStagingRoleSplitLedger(entries)).toBe(
      `0001_first.sql|${sha('a')}\n0002_second.sql|${sha('b')}\n`,
    );
    expect(communitiesStagingRoleSplitLedgerSha256(entries)).toBe(
      'dc13c427dee01f4b4b1d31e7f63f0e083a21cff435b0d51276884950f21e3d10',
    );
  });

  it('rejects duplicate ledger filenames and extra evidence fields', () => {
    expect(() =>
      canonicalCommunitiesStagingRoleSplitLedger([
        { filename: '0001_first.sql', checksum: sha('a') },
        { filename: '0001_first.sql', checksum: sha('b') },
      ]),
    ).toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_LEDGER_INVALID');
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(
        payload,
        communitiesStagingRoleSplitRestoreMarker(payload),
        {
          ...evidence,
          sourceDatabase: payload.sourceDatabase,
        } as unknown as CommunitiesStagingRoleSplitRestoreMarkerEvidence,
      ),
    ).toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_EVIDENCE_INVALID');
  });

  it.each([
    ['request', { requestSha256: sha('9') }],
    ['payload', { markerPayloadSha256: sha('9') }],
    ['marker value', { markerValueSha256: sha('9') }],
    ['backup', { backupSha256: sha('9') }],
    ['ledger', { sourceLedgerSha256: sha('9') }],
    ['clone', { cloneBindingSha256: sha('9') }],
    ['source', { sourceBindingSha256: sha('9') }],
    ['writer', { markerWriterSha256: sha('9') }],
  ])('rejects fabricated %s evidence', (_label, override) => {
    expect(() =>
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(
        payload,
        communitiesStagingRoleSplitRestoreMarker(payload),
        { ...evidence, ...override },
      ),
    ).toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_EVIDENCE_BINDING_INVALID');
  });
});
