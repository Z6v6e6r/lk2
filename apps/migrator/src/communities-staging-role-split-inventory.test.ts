import { createHash } from 'node:crypto';

import {
  canonicalCommunitiesStagingRoleSplitLedger,
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import type { QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  compareCommunitiesStagingRoleSplitInventories,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL,
  parseCommunitiesStagingRoleSplitMarkerRequest,
  produceCommunitiesStagingRoleSplitInventory,
  type CommunitiesStagingRoleSplitInventoryClientFactory,
} from './communities-staging-role-split-inventory.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const repeatedSha = (value: string): string => value.repeat(64);
const ledgerRows = [
  { filename: '0001_platform_baseline.sql', checksum: repeatedSha('a') },
  { filename: '0002_identity.sql', checksum: repeatedSha('b') },
];
const sourceLedgerSha256 = digest(canonicalCommunitiesStagingRoleSplitLedger(ledgerRows));
const request = {
  restoreDatabase: 'phub_restore_123_4',
  expectedCloneDatabaseOwner: 'phub_staging',
  expectedCloneDatabaseOwnerOid: '16384',
  sourceDatabase: 'phub_staging',
  sourceDatabaseOid: '16385',
  sourceDatabaseOwner: 'phub_staging',
  sourceDatabaseOwnerOid: '16384',
  systemIdentifier: '7421000000000000000',
  backupBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump',
  backupSha256: repeatedSha('b'),
  backupBytes: '1048576',
  backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
  backupEvidenceSha256: repeatedSha('c'),
  archiveTocSha256: repeatedSha('d'),
  sourceLedgerSha256,
  sourceLedgerCount: ledgerRows.length.toString(),
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: repeatedSha('2'),
  markerWriterSha256: repeatedSha('3'),
} satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
const requestText = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(request);
const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
const payload = {
  requestSha256,
  restoreDatabase: request.restoreDatabase,
  cloneDatabaseOid: '45678',
  cloneDatabaseOwner: request.expectedCloneDatabaseOwner,
  cloneDatabaseOwnerOid: request.expectedCloneDatabaseOwnerOid,
  sourceDatabase: request.sourceDatabase,
  sourceDatabaseOid: request.sourceDatabaseOid,
  sourceDatabaseOwner: request.sourceDatabaseOwner,
  sourceDatabaseOwnerOid: request.sourceDatabaseOwnerOid,
  systemIdentifier: request.systemIdentifier,
  backupSha256: request.backupSha256,
  backupBytes: request.backupBytes,
  backupEvidenceSha256: request.backupEvidenceSha256,
  archiveTocSha256: request.archiveTocSha256,
  sourceLedgerSha256: request.sourceLedgerSha256,
  sourceLedgerCount: request.sourceLedgerCount,
  activeRelease: request.activeRelease,
  restoreRunId: request.restoreRunId,
  restoreRunAttempt: request.restoreRunAttempt,
  postgresMajor: request.postgresMajor,
  objectManifestSha256: request.objectManifestSha256,
  restoreHelperSha256: request.restoreHelperSha256,
  markerWriterSha256: request.markerWriterSha256,
} satisfies CommunitiesStagingRoleSplitRestoreMarkerPayload;
const marker = communitiesStagingRoleSplitRestoreMarker(payload);
const markerEvidence = {
  schemaVersion: 'communities-role-split-clone-marker-evidence-v1',
  status: 'MARKED',
  requestSha256,
  markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload),
  markerValueSha256: digest(marker),
  backupSha256: payload.backupSha256,
  sourceLedgerSha256: payload.sourceLedgerSha256,
  sourceLedgerCount: payload.sourceLedgerCount,
  cloneDatabaseOid: payload.cloneDatabaseOid,
  cloneBindingSha256: digest(`${payload.restoreDatabase}\0${payload.cloneDatabaseOid}`),
  sourceBindingSha256: digest(
    `${payload.sourceDatabase}\0${payload.sourceDatabaseOid}\0${payload.systemIdentifier}`,
  ),
  restoreRunId: payload.restoreRunId,
  restoreRunAttempt: payload.restoreRunAttempt,
  restoreHelperSha256: payload.restoreHelperSha256,
  markerWriterSha256: payload.markerWriterSha256,
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

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

type FakeOverrides = {
  readonly marker?: string | null;
  readonly cloneOid?: string;
  readonly systemIdentifier?: string;
  readonly sourceOid?: string;
  readonly reverseRecords?: boolean;
  readonly changedCategory?: string;
  readonly ledger?: readonly { filename: string; checksum: string }[];
  readonly readOnly?: boolean;
  readonly connectError?: boolean;
};

function fake(overrides: FakeOverrides = {}) {
  const queries: string[] = [];
  const query = vi.fn(<T extends Record<string, unknown>>(text: string) => {
    queries.push(text);
    if (text.includes('communities-role-split-inventory:identity'))
      return Promise.resolve(
        result([
          {
            database_name: request.restoreDatabase,
            database_oid: overrides.cloneOid ?? payload.cloneDatabaseOid,
            database_owner: request.expectedCloneDatabaseOwner,
            database_owner_oid: request.expectedCloneDatabaseOwnerOid,
            source_database_oid: overrides.sourceOid ?? request.sourceDatabaseOid,
            source_database_owner: request.sourceDatabaseOwner,
            source_database_owner_oid: request.sourceDatabaseOwnerOid,
            system_identifier: overrides.systemIdentifier ?? request.systemIdentifier,
            postgres_major: '16',
            marker: overrides.marker === undefined ? marker : overrides.marker,
            current_role: 'phub_inventory',
            session_role: 'phub_inventory',
            transaction_read_only: overrides.readOnly ? 'off' : 'on',
            role_safe: true,
          },
        ]) as unknown as QueryResult<T>,
      );
    if (text.includes('communities-role-split-inventory:ledger'))
      return Promise.resolve(
        result([...(overrides.ledger ?? ledgerRows)]) as unknown as QueryResult<T>,
      );
    const category = COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES.find((name) =>
      text.includes(`communities-role-split-inventory:${name}`),
    );
    if (category) {
      const rows = [
        { record: `["${category}","a"]` },
        { record: `["${category}","${overrides.changedCategory === category ? 'changed' : 'b'}"]` },
      ];
      return Promise.resolve(
        result(overrides.reverseRecords ? rows.reverse() : rows) as unknown as QueryResult<T>,
      );
    }
    if (text.includes('communities-role-split-inventory:manifestCoverage'))
      return Promise.resolve(
        result(
          COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.map(
            ([kind, objectName, expectation], ordinal) => {
              const present = !expectation.startsWith('absent-');
              return {
                ordinal: ordinal.toString(),
                kind,
                object_name: objectName,
                expectation,
                present,
                expected_state_matches: true,
                record: JSON.stringify([kind, objectName, expectation, present]),
              };
            },
          ),
        ) as unknown as QueryResult<T>,
      );
    if (text.includes('communities-role-split-inventory:anomalies'))
      return Promise.resolve(
        result([
          {
            public_acl_grants: '0',
            grant_options: '0',
            column_acl_entries: '0',
            non_owner_acl_grants: '0',
            dangerous_role_capabilities: '0',
            role_memberships: '0',
            mixed_object_owners: '0',
            manifest_tables_without_rls: '0',
            manifest_tables_without_forced_rls: '0',
          },
        ]) as unknown as QueryResult<T>,
      );
    return Promise.resolve(result([]) as QueryResult<T>);
  });
  return {
    queries,
    client: {
      connect: vi.fn(() =>
        overrides.connectError
          ? Promise.reject(new Error('postgresql://user:secret@shared/database'))
          : Promise.resolve(),
      ),
      query,
      end: vi.fn(() => Promise.resolve()),
    } as unknown as ReturnType<CommunitiesStagingRoleSplitInventoryClientFactory>,
  };
}

const exactInput = {
  confirmation: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION,
  connectionString: `postgresql://phub_inventory@postgres:5432/${request.restoreDatabase}`,
  requestText,
  expectedRequestSha256: requestSha256,
  markerEvidence,
};

describe('Communities staging role-split inventory producer', () => {
  it('requires the exact canonical request and its independent pin', () => {
    expect(parseCommunitiesStagingRoleSplitMarkerRequest(requestText)).toEqual(request);
    expect(() =>
      parseCommunitiesStagingRoleSplitMarkerRequest(requestText.replace(/\n/g, '\r\n')),
    ).toThrow('REQUEST_SHAPE_INVALID');
    expect(() =>
      parseCommunitiesStagingRoleSplitMarkerRequest(`${requestText}extra=value\n`),
    ).toThrow('REQUEST_SHAPE_INVALID');
  });

  it('produces deterministic redacted metadata only in a read-only repeatable-read transaction', async () => {
    const firstClient = fake();
    const reversedClient = fake({ reverseRecords: true });
    const first = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => firstClient.client,
    );
    const reversed = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => reversedClient.client,
    );
    expect(first).toEqual(reversed);
    expect(first.manifestCoverage).toMatchObject({
      entryCount: COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.length,
      exact: true,
      expectedStateMismatchCount: 0,
    });
    expect(first.authorizes).toEqual(
      expect.objectContaining({
        roleCreation: false,
        roleSplit: false,
        sharedDatabaseMutation: false,
      }),
    );
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      request.restoreDatabase,
      request.sourceDatabase,
      request.systemIdentifier,
      payload.cloneDatabaseOid,
      'phub_inventory',
      exactInput.connectionString,
    ])
      expect(serialized).not.toContain(forbidden);
    expect(firstClient.queries[0]).toBe(
      'begin transaction isolation level repeatable read read only',
    );
    expect(firstClient.queries.at(-1)).toBe('rollback');
  });

  it.each([
    ['missing marker', { marker: null }],
    ['wrong marker', { marker: `phub-communities-role-split-clone-v1:${repeatedSha('9')}` }],
    ['clone OID drift', { cloneOid: '45679' }],
    ['source OID drift', { sourceOid: '16386' }],
    ['system identifier drift', { systemIdentifier: '7421000000000000001' }],
    ['read-write transaction', { readOnly: true }],
  ])('fails closed for %s', async (_label, overrides) => {
    await expect(
      produceCommunitiesStagingRoleSplitInventory(exactInput, () => fake(overrides).client),
    ).rejects.toThrow(/^COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_/);
  });

  it('fails before catalog publication for request, evidence and ledger drift', async () => {
    await expect(
      produceCommunitiesStagingRoleSplitInventory(
        { ...exactInput, expectedRequestSha256: repeatedSha('9') },
        () => fake().client,
      ),
    ).rejects.toThrow('REQUEST_PIN_INVALID');
    await expect(
      produceCommunitiesStagingRoleSplitInventory(
        {
          ...exactInput,
          markerEvidence: { ...markerEvidence, requestSha256: repeatedSha('9') },
        },
        () => fake().client,
      ),
    ).rejects.toThrow('EVIDENCE_BINDING_INVALID');
    await expect(
      produceCommunitiesStagingRoleSplitInventory(
        exactInput,
        () =>
          fake({ ledger: [{ ...ledgerRows[0]!, checksum: repeatedSha('9') }, ledgerRows[1]!] })
            .client,
      ),
    ).rejects.toThrow('LEDGER_BINDING_INVALID');
    await expect(
      produceCommunitiesStagingRoleSplitInventory(
        exactInput,
        () => fake({ connectError: true }).client,
      ),
    ).rejects.toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_EXECUTION_FAILED');
  });

  it('contains catalog SELECTs only and never carries a mutation primitive', () => {
    const sql = [
      COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.identity,
      ...Object.values(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories),
      COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.manifestCoverage,
      COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.anomalies,
    ].join('\n');
    expect(sql).not.toMatch(
      /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|reassign|comment|copy|call|do)\b/iu,
    );
  });

  it('compares only reports with identical provenance and reports category drift', async () => {
    const before = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake().client,
    );
    const identical = compareCommunitiesStagingRoleSplitInventories(before, before);
    expect(identical).toMatchObject({
      status: 'UNCHANGED',
      inventoryUnchanged: true,
      changedCategoryCount: 0,
    });
    const after = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake({ changedCategory: 'functions' }).client,
    );
    expect(compareCommunitiesStagingRoleSplitInventories(before, after)).toMatchObject({
      status: 'CHANGED_REVIEW_REQUIRED',
      inventoryUnchanged: false,
      changedCategoryCount: 1,
      changedCategories: ['functions'],
    });
    await expect(
      Promise.resolve().then(() =>
        compareCommunitiesStagingRoleSplitInventories(before, {
          ...after,
          provenance: { ...after.provenance, requestSha256: repeatedSha('9') },
        }),
      ),
    ).rejects.toThrow(/^COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_/);
  });
});
