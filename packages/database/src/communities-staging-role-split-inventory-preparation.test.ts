import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_VERSION,
  canonicalCommunitiesStagingRoleSplitInventoryPreparation,
  communitiesStagingRoleSplitInventoryPreparationSha256,
  parseCommunitiesStagingRoleSplitInventoryPreparation,
  type CommunitiesStagingRoleSplitInventoryPreparation,
} from './communities-staging-role-split-inventory-preparation.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

function preparation(): CommunitiesStagingRoleSplitInventoryPreparation {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_VERSION,
    status: 'CODE_ONLY_DISABLED',
    candidateCommitSha: 'a'.repeat(40),
    phase: 'BEFORE',
    requestSha256: sha('request'),
    creationReceiptSha256: sha('receipt'),
    cloneDatabaseOid: '45678',
    sourceDatabaseOid: '16384',
    systemIdentifier: '7421000000000000000',
    inputs: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.map((code, index) => ({
      code,
      pathSha256: sha(`path:${index}`),
      contentSha256: sha(`content:${index}`),
    })),
    outputArtifactPathSha256: sha('output-path'),
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

describe('communities staging role split inventory preparation', () => {
  it('round-trips exact canonical disabled bytes and a stable digest', () => {
    const candidate = preparation();
    const text = canonicalCommunitiesStagingRoleSplitInventoryPreparation(candidate);
    expect(parseCommunitiesStagingRoleSplitInventoryPreparation(text)).toEqual(candidate);
    expect(communitiesStagingRoleSplitInventoryPreparationSha256(candidate)).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(text).not.toContain('/var/');
  });

  it('rejects reordered or incomplete inputs and every true authorization', () => {
    const candidate = preparation();
    expect(() =>
      canonicalCommunitiesStagingRoleSplitInventoryPreparation({
        ...candidate,
        inputs: [...candidate.inputs].reverse(),
      }),
    ).toThrow('INVENTORY_PREPARATION_INPUT_BINDING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitInventoryPreparation({
        ...candidate,
        inputs: candidate.inputs.slice(1),
      }),
    ).toThrow('INVENTORY_PREPARATION_SHAPE_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitInventoryPreparation({
        ...candidate,
        authorizes: { ...candidate.authorizes, inventoryRead: true },
      } as unknown as CommunitiesStagingRoleSplitInventoryPreparation),
    ).toThrow('INVENTORY_PREPARATION_SHAPE_INVALID');
  });

  it('rejects noncanonical JSON and extra fields', () => {
    const candidate = preparation();
    expect(() =>
      parseCommunitiesStagingRoleSplitInventoryPreparation(`${JSON.stringify(candidate)}\n`),
    ).toThrow('INVENTORY_PREPARATION_CANONICAL_ENCODING_INVALID');
    expect(() =>
      canonicalCommunitiesStagingRoleSplitInventoryPreparation({
        ...candidate,
        extra: true,
      } as unknown as CommunitiesStagingRoleSplitInventoryPreparation),
    ).toThrow('INVENTORY_PREPARATION_SHAPE_INVALID');
  });
});
