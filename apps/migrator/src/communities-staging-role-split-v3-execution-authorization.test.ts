import {
  assertCommunitiesStagingRoleSplitV3AttestedEvidence,
  assertCommunitiesStagingRoleSplitV3CloneCreationAuthorizationBinding,
  assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding,
  canonicalCommunitiesStagingRoleSplitV3AttestedEvidence,
  canonicalCommunitiesStagingRoleSplitV3CloneCreationAuthorization,
  canonicalCommunitiesStagingRoleSplitV3ExecutionAuthorization,
  communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  communitiesStagingRoleSplitV3Marker,
  createCommunitiesStagingRoleSplitV3AttestedEvidence,
  createCommunitiesStagingRoleSplitV3MarkerEvidence,
  parseCommunitiesStagingRoleSplitV3CloneCreationAuthorization,
  parseCommunitiesStagingRoleSplitV3ExecutionAuthorization,
} from '@phub/database';
import { describe, expect, it } from 'vitest';

import {
  createCommunitiesStagingRoleSplitV3Fixture,
  fixtureSha,
} from './communities-staging-role-split-v3-test-fixtures.js';

const fixture = createCommunitiesStagingRoleSplitV3Fixture();
const hostBinding = (code: 'OWNERSHIP_ACL_ATTESTATION' | 'SOURCE_WRITE_DENIAL_ATTESTATION') =>
  fixture.hostAuthorization.bindings.find((binding) => binding.code === code)!;

