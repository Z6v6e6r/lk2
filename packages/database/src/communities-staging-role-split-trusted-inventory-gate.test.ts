import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryGate,
  communitiesStagingRoleSplitTrustedInventoryGateSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryGate,
  type CommunitiesStagingRoleSplitTrustedInventoryGate,
} from './communities-staging-role-split-trusted-inventory-gate.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const gate = {
  schemaVersion: 'communities-staging-role-split-trusted-inventory-gate-v1',
  status: 'PREPARED_FOR_SEPARATE_AUTHORIZATION_REVIEW',
  candidateCommitSha: 'a'.repeat(40),
  phase: 'BEFORE',
  installedCandidateReceiptSha256: sha256('installed-receipt'),
  runtimeBundleSha256: sha256('runtime-bundle'),
  preparationSha256: sha256('preparation'),
  preparationVerificationSha256: sha256('preparation-verification'),
  connectionDescriptorSha256: sha256('connection'),
  producerExecutableSha256: sha256('producer'),
  credentialDescriptorPathSha256: sha256('/input/credential\n'),
  producerDescriptorPathSha256: sha256('/input/producer\n'),
  outputDirectoryPathSha256: sha256('/output\n'),
  outputArtifactPathSha256: sha256('/output/input-c.json\n'),
  outputReceiptPathSha256: sha256('/output/receipt.json\n'),
  markerRequestPathSha256: sha256('/evidence/request.json\n'),
  markerEvidencePathSha256: sha256('/evidence/marker.json\n'),
  roleMappingPathSha256: sha256('/evidence/mapping.json\n'),
  runtimeWiringVersion: 'communities-staging-role-split-trusted-inventory-runtime-wiring-v1',
  collectionTimeoutMillis: 45_000,
  terminationGraceMillis: 5_000,
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
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryGate;

describe('trusted inventory authorization-review gate contract', () => {
  it('round-trips exact canonical review-only bytes', () => {
    const text = canonicalCommunitiesStagingRoleSplitTrustedInventoryGate(gate);

    expect(parseCommunitiesStagingRoleSplitTrustedInventoryGate(text)).toEqual(gate);
    expect(communitiesStagingRoleSplitTrustedInventoryGateSha256(gate)).toBe(sha256(text));
  });

  it('rejects noncanonical, widened and execution-authorizing inputs', () => {
    const text = canonicalCommunitiesStagingRoleSplitTrustedInventoryGate(gate);
    expect(() => parseCommunitiesStagingRoleSplitTrustedInventoryGate(` ${text}`)).toThrow(
      /TRUSTED_INVENTORY_GATE_CANONICAL_INVALID/u,
    );
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryGate({
        ...gate,
        authorizes: { ...gate.authorizes, inventoryRead: true as false },
      }),
    ).toThrow(/TRUSTED_INVENTORY_GATE_INVALID/u);
    expect(() =>
      parseCommunitiesStagingRoleSplitTrustedInventoryGate(
        `${JSON.stringify({ ...gate, authorizationSha256: sha256('forbidden') })}\n`,
      ),
    ).toThrow(/TRUSTED_INVENTORY_GATE_INVALID/u);
  });
});
