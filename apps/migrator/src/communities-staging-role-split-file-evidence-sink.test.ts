import { createHash } from 'node:crypto';

import type { CommunitiesStagingRoleSplitRestoreMarkerEvidence } from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
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

describe('CommunitiesStagingRoleSplitFileEvidenceSink', () => {
  it('uses deterministic canonical LF-terminated evidence bytes', () => {
    const first = canonicalCommunitiesStagingRoleSplitMarkerEvidence(evidence);
    const reordered = { ...evidence, status: evidence.status };
    expect(canonicalCommunitiesStagingRoleSplitMarkerEvidence(reordered)).toEqual(first);
    expect(first.at(-1)).toBe(10);
  });

  it('rejects a relative evidence directory before filesystem access', () => {
    expect(
      () => new CommunitiesStagingRoleSplitFileEvidenceSink(sha('sink'), 'relative/path'),
    ).toThrow(/CONFIG_INVALID/u);
  });
});
