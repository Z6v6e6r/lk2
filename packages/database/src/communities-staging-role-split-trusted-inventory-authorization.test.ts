import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSha256,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  communitiesStagingRoleSplitTrustedInventoryConsumptionReceiptSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  parseCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
  type CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
} from './communities-staging-role-split-trusted-inventory-authorization.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const noAuthorities = {
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
} as const;
const requestedInventoryAuthorities = {
  ...noAuthorities,
  inventoryConnection: true,
  inventoryRead: true,
  artifactWrite: true,
} as const;

function evidence(): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence {
  return {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-evidence-v1',
    status: 'INDEPENDENTLY_ATTESTED',
    code: 'CLEAN_CLONE_PROVENANCE',
    requestIdSha256: sha256('request-id'),
    candidateCommitSha: 'a'.repeat(40),
    phase: 'BEFORE',
    gateSha256: sha256('gate'),
    subjectSha256: sha256('subject'),
    payloadSha256: sha256('payload'),
    evidencePathSha256: sha256('/evidence/clean-clone.json\n'),
    attestorSubjectSha256: sha256('attestor'),
    authorizes: noAuthorities,
  };
}

function approval(): CommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval {
  return {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-approval-v1',
    status: 'INDEPENDENTLY_APPROVED',
    approvalIdSha256: sha256('approval-id'),
    requestSha256: sha256('request'),
    requestVerificationSha256: sha256('request-verification'),
    evidenceSetSha256: sha256('evidence-set'),
    issuerSubjectSha256: sha256('issuer'),
    approverSubjectSha256: sha256('approver'),
    clockSubjectSha256: sha256('clock'),
    ledgerSubjectSha256: sha256('ledger'),
    notBeforeUnixSeconds: '1000',
    expiresAtUnixSeconds: '1300',
    maximumAttempts: 1,
    authorizes: noAuthorities,
  };
}

function authorization(): CommunitiesStagingRoleSplitTrustedInventoryAuthorization {
  const approved = approval();
  return {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-v1',
    status: 'ISSUED_PENDING_SINGLE_USE_CONSUMPTION',
    approvalSha256:
      communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256(approved),
    approvalIdSha256: approved.approvalIdSha256,
    requestSha256: approved.requestSha256,
    requestVerificationSha256: approved.requestVerificationSha256,
    requestIdSha256: sha256('request-id'),
    candidateCommitSha: 'a'.repeat(40),
    phase: 'BEFORE',
    gateSha256: sha256('gate'),
    evidenceSetSha256: approved.evidenceSetSha256,
    issuerSubjectSha256: approved.issuerSubjectSha256,
    approverSubjectSha256: approved.approverSubjectSha256,
    clockSubjectSha256: approved.clockSubjectSha256,
    ledgerSubjectSha256: approved.ledgerSubjectSha256,
    notBeforeUnixSeconds: approved.notBeforeUnixSeconds,
    expiresAtUnixSeconds: approved.expiresAtUnixSeconds,
    maximumAttempts: 1,
    requestedAuthorities: requestedInventoryAuthorities,
    authorizes: noAuthorities,
  };
}

function consumption(): CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt {
  const issued = authorization();
  return {
    schemaVersion: 'communities-staging-role-split-trusted-inventory-consumption-receipt-v1',
    status: 'CONSUMED',
    authorizationSha256: communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(issued),
    requestIdSha256: issued.requestIdSha256,
    ledgerSubjectSha256: issued.ledgerSubjectSha256,
    attempt: 1,
    consumedAtUnixSeconds: '1100',
    authorizes: noAuthorities,
  };
}

describe('trusted inventory authorization artifact contracts', () => {
  it('round-trips exact canonical evidence, approval, pending authorization and consumption', () => {
    const values = [
      [
        evidence(),
        canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
        parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
        communitiesStagingRoleSplitTrustedInventoryAuthorizationEvidenceSha256,
      ],
      [
        approval(),
        canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
        parseCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval,
        communitiesStagingRoleSplitTrustedInventoryAuthorizationApprovalSha256,
      ],
      [
        authorization(),
        canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
        parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
        communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
      ],
      [
        consumption(),
        canonicalCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
        parseCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
        communitiesStagingRoleSplitTrustedInventoryConsumptionReceiptSha256,
      ],
    ] as const;

    for (const [value, canonical, parse, digest] of values) {
      const text = canonical(value as never);
      expect(parse(text)).toEqual(value);
      expect(digest(value as never)).toBe(sha256(text));
      expect(Object.values(value.authorizes).every((entry) => entry === false)).toBe(true);
    }
    expect(authorization().requestedAuthorities).toEqual(requestedInventoryAuthorities);
  });

  it('rejects authority widening, replay drift and windows longer than five minutes', () => {
    const widenedEvidence = structuredClone(evidence());
    (widenedEvidence.authorizes as unknown as { inventoryRead: boolean }).inventoryRead = true;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(widenedEvidence),
    ).toThrow(/AUTHORITY_INVALID/u);

    const widenedAuthorization = structuredClone(authorization());
    (widenedAuthorization.requestedAuthorities as unknown as { roleSplit: boolean }).roleSplit =
      true;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(widenedAuthorization),
    ).toThrow(/AUTHORITY_INVALID/u);

    const replayable = structuredClone(approval());
    (replayable as unknown as { maximumAttempts: number }).maximumAttempts = 2;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(replayable),
    ).toThrow(/APPROVAL_INVALID/u);

    const longWindow = structuredClone(approval());
    (longWindow as unknown as { expiresAtUnixSeconds: string }).expiresAtUnixSeconds = '1301';
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(longWindow),
    ).toThrow(/TIME_INVALID/u);
  });

  it('rejects subject aliases, unexpected keys and non-canonical JSON', () => {
    const aliased = structuredClone(approval());
    (aliased as unknown as { approverSubjectSha256: string }).approverSubjectSha256 =
      aliased.issuerSubjectSha256;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationApproval(aliased),
    ).toThrow(/APPROVAL_INVALID/u);

    const unexpected = evidence() as unknown as Record<string, unknown>;
    unexpected.authorizesDatabaseMutation = false;
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence(
        unexpected as unknown as CommunitiesStagingRoleSplitTrustedInventoryAuthorizationEvidence,
      ),
    ).toThrow(/EVIDENCE_INVALID/u);

    const canonical =
      canonicalCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt(consumption());
    expect(() =>
      parseCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt(` ${canonical}`),
    ).toThrow(/CANONICAL_INVALID/u);
  });
});
