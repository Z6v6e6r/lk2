/* eslint-disable @typescript-eslint/require-await */
import {
  communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  communitiesStagingRoleSplitV3Marker,
  type CommunitiesStagingRoleSplitV3AttestedEvidence,
  type CommunitiesStagingRoleSplitV3State,
} from '@phub/database';
import { describe, expect, it, vi } from 'vitest';

import {
  CommunitiesStagingRoleSplitV3ExecutableCompositionError,
  runCommunitiesStagingRoleSplitV3ExecutableComposition,
  type CommunitiesStagingRoleSplitV3ExecutableHost,
  type CommunitiesStagingRoleSplitV3ExecutableLease,
  type CommunitiesStagingRoleSplitV3VerifiedArtifacts,
} from './communities-staging-role-split-v3-executable-composition.js';
import {
  createCommunitiesStagingRoleSplitV3Fixture,
  fixtureSha,
} from './communities-staging-role-split-v3-test-fixtures.js';

const fixture = createCommunitiesStagingRoleSplitV3Fixture();

class FakeHost implements CommunitiesStagingRoleSplitV3ExecutableHost {
  readonly subjects = {
    ...fixture.executionAuthorization.components,
    cloneFactorySha256: fixture.cloneCreationAuthorization.components.cloneFactorySha256,
  };
  state: CommunitiesStagingRoleSplitV3State | null = null;
  artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts | null = null;
  markerWritten = false;
  cloneExists = false;
  cloneResponseLoss = false;
  evidence: CommunitiesStagingRoleSplitV3AttestedEvidence | null = null;
  markerResponseLoss = false;
  evidenceResponseLoss = false;
  loadStateError = false;
  readonly log: string[] = [];
  readonly restoreOwnedCall = vi.fn(
    async (
      _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
      current: CommunitiesStagingRoleSplitV3State,
      pending: CommunitiesStagingRoleSplitV3State,
      restored: CommunitiesStagingRoleSplitV3State,
    ) => {
      this.log.push(`restore:${current.phase}->${pending.phase}->${restored.phase}`);
      this.state = restored;
    },
  );

