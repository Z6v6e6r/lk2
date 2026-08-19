import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
} from './communities-staging-role-split-restore-marker.js';
import { failCommunitiesStagingRoleSplit } from './communities-staging-role-split.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_VERSION =
  'communities-staging-role-split-inventory-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_VERSION =
  'communities-staging-role-split-inventory-artifact-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_DIFF_VERSION =
  'communities-staging-role-split-inventory-diff-v1';

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonRecord = { readonly [key: string]: JsonValue };

export interface CommunitiesStagingRoleSplitInventoryInput {
  readonly database: { readonly name: string; readonly owner: string; readonly acl: JsonValue };
  readonly schemas: readonly {
    readonly name: string;
    readonly exists: boolean;
    readonly owner: string | null;
    readonly acl: JsonValue;
  }[];
  readonly default_acls: readonly {
    readonly role: string;
    readonly schema: string | null;
    readonly type: string;
    readonly acl: JsonValue;
  }[];
  readonly relations: readonly {
    readonly schema: string;
    readonly name: string;
    readonly kind: string;
    readonly owner: string;
    readonly acl: JsonValue;
    readonly rls: boolean;
    readonly force_rls: boolean;
  }[];
  readonly column_acls: readonly {
    readonly schema: string;
    readonly relation: string;
    readonly column: string;
    readonly acl: JsonValue;
  }[];
  readonly policies: readonly {
    readonly schema: string;
    readonly table: string;
    readonly name: string;
    readonly permissive: string;
    readonly roles: readonly string[];
    readonly command: string;
    readonly qual: string | null;
    readonly check: string | null;
  }[];
  readonly routines: readonly {
    readonly schema: string;
    readonly name: string;
    readonly identity_args: string;
    readonly kind: string;
    readonly owner: string;
    readonly acl: JsonValue;
    readonly security_definer: boolean;
    readonly config: JsonValue;
  }[];
  readonly types: readonly {
    readonly schema: string;
    readonly name: string;
    readonly kind: string;
    readonly owner: string;
    readonly acl: JsonValue;
  }[];
  readonly extensions: readonly {
    readonly name: string;
    readonly version: string;
    readonly schema: string;
    readonly owner: string;
  }[];
}

export interface CommunitiesStagingRoleSplitInventoryArtifact {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_VERSION;
  readonly restoreDatabase: string;
  readonly cloneDatabaseOid: string;
  readonly markerPayloadSha256: string;
  readonly inventorySha256: string;
  readonly categoryCounts: Readonly<Record<CommunitiesStagingRoleSplitInventoryCategory, number>>;
  readonly categorySha256: Readonly<Record<CommunitiesStagingRoleSplitInventoryCategory, string>>;
  readonly authorizes: {
    readonly roleSplit: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
}

export interface CommunitiesStagingRoleSplitInventoryDiff {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_DIFF_VERSION;
  readonly baselineInventorySha256: string;
  readonly currentInventorySha256: string;
  readonly categories: Readonly<
    Record<
      CommunitiesStagingRoleSplitInventoryCategory,
      {
        readonly baselineCount: number;
        readonly currentCount: number;
        readonly changed: boolean;
      }
    >
  >;
  readonly authorizes: {
    readonly roleSplit: false;
    readonly migration: false;
    readonly deploy: false;
    readonly activation: false;
  };
}

export type CommunitiesStagingRoleSplitInventoryCategory =
  | 'database'
  | 'schemas'
  | 'defaultAcls'
  | 'relations'
  | 'columnAcls'
  | 'policies'
  | 'routines'
  | 'types'
  | 'extensions';

const categories = [
  'database',
  'schemas',
  'defaultAcls',
  'relations',
  'columnAcls',
  'policies',
  'routines',
  'types',
  'extensions',
] as const satisfies readonly CommunitiesStagingRoleSplitInventoryCategory[];
const sha256 = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function fail(code: string): never {
  return failCommunitiesStagingRoleSplit(`INVENTORY_${code}`);
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    fail('VALUE_INVALID');
}

function assertText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) fail('VALUE_INVALID');
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) fail('IDENTIFIER_INVALID');
}

function assertIdentifierArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    fail('POLICY_SHAPE_INVALID');
  value.forEach(assertIdentifier);
}

function assertJson(value: unknown): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertJson);
    return;
  }
  if (!isRecord(value)) fail('JSON_INVALID');
  for (const [key, nested] of Object.entries(value)) {
    assertString(key);
    assertJson(nested);
  }
}

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key] as JsonValue)]),
  );
}

function assertUnique<T>(entries: readonly T[], key: (entry: T) => string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const current = key(entry);
    if (seen.has(current)) fail('ARRAY_DUPLICATE');
    seen.add(current);
  }
}

