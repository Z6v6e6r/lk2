import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  communitiesStagingRoleSplitRestoreMarker,
  type CommunitiesStagingRoleSplitMarkerCeremonyObservation,
  type CommunitiesStagingRoleSplitMarkerCeremonyState,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  CommunitiesStagingRoleSplitMarkerCeremonyError,
  runCommunitiesStagingRoleSplitMarkerCeremony,
  type CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  type CommunitiesStagingRoleSplitMarkerCeremonyHost,
  type CommunitiesStagingRoleSplitMarkerCeremonyLease,
} from './communities-staging-role-split-marker-ceremony.js';

const requestSha256 = 'a'.repeat(64);
const cloneDatabaseOid = '45678';
const payload = {
  requestSha256,
  restoreDatabase: 'phub_restore_123_4',
  cloneDatabaseOid,
  cloneDatabaseOwner: 'phub_staging',
  cloneDatabaseOwnerOid: '16384',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16384',
  systemIdentifier: '7421000000000000000',
  backupSha256: 'b'.repeat(64),
  backupBytes: '1048576',
  backupEvidenceSha256: 'c'.repeat(64),
  archiveTocSha256: 'd'.repeat(64),
  sourceLedgerSha256: 'e'.repeat(64),
  sourceLedgerCount: '91',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: '2'.repeat(64),
  markerWriterSha256: '3'.repeat(64),
} satisfies CommunitiesStagingRoleSplitRestoreMarkerPayload;
const marker = communitiesStagingRoleSplitRestoreMarker(payload);
const artifacts = {
  payload,
  marker,
} satisfies CommunitiesStagingRoleSplitMarkerCeremonyArtifacts;
const lease = {
  requestSha256,
  fencingToken: '9'.repeat(64),
} satisfies CommunitiesStagingRoleSplitMarkerCeremonyLease;

class FakeHost implements CommunitiesStagingRoleSplitMarkerCeremonyHost {
  state: CommunitiesStagingRoleSplitMarkerCeremonyState | null = null;
  storedArtifacts: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts | null = null;
  clone: CommunitiesStagingRoleSplitMarkerCeremonyObservation = 'absent';
  markerState: CommunitiesStagingRoleSplitMarkerCeremonyObservation = 'absent';
  evidenceState: CommunitiesStagingRoleSplitMarkerCeremonyObservation = 'absent';
  failCreate = false;
  failRestore = false;
  failVerify = false;
  writeMode: 'success' | 'lost_response' | 'absent_error' = 'success';
  failEvidence = false;
  failRelease = false;
  failStateWriteAfterCommitPhase: CommunitiesStagingRoleSplitMarkerCeremonyState['phase'] | null =
    null;
  readonly log: string[] = [];

