import { describe, expect, it } from 'vitest';

import {
  advanceCommunitiesStagingRoleSplitMarkerCeremonyState,
  canonicalCommunitiesStagingRoleSplitMarkerCeremonyState,
  cleanupCommunitiesStagingRoleSplitMarkerCeremony,
  communitiesStagingRoleSplitMarkerCeremonyStateSha256,
  createCommunitiesStagingRoleSplitMarkerCeremonyCandidate,
  recoverCommunitiesStagingRoleSplitMarkerCeremony,
  type CommunitiesStagingRoleSplitMarkerCeremonyState,
} from './communities-staging-role-split-marker-ceremony.js';

const requestSha256 = 'a'.repeat(64);
const markerPayloadSha256 = 'b'.repeat(64);
const cloneDatabaseOid = '16384';

function states(): Record<string, CommunitiesStagingRoleSplitMarkerCeremonyState> {
  const candidate = createCommunitiesStagingRoleSplitMarkerCeremonyCandidate(requestSha256);
  const owned = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(candidate, 'OWNED', {
    cloneDatabaseOid,
  });
  const restored = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(owned, 'RESTORED', {
    cloneDatabaseOid,
  });
  const verified = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(restored, 'VERIFIED', {
    cloneDatabaseOid,
    markerPayloadSha256,
  });
  const pending = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(
    verified,
    'MARKER_PENDING',
    { cloneDatabaseOid, markerPayloadSha256 },
  );
  const marked = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(pending, 'MARKED', {
    cloneDatabaseOid,
    markerPayloadSha256,
  });
  const evidenced = advanceCommunitiesStagingRoleSplitMarkerCeremonyState(marked, 'EVIDENCED', {
    cloneDatabaseOid,
    markerPayloadSha256,
  });
  return { candidate, owned, restored, verified, pending, marked, evidenced };
}

describe('Communities role-split marker ceremony state', () => {
  it('pins the exact transition order and stable canonical digest', () => {
    const fixture = states();
    expect(Object.values(fixture).map((state) => state.phase)).toEqual([
      'CANDIDATE',
      'OWNED',
      'RESTORED',
      'VERIFIED',
      'MARKER_PENDING',
      'MARKED',
      'EVIDENCED',
    ]);
    expect(canonicalCommunitiesStagingRoleSplitMarkerCeremonyState(fixture.pending!)).toBe(
      `communities-staging-role-split-marker-ceremony-state-v1\nrequestSha256=${requestSha256}\nphase=MARKER_PENDING\ncloneDatabaseOid=${cloneDatabaseOid}\nmarkerPayloadSha256=${markerPayloadSha256}\n`,
    );
    expect(communitiesStagingRoleSplitMarkerCeremonyStateSha256(fixture.pending!)).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(() =>
      advanceCommunitiesStagingRoleSplitMarkerCeremonyState(fixture.owned!, 'VERIFIED', {
        cloneDatabaseOid,
        markerPayloadSha256,
      }),
    ).toThrow('MARKER_CEREMONY_STATE_TRANSITION_INVALID');
    expect(() =>
      advanceCommunitiesStagingRoleSplitMarkerCeremonyState(fixture.marked!, 'EVIDENCED', {
        cloneDatabaseOid: '999',
        markerPayloadSha256,
      }),
    ).toThrow('MARKER_CEREMONY_STATE_BINDING_INVALID');
  });

  it('recovers only exact state and never treats ambiguity as success', () => {
    const fixture = states();
    expect(
      recoverCommunitiesStagingRoleSplitMarkerCeremony(fixture.candidate!, {
        clone: 'absent',
        marker: 'not_checked',
        evidence: 'not_checked',
      }),
    ).toBe('CREATE_CLONE');
    expect(
      recoverCommunitiesStagingRoleSplitMarkerCeremony(fixture.pending!, {
        clone: 'exact',
        marker: 'exact',
        evidence: 'not_checked',
      }),
    ).toBe('ADVANCE_MARKED');
    expect(
      recoverCommunitiesStagingRoleSplitMarkerCeremony(fixture.marked!, {
        clone: 'exact',
        marker: 'exact',
        evidence: 'absent',
      }),
    ).toBe('PUBLISH_EVIDENCE');
    expect(
      recoverCommunitiesStagingRoleSplitMarkerCeremony(fixture.evidenced!, {
        clone: 'exact',
        marker: 'exact',
        evidence: 'exact',
      }),
    ).toBe('SUCCESS');
    for (const observation of ['different', 'unknown'] as const) {
      expect(
        recoverCommunitiesStagingRoleSplitMarkerCeremony(fixture.pending!, {
          clone: 'exact',
          marker: observation,
          evidence: 'not_checked',
        }),
      ).toBe('RETAIN_AND_FAIL');
    }
  });

  it('permits cleanup only before a marker can exist and only for an exact clone OID', () => {
    const fixture = states();
    expect(
      cleanupCommunitiesStagingRoleSplitMarkerCeremony(fixture.candidate!, {
        clone: 'absent',
        marker: 'not_checked',
      }),
    ).toBe('CLEAR_STATE_AND_RETRY');
    for (const phase of ['owned', 'restored', 'verified'] as const) {
      expect(
        cleanupCommunitiesStagingRoleSplitMarkerCeremony(fixture[phase]!, {
          clone: 'exact',
          marker: 'absent',
        }),
      ).toBe('DROP_EXACT_CLONE_AND_RETRY');
      expect(
        cleanupCommunitiesStagingRoleSplitMarkerCeremony(fixture[phase]!, {
          clone: 'exact',
          marker: 'not_checked',
        }),
      ).toBe('RETAIN_AND_FAIL');
    }
    expect(
      cleanupCommunitiesStagingRoleSplitMarkerCeremony(fixture.pending!, {
        clone: 'exact',
        marker: 'unknown',
      }),
    ).toBe('RETAIN_AND_FAIL');
    for (const phase of ['marked', 'evidenced'] as const) {
      expect(
        cleanupCommunitiesStagingRoleSplitMarkerCeremony(fixture[phase]!, {
          clone: 'exact',
          marker: 'absent',
        }),
      ).toBe('RETAIN_AND_FAIL');
    }
  });
});
