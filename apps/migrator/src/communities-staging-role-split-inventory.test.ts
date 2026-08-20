import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
  assertCommunitiesRoleSplitAcceptancePass,
  assertCommunitiesRoleSplitInputC,
  canonicalCommunitiesStagingRoleSplitLedger,
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  communitiesRoleSplitCanonicalJson,
  communitiesRoleSplitInputCArtifactSha256,
  communitiesRoleSplitInputCArtifactText,
  communitiesRoleSplitInputCManifestSha256,
  type CommunitiesRoleSplitAcceptanceEnvelope,
  type CommunitiesRoleSplitExpectedPins,
  type CommunitiesRoleSplitGrantDecision,
  type CommunitiesRoleSplitGrantObjectKind,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitObjectKind,
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
import {
  communitiesStagingRoleSplitInventoryArtifactVerificationText,
  verifyCommunitiesStagingRoleSplitInventoryArtifact,
} from './communities-staging-role-split-inventory-artifact.js';
import {
  COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_PINS_VERSION,
  communitiesRoleSplitAcceptanceArtifactPinsText,
  communitiesRoleSplitAcceptanceArtifactVerificationText,
  verifyCommunitiesRoleSplitAcceptanceArtifact,
  type CommunitiesRoleSplitAcceptanceArtifactPins,
} from './communities-role-split-acceptance-artifact.js';

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type JsonSchema = Record<string, unknown>;
function validatesJsonSchema(root: JsonSchema, schema: JsonSchema, value: unknown): boolean {
  if (typeof schema.$ref === 'string') {
    const resolved = schema.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (target, key) =>
          typeof target === 'object' && target !== null
            ? (target as Record<string, unknown>)[key]
            : undefined,
        root,
      );
    return (
      typeof resolved === 'object' &&
      resolved !== null &&
      validatesJsonSchema(root, resolved as JsonSchema, value)
    );
  }
  if ('const' in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (
    Array.isArray(schema.allOf) &&
    schema.allOf.some((candidate) => !validatesJsonSchema(root, candidate as JsonSchema, value))
  )
    return false;
  if (typeof schema.if === 'object' && schema.if !== null) {
    const condition = validatesJsonSchema(root, schema.if as JsonSchema, value);
    const branch = condition ? schema.then : schema.else;
    if (
      typeof branch === 'object' &&
      branch !== null &&
      !validatesJsonSchema(root, branch as JsonSchema, value)
    )
      return false;
  }
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((candidate) => validatesJsonSchema(root, candidate as JsonSchema, value))
      .length !== 1
  )
    return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const actual =
      value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : Number.isInteger(value)
            ? 'integer'
            : typeof value;
    if (!types.includes(actual)) return false;
  }
  if (
    typeof value === 'string' &&
    typeof schema.pattern === 'string' &&
    !new RegExp(schema.pattern, 'u').test(value)
  )
    return false;
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum)
    return false;
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      return false;
    if (
      typeof schema.items === 'object' &&
      schema.items !== null &&
      value.some((item) => !validatesJsonSchema(root, schema.items as JsonSchema, item))
    )
      return false;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((key) => typeof key !== 'string' || !(key in object))
    )
      return false;
    const properties =
      typeof schema.properties === 'object' && schema.properties !== null
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
    if (
      schema.additionalProperties === false &&
      Object.keys(object).some((key) => !(key in properties))
    )
      return false;
    if (
      Object.entries(properties).some(
        ([key, child]) => key in object && !validatesJsonSchema(root, child, object[key]),
      )
    )
      return false;
  }
  return true;
}
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
  creationReceiptSha256: repeated('4'),
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
  creationReceiptSha256: payload.creationReceiptSha256,
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
    'schemaVersion=communities-role-split-clone-marker-evidence-v2',
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

type CatalogAclEntry = {
  granteeOid: string;
  grantorOid: string;
  privilege: string;
  grantOption: boolean;
};

