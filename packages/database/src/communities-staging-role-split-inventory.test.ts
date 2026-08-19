import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
} from './communities-staging-role-split-restore-marker.js';
import { COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256 } from './communities-staging-role-split.js';
import {
  canonicalCommunitiesStagingRoleSplitInventory,
  communitiesStagingRoleSplitInventoryArtifact,
  diffCommunitiesStagingRoleSplitInventoryArtifacts,
  type CommunitiesStagingRoleSplitInventoryInput,
} from './communities-staging-role-split-inventory.js';

const sha = (value: string) => value.repeat(64);
const markerPayload = {
  requestSha256: sha('a'),
  restoreDatabase: 'phub_restore_123_4',
  cloneDatabaseOid: '45678',
  cloneDatabaseOwner: 'phub_staging',
  cloneDatabaseOwnerOid: '16384',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16384',
  systemIdentifier: '7421000000000000000',
  backupSha256: sha('b'),
  backupBytes: '1048576',
  backupEvidenceSha256: sha('c'),
  archiveTocSha256: sha('d'),
  sourceLedgerSha256: sha('e'),
  sourceLedgerCount: '91',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: sha('2'),
  markerWriterSha256: sha('3'),
} satisfies CommunitiesStagingRoleSplitRestoreMarkerPayload;
const marker = communitiesStagingRoleSplitRestoreMarker(markerPayload);
const markerEvidence = {
  schemaVersion: 'communities-role-split-clone-marker-evidence-v1',
  status: 'MARKED',
  requestSha256: markerPayload.requestSha256,
  markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(markerPayload),
  markerValueSha256: createHash('sha256').update(marker, 'utf8').digest('hex'),
  backupSha256: markerPayload.backupSha256,
  sourceLedgerSha256: markerPayload.sourceLedgerSha256,
  sourceLedgerCount: markerPayload.sourceLedgerCount,
  cloneDatabaseOid: markerPayload.cloneDatabaseOid,
  cloneBindingSha256: createHash('sha256')
    .update(`${markerPayload.restoreDatabase}\0${markerPayload.cloneDatabaseOid}`, 'utf8')
    .digest('hex'),
  sourceBindingSha256: createHash('sha256')
    .update(
      `${markerPayload.sourceDatabase}\0${markerPayload.sourceDatabaseOid}\0${markerPayload.systemIdentifier}`,
      'utf8',
    )
    .digest('hex'),
  restoreRunId: markerPayload.restoreRunId,
  restoreRunAttempt: markerPayload.restoreRunAttempt,
  restoreHelperSha256: markerPayload.restoreHelperSha256,
  markerWriterSha256: markerPayload.markerWriterSha256,
  bindings: {
    request: true,
    backup: true,
    archiveOwnershipAcl: true,
    sourceStable: true,
    restoredLedger: true,
    cloneIdentity: true,
    markerReadback: true,
  },
  authorizes: {
    roleCreation: false,
    roleSplit: false,
    sharedDatabaseMutation: false,
    migration: false,
    deploy: false,
    import: false,
    activation: false,
  },
} satisfies CommunitiesStagingRoleSplitRestoreMarkerEvidence;

const inventory = {
  database: { name: 'phub_restore_123_4', owner: 'phub_staging', acl: null },
  schemas: [{ name: 'communities', exists: true, owner: 'phub_staging', acl: null }],
  default_acls: [],
  relations: [
    {
      schema: 'communities',
      name: 'memberships',
      kind: 'r',
      owner: 'phub_staging',
      acl: null,
      rls: true,
      force_rls: true,
    },
  ],
  column_acls: [],
  policies: [
    {
      schema: 'communities',
      table: 'memberships',
      name: 'tenant_scope',
      permissive: 'PERMISSIVE',
      roles: ['phub_runtime'],
      command: 'ALL',
      qual: "tenant_id = current_setting('app.tenant_id')::uuid",
      check: null,
    },
  ],
  routines: [],
  types: [],
  extensions: [{ name: 'pg_trgm', version: '1.6', schema: 'public', owner: 'phub_staging' }],
} satisfies CommunitiesStagingRoleSplitInventoryInput;