function sortedBy<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  return [...entries].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function assertArray(value: unknown): asserts value is readonly JsonRecord[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) fail('ARRAY_SHAPE_INVALID');
}

function assertInventory(input: CommunitiesStagingRoleSplitInventoryInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'database',
      'schemas',
      'default_acls',
      'relations',
      'column_acls',
      'policies',
      'routines',
      'types',
      'extensions',
    ])
  )
    fail('SHAPE_INVALID');
  if (!isRecord(input.database) || !hasExactKeys(input.database, ['name', 'owner', 'acl']))
    fail('DATABASE_SHAPE_INVALID');
  assertIdentifier(input.database.name);
  assertIdentifier(input.database.owner);
  assertJson(input.database.acl);

  assertArray(input.schemas);
  input.schemas.forEach((entry) => {
    if (
      !hasExactKeys(entry, ['name', 'exists', 'owner', 'acl']) ||
      typeof entry.exists !== 'boolean' ||
      (entry.owner !== null && !identifier.test(entry.owner))
    )
      fail('SCHEMA_SHAPE_INVALID');
    assertIdentifier(entry.name);
    assertJson(entry.acl);
  });
  assertUnique(input.schemas, (entry) => entry.name);

  assertArray(input.default_acls);
  input.default_acls.forEach((entry) => {
    if (
      !hasExactKeys(entry, ['role', 'schema', 'type', 'acl']) ||
      (entry.schema !== null && !identifier.test(entry.schema))
    )
      fail('DEFAULT_ACL_SHAPE_INVALID');
    assertIdentifier(entry.role);
    assertString(entry.type);
    assertJson(entry.acl);
  });
  assertUnique(
    input.default_acls,
    (entry) => `${entry.role}\0${entry.schema ?? ''}\0${entry.type}`,
  );

  assertArray(input.relations);
  input.relations.forEach((entry) => {
    if (
      !hasExactKeys(entry, ['schema', 'name', 'kind', 'owner', 'acl', 'rls', 'force_rls']) ||
      typeof entry.rls !== 'boolean' ||
      typeof entry.force_rls !== 'boolean'
    )
      fail('RELATION_SHAPE_INVALID');
    assertIdentifier(entry.schema);
    assertIdentifier(entry.name);
    assertString(entry.kind);
    assertIdentifier(entry.owner);
    assertJson(entry.acl);
  });
  assertUnique(input.relations, (entry) => `${entry.schema}\0${entry.name}`);

  assertArray(input.column_acls);
  input.column_acls.forEach((entry) => {
    if (!hasExactKeys(entry, ['schema', 'relation', 'column', 'acl']))
      fail('COLUMN_ACL_SHAPE_INVALID');
    assertIdentifier(entry.schema);
    assertIdentifier(entry.relation);
    assertIdentifier(entry.column);
    assertJson(entry.acl);
  });
  assertUnique(input.column_acls, (entry) => `${entry.schema}\0${entry.relation}\0${entry.column}`);

  assertArray(input.policies);
  input.policies.forEach((entry) => {
    const policyRoles = entry.roles;
    if (
      !hasExactKeys(entry, [
        'schema',
        'table',
        'name',
        'permissive',
        'roles',
        'command',
        'qual',
        'check',
      ]) ||
      !Array.isArray(policyRoles) ||
      (entry.qual !== null && typeof entry.qual !== 'string') ||
      (entry.check !== null && typeof entry.check !== 'string')
    )
      fail('POLICY_SHAPE_INVALID');
    assertIdentifierArray(policyRoles);
    assertIdentifier(entry.schema);
    assertIdentifier(entry.table);
    assertIdentifier(entry.name);
    assertString(entry.permissive);
    assertString(entry.command);
    assertUnique(policyRoles, (role) => role);
  });
  assertUnique(input.policies, (entry) => `${entry.schema}\0${entry.table}\0${entry.name}`);

  assertArray(input.routines);
  input.routines.forEach((entry) => {
    if (
      !hasExactKeys(entry, [
        'schema',
        'name',
        'identity_args',
        'kind',
        'owner',
        'acl',
        'security_definer',
        'config',
      ]) ||
      typeof entry.security_definer !== 'boolean'
    )
      fail('ROUTINE_SHAPE_INVALID');
    assertIdentifier(entry.schema);
    assertIdentifier(entry.name);
    assertText(entry.identity_args);
    assertString(entry.kind);
    assertIdentifier(entry.owner);
    assertJson(entry.acl);
    assertJson(entry.config);
  });
  assertUnique(input.routines, (entry) => `${entry.schema}\0${entry.name}\0${entry.identity_args}`);

  assertArray(input.types);
  input.types.forEach((entry) => {
    if (!hasExactKeys(entry, ['schema', 'name', 'kind', 'owner', 'acl']))
      fail('TYPE_SHAPE_INVALID');
    assertIdentifier(entry.schema);
    assertIdentifier(entry.name);
    assertString(entry.kind);
    assertIdentifier(entry.owner);
    assertJson(entry.acl);
  });
  assertUnique(input.types, (entry) => `${entry.schema}\0${entry.name}`);

  assertArray(input.extensions);
  input.extensions.forEach((entry) => {
    if (!hasExactKeys(entry, ['name', 'version', 'schema', 'owner']))
      fail('EXTENSION_SHAPE_INVALID');
    assertIdentifier(entry.name);
    assertString(entry.version);
    assertIdentifier(entry.schema);
    assertIdentifier(entry.owner);
  });
  assertUnique(input.extensions, (entry) => entry.name);
}