  async acquireLease(observedRequestSha256: string) {
    await Promise.resolve();
    this.log.push('acquireLease');
    if (observedRequestSha256 !== requestSha256) throw new Error('request');
    return lease;
  }
  async releaseLease(observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease) {
    await Promise.resolve();
    void observedLease;
    this.log.push('releaseLease');
    if (this.failRelease) throw new Error('release');
  }
  async loadState(observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease) {
    await Promise.resolve();
    void observedLease;
    this.log.push('loadState');
    return this.state;
  }
  async createCandidate(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    state: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ) {
    await Promise.resolve();
    void observedLease;
    this.log.push('createCandidate');
    if (this.state !== null) throw new Error('conflict');
    this.state = state;
  }
  async advanceState(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ) {
    await Promise.resolve();
    void observedLease;
    this.log.push(`advance:${current.phase}->${next.phase}`);
    if (this.state !== current) throw new Error('cas');
    this.state = next;
    if (this.failStateWriteAfterCommitPhase === next.phase) throw new Error('lost');
  }
  async saveVerified(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
    next: CommunitiesStagingRoleSplitMarkerCeremonyState,
    value: CommunitiesStagingRoleSplitMarkerCeremonyArtifacts,
  ) {
    await Promise.resolve();
    void observedLease;
    this.log.push('saveVerified');
    if (this.state !== current) throw new Error('cas');
    this.storedArtifacts = value;
    this.state = next;
    if (this.failStateWriteAfterCommitPhase === next.phase) throw new Error('lost');
  }
  async loadVerifiedArtifacts(observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease) {
    await Promise.resolve();
    void observedLease;
    this.log.push('loadVerifiedArtifacts');
    if (this.storedArtifacts === null) throw new Error('missing');
    return this.storedArtifacts;
  }
  async observeClone(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expected: string | null,
  ) {
    await Promise.resolve();
    void observedLease;
    this.log.push(`observeClone:${expected ?? 'candidate'}`);
    return this.clone;
  }
  async observeMarkerPresence(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expected: string,
  ) {
    await Promise.resolve();
    void observedLease;
    void expected;
    this.log.push('observeMarkerPresence');
    if (this.markerState === 'absent') return 'absent' as const;
    if (this.markerState === 'unknown') return 'unknown' as const;
    return 'present' as const;
  }
  async observeMarker(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    expected: string,
    expectedMarker: string,
  ) {
    await Promise.resolve();
    void observedLease;
    void expected;
    void expectedMarker;
    this.log.push('observeMarker');
    return this.markerState;
  }
  async observeEvidence(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    observedEvidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ) {
    await Promise.resolve();
    void observedLease;
    void observedEvidence;
    this.log.push('observeEvidence');
    return this.evidenceState;
  }
  async createClone(observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease) {
    await Promise.resolve();
    void observedLease;
    this.log.push('createClone');
    if (this.failCreate) throw new Error('create');
    this.clone = 'exact';
    return { cloneDatabaseOid };
  }
  async restoreClone(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    observedCloneDatabaseOid: string,
  ) {
    await Promise.resolve();
    void observedLease;
    void observedCloneDatabaseOid;
    this.log.push('restoreClone');
    if (this.failRestore) throw new Error('restore');
  }
  async verifyBindings(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    observedCloneDatabaseOid: string,
  ) {
    await Promise.resolve();
    void observedLease;
    void observedCloneDatabaseOid;
    this.log.push('verifyBindings');
    if (this.failVerify) throw new Error('verify');
    return artifacts;
  }
  async writeMarker(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    observedCloneDatabaseOid: string,
    observedMarker: string,
  ) {
    await Promise.resolve();
    void observedLease;
    void observedCloneDatabaseOid;
    void observedMarker;
    this.log.push('writeMarker');
    if (this.writeMode === 'lost_response') {
      this.markerState = 'exact';
      throw new Error('lost');
    }
    if (this.writeMode === 'absent_error') throw new Error('absent');
    this.markerState = 'exact';
  }
  async publishEvidence(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    observedEvidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  ) {
    await Promise.resolve();
    void observedLease;
    void observedEvidence;
    this.log.push('publishEvidence');
    if (this.failEvidence) throw new Error('evidence');
    this.evidenceState = 'exact';
  }
  async dropExactClone(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    observedCloneDatabaseOid: string,
  ) {
    await Promise.resolve();
    void observedLease;
    void observedCloneDatabaseOid;
    this.log.push('dropExactClone');
    this.clone = 'absent';
  }
  async clearState(
    observedLease: CommunitiesStagingRoleSplitMarkerCeremonyLease,
    current: CommunitiesStagingRoleSplitMarkerCeremonyState,
  ) {
    await Promise.resolve();
    void observedLease;
    void current;
    this.log.push('clearState');
    this.state = null;
    this.storedArtifacts = null;
  }
}

