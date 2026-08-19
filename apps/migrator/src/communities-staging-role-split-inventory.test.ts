import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  canonicalCommunitiesStagingRoleSplitLedger,
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import type { QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  compareCommunitiesStagingRoleSplitInventories,
  compareUtf8Bytes,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CANONICALIZATION_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SORT_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL,
  COMMUNITIES_STAGING_ROLE_SPLIT_MAPPING_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES,
  parseCommunitiesStagingRoleSplitMarkerEvidence,
  produceCommunitiesStagingRoleSplitInventory,
  type CommunitiesStagingRoleSplitInventoryClientFactory,
} from './communities-staging-role-split-inventory.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const repeated = (value: string): string => value.repeat(64);
const ledgerRows = [{ filename: '0001_first.sql', checksum: repeated('a') }];
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
  backupSha256: repeated('b'),
  backupBytes: '100',
  backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
  backupEvidenceSha256: repeated('c'),
  archiveTocSha256: repeated('d'),
  sourceLedgerSha256: sha(canonicalCommunitiesStagingRoleSplitLedger(ledgerRows)),
  sourceLedgerCount: '1',
  activeRelease: 'f'.repeat(40),
  restoreRunId: '123',
  restoreRunAttempt: '4',
  postgresMajor: '16',
  objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  restoreHelperSha256: repeated('2'),
  markerWriterSha256: repeated('3'),
} satisfies CommunitiesStagingRoleSplitRestoreMarkerRequest;
const requestText = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(request);
const requestDigest = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
const payload = {
  requestSha256: requestDigest,
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
const evidenceValues = {
  status: 'MARKED',
  requestSha256: requestDigest,
  markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload),
  markerValueSha256: sha(marker),
  backupSha256: payload.backupSha256,
  sourceLedgerSha256: payload.sourceLedgerSha256,
  sourceLedgerCount: payload.sourceLedgerCount,
  cloneDatabaseOid: payload.cloneDatabaseOid,
  cloneBindingSha256: sha(`${payload.restoreDatabase}\0${payload.cloneDatabaseOid}`),
  sourceBindingSha256: sha(
    `${payload.sourceDatabase}\0${payload.sourceDatabaseOid}\0${payload.systemIdentifier}`,
  ),
  restoreRunId: payload.restoreRunId,
  restoreRunAttempt: payload.restoreRunAttempt,
  restoreHelperSha256: payload.restoreHelperSha256,
  markerWriterSha256: payload.markerWriterSha256,
};
const evidenceText =
  [
    'schemaVersion=communities-role-split-clone-marker-evidence-v1',
    ...Object.entries(evidenceValues).map(([key, value]) => `${key}=${value}`),
    'binding.request=true',
    'binding.backup=true',
    'binding.archiveOwnershipAcl=true',
    'binding.sourceStable=true',
    'binding.restoredLedger=true',
    'binding.cloneIdentity=true',
    'binding.markerReadback=true',
    'authorizes.roleCreation=false',
    'authorizes.roleSplit=false',
    'authorizes.sharedDatabaseMutation=false',
    'authorizes.migration=false',
    'authorizes.deploy=false',
    'authorizes.import=false',
    'authorizes.activation=false',
  ].join('\n') + '\n';
const mappingText =
  [
    COMMUNITIES_STAGING_ROLE_SPLIT_MAPPING_VERSION,
    ...COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES.map(
      (category, index) =>
        `${category}=${category === 'INVENTORY_READER' ? 'inventory_reader' : `role_${index + 1}`}|${17000 + index}`,
    ),
  ].join('\n') + '\n';

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function fake(options: { changed?: string; added?: string; marker?: string | null } = {}) {
  const queries: string[] = [];
  const query = vi.fn(<T extends Record<string, unknown>>(text: string) => {
    queries.push(text);
    if (text.includes(':identity'))
      return Promise.resolve(
        result([
          {
            database_name: request.restoreDatabase,
            database_oid: payload.cloneDatabaseOid,
            database_owner: request.expectedCloneDatabaseOwner,
            database_owner_oid: request.expectedCloneDatabaseOwnerOid,
            source_database_oid: request.sourceDatabaseOid,
            source_database_owner: request.sourceDatabaseOwner,
            source_database_owner_oid: request.sourceDatabaseOwnerOid,
            system_identifier: request.systemIdentifier,
            postgres_major: '16',
            marker: options.marker === undefined ? marker : options.marker,
            current_role: 'inventory_reader',
            current_role_oid: '17005',
            session_role: 'inventory_reader',
            transaction_read_only: 'on',
            role_safe: true,
          },
        ]) as unknown as QueryResult<T>,
      );
    if (text.includes(':ledger'))
      return Promise.resolve(result(ledgerRows) as unknown as QueryResult<T>);
    if (text.includes(':mapping'))
      return Promise.resolve(
        result(
          COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES.map((category, index) => ({
            role_name: category === 'INVENTORY_READER' ? 'inventory_reader' : `role_${index + 1}`,
            role_oid: String(17000 + index),
          })),
        ) as unknown as QueryResult<T>,
      );
    const category = COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES.find((name) =>
      text.includes(`:${name}`),
    );
    if (category) {
      const rows = [
        { canonical_key: `${category}-é`, value: options.changed === category ? 'changed' : 'one' },
        { canonical_key: `${category}-z`, value: 'two' },
      ];
      if (options.added === category) rows.push({ canonical_key: `${category}-new`, value: 'new' });
      return Promise.resolve(result(rows.reverse()) as unknown as QueryResult<T>);
    }
    if (text.includes(':anomalies'))
      return Promise.resolve(
        result([
          {
            dangerous_roles: '0',
            mapped_memberships: '0',
            public_grants: '0',
            third_party_grants: '0',
            grant_options: '0',
            column_grants: '0',
            default_acls: '0',
          },
        ]) as unknown as QueryResult<T>,
      );
    return Promise.resolve(result([]) as QueryResult<T>);
  });
  return {
    queries,
    client: {
      connect: vi.fn(() => Promise.resolve()),
      query,
      end: vi.fn(() => Promise.resolve()),
    } as unknown as ReturnType<CommunitiesStagingRoleSplitInventoryClientFactory>,
  };
}