function canonicalInventoryValue(input: CommunitiesStagingRoleSplitInventoryInput): JsonRecord {
  assertInventory(input);
  const canonical = {
    database: {
      name: input.database.name,
      owner: input.database.owner,
      acl: canonicalJson(input.database.acl),
    },
    schemas: sortedBy(input.schemas, (entry) => entry.name).map((entry) => ({
      name: entry.name,
      exists: entry.exists,
      owner: entry.owner,
      acl: canonicalJson(entry.acl),
    })),
    default_acls: sortedBy(
      input.default_acls,
      (entry) => `${entry.role}\0${entry.schema ?? '\uffff'}\0${entry.type}`,
    ).map((entry) => ({
      role: entry.role,
      schema: entry.schema,
      type: entry.type,
      acl: canonicalJson(entry.acl),
    })),
    relations: sortedBy(input.relations, (entry) => `${entry.schema}\0${entry.name}`).map(
      (entry) => ({
        schema: entry.schema,
        name: entry.name,
        kind: entry.kind,
        owner: entry.owner,
        acl: canonicalJson(entry.acl),
        rls: entry.rls,
        force_rls: entry.force_rls,
      }),
    ),
    column_acls: sortedBy(
      input.column_acls,
      (entry) => `${entry.schema}\0${entry.relation}\0${entry.column}`,
    ).map((entry) => ({
      schema: entry.schema,
      relation: entry.relation,
      column: entry.column,
      acl: canonicalJson(entry.acl),
    })),
    policies: sortedBy(
      input.policies,
      (entry) => `${entry.schema}\0${entry.table}\0${entry.name}`,
    ).map((entry) => ({
      schema: entry.schema,
      table: entry.table,
      name: entry.name,
      permissive: entry.permissive,
      roles: sortedBy(entry.roles, (role) => role),
      command: entry.command,
      qual: entry.qual,
      check: entry.check,
    })),
    routines: sortedBy(
      input.routines,
      (entry) => `${entry.schema}\0${entry.name}\0${entry.identity_args}`,
    ).map((entry) => ({
      schema: entry.schema,
      name: entry.name,
      identity_args: entry.identity_args,
      kind: entry.kind,
      owner: entry.owner,
      acl: canonicalJson(entry.acl),
      security_definer: entry.security_definer,
      config: canonicalJson(entry.config),
    })),
    types: sortedBy(input.types, (entry) => `${entry.schema}\0${entry.name}`).map((entry) => ({
      schema: entry.schema,
      name: entry.name,
      kind: entry.kind,
      owner: entry.owner,
      acl: canonicalJson(entry.acl),
    })),
    extensions: sortedBy(input.extensions, (entry) => entry.name).map((entry) => ({
      name: entry.name,
      version: entry.version,
      schema: entry.schema,
      owner: entry.owner,
    })),
  };
  return canonical;
}

export function canonicalCommunitiesStagingRoleSplitInventory(
  input: CommunitiesStagingRoleSplitInventoryInput,
): string {
  return `${COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_VERSION}\n${JSON.stringify(canonicalInventoryValue(input))}\n`;
}