describe('Communities staging role-split inventory artifact', () => {
  it('has a stable golden canonical form and emits redacted counts rather than raw ACL data', () => {
    const canonical = canonicalCommunitiesStagingRoleSplitInventory(inventory);
    expect(canonical).toBe(
      `communities-staging-role-split-inventory-v1\n${JSON.stringify(inventory)}\n`,
    );
    const artifact = communitiesStagingRoleSplitInventoryArtifact({
      inventory,
      inventoryDatabaseOid: '45678',
      markerPayload,
      marker,
      markerEvidence,
    });
    expect(artifact).toMatchObject({
      restoreDatabase: 'phub_restore_123_4',
      cloneDatabaseOid: '45678',
      categoryCounts: { database: 1, schemas: 1, relations: 1, policies: 1, extensions: 1 },
      authorizes: { roleSplit: false, migration: false, deploy: false, activation: false },
    });
    expect(JSON.stringify(artifact)).not.toContain('tenant_id =');
    expect(JSON.stringify(artifact)).not.toContain('acl');

    const reorderedDatabaseKeys = {
      ...inventory,
      database: {
        acl: inventory.database.acl,
        owner: inventory.database.owner,
        name: inventory.database.name,
      },
    } satisfies CommunitiesStagingRoleSplitInventoryInput;
    expect(canonicalCommunitiesStagingRoleSplitInventory(reorderedDatabaseKeys)).toBe(canonical);
  });

  it('canonicalizes reordered arrays and rejects duplicates and marker evidence drift', () => {
    const relation = inventory.relations[0]!;
    const reordered = canonicalCommunitiesStagingRoleSplitInventory({
      ...inventory,
      schemas: [
        { name: 'identity', exists: true, owner: 'phub_staging', acl: null },
        { name: 'games', exists: true, owner: 'phub_staging', acl: null },
        ...inventory.schemas,
      ],
    });
    const sorted = canonicalCommunitiesStagingRoleSplitInventory({
      ...inventory,
      schemas: [
        ...inventory.schemas,
        { name: 'games', exists: true, owner: 'phub_staging', acl: null },
        { name: 'identity', exists: true, owner: 'phub_staging', acl: null },
      ],
    });
    expect(reordered).toBe(sorted);
    const orderingFixture = {
      ...inventory,
      default_acls: [
        { role: 'phub_staging', schema: null, type: 'r', acl: null },
        { role: 'phub_staging', schema: 'communities', type: 'r', acl: null },
      ],
      column_acls: [
        { schema: 'communities', relation: 'memberships', column: 'zeta', acl: null },
        { schema: 'communities', relation: 'memberships', column: 'alpha', acl: null },
      ],
      policies: [{ ...inventory.policies[0]!, roles: ['phub_runtime', 'phub_migrator'] }],
      routines: [
        {
          schema: 'communities',
          name: 'member_count',
          identity_args: '',
          kind: 'f',
          owner: 'phub_staging',
          acl: null,
          security_definer: false,
          config: null,
        },
      ],
    } satisfies CommunitiesStagingRoleSplitInventoryInput;
    expect(canonicalCommunitiesStagingRoleSplitInventory(orderingFixture)).toBe(
      canonicalCommunitiesStagingRoleSplitInventory({
        ...orderingFixture,
        default_acls: [...orderingFixture.default_acls].reverse(),
        column_acls: [...orderingFixture.column_acls].reverse(),
        policies: [{ ...orderingFixture.policies[0]!, roles: ['phub_migrator', 'phub_runtime'] }],
      }),
    );
    expect(() =>
      canonicalCommunitiesStagingRoleSplitInventory({
        ...inventory,
        relations: [{ ...relation }, { ...relation }],
      }),
    ).toThrow('INVENTORY_ARRAY_DUPLICATE');
    expect(() =>
      communitiesStagingRoleSplitInventoryArtifact({
        inventory,
        inventoryDatabaseOid: '45678',
        markerPayload,
        marker,
        markerEvidence: { ...markerEvidence, cloneDatabaseOid: '999' },
      }),
    ).toThrow('RESTORE_MARKER_EVIDENCE_BINDING_INVALID');
    expect(() =>
      communitiesStagingRoleSplitInventoryArtifact({
        inventory,
        inventoryDatabaseOid: '999',
        markerPayload,
        marker,
        markerEvidence,
      }),
    ).toThrow('INVENTORY_DATABASE_BINDING_INVALID');
    expect(() =>
      communitiesStagingRoleSplitInventoryArtifact({
        inventory: { ...inventory, database: { ...inventory.database, owner: 'other_owner' } },
        inventoryDatabaseOid: '45678',
        markerPayload,
        marker,
        markerEvidence,
      }),
    ).toThrow('INVENTORY_DATABASE_BINDING_INVALID');
  });

  it('diffs only hashes and redacted category counts and rejects cross-clone comparisons', () => {
    const baseline = communitiesStagingRoleSplitInventoryArtifact({
      inventory,
      inventoryDatabaseOid: '45678',
      markerPayload,
      marker,
      markerEvidence,
    });
    const current = communitiesStagingRoleSplitInventoryArtifact({
      inventory: {
        ...inventory,
        types: [
          {
            schema: 'communities',
            name: 'membership_state',
            kind: 'e',
            owner: 'phub_staging',
            acl: null,
          },
        ],
      },
      inventoryDatabaseOid: '45678',
      markerPayload,
      marker,
      markerEvidence,
    });
    const diff = diffCommunitiesStagingRoleSplitInventoryArtifacts(baseline, current);
    expect(diff.categories.types).toEqual({ baselineCount: 0, currentCount: 1, changed: true });
    expect(diff.authorizes).toEqual({
      roleSplit: false,
      migration: false,
      deploy: false,
      activation: false,
    });
    expect(JSON.stringify(diff)).not.toContain('membership_state');
    expect(() =>
      diffCommunitiesStagingRoleSplitInventoryArtifacts(baseline, {
        ...current,
        cloneDatabaseOid: '999',
      }),
    ).toThrow('INVENTORY_ARTIFACT_BINDING_INVALID');
    expect(() =>
      diffCommunitiesStagingRoleSplitInventoryArtifacts(
        {
          ...baseline,
          authorizes: { ...baseline.authorizes, roleSplit: true },
        } as unknown as typeof baseline,
        current,
      ),
    ).toThrow('INVENTORY_ARTIFACT_INVALID');
    const policy = inventory.policies[0]!;
    const sameCount = communitiesStagingRoleSplitInventoryArtifact({
      inventory: { ...inventory, policies: [{ ...policy, qual: 'tenant_id is not null' }] },
      inventoryDatabaseOid: '45678',
      markerPayload,
      marker,
      markerEvidence,
    });
    expect(
      diffCommunitiesStagingRoleSplitInventoryArtifacts(baseline, sameCount).categories.policies
        .changed,
    ).toBe(true);

    const databaseDrift = communitiesStagingRoleSplitInventoryArtifact({
      inventory: {
        ...inventory,
        database: { ...inventory.database, acl: ['phub_runtime=c/phub_staging'] },
      },
      inventoryDatabaseOid: '45678',
      markerPayload,
      marker,
      markerEvidence,
    });
    expect(
      diffCommunitiesStagingRoleSplitInventoryArtifacts(baseline, databaseDrift).categories.database
        .changed,
    ).toBe(true);
  });
});