describe('Communities role-split marker ceremony orchestration', () => {
  it('runs the exact state order and makes an evidenced rerun idempotent', async () => {
    const host = new FakeHost();
    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host),
    ).resolves.toBeUndefined();
    expect(host.state?.phase).toBe('EVIDENCED');
    expect(host.log).toEqual(
      expect.arrayContaining([
        'advance:CANDIDATE->OWNED',
        'advance:OWNED->RESTORE_PENDING',
        'advance:RESTORE_PENDING->RESTORED',
        'saveVerified',
        'advance:VERIFIED->MARKER_PENDING',
        'writeMarker',
        'advance:MARKER_PENDING->MARKED',
        'publishEvidence',
        'advance:MARKED->EVIDENCED',
      ]),
    );
    const writes = host.log.filter((entry) => entry === 'writeMarker').length;
    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host),
    ).resolves.toBeUndefined();
    expect(host.log.filter((entry) => entry === 'writeMarker')).toHaveLength(writes);
    expect(host.log).not.toContain('dropExactClone');
  });

  it('retains ambiguous restore and cleans only a verified absent-marker clone after verify failure', async () => {
    for (const failure of ['restore', 'verify'] as const) {
      const host = new FakeHost();
      if (failure === 'restore') host.failRestore = true;
      else host.failVerify = true;
      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host),
      ).rejects.toEqual(
        new CommunitiesStagingRoleSplitMarkerCeremonyError(
          failure === 'restore'
            ? 'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RESTORE_OUTCOME_AMBIGUOUS'
            : 'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RETRY_REQUIRED',
        ),
      );
      if (failure === 'restore') {
        expect(host.log).not.toContain('dropExactClone');
        expect(host.state?.phase).toBe('RESTORE_PENDING');
      } else {
        expect(host.log).toContain('dropExactClone');
        expect(host.log).toContain('clearState');
        expect(host.state).toBeNull();
      }
    }
  });

  it('reconciles a lost marker-write response and never drops the marked clone', async () => {
    const host = new FakeHost();
    host.writeMode = 'lost_response';
    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host),
    ).resolves.toBeUndefined();
    expect(host.state?.phase).toBe('EVIDENCED');
    expect(host.log).not.toContain('dropExactClone');
  });

  it('cleans only after authoritative marker absence and retains ambiguous marker outcomes', async () => {
    const absent = new FakeHost();
    absent.writeMode = 'absent_error';
    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, absent),
    ).rejects.toEqual(
      new CommunitiesStagingRoleSplitMarkerCeremonyError(
        'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RETRY_REQUIRED',
      ),
    );
    expect(absent.log).toContain('dropExactClone');

    const ambiguous = new FakeHost();
    ambiguous.writeMode = 'absent_error';
    ambiguous.markerState = 'unknown';
    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, ambiguous),
    ).rejects.toEqual(
      new CommunitiesStagingRoleSplitMarkerCeremonyError(
        'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_MARKER_OUTCOME_AMBIGUOUS',
      ),
    );
    expect(ambiguous.log).not.toContain('dropExactClone');
    expect(ambiguous.state?.phase).toBe('MARKER_PENDING');
  });

  it('retains a marked clone when evidence publication fails and resumes without rewriting marker', async () => {
    const host = new FakeHost();
    host.failEvidence = true;
    await expect(runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host)).rejects.toEqual(
      new CommunitiesStagingRoleSplitMarkerCeremonyError(
        'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_EVIDENCE_WRITE_FAILED',
      ),
    );
    expect(host.state?.phase).toBe('MARKED');
    expect(host.log).not.toContain('dropExactClone');
    host.failEvidence = false;
    const markerWrites = host.log.filter((entry) => entry === 'writeMarker').length;
    await expect(
      runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host),
    ).resolves.toBeUndefined();
    expect(host.log.filter((entry) => entry === 'writeMarker')).toHaveLength(markerWrites);
  });

  it('retains candidate state on ambiguous create response', async () => {
    const host = new FakeHost();
    host.failCreate = true;
    await expect(runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host)).rejects.toEqual(
      new CommunitiesStagingRoleSplitMarkerCeremonyError(
        'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_CREATE_OUTCOME_AMBIGUOUS',
      ),
    );
    expect(host.state?.phase).toBe('CANDIDATE');
    expect(host.log).not.toContain('dropExactClone');
  });

  it('retains the clone after every pre-marker lost state-write response', async () => {
    for (const phase of ['OWNED', 'RESTORE_PENDING', 'RESTORED', 'VERIFIED'] as const) {
      const host = new FakeHost();
      host.failStateWriteAfterCommitPhase = phase;
      await expect(
        runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host),
      ).rejects.toEqual(
        new CommunitiesStagingRoleSplitMarkerCeremonyError(
          'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_STATE_WRITE_AMBIGUOUS',
        ),
      );
      expect(host.state?.phase).toBe(phase);
      expect(host.clone).toBe('exact');
      expect(host.log).not.toContain('dropExactClone');
    }
  });

  it('never drops a clone after an ambiguous restore response', async () => {
    const host = new FakeHost();
    host.failRestore = true;
    host.markerState = 'different';
    await expect(runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host)).rejects.toEqual(
      new CommunitiesStagingRoleSplitMarkerCeremonyError(
        'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RESTORE_OUTCOME_AMBIGUOUS',
      ),
    );
    expect(host.log).not.toContain('dropExactClone');
    expect(host.state?.phase).toBe('RESTORE_PENDING');
    const restoreCalls = host.log.filter((entry) => entry === 'restoreClone').length;
    host.failRestore = false;
    await expect(runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host)).rejects.toEqual(
      new CommunitiesStagingRoleSplitMarkerCeremonyError(
        'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RESTORE_OUTCOME_AMBIGUOUS',
      ),
    );
    expect(host.log.filter((entry) => entry === 'restoreClone')).toHaveLength(restoreCalls);
  });

  it('preserves the primary ambiguous outcome when lease release also fails', async () => {
    const host = new FakeHost();
    host.failRestore = true;
    host.failRelease = true;
    const error = await runCommunitiesStagingRoleSplitMarkerCeremony(requestSha256, host).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: 'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_RESTORE_OUTCOME_AMBIGUOUS',
      cause: {
        code: 'COMMUNITIES_STAGING_ROLE_SPLIT_MARKER_CEREMONY_LEASE_RELEASE_FAILED',
      },
    });
  });
});