describe('V3 execution authorization and attested evidence', () => {
  it('keeps clone creation separate from continuation authority', () => {
    const cloneBytes = canonicalCommunitiesStagingRoleSplitV3CloneCreationAuthorization(
      fixture.cloneCreationAuthorization,
    );
    expect(parseCommunitiesStagingRoleSplitV3CloneCreationAuthorization(cloneBytes)).toEqual(
      fixture.cloneCreationAuthorization,
    );
    expect(fixture.cloneCreationAuthorization.authorizes).toMatchObject({
      statePersistence: true,
      cloneCreation: true,
      restoreExecution: false,
      markerWrite: false,
      evidencePublication: false,
      roleSplit: false,
    });
    expect(
      communitiesStagingRoleSplitV3CloneCreationAuthorizationSha256(
        fixture.cloneCreationAuthorization,
      ),
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      assertCommunitiesStagingRoleSplitV3CloneCreationAuthorizationBinding({
        request: fixture.request,
        expectedCandidateCommitSha: fixture.cloneCreationAuthorization.candidateCommitSha,
        expectedComponents: fixture.cloneCreationAuthorization.components,
        authorization: fixture.cloneCreationAuthorization,
      }),
    ).not.toThrow();
  });

  it('binds continuation to host, durable restore and all executable subjects', () => {
    const bytes = canonicalCommunitiesStagingRoleSplitV3ExecutionAuthorization(
      fixture.executionAuthorization,
    );
    expect(parseCommunitiesStagingRoleSplitV3ExecutionAuthorization(bytes)).toEqual(
      fixture.executionAuthorization,
    );
    expect(() =>
      assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding({
        request: fixture.request,
        cloneCreationAuthorization: fixture.cloneCreationAuthorization,
        hostAuthorization: fixture.hostAuthorization,
        durableRestoreAuthorization: fixture.durableRestoreAuthorization,
        authorization: fixture.executionAuthorization,
      }),
    ).not.toThrow();
    expect(fixture.executionAuthorization.authorizes).toMatchObject({
      statePersistence: true,
      cloneCreation: false,
      restoreExecution: true,
      markerWrite: true,
      evidencePublication: true,
      automaticCleanup: false,
      roleCreation: false,
      roleSplit: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      activation: false,
    });
    expect(
      communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(fixture.executionAuthorization),
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      canonicalCommunitiesStagingRoleSplitV3ExecutionAuthorization({
        ...fixture.executionAuthorization,
        components: {
          ...fixture.executionAuthorization.components,
          evidenceSinkSha256: fixtureSha('drift'),
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding({
        request: fixture.request,
        cloneCreationAuthorization: fixture.cloneCreationAuthorization,
        hostAuthorization: fixture.hostAuthorization,
        durableRestoreAuthorization: fixture.durableRestoreAuthorization,
        authorization: {
          ...fixture.executionAuthorization,
          components: {
            ...fixture.executionAuthorization.components,
            evidenceSinkSha256: fixtureSha('drift'),
          },
        },
      }),
    ).toThrow('V3_EXECUTION_AUTHORIZATION_BINDING_INVALID');
    expect(() =>
      assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding({
        request: fixture.request,
        cloneCreationAuthorization: {
          ...fixture.cloneCreationAuthorization,
          components: {
            ...fixture.cloneCreationAuthorization.components,
            stateStoreSha256: fixtureSha('other-state-store'),
          },
        },
        hostAuthorization: fixture.hostAuthorization,
        durableRestoreAuthorization: fixture.durableRestoreAuthorization,
        authorization: fixture.executionAuthorization,
      }),
    ).toThrow('V3_EXECUTION_AUTHORIZATION_BINDING_INVALID');
  });

  it('publishes a distinct V3 attested envelope bound to the V3 authorization', () => {
    const marker = communitiesStagingRoleSplitV3Marker(fixture.markerPayload);
    const markerEvidence = createCommunitiesStagingRoleSplitV3MarkerEvidence(
      fixture.markerPayload,
      marker,
    );
    const evidence = createCommunitiesStagingRoleSplitV3AttestedEvidence({
      payload: fixture.markerPayload,
      marker,
      markerEvidence,
      executionAuthorization: fixture.executionAuthorization,
      hostAuthorization: fixture.hostAuthorization,
      ownershipAclAttestation: {
        subjectSha256: fixture.executionAuthorization.components.ownershipAclAttestorSha256,
        evidenceSha256: hostBinding('OWNERSHIP_ACL_ATTESTATION').evidenceSha256,
      },
      sourceWriteDenialAttestation: {
        subjectSha256: fixture.executionAuthorization.components.sourceWriteDenialAttestorSha256,
        evidenceSha256: hostBinding('SOURCE_WRITE_DENIAL_ATTESTATION').evidenceSha256,
      },
      evidenceSinkSubjectSha256: fixture.executionAuthorization.components.evidenceSinkSha256,
    });
    expect(evidence.schemaVersion).toBe('communities-staging-role-split-v3-attested-evidence-v2');
    expect(evidence.authorizes).toEqual({
      roleCreation: false,
      roleSplit: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      import: false,
      activation: false,
    });
    expect(() =>
      assertCommunitiesStagingRoleSplitV3AttestedEvidence({
        payload: fixture.markerPayload,
        marker,
        executionAuthorization: fixture.executionAuthorization,
        hostAuthorization: fixture.hostAuthorization,
        evidence,
      }),
    ).not.toThrow();
    expect(
      canonicalCommunitiesStagingRoleSplitV3AttestedEvidence({
        payload: fixture.markerPayload,
        marker,
        executionAuthorization: fixture.executionAuthorization,
        hostAuthorization: fixture.hostAuthorization,
        evidence,
      }),
    ).toMatch(/"schemaVersion":"communities-staging-role-split-v3-attested-evidence-v2"/u);
    expect(() =>
      assertCommunitiesStagingRoleSplitV3AttestedEvidence({
        payload: fixture.markerPayload,
        marker,
        executionAuthorization: fixture.executionAuthorization,
        hostAuthorization: fixture.hostAuthorization,
        evidence: {
          ...evidence,
          executionAuthorizationSha256: fixtureSha('other'),
        },
      }),
    ).toThrow('V3_ATTESTED_EVIDENCE_BINDING_INVALID');

    expect(() =>
      assertCommunitiesStagingRoleSplitV3AttestedEvidence({
        payload: fixture.markerPayload,
        marker,
        executionAuthorization: fixture.executionAuthorization,
        hostAuthorization: fixture.hostAuthorization,
        evidence: {
          ...evidence,
          ownershipAclAttestation: {
            ...evidence.ownershipAclAttestation,
            evidenceSha256: fixtureSha('replayed-other-context'),
          },
        },
      }),
    ).toThrow('V3_ATTESTED_EVIDENCE_BINDING_INVALID');

    expect(() =>
      assertCommunitiesStagingRoleSplitV3AttestedEvidence({
        payload: fixture.markerPayload,
        marker,
        executionAuthorization: fixture.executionAuthorization,
        hostAuthorization: fixture.hostAuthorization,
        evidence: {
          ...evidence,
          schemaVersion: 'communities-staging-role-split-v3-attested-evidence-v1',
        } as unknown as typeof evidence,
      }),
    ).toThrow('V3_ATTESTED_EVIDENCE_SHAPE_INVALID');
  });
});
