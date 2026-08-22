import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
  canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt,
  communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256,
  communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256,
  communitiesStagingRoleSplitTrustedInventoryReceiptSha256,
  parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
  parseCommunitiesStagingRoleSplitTrustedInventoryReceipt,
  type CommunitiesStagingRoleSplitTrustedInventoryAuthorization,
  type CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor,
  type CommunitiesStagingRoleSplitTrustedInventoryReceipt,
} from './communities-staging-role-split-trusted-inventory.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const connection = {
  schemaVersion: 'communities-staging-role-split-trusted-inventory-connection-v1',
  sourceKind: 'INDEPENDENTLY_SOURCED_CLEAN_CLONE',
  host: 'postgres',
  port: 5432,
  database: 'phub_restore_123_4',
  user: 'inventory_reader',
  sslMode: 'disable',
  passwordTransport: 'FD_3',
  defaultTransactionReadOnly: true,
  applicationName: 'phub-communities-role-split-input-c-v1',
  connectTimeoutMillis: 10_000,
  statementTimeoutMillis: 30_000,
  lockTimeoutMillis: 5_000,
  markerRequestSha256: sha('request'),
  markerEvidenceSha256: sha('evidence'),
  roleMappingSha256: sha('mapping'),
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor;

const authorization = {
  schemaVersion: 'communities-staging-role-split-trusted-inventory-authorization-v1',
  status: 'AUTHORIZED_READ_ONLY_CLEAN_CLONE_INVENTORY',
  candidateCommitSha: 'a'.repeat(40),
  phase: 'BEFORE',
  preparationSha256: sha('preparation'),
  connectionDescriptorSha256:
    communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(connection),
  producerExecutableSha256: sha('producer'),
  outputDirectoryPathSha256: sha('/inventory\n'),
  outputArtifactPathSha256: sha('/inventory/before.json\n'),
  outputReceiptPathSha256: sha('/inventory/before.receipt.json\n'),
  collectionTimeoutMillis: 45_000,
  terminationGraceMillis: 5_000,
  authorizes: {
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
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryAuthorization;

const receipt = {
  schemaVersion: 'communities-staging-role-split-trusted-inventory-receipt-v1',
  status: 'COLLECTED_READ_ONLY_REVIEW_EVIDENCE',
  candidateCommitSha: authorization.candidateCommitSha,
  phase: authorization.phase,
  preparationSha256: authorization.preparationSha256,
  authorizationSha256:
    communitiesStagingRoleSplitTrustedInventoryAuthorizationSha256(authorization),
  connectionDescriptorSha256: authorization.connectionDescriptorSha256,
  producerExecutableSha256: authorization.producerExecutableSha256,
  artifactSha256: sha('artifact'),
  manifestSha256: sha('manifest'),
  outputArtifactPathSha256: authorization.outputArtifactPathSha256,
  outputReceiptPathSha256: authorization.outputReceiptPathSha256,
  bindings: {
    preparationVerified: true,
    independentlySourcedCloneClaimBound: true,
    credentialDescriptorValidatorCompleted: true,
    producerDescriptorValidatorCompleted: true,
    processExitedZero: true,
    processStderrEmpty: true,
    readOnlyProducerBoundaryBound: true,
    artifactCanonicalReadback: true,
    receiptCanonicalReadback: true,
  },
  limitations: {
    hostCollaboratorCompositionNotAttested: true,
    independentArtifactPinNotAttested: true,
    organizationalIndependenceNotAttested: true,
    cleanCloneProvenanceSemanticsNotAttested: true,
    trustedInventoryDesignationNotGranted: true,
  },
  authorizes: {
    trustedInventoryDesignation: false,
    roleCreation: false,
    roleSplit: false,
    aclMutation: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    activation: false,
  },
} as const satisfies CommunitiesStagingRoleSplitTrustedInventoryReceipt;

describe('trusted role-split inventory contracts', () => {
  it('round-trips exact canonical connection, authorization and receipt bytes', () => {
    const connectionText =
      canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(connection);
    const authorizationText =
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization(authorization);
    const receiptText = canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt(receipt);

    expect(
      parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(connectionText),
    ).toEqual(connection);
    expect(
      parseCommunitiesStagingRoleSplitTrustedInventoryAuthorization(authorizationText),
    ).toEqual(authorization);
    expect(parseCommunitiesStagingRoleSplitTrustedInventoryReceipt(receiptText)).toEqual(receipt);
    expect(communitiesStagingRoleSplitTrustedInventoryReceiptSha256(receipt)).toBe(
      sha(receiptText),
    );
  });

  it('rejects noncanonical, widened or password-bearing connection inputs', () => {
    const text =
      canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(connection);
    expect(() =>
      parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(` ${text}`),
    ).toThrow(/TRUSTED_INVENTORY_CANONICAL_INVALID/u);
    expect(() =>
      parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
        JSON.stringify({ ...connection, password: 'forbidden' }) + '\n',
      ),
    ).toThrow(/TRUSTED_INVENTORY_CONNECTION_DESCRIPTOR_INVALID/u);
    expect(() =>
      parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
        canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor({
          ...connection,
          host: 'staging-postgres' as 'postgres',
        }),
      ),
    ).toThrow(/TRUSTED_INVENTORY_CONNECTION_DESCRIPTOR_INVALID/u);
  });

  it('never lets an authorization or receipt grant mutation or trusted designation', () => {
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryAuthorization({
        ...authorization,
        authorizes: { ...authorization.authorizes, aclMutation: true as false },
      }),
    ).toThrow(/TRUSTED_INVENTORY_AUTHORIZATION_INVALID/u);
    expect(() =>
      canonicalCommunitiesStagingRoleSplitTrustedInventoryReceipt({
        ...receipt,
        limitations: {
          ...receipt.limitations,
          trustedInventoryDesignationNotGranted: false as true,
        },
      }),
    ).toThrow(/TRUSTED_INVENTORY_RECEIPT_INVALID/u);
  });
});