  async acquireLease(requestSha256: string) {
    this.log.push('lease:acquire');
    return { requestSha256, fencingToken: fixtureSha('lease') };
  }
  async releaseLease() {
    this.log.push('lease:release');
  }
  async loadState() {
    this.log.push('state:load');
    if (this.loadStateError) throw new Error('private host detail');
    return this.state;
  }
  async createCandidate(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    state: CommunitiesStagingRoleSplitV3State,
  ) {
    this.log.push('state:create:CANDIDATE');
    this.state = state;
  }
  async advanceState(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    current: CommunitiesStagingRoleSplitV3State,
    next: CommunitiesStagingRoleSplitV3State,
  ) {
    expect(this.state).toEqual(current);
    this.log.push(`state:${current.phase}->${next.phase}`);
    this.state = next;
  }
  async saveVerified(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    current: CommunitiesStagingRoleSplitV3State,
    next: CommunitiesStagingRoleSplitV3State,
    artifacts: CommunitiesStagingRoleSplitV3VerifiedArtifacts,
  ) {
    expect(this.state).toEqual(current);
    this.log.push('state:RESTORED->VERIFIED');
    this.state = next;
    this.artifacts = artifacts;
  }
  async loadVerifiedArtifacts() {
    this.log.push('artifacts:load');
    if (this.artifacts === null) throw new Error('missing');
    return this.artifacts;
  }
  async observeClone(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    expectedOid: string | null,
  ) {
    this.log.push('clone:observe');
    if (expectedOid === null) return this.cloneExists ? ('exact' as const) : ('absent' as const);
    return expectedOid === fixture.executionAuthorization.cloneDatabaseOid
      ? ('exact' as const)
      : ('different' as const);
  }
  async observeRestoreExecutionEvidence() {
    this.log.push('restore-evidence:observe');
    return 'exact' as const;
  }
  async observeMarker() {
    this.log.push('marker:observe');
    return this.markerWritten ? ('exact' as const) : ('absent' as const);
  }
  async observeEvidence(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ) {
    this.log.push('evidence:observe');
    return this.evidence === null
      ? ('absent' as const)
      : JSON.stringify(this.evidence) === JSON.stringify(evidence)
        ? ('exact' as const)
        : ('different' as const);
  }
  async createClone() {
    this.log.push('clone:create');
    this.cloneExists = true;
    if (this.cloneResponseLoss) throw new Error('lost');
    return {
      cloneDatabaseOid: fixture.executionAuthorization.cloneDatabaseOid,
      restoreExecutionEvidenceBinding: fixture.restoreExecutionEvidenceBinding,
    };
  }
  restoreOwned = this.restoreOwnedCall;
  async verifyBindings() {
    this.log.push('bindings:verify');
    return {
      payload: fixture.markerPayload,
      marker: communitiesStagingRoleSplitV3Marker(fixture.markerPayload),
      restoreExecutionEvidenceBinding: fixture.restoreExecutionEvidenceBinding,
      ownershipAclAttestation: {
        subjectSha256: fixture.executionAuthorization.components.ownershipAclAttestorSha256,
        evidenceSha256: fixtureSha('ownership-acl-evidence'),
      },
      sourceWriteDenialAttestation: {
        subjectSha256: fixture.executionAuthorization.components.sourceWriteDenialAttestorSha256,
        evidenceSha256: fixtureSha('source-denial-evidence'),
      },
    };
  }
  async writeMarker() {
    this.log.push('marker:write');
    this.markerWritten = true;
    if (this.markerResponseLoss) throw new Error('lost');
  }
  async publishEvidence(
    _lease: CommunitiesStagingRoleSplitV3ExecutableLease,
    evidence: CommunitiesStagingRoleSplitV3AttestedEvidence,
  ) {
    this.log.push('evidence:publish');
    this.evidence = evidence;
    if (this.evidenceResponseLoss) throw new Error('lost');
  }
}

const createConfig = (host: FakeHost) => ({
  mode: 'CREATE' as const,
  request: fixture.request,
  expectedCandidateCommitSha: fixture.cloneCreationAuthorization.candidateCommitSha,
  authorization: fixture.cloneCreationAuthorization,
  expectedAuthorizationSha256: communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256(
    fixture.cloneCreationAuthorization,
  ),
  host,
});

const continueConfig = (host: FakeHost) => ({
  mode: 'CONTINUE' as const,
  request: fixture.request,
  cloneCreationAuthorization: fixture.cloneCreationAuthorization,
  hostAuthorization: fixture.hostAuthorization,
  durableRestoreAuthorization: fixture.durableRestoreAuthorization,
  authorization: fixture.executionAuthorization,
  expectedAuthorizationSha256: communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(
    fixture.executionAuthorization,
  ),
  host,
});

