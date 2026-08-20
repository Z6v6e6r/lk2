import { createHash } from 'node:crypto';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_ATTESTED_EVIDENCE_VERSION,
  type CommunitiesStagingRoleSplitAttestedEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesStagingRoleSplitPinnedEvidenceDirectory,
  canonicalCommunitiesStagingRoleSplitMarkerEvidence,
  CommunitiesStagingRoleSplitFileEvidenceSink,
} from './communities-staging-role-split-file-evidence-sink.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const evidence = {
  schemaVersion: 'communities-role-split-clone-marker-evidence-v2',
  status: 'MARKED',
  requestSha256: sha('request'),
  creationReceiptSha256: sha('receipt'),
  markerPayloadSha256: sha('payload'),
  markerValueSha256: sha('marker'),
  backupSha256: sha('backup'),
  sourceLedgerSha256: sha('ledger'),
  sourceLedgerCount: '1',
  cloneDatabaseOid: '45678',
  cloneBindingSha256: sha('clone'),
  sourceBindingSha256: sha('source'),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  restoreHelperSha256: sha('helper'),
  markerWriterSha256: sha('writer'),
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
} as const satisfies CommunitiesStagingRoleSplitRestoreMarkerEvidence;
const attestedEvidence = {
  schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_ATTESTED_EVIDENCE_VERSION,
  status: 'ATTESTED',
  authorizationSha256: sha('authorization'),
  markerEvidence: evidence,
  ownershipAclAttestation: {
    subjectSha256: sha('ownership subject'),
    evidenceSha256: sha('ownership evidence'),
  },
  sourceWriteDenialAttestation: {
    subjectSha256: sha('denial subject'),
    evidenceSha256: sha('denial evidence'),
  },
  evidenceSinkSubjectSha256: sha('sink'),
} as const satisfies CommunitiesStagingRoleSplitAttestedEvidence;

describe('CommunitiesStagingRoleSplitFileEvidenceSink', () => {
  it('uses deterministic canonical LF-terminated evidence bytes', () => {
    const first = canonicalCommunitiesStagingRoleSplitMarkerEvidence(attestedEvidence);
    const reordered = { ...attestedEvidence, status: attestedEvidence.status };
    expect(canonicalCommunitiesStagingRoleSplitMarkerEvidence(reordered)).toEqual(first);
    expect(first.at(-1)).toBe(10);
  });

  it('rejects a relative evidence directory before filesystem access', () => {
    expect(
      () => new CommunitiesStagingRoleSplitFileEvidenceSink(sha('sink'), 'relative/path'),
    ).toThrow(/CONFIG_INVALID/u);
  });

  it('rejects path substitution while operations remain pinned to the opened directory inode', () => {
    const directory = (ino: number) => ({
      dev: 7,
      ino,
      uid: 0,
      mode: 0o40700,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    });
    expect(() =>
      assertCommunitiesStagingRoleSplitPinnedEvidenceDirectory({
        initialPath: directory(11),
        initialHandle: directory(11),
        finalHandle: directory(11),
        finalPath: directory(12),
        effectiveUid: 0,
      }),
    ).toThrow(/DIRECTORY_UNSAFE/u);
  });
});
