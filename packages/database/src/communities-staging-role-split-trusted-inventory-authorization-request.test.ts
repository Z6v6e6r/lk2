import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
} from './communities-staging-role-split-trusted-inventory-authorization-request.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function request(): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest {
  return {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-request-v1',
    status: 'AUTHORIZATION_REQUEST_REVIEW_ONLY',
    requestIdSha256: sha256('request-id'),
    candidateCommitSha: 'a'.repeat(40),
    phase: 'BEFORE',
    gateSha256: sha256('gate'),
    gateVerificationSha256: sha256('gate-verification'),
    evidencePins: COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_AUTHORIZATION_EVIDENCE_CODES.map(
      (code, index) => ({
        code,
        status: 'PINNED_FOR_SEPARATE_REVIEW',
        subjectSha256: sha256(`subject-${code}`),
        evidenceSha256: sha256(`evidence-${code}`),
        evidencePathSha256: sha256(`/evidence/${index}-${code}.json\n`),
      }),
    ),
    policy: {
      singleUse: true,
      maximumAttempts: 1,
      authorizationValiditySeconds: 300,
      requiresDurableConsumptionLedger: true,
      requiresRootOwnedEvidence: true,
      requiresIndependentApprover: true,
      requiresFailClosedClock: true,
    },
    requestedAuthorities: {
      inventoryConnection: true,
      inventoryRead: true,
      artifactWrite: true,
      trustedInventoryDesignation: false,
      roleCreation: false,
      roleSplit: false,
      aclMutation: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      activation: false,
    },
    authorizes: {
      inventoryConnection: false,
      inventoryRead: false,
      artifactWrite: false,
      trustedInventoryDesignation: false,
      roleCreation: false,
      roleSplit: false,
      aclMutation: false,
      sharedDatabaseMutation: false,
      migration: false,
      deploy: false,
      activation: false,
    },
  };
}

describe('trusted inventory separate-authorization request contract', () => {
  it('round-trips one exact review-only request', () => {
    const value = request();
    const text = canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(value);

    expect(parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(text)).toEqual(
      value,
    );
    expect(communitiesStagingRoleSplitTrustedInventoryAuthorizationRequestSha256(value)).toBe(
      sha256(text),
    );
    expect(Object.values(value.authorizes).every((entry) => entry === false)).toBe(true);
  });

  it('rejects widened authority, replay policy drift and evidence aliases', () => {
    const widened = request();
    (widened.authorizes as unknown as { inventoryRead: boolean }).inventoryRead = true;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(widened),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_AUTHORITY_INVALID/u);

    const widenedRequest = request();
    (
      widenedRequest.requestedAuthorities as unknown as {
        trustedInventoryDesignation: boolean;
      }
    ).trustedInventoryDesignation = true;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(widenedRequest),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_AUTHORITY_INVALID/u);

    const replayable = request();
    (replayable.policy as unknown as { maximumAttempts: number }).maximumAttempts = 2;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(replayable),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);

    const aliased = request();
    const first = aliased.evidencePins[0]!;
    const second = aliased.evidencePins[1]!;
    (second as unknown as { evidencePathSha256: string }).evidencePathSha256 =
      first.evidencePathSha256;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(aliased),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_EVIDENCE_PIN_INVALID/u);

    const unexpected = request() as unknown as Record<string, unknown>;
    unexpected.authorizationReceiptSha256 = sha256('forbidden');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest(
        unexpected as unknown as CommunitiesStagingRoleSplitTrustedInventoryAuthorizationRequest,
      ),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_REQUEST_INVALID/u);
  });
});