describe('V3 executable role-split composition', () => {
  it('creates exactly one owned clone and stops for the independently pinned continuation', async () => {
    const host = new FakeHost();
    const result = await runCommunitiesStagingRoleSplitV3ExecutableComposition(createConfig(host));
    expect(result.status).toBe('OWNED_CONTINUATION_REQUIRED');
    expect(result.state.phase).toBe('OWNED');
    expect(host.restoreOwnedCall).not.toHaveBeenCalled();
    expect(host.log).toEqual([
      'lease:acquire',
      'state:load',
      'state:create:CANDIDATE',
      'clone:observe',
      'clone:create',
      'state:CANDIDATE->OWNED',
      'lease:release',
    ]);
  });

  it('runs the full V3 continuation and reconciles a lost marker response by exact readback', async () => {
    const host = new FakeHost();
    host.state = fixture.ownedState;
    host.markerResponseLoss = true;
    const result = await runCommunitiesStagingRoleSplitV3ExecutableComposition(
      continueConfig(host),
    );
    expect(result.status).toBe('EVIDENCED');
    expect(host.restoreOwnedCall).toHaveBeenCalledTimes(1);
    expect(host.log.filter((entry) => entry === 'marker:write')).toHaveLength(1);
    expect(host.log.filter((entry) => entry === 'evidence:publish')).toHaveLength(1);
    expect(host.state?.phase).toBe('EVIDENCED');
  });

  it('retains CANDIDATE and never retries clone creation after a lost create response', async () => {
    const host = new FakeHost();
    host.cloneResponseLoss = true;
    await expect(
      runCommunitiesStagingRoleSplitV3ExecutableComposition(createConfig(host)),
    ).rejects.toMatchObject({ code: 'CREATE_OUTCOME_AMBIGUOUS' });
    expect(host.state?.phase).toBe('CANDIDATE');
    await expect(
      runCommunitiesStagingRoleSplitV3ExecutableComposition(createConfig(host)),
    ).rejects.toMatchObject({ code: 'CREATE_OUTCOME_AMBIGUOUS' });
    expect(host.log.filter((entry) => entry === 'clone:create')).toHaveLength(1);
  });

  it('resumes exact published evidence without publishing or writing the marker again', async () => {
    const host = new FakeHost();
    host.state = fixture.ownedState;
    host.evidenceResponseLoss = true;
    await expect(
      runCommunitiesStagingRoleSplitV3ExecutableComposition(continueConfig(host)),
    ).rejects.toMatchObject({ code: 'EVIDENCE_WRITE_FAILED' });
    expect(host.state?.phase).toBe('MARKED');
    expect(host.evidence).not.toBeNull();
    const publishCount = host.log.filter((entry) => entry === 'evidence:publish').length;
    host.evidenceResponseLoss = false;
    const result = await runCommunitiesStagingRoleSplitV3ExecutableComposition(
      continueConfig(host),
    );
    expect(result.status).toBe('EVIDENCED');
    expect(host.log.filter((entry) => entry === 'evidence:publish')).toHaveLength(publishCount);
    expect(host.log.filter((entry) => entry === 'marker:write')).toHaveLength(1);
  });

  it('never retries a durable RESTORE_PENDING state', async () => {
    const host = new FakeHost();
    host.state = fixture.restorePendingState;
    await expect(
      runCommunitiesStagingRoleSplitV3ExecutableComposition(continueConfig(host)),
    ).rejects.toMatchObject({ code: 'RESTORE_RECONCILIATION_REQUIRED' });
    expect(host.restoreOwnedCall).not.toHaveBeenCalled();
  });

  it('rejects an authorization or component drift before acquiring the lease', async () => {
    const host = new FakeHost();
    const config = continueConfig(host);
    await expect(
      runCommunitiesStagingRoleSplitV3ExecutableComposition({
        ...config,
        expectedAuthorizationSha256: fixtureSha('wrong'),
      }),
    ).rejects.toBeInstanceOf(CommunitiesStagingRoleSplitV3ExecutableCompositionError);
    expect(host.log).toEqual([]);

    const changed = new FakeHost();
    changed.subjects.stateStoreSha256 = fixtureSha('changed-state-store');
    await expect(
      runCommunitiesStagingRoleSplitV3ExecutableComposition(continueConfig(changed)),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(changed.log).toEqual([]);
  });

  it('maps an injected host failure to a stable redacted code', async () => {
    const host = new FakeHost();
    host.state = fixture.ownedState;
    host.loadStateError = true;
    await expect(
      runCommunitiesStagingRoleSplitV3ExecutableComposition(continueConfig(host)),
    ).rejects.toMatchObject({
      code: 'HOST_OPERATION_FAILED',
      message: 'COMMUNITIES_STAGING_ROLE_SPLIT_V3_EXECUTABLE_COMPOSITION_HOST_OPERATION_FAILED',
    });
    expect(host.log).toEqual(['lease:acquire', 'state:load', 'lease:release']);
  });
});
