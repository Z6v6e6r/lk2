import { describe, expect, it } from 'vitest';

import {
  assertCommunitiesStagingRoleSplitCloneRequest,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST,
  requireCommunitiesStagingRoleSplitInventory,
} from './communities-staging-role-split.js';

const exact = {
  confirmation: 'PREPARE_COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_V1',
  restoreDatabase: 'phub_restore_123_1',
  sharedDatabase: 'phub_staging',
  expectedSystemIdentifier: '123456',
  manifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  expectedExecutorRoleName: 'phub_executor',
  expectedExecutorRoleOid: '333',
  expectedCloneDatabaseOwner: 'phub_staging',
  expectedSharedDatabaseOwner: 'phub_staging',
  legacyOwnerRoleName: 'phub_staging',
  runtimeRoleName: 'phub_runtime',
  runtimeRoleOid: '111',
  migratorRoleName: 'phub_migrator',
  migratorRoleOid: '222',
  sourceLedgerSha256: 'a'.repeat(64),
  sourceLedgerCount: '1',
  cloneSourceBindingMarker: 'clone-source-binding-1234',
  expectedInventorySha256: 'b'.repeat(64),
};

describe('Communities staging role split clone contract', () => {
  it('binds a stable explicit manifest and no executable wildcard plan', () => {
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST).toContainEqual([
      'table',
      'profile.privacy_settings',
      'alter-0053',
    ]);
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.flat().join(' ')).not.toMatch(
      /\*|grant all|reassign owned/i,
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects shared targets, bad role identities and a changed manifest before execution', () => {
    expect(() =>
      assertCommunitiesStagingRoleSplitCloneRequest({ ...exact, restoreDatabase: 'phub_staging' }),
    ).toThrow('RESTORE_DATABASE_INVALID');
    expect(() =>
      assertCommunitiesStagingRoleSplitCloneRequest({
        ...exact,
        sharedDatabase: 'phub_restore_123_1',
      }),
    ).toThrow('SHARED_DATABASE_INVALID');
    expect(() =>
      assertCommunitiesStagingRoleSplitCloneRequest({
        ...exact,
        runtimeRoleName: 'same',
        migratorRoleName: 'same',
      }),
    ).toThrow('ROLES_NOT_DISTINCT');
    expect(() =>
      assertCommunitiesStagingRoleSplitCloneRequest({ ...exact, manifestSha256: '0'.repeat(64) }),
    ).toThrow('MANIFEST_BINDING_INVALID');
  });

  it('is explicitly inventory-gated', () => {
    expect(requireCommunitiesStagingRoleSplitInventory).toThrow(
      'COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_REQUIRED',
    );
  });
});