export function communitiesStagingRoleSplitInventoryArtifact(input: {
  readonly inventory: CommunitiesStagingRoleSplitInventoryInput;
  readonly inventoryDatabaseOid: string;
  readonly markerPayload: CommunitiesStagingRoleSplitRestoreMarkerPayload;
  readonly marker: string;
  readonly markerEvidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence;
}): CommunitiesStagingRoleSplitInventoryArtifact {
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(
    input.markerPayload,
    input.marker,
    input.markerEvidence,
  );
  if (
    !/^[1-9][0-9]*$/.test(input.inventoryDatabaseOid) ||
    input.inventoryDatabaseOid !== input.markerPayload.cloneDatabaseOid ||
    input.inventory.database.name !== input.markerPayload.restoreDatabase ||
    input.inventory.database.owner !== input.markerPayload.cloneDatabaseOwner
  )
    fail('DATABASE_BINDING_INVALID');
  const canonicalValue = canonicalInventoryValue(input.inventory);
  const canonical = `${COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_VERSION}\n${JSON.stringify(canonicalValue)}\n`;
  const categorySha256 = Object.fromEntries(
    categories.map((category) => {
      const raw =
        category === 'database'
          ? canonicalValue.database
          : category === 'schemas'
            ? canonicalValue.schemas
            : category === 'defaultAcls'
              ? canonicalValue.default_acls
              : category === 'relations'
                ? canonicalValue.relations
                : category === 'columnAcls'
                  ? canonicalValue.column_acls
                  : category === 'policies'
                    ? canonicalValue.policies
                    : category === 'routines'
                      ? canonicalValue.routines
                      : category === 'types'
                        ? canonicalValue.types
                        : canonicalValue.extensions;
      if (raw === undefined) fail('CATEGORY_INVALID');
      return [
        category,
        createHash('sha256')
          .update(JSON.stringify(canonicalJson(raw)), 'utf8')
          .digest('hex'),
      ];
    }),
  ) as CommunitiesStagingRoleSplitInventoryArtifact['categorySha256'];
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_VERSION,
    restoreDatabase: input.markerPayload.restoreDatabase,
    cloneDatabaseOid: input.markerPayload.cloneDatabaseOid,
    markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(input.markerPayload),
    inventorySha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    categoryCounts: {
      database: 1,
      schemas: input.inventory.schemas.length,
      defaultAcls: input.inventory.default_acls.length,
      relations: input.inventory.relations.length,
      columnAcls: input.inventory.column_acls.length,
      policies: input.inventory.policies.length,
      routines: input.inventory.routines.length,
      types: input.inventory.types.length,
      extensions: input.inventory.extensions.length,
    },
    categorySha256,
    authorizes: {
      roleSplit: false,
      migration: false,
      deploy: false,
      activation: false,
    },
  };
}

function assertArtifact(value: CommunitiesStagingRoleSplitInventoryArtifact): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'restoreDatabase',
      'cloneDatabaseOid',
      'markerPayloadSha256',
      'inventorySha256',
      'categoryCounts',
      'categorySha256',
      'authorizes',
    ]) ||
    value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ARTIFACT_VERSION ||
    !/^phub_restore_[0-9]+_[0-9]+$/.test(value.restoreDatabase) ||
    !/^[1-9][0-9]*$/.test(value.cloneDatabaseOid) ||
    !sha256.test(value.markerPayloadSha256) ||
    !sha256.test(value.inventorySha256) ||
    !isRecord(value.categoryCounts) ||
    !hasExactKeys(value.categoryCounts, categories) ||
    !isRecord(value.categorySha256) ||
    !hasExactKeys(value.categorySha256, categories) ||
    !isRecord(value.authorizes) ||
    !hasExactKeys(value.authorizes, ['roleSplit', 'migration', 'deploy', 'activation']) ||
    Object.values(value.authorizes).some((entry) => entry !== false)
  )
    fail('ARTIFACT_INVALID');
  for (const category of categories)
    if (!Number.isSafeInteger(value.categoryCounts[category]) || value.categoryCounts[category] < 0)
      fail('ARTIFACT_INVALID');
  for (const category of categories)
    if (!sha256.test(value.categorySha256[category])) fail('ARTIFACT_INVALID');
}

export function diffCommunitiesStagingRoleSplitInventoryArtifacts(
  baseline: CommunitiesStagingRoleSplitInventoryArtifact,
  current: CommunitiesStagingRoleSplitInventoryArtifact,
): CommunitiesStagingRoleSplitInventoryDiff {
  assertArtifact(baseline);
  assertArtifact(current);
  if (
    baseline.restoreDatabase !== current.restoreDatabase ||
    baseline.cloneDatabaseOid !== current.cloneDatabaseOid ||
    baseline.markerPayloadSha256 !== current.markerPayloadSha256
  )
    fail('ARTIFACT_BINDING_INVALID');
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_DIFF_VERSION,
    baselineInventorySha256: baseline.inventorySha256,
    currentInventorySha256: current.inventorySha256,
    categories: Object.fromEntries(
      categories.map((category) => [
        category,
        {
          baselineCount: baseline.categoryCounts[category],
          currentCount: current.categoryCounts[category],
          changed: baseline.categorySha256[category] !== current.categorySha256[category],
        },
      ]),
    ) as CommunitiesStagingRoleSplitInventoryDiff['categories'],
    authorizes: {
      roleSplit: false,
      migration: false,
      deploy: false,
      activation: false,
    },
  };
}