const baseInput = {
  confirmation: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION,
  connectionString: `postgresql://inventory_reader@postgres:5432/${request.restoreDatabase}`,
  requestText,
  expectedRequestSha256: requestDigest,
  markerEvidenceText: evidenceText,
  expectedMarkerEvidenceSha256: sha(evidenceText),
};
const exactInput = {
  ...baseInput,
  roleMappingText: mappingText,
  expectedRoleMappingSha256: sha(mappingText),
};

describe('Communities role split INPUT_C producer', () => {
  it('parses exact A fixed-line evidence without an untrusted transform', () => {
    expect(parseCommunitiesStagingRoleSplitMarkerEvidence(evidenceText)).toMatchObject(
      evidenceValues,
    );
    expect(() =>
      parseCommunitiesStagingRoleSplitMarkerEvidence(evidenceText.replace('\n', '\r\n')),
    ).toThrow('EVIDENCE_SHAPE_INVALID');
  });

  it('emits the exact twelve-category redacted shape and exact provenance', async () => {
    const target = fake();
    const report = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => target.client,
    );
    expect(report).toMatchObject({
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION,
      canonicalizationVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CANONICALIZATION_VERSION,
      sortVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SORT_VERSION,
      provenance: { mappingObservationState: 'OBSERVED', cloneOidBound: true, pgMajor: 16 },
    });
    expect(Object.keys(report.normalized)).toEqual([
      ...COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES,
    ]);
    for (const records of Object.values(report.normalized))
      for (const record of records) {
        expect(record.canonicalKeySha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(record.observationState).toBe('OBSERVED');
        expect(record.valueSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(record.provenanceSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    expect(JSON.stringify(report)).not.toMatch(
      /phub_restore|phub_staging|inventory_reader|7421000000000000000|45678/u,
    );
    expect(target.queries[0]).toBe('begin transaction isolation level repeatable read read only');
    expect(target.queries.at(-1)).toBe('rollback');
  });

  it('uses Buffer byte sorting and marks missing mapping UNKNOWN/fail-closed', async () => {
    expect(['é', 'z'].sort(compareUtf8Bytes)).toEqual(['z', 'é']);
    const report = await produceCommunitiesStagingRoleSplitInventory(
      baseInput,
      () => fake().client,
    );
    expect(report.provenance).toMatchObject({
      mappingObservationState: 'UNKNOWN',
      mappingDigest: null,
    });
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ code: 'MAPPING_INCOMPLETE', count: 1 }),
    );
  });

  it('separates explicit/effective ACLs, expands NULL defaults and captures extension membership', () => {
    const sql = Object.values(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories).join('\n');
    for (const code of ['d', 'n', 'r', 's', 'f', 'T'])
      expect(sql).toContain(`acldefault('${code}'`);
    expect(sql).toContain("'|explicit|'");
    expect(sql).toContain("'|effective|'");
    expect(sql).toContain("'<NULL>'");
    expect(sql).not.toMatch(/order\s+by|collate/iu);
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      'pg_catalog.pg_depend',
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      "dependency.deptype='e'",
    );
  });

  it('reports record deltas and rejects schema, canonicalization, sort or provenance drift', async () => {
    const before = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake().client,
    );
    const after = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake({ changed: 'functions', added: 'extensions' }).client,
    );
    const comparison = compareCommunitiesStagingRoleSplitInventories(before, after);
    expect(comparison).toMatchObject({
      changedRecordCount: 1,
      addedRecordCount: 1,
      removedRecordCount: 0,
    });
    expect(comparison.forbiddenTransitionCodes).toContain('EXTENSION_CHANGE_FORBIDDEN');
    expect(comparison.forbiddenTransitionCodes).toContain('OUT_OF_MANIFEST_CHANGE_FORBIDDEN');
    for (const drift of [
      { schemaVersion: 'other' },
      { canonicalizationVersion: 'other' },
      { sortVersion: 'other' },
      { provenance: { ...before.provenance, markerDigest: repeated('9') } },
    ])
      expect(() =>
        compareCommunitiesStagingRoleSplitInventories(before, { ...before, ...drift }),
      ).toThrow(/^COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_/u);
  });

  it('builds exact CLI dist entries and fails closed without pins before DB access', () => {
    execFileSync('npm', ['run', 'build', '-w', '@phub/migrator'], {
      cwd: new URL('../../..', import.meta.url),
      stdio: 'ignore',
    });
    const producer = new URL(
      '../dist/produce-communities-staging-role-split-inventory.js',
      import.meta.url,
    );
    const comparison = new URL(
      '../dist/compare-communities-staging-role-split-inventories.js',
      import.meta.url,
    );
    expect(existsSync(producer)).toBe(true);
    expect(existsSync(comparison)).toBe(true);
    const smoke = spawnSync(process.execPath, [fileURLToPath(producer)], {
      env: {},
      encoding: 'utf8',
    });
    expect(smoke).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_INPUT_INVALID\n',
    });
    const compareSmoke = spawnSync(process.execPath, [fileURLToPath(comparison)], {
      env: {},
      encoding: 'utf8',
    });
    expect(compareSmoke).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_INPUT_INVALID\n',
    });
  }, 30_000);
});