function fake(
  options: {
    changed?: string;
    added?: string;
    marker?: string | null;
    acl?: Partial<Record<string, readonly CatalogAclEntry[]>>;
    thirdPartyGrants?: string;
    unsupportedExtensionMembers?: string;
  } = {},
) {
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
            can_login: true,
            superuser: false,
            bypass_rls: false,
            create_database: false,
            create_role: false,
            replication: false,
          })),
        ) as unknown as QueryResult<T>,
      );
    const category = COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES.find((name) =>
      text.includes(`:${name}`),
    );
    if (category) {
      const objectCategories = new Set([
        'databaseAcl',
        'schemas',
        'relations',
        'sequences',
        'functions',
        'types',
      ]);
      if (objectCategories.has(category)) {
        const aclEntries =
          options.acl?.[category] ??
          (options.changed === category
            ? [
                {
                  granteeOid: '17004',
                  grantorOid: '17003',
                  privilege: 'SELECT',
                  grantOption: false,
                },
              ]
            : []);
        const objectIdentities = (
          category === 'functions'
            ? [
                [category, 'a.b', 'c|d', 'integer'],
                [category, 'a', 'b.c|d', 'integer'],
                [category, 'a.b', 'c|d', 'text'],
              ]
            : [[category, 'quoted.name|part', '']]
        ).map((identity) => JSON.stringify(identity));
        const rows = objectIdentities.flatMap((objectIdentity) => [
          {
            object_identity: objectIdentity,
            field_identity: JSON.stringify(['owner']),
            field_kind: 'OWNER',
            value: 'role_3',
            owner_oid: '17002',
          },
          {
            object_identity: objectIdentity,
            field_identity: JSON.stringify(['explicitAcl']),
            field_kind: 'ACL_EXPLICIT',
            value: JSON.stringify(aclEntries),
            owner_oid: null,
          },
          {
            object_identity: objectIdentity,
            field_identity: JSON.stringify(['effectiveAcl']),
            field_kind: 'ACL_EFFECTIVE',
            value: JSON.stringify(aclEntries),
            owner_oid: null,
          },
        ]);
        if (options.added === category)
          rows.push({
            object_identity: JSON.stringify([category, 'new']),
            field_identity: JSON.stringify(['metadata']),
            field_kind: 'METADATA',
            value: 'new',
            owner_oid: null,
          });
        return Promise.resolve(result(rows.reverse()) as unknown as QueryResult<T>);
      }
      if (category === 'extensions') {
        const rows = [
          {
            object_identity: JSON.stringify(['extension', 'quoted.name|part']),
            field_identity: JSON.stringify(['owner']),
            field_kind: 'OWNER',
            value: 'role_3',
            owner_oid: '17002',
          },
          {
            object_identity: JSON.stringify(['extension', 'quoted.name|part']),
            field_identity: JSON.stringify(['metadata']),
            field_kind: 'METADATA',
            value: options.changed === category ? 'changed' : 'metadata',
            owner_oid: null,
          },
        ];
        if (options.added === category)
          rows.push({
            object_identity: JSON.stringify(['extension', 'quoted.name|part']),
            field_identity: JSON.stringify(['member', 'new']),
            field_kind: 'EXTENSION_MEMBER',
            value: 'new',
            owner_oid: null,
          });
        return Promise.resolve(result(rows.reverse()) as unknown as QueryResult<T>);
      }
      const kind =
        category === 'roles'
          ? 'ROLE'
          : category === 'memberships'
            ? 'MEMBERSHIP'
            : category === 'defaultAcls'
              ? 'DEFAULT_ACL'
              : category === 'columnAcls'
                ? 'ACL_EXPLICIT'
                : category === 'rlsPolicies'
                  ? 'RLS'
                  : 'METADATA';
      const rows = [
        {
          object_identity: JSON.stringify([category, 'é.name|part']),
          field_identity: JSON.stringify([kind === 'ACL_EXPLICIT' ? 'explicitAcl' : 'metadata']),
          field_kind: kind,
          value: kind === 'ACL_EXPLICIT' ? '[]' : options.changed === category ? 'changed' : 'one',
          owner_oid: null,
        },
        {
          object_identity: JSON.stringify([category, 'z']),
          field_identity: JSON.stringify([kind === 'ACL_EXPLICIT' ? 'explicitAcl' : 'metadata']),
          field_kind: kind,
          value: kind === 'ACL_EXPLICIT' ? '[]' : 'two',
          owner_oid: null,
        },
      ];
      if (options.added === category)
        rows.push({
          object_identity: JSON.stringify([category, 'new']),
          field_identity: JSON.stringify(['metadata']),
          field_kind: kind,
          value: kind === 'ACL_EXPLICIT' ? '[]' : 'new',
          owner_oid: null,
        });
      return Promise.resolve(result(rows.reverse()) as unknown as QueryResult<T>);
    }
    if (text.includes(':anomalies'))
      return Promise.resolve(
        result([
          {
            dangerous_roles: '0',
            mapped_memberships: '0',
            mixed_owners: '0',
            extension_owner_mismatches: '0',
            unsupported_extension_members: options.unsupportedExtensionMembers ?? '0',
            public_grants: '0',
            third_party_grants: options.thirdPartyGrants ?? '0',
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
      provenance: {
        contractVersion: 'communities-role-split-clone-marker-evidence-v2',
        creationReceiptSha256: payload.creationReceiptSha256,
        cloneOidBound: true,
        pgMajor: 16,
      },
    });
    expect(Object.keys(report.normalized)).toEqual([
      ...COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES,
    ]);
    for (const records of Object.values(report.normalized))
      for (const record of records) {
        expect(record.objectKeySha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(record.fieldKeySha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(record.fieldKind).toMatch(/^[A-Z_]+$/u);
        expect(record.observationState).toBe('OBSERVED');
        expect(record.valueSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(record.provenanceSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    const overloadedFunctionOwners = report.normalized.functions.filter(
      (record) => record.fieldKind === 'OWNER',
    );
    expect(overloadedFunctionOwners).toHaveLength(3);
    expect(new Set(overloadedFunctionOwners.map((record) => record.objectKeySha256)).size).toBe(3);
    expect(JSON.stringify(report)).not.toMatch(
      /phub_restore|phub_staging|inventory_reader|7421000000000000000|45678/u,
    );
    expect(target.queries[0]).toBe('begin transaction isolation level repeatable read read only');
    expect(target.queries.at(-1)).toBe('rollback');
  });

  it('verifies only canonical INPUT_C bytes against an independently supplied artifact pin', async () => {
    const report = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake().client,
    );
    const artifactBytes = Buffer.from(communitiesRoleSplitInputCArtifactText(report), 'utf8');
    const artifactSha256 = communitiesRoleSplitInputCArtifactSha256(report);
    const verification = verifyCommunitiesStagingRoleSplitInventoryArtifact(
      artifactBytes,
      artifactSha256,
    );
    expect(verification).toMatchObject({
      schemaVersion: 'communities-role-split-inventory-artifact-verification-v1',
      artifactSha256,
      manifestSha256: report.manifestSha256,
      anomalyObservationCount: 0,
      binding: { callerSuppliedArtifactPinMatched: true, canonicalArtifactBytes: true },
      limitations: {
        independentCustodyNotAttested: true,
        cleanCloneProvenanceNotAttested: true,
      },
      authorizes: {
        roleCreation: false,
        roleRepair: false,
        roleSplit: false,
        aclMutation: false,
        schemaMutation: false,
        sharedDatabaseMutation: false,
        migration: false,
        deploy: false,
        activation: false,
      },
    });
    expect(Object.keys(verification.normalizedRecordCounts)).toEqual([
      ...COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES,
    ]);
    expect(communitiesStagingRoleSplitInventoryArtifactVerificationText(verification)).not.toMatch(
      /phub_restore|phub_staging|inventory_reader|7421000000000000000|45678/u,
    );
    expect(() =>
      verifyCommunitiesStagingRoleSplitInventoryArtifact(artifactBytes, repeated('9')),
    ).toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_INVALID');
    expect(() =>
      verifyCommunitiesStagingRoleSplitInventoryArtifact(
        Buffer.from(` ${artifactBytes.toString('utf8')}`, 'utf8'),
        artifactSha256,
      ),
    ).toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_INVALID');
  });

  it('passes a real C artifact through JSON Schema structural validation and the D evaluator', async () => {
    const select = {
      granteeOid: '17004',
      grantorOid: '17003',
      privilege: 'SELECT',
      grantOption: false,
    } as const;
    const update = {
      granteeOid: '17004',
      grantorOid: '17003',
      privilege: 'UPDATE',
      grantOption: false,
    } as const;
    const observedBefore = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake({ acl: { sequences: [update] } }).client,
    );
    const observedAfter = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake({ acl: { relations: [select] } }).client,
    );
    const objectCategories = {
      database: 'databaseAcl',
      schema: 'schemas',
      relation: 'relations',
      sequence: 'sequences',
      function: 'functions',
      type: 'types',
      extension: 'extensions',
    } as const;
    const ownershipPlan = (
      Object.keys(objectCategories) as CommunitiesRoleSplitObjectKind[]
    ).flatMap((objectKind) =>
      observedBefore.normalized[objectCategories[objectKind]]
        .filter((record) => record.fieldKind === 'OWNER')
        .map((owner) => ({
          objectKind,
          objectKeySha256: owner.objectKeySha256,
          ownerFieldKeySha256: owner.fieldKeySha256,
          beforeOwnerCategory: 'SHARED_OWNER' as const,
          targetOwnerCategory: 'PRESERVE_CURRENT' as const,
          beforeOwnerValueSha256: owner.valueSha256!,
          afterOwnerValueSha256: owner.valueSha256!,
          ownerEvidenceSha256: owner.provenanceSha256!,
        })),
    );
    const grantPlan: CommunitiesRoleSplitGrantDecision[] = (
      Object.keys(objectCategories).filter(
        (kind) => kind !== 'extension',
      ) as CommunitiesRoleSplitGrantObjectKind[]
    ).flatMap((objectKind) =>
      observedBefore.normalized[objectCategories[objectKind]]
        .filter(
          (record) => record.fieldKind === 'ACL_EXPLICIT' || record.fieldKind === 'ACL_EFFECTIVE',
        )
        .flatMap((record): CommunitiesRoleSplitGrantDecision[] => {
          const after = observedAfter.normalized[objectCategories[objectKind]].find(
            (candidate) => candidate.fieldKeySha256 === record.fieldKeySha256,
          )!;
          const beforeEntries =
            record.semantic && 'entries' in record.semantic ? record.semantic.entries : [];
          const afterEntries =
            after.semantic && 'entries' in after.semantic ? after.semantic.entries : [];
          const beforeKeys = new Set(beforeEntries.map((entry) => JSON.stringify(entry)));
          const afterKeys = new Set(afterEntries.map((entry) => JSON.stringify(entry)));
          const common = {
            objectKind,
            objectKeySha256: record.objectKeySha256,
            fieldKeySha256: record.fieldKeySha256,
            beforeStateSha256: record.valueSha256!,
            targetStateSha256: after.valueSha256!,
            evidenceSha256: record.provenanceSha256!,
            grantOption: false as const,
          };
          const changed = [
            ...afterEntries
              .filter((entry) => !beforeKeys.has(JSON.stringify(entry)))
              .map((entry) => ({
                ...common,
                action: 'ADD' as const,
                granteeCategory:
                  entry.granteeCategory as CommunitiesRoleSplitGrantDecision['granteeCategory'],
                granteeEvidenceSha256: entry.granteeEvidenceSha256,
                grantorCategory: entry.grantorCategory,
                grantorEvidenceSha256: entry.grantorEvidenceSha256,
                occurrenceSha256: entry.occurrenceSha256,
                privileges: [
                  entry.privilege as CommunitiesRoleSplitGrantDecision['privileges'][number],
                ],
              })),
            ...beforeEntries
              .filter((entry) => !afterKeys.has(JSON.stringify(entry)))
              .map((entry) => ({
                ...common,
                action: 'REMOVE' as const,
                granteeCategory:
                  entry.granteeCategory as CommunitiesRoleSplitGrantDecision['granteeCategory'],
                granteeEvidenceSha256: entry.granteeEvidenceSha256,
                grantorCategory: entry.grantorCategory,
                grantorEvidenceSha256: entry.grantorEvidenceSha256,
                occurrenceSha256: entry.occurrenceSha256,
                privileges: [
                  entry.privilege as CommunitiesRoleSplitGrantDecision['privileges'][number],
                ],
              })),
          ];
          return changed.length > 0
            ? changed
            : [
                {
                  ...common,
                  action: 'PRESERVE',
                  granteeCategory: 'FUTURE_RUNTIME',
                  granteeEvidenceSha256: null,
                  grantorCategory: null,
                  grantorEvidenceSha256: null,
                  occurrenceSha256: null,
                  privileges: [],
                },
              ];
        }),
    );
    const envelope: CommunitiesRoleSplitAcceptanceEnvelope = {
      contractVersion: COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_VERSION,
      observedBefore,
      observedAfter,
      ownershipPlan,
      grantPlan,
      comparison: {
        sortVersion: observedBefore.sortVersion,
        beforeManifestSha256: observedBefore.manifestSha256,
        afterManifestSha256: observedAfter.manifestSha256,
        changedCount: 4,
        addedCount: 0,
        removedCount: 0,
        forbiddenTransitionCodes: [],
      },
      decision: {
        status: 'PASS',
        blockerCodes: [],
        authorizesRoleCreation: false,
        authorizesRoleAlteration: false,
        authorizesAclMutation: false,
        authorizesMigration: false,
        authorizesDeploy: false,
        authorizesRuntimeActivation: false,
      },
    };
    const schema = JSON.parse(
      readFileSync(
        new URL(
          '../../../docs/plans/communities-role-split-acceptance-v1.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as JsonSchema;
    expect(validatesJsonSchema(schema, schema, envelope)).toBe(true);
    const pins: CommunitiesRoleSplitExpectedPins = {
      beforeArtifactSha256: communitiesRoleSplitInputCArtifactSha256(observedBefore),
      afterArtifactSha256: communitiesRoleSplitInputCArtifactSha256(observedAfter),
      beforeManifestSha256: observedBefore.manifestSha256,
      afterManifestSha256: observedAfter.manifestSha256,
      expectedMappingDigest: observedBefore.provenance.mappingDigest,
      markerDigest: observedBefore.provenance.markerDigest,
      markerEvidenceDigest: observedBefore.provenance.markerEvidenceDigest,
      requestDigest: observedBefore.provenance.requestDigest,
      creationReceiptSha256: observedBefore.provenance.creationReceiptSha256,
      objectManifestDigest: observedBefore.provenance.objectManifestDigest,
      ledgerDigest: observedBefore.provenance.ledgerDigest,
    };
    expect(assertCommunitiesRoleSplitAcceptancePass(envelope, pins)).toEqual(envelope.comparison);

    const acceptanceEnvelopeBytes = Buffer.from(
      `${communitiesRoleSplitCanonicalJson(envelope)}\n`,
      'utf8',
    );
    const acceptanceArtifactPins: CommunitiesRoleSplitAcceptanceArtifactPins = {
      schemaVersion: COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_PINS_VERSION,
      acceptanceEnvelopeSha256: sha(acceptanceEnvelopeBytes),
      ...pins,
    };
    const pinsText = communitiesRoleSplitAcceptanceArtifactPinsText(acceptanceArtifactPins);
    const verification = verifyCommunitiesRoleSplitAcceptanceArtifact({
      acceptanceEnvelopeBytes,
      beforeArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedBefore)),
      afterArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedAfter)),
      pinsBytes: Buffer.from(pinsText),
      independentlyPinnedPinsSha256: sha(pinsText),
    });
    expect(verification).toMatchObject({
      status: 'ACCEPTANCE_PASS_REVIEW_ONLY',
      pinsArtifactSha256: sha(pinsText),
      acceptanceEnvelopeSha256: acceptanceArtifactPins.acceptanceEnvelopeSha256,
      beforeArtifactSha256: pins.beforeArtifactSha256,
      afterArtifactSha256: pins.afterArtifactSha256,
      comparison: {
        changedCount: 4,
        addedCount: 0,
        removedCount: 0,
        forbiddenTransitionCount: 0,
      },
      bindings: {
        callerSuppliedPinsArtifactMatched: true,
        embeddedSnapshotsMatchedExternalArtifacts: true,
        authoritativeAcceptanceEvaluatorPassed: true,
      },
      limitations: {
        independentPinCustodyNotAttested: true,
        independentlySourcedCleanCloneNotAttested: true,
        dbaRoleMatrixReviewNotAttested: true,
        v3ExecutableCompositionNotPresent: true,
      },
      authorizes: {
        trustedInventoryDesignation: false,
        executionCandidateBuild: false,
        forcedCommandKey: false,
        ceremony: false,
        roleCreation: false,
        roleSplit: false,
        aclMutation: false,
        sharedDatabaseMutation: false,
        migration: false,
        deploy: false,
        activation: false,
      },
    });
    expect(communitiesRoleSplitAcceptanceArtifactVerificationText(verification)).not.toMatch(
      /phub_restore|phub_staging|inventory_reader|7421000000000000000|45678/u,
    );
    expect(() =>
      verifyCommunitiesRoleSplitAcceptanceArtifact({
        acceptanceEnvelopeBytes: Buffer.from(` ${acceptanceEnvelopeBytes.toString('utf8')}`),
        beforeArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedBefore)),
        afterArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedAfter)),
        pinsBytes: Buffer.from(pinsText),
        independentlyPinnedPinsSha256: sha(pinsText),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_INVALID');
    expect(() =>
      verifyCommunitiesRoleSplitAcceptanceArtifact({
        acceptanceEnvelopeBytes,
        beforeArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedBefore)),
        afterArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedAfter)),
        pinsBytes: Buffer.from(pinsText),
        independentlyPinnedPinsSha256: repeated('9'),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_INVALID');
    const mismatchedEnvelopeBytes = Buffer.from(
      `${communitiesRoleSplitCanonicalJson({ ...envelope, observedBefore: observedAfter })}\n`,
    );
    const mismatchedPinsText = communitiesRoleSplitAcceptanceArtifactPinsText({
      ...acceptanceArtifactPins,
      acceptanceEnvelopeSha256: sha(mismatchedEnvelopeBytes),
    });
    expect(() =>
      verifyCommunitiesRoleSplitAcceptanceArtifact({
        acceptanceEnvelopeBytes: mismatchedEnvelopeBytes,
        beforeArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedBefore)),
        afterArtifactBytes: Buffer.from(communitiesRoleSplitInputCArtifactText(observedAfter)),
        pinsBytes: Buffer.from(mismatchedPinsText),
        independentlyPinnedPinsSha256: sha(mismatchedPinsText),
      }),
    ).toThrow('COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_INVALID');
  });

  it('uses Buffer byte sorting and rejects missing mapping before database access', async () => {
    expect(['é', 'z'].sort(compareUtf8Bytes)).toEqual(['z', 'é']);
    await expect(
      produceCommunitiesStagingRoleSplitInventory(
        baseInput as Parameters<typeof produceCommunitiesStagingRoleSplitInventory>[0],
        () => fake().client,
      ),
    ).rejects.toThrow('MAPPING_INVALID');
  });

  it('uses structured identities, stable ACL fields, defaults and overloaded function identities', () => {
    const sql = Object.values(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories).join('\n');
    for (const code of ['d', 'n', 'r', 's', 'f', 'T'])
      expect(sql).toContain(`acldefault('${code}'`);
    expect(sql).toContain("jsonb_build_array('explicitAcl')");
    expect(sql).toContain("jsonb_build_array('effectiveAcl')");
    expect(sql).toContain('when pg_catalog.cardinality(');
    expect(sql).toContain("is null then pg_catalog.acldefault('");
    expect(sql).toContain('pg_get_function_identity_arguments');
    expect(sql).toContain('owner.rolname::text value');
    expect(sql).not.toContain("aclexplode(coalesce(attribute.attacl,'{}'::aclitem[]))");
    expect(sql).not.toContain("'{}'::aclitem[]");
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.functions).toContain(
      "dependency.deptype='e'",
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.types).toContain(
      "relation.oid=object_type.typrelid and relation.relkind='c'",
    );
    expect(sql).not.toContain('canonical_key');
    expect(sql).not.toMatch(/\|owner|\|metadata|\|explicit|\|effective/u);
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      'pg_catalog.pg_depend',
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      'namespace.oid=extension.extnamespace',
    );
    const anomalySql = COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.anomalies;
    const anomalyAcl = anomalySql.slice(
      anomalySql.indexOf('), acl('),
      anomalySql.indexOf('), exploded as'),
    );
    expect(anomalyAcl).not.toContain("dependency.deptype='e'");
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.anomalies).toContain(
      'extension_owner_mismatches',
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.anomalies).toContain(
      'unsupported_extension_members',
    );
    for (const catalog of ['pg_amop', 'pg_amproc', 'pg_cast'])
      expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.anomalies).toContain(catalog);
    for (const catalog of ['pg_operator', 'pg_opclass', 'pg_opfamily'])
      expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(catalog);
    for (const namespaceColumn of ['oprnamespace', 'opcnamespace', 'opfnamespace']) {
      expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
        namespaceColumn,
      );
      expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.anomalies).toContain(namespaceColumn);
    }
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      "'columnAcl'",
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      "'policies'",
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      "'securityDefiner'",
    );
    expect(COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL.categories.extensions).toContain(
      "dependency.deptype='e'",
    );
  });

  it('redacts distinct third-party grantors and preserves duplicate ACL occurrences', async () => {
    const report = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () =>
        fake({
          acl: {
            relations: [
              { granteeOid: '17004', grantorOid: '18001', privilege: 'SELECT', grantOption: false },
              { granteeOid: '17004', grantorOid: '18001', privilege: 'SELECT', grantOption: false },
              { granteeOid: '17004', grantorOid: '18002', privilege: 'SELECT', grantOption: false },
            ],
          },
          thirdPartyGrants: '3',
        }).client,
    );
    const explicit = report.normalized.relations.find(
      (record) => record.fieldKind === 'ACL_EXPLICIT',
    )!;
    const entries =
      explicit.semantic && 'entries' in explicit.semantic ? explicit.semantic.entries : [];
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.grantorEvidenceSha256)).size).toBe(2);
    expect(new Set(entries.map((entry) => entry.occurrenceSha256)).size).toBe(3);
    expect(entries.every((entry) => entry.grantorCategory === 'THIRD_PARTY')).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/18001|18002/u);
  });

  it('blocks an extension member from an unreviewed catalog class', async () => {
    const report = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake({ unsupportedExtensionMembers: '1' }).client,
    );
    expect(report.anomalies).toEqual([
      expect.objectContaining({ code: 'EXTENSION_CHANGE_FORBIDDEN', count: 1 }),
    ]);
  });

  it('keeps JSON Schema and runtime INPUT_C validation in nested-key and semantic parity', async () => {
    const valid = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () => fake().client,
    );
    const schema = JSON.parse(
      readFileSync(
        new URL(
          '../../../docs/plans/communities-role-split-acceptance-v1.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as JsonSchema;
    const inputSchema = (schema.$defs as Record<string, JsonSchema>).inputC!;
    const accepts = (candidate: unknown): [boolean, boolean] => {
      const structural = validatesJsonSchema(schema, inputSchema, candidate);
      let runtime = true;
      try {
        assertCommunitiesRoleSplitInputC(candidate);
      } catch {
        runtime = false;
      }
      return [structural, runtime];
    };
    expect(accepts(valid)).toEqual([true, true]);

    const extraProvenance = structuredClone(valid) as CommunitiesRoleSplitInputC & {
      provenance: CommunitiesRoleSplitInputC['provenance'] & { extra?: boolean };
    };
    extraProvenance.provenance.extra = true;
    expect(accepts(extraProvenance)).toEqual([false, false]);

    const missingAuthorization = structuredClone(valid) as unknown as {
      authorizes: Record<string, boolean>;
    };
    delete missingAuthorization.authorizes.activation;
    expect(accepts(missingAuthorization)).toEqual([false, false]);

    const missingCapability = structuredClone(valid) as unknown as {
      mapping: { categories: { capabilities: Record<string, boolean> }[] };
    };
    delete missingCapability.mapping.categories[0]!.capabilities.replication;
    expect(accepts(missingCapability)).toEqual([false, false]);

    const extraAclEntry = await produceCommunitiesStagingRoleSplitInventory(
      exactInput,
      () =>
        fake({
          acl: {
            relations: [
              { granteeOid: '17004', grantorOid: '17003', privilege: 'SELECT', grantOption: false },
            ],
          },
        }).client,
    );
    const aclRecord = extraAclEntry.normalized.relations.find(
      (record) => record.fieldKind === 'ACL_EXPLICIT',
    )!;
    if (!aclRecord.semantic || !('entries' in aclRecord.semantic)) throw new Error('test fixture');
    (
      aclRecord.semantic
        .entries[0] as unknown as CommunitiesRoleSplitInputC['normalized']['relations'][number]['semantic'] & {
        extra?: boolean;
      }
    ).extra = true;
    expect(accepts(extraAclEntry)).toEqual([false, false]);

    for (const fieldKind of ['OWNER', 'ACL_EXPLICIT'] as const) {
      const unknown = structuredClone(valid);
      const target = Object.values(unknown.normalized)
        .flat()
        .find((record) => record.fieldKind === fieldKind)!;
      (target as { observationState: string }).observationState = 'UNKNOWN';
      (target as { valueSha256: string | null }).valueSha256 = null;
      (target as { provenanceSha256: string | null }).provenanceSha256 = null;
      (target as { semantic: unknown }).semantic = null;
      (unknown as { manifestSha256: string }).manifestSha256 =
        communitiesRoleSplitInputCManifestSha256(unknown);
      expect(accepts(unknown)).toEqual([true, true]);
    }

    for (const fieldKind of ['OWNER', 'ACL_EXPLICIT'] as const) {
      const invalid = structuredClone(valid);
      const target = Object.values(invalid.normalized)
        .flat()
        .find((record) => record.fieldKind === fieldKind)!;
      (target as { semantic: unknown }).semantic = null;
      (invalid as { manifestSha256: string }).manifestSha256 =
        communitiesRoleSplitInputCManifestSha256(invalid);
      expect(accepts(invalid)).toEqual([false, false]);
    }
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
      changedRecordCount: 6,
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
    const artifactVerifier = new URL(
      '../dist/verify-communities-staging-role-split-inventory-artifact.js',
      import.meta.url,
    );
    const acceptanceArtifactVerifier = new URL(
      '../dist/verify-communities-role-split-acceptance-artifact.js',
      import.meta.url,
    );
    expect(existsSync(producer)).toBe(true);
    expect(existsSync(comparison)).toBe(true);
    expect(existsSync(artifactVerifier)).toBe(true);
    expect(existsSync(acceptanceArtifactVerifier)).toBe(true);
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
    const artifactVerifierSmoke = spawnSync(process.execPath, [fileURLToPath(artifactVerifier)], {
      env: {},
      encoding: 'utf8',
    });
    expect(artifactVerifierSmoke).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_INVALID\n',
    });
    const acceptanceArtifactVerifierSmoke = spawnSync(
      process.execPath,
      [fileURLToPath(acceptanceArtifactVerifier)],
      { env: {}, encoding: 'utf8' },
    );
    expect(acceptanceArtifactVerifierSmoke).toMatchObject({
      status: 1,
      stdout: '',
      stderr: 'COMMUNITIES_ROLE_SPLIT_ACCEPTANCE_ARTIFACT_INVALID\n',
    });
  }, 30_000);
});
