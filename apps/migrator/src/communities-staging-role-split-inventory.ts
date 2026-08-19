import { createHash } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  canonicalCommunitiesStagingRoleSplitLedger,
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerPayloadSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST,
  COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_REQUEST_VERSION,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { Client, type QueryResult } from 'pg';

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION =
  'PRODUCE_COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_V1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION =
  'communities-staging-role-split-inventory-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_SCHEMA_VERSION =
  'communities-staging-role-split-inventory-comparison-v1';

const sha256Pattern = /^[a-f0-9]{64}$/;
const positiveDecimalPattern = /^[1-9][0-9]*$/;
const maximumCategoryRecords = 250_000;
const maximumCanonicalRecordBytes = 64 * 1024;

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES = [
  'databaseSchemaDefaultAcl',
  'owners',
  'roleCapabilitiesMemberships',
  'extensions',
  'tablesColumnsAcl',
  'rlsPolicies',
  'sequences',
  'functions',
  'types',
] as const;

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ANOMALY_NAMES = [
  'publicAclGrants',
  'grantOptions',
  'columnAclEntries',
  'nonOwnerAclGrants',
  'dangerousRoleCapabilities',
  'roleMemberships',
  'mixedObjectOwners',
  'manifestExpectedStateMismatches',
  'manifestTablesWithoutRls',
  'manifestTablesWithoutForcedRls',
] as const;

type InventoryCategoryName =
  (typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES)[number];
type InventoryAnomalyName = (typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ANOMALY_NAMES)[number];

export class CommunitiesStagingRoleSplitInventoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CommunitiesStagingRoleSplitInventoryError';
  }
}

function fail(code: string): never {
  throw new CommunitiesStagingRoleSplitInventoryError(
    `COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_${code}`,
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('REPORT_SHAPE_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (!isRecord(value)) fail('REPORT_SHAPE_INVALID');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function parseCommunitiesStagingRoleSplitMarkerRequest(
  value: string,
): CommunitiesStagingRoleSplitRestoreMarkerRequest {
  if (value.includes('\r') || !value.endsWith('\n')) fail('REQUEST_SHAPE_INVALID');
  const lines = value.slice(0, -1).split('\n');
  if (lines.shift() !== COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_REQUEST_VERSION)
    fail('REQUEST_SHAPE_INVALID');
  const parsed: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0 || line.indexOf('=', separator + 1) !== -1) fail('REQUEST_SHAPE_INVALID');
    const key = line.slice(0, separator);
    if (Object.hasOwn(parsed, key)) fail('REQUEST_SHAPE_INVALID');
    parsed[key] = line.slice(separator + 1);
  }
  try {
    const request = parsed as unknown as CommunitiesStagingRoleSplitRestoreMarkerRequest;
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(request);
    if (canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(request) !== value)
      fail('REQUEST_SHAPE_INVALID');
    return request;
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitInventoryError) throw error;
    fail('REQUEST_SHAPE_INVALID');
  }
}

export interface CommunitiesStagingRoleSplitInventoryCategorySummary {
  readonly count: number;
  readonly digest: string;
  readonly nonEmpty: boolean;
}

export interface CommunitiesStagingRoleSplitInventoryReport {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION;
  readonly status: 'CAPTURED_REVIEW_REQUIRED';
  readonly objectManifestSha256: string;
  readonly provenance: {
    readonly requestSha256: string;
    readonly markerPayloadSha256: string;
    readonly markerValueSha256: string;
    readonly markerEvidenceSha256: string;
    readonly sourceLedgerSha256: string;
    readonly sourceLedgerCount: number;
    readonly bindings: {
      readonly request: true;
      readonly marker: true;
      readonly evidence: true;
      readonly cloneDatabase: true;
      readonly cloneOid: true;
      readonly sourceDatabase: true;
      readonly sourceOid: true;
      readonly owners: true;
      readonly systemIdentifier: true;
      readonly postgres16: true;
      readonly ledger: true;
      readonly readOnlyTransaction: true;
    };
  };
  readonly categories: Readonly<
    Record<InventoryCategoryName, CommunitiesStagingRoleSplitInventoryCategorySummary>
  >;
  readonly manifestCoverage: {
    readonly entryCount: number;
    readonly observedEntryCount: number;
    readonly presentCount: number;
    readonly absentCount: number;
    readonly expectedStateMismatchCount: number;
    readonly exact: true;
    readonly digest: string;
  };
  readonly anomalies: {
    readonly total: number;
    readonly counts: Readonly<Record<InventoryAnomalyName, number>>;
    readonly digest: string;
  };
  readonly inventoryDigest: string;
  readonly reportSha256: string;
  readonly authorizes: {
    readonly roleCreation: false;
    readonly roleRepair: false;
    readonly roleSplit: false;
    readonly grantChange: false;
    readonly schemaChange: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly import: false;
    readonly activation: false;
  };
}

type InventoryClient = {
  connect(): Promise<void>;
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
};

export type CommunitiesStagingRoleSplitInventoryClientFactory = (
  connectionString: string,
) => InventoryClient;

export interface CommunitiesStagingRoleSplitInventoryInput {
  readonly confirmation: string;
  readonly connectionString: string;
  readonly requestText: string;
  readonly expectedRequestSha256: string;
  readonly markerEvidence: CommunitiesStagingRoleSplitRestoreMarkerEvidence;
}

type IdentityRow = {
  readonly database_name: string;
  readonly database_oid: string;
  readonly database_owner: string;
  readonly database_owner_oid: string;
  readonly source_database_oid: string | null;
  readonly source_database_owner: string | null;
  readonly source_database_owner_oid: string | null;
  readonly system_identifier: string;
  readonly postgres_major: string;
  readonly marker: string | null;
  readonly current_role: string;
  readonly session_role: string;
  readonly transaction_read_only: string;
  readonly role_safe: boolean;
};

const identitySql = `/* communities-role-split-inventory:identity */
select database.datname as database_name,
       database.oid::text as database_oid,
       database_owner.rolname as database_owner,
       database_owner.oid::text as database_owner_oid,
       source_database.oid::text as source_database_oid,
       source_owner.rolname as source_database_owner,
       source_owner.oid::text as source_database_owner_oid,
       (select system_identifier::text from pg_catalog.pg_control_system()) as system_identifier,
       (current_setting('server_version_num')::integer / 10000)::text as postgres_major,
       pg_catalog.shobj_description(database.oid, 'pg_database') as marker,
       current_user as current_role,
       session_user as session_role,
       current_setting('transaction_read_only') as transaction_read_only,
       (collector.rolcanlogin and not collector.rolsuper and not collector.rolbypassrls
        and not collector.rolcreatedb and not collector.rolcreaterole
        and not collector.rolreplication
        and not exists (
          select 1 from pg_catalog.pg_auth_members membership
           where membership.member = collector.oid or membership.roleid = collector.oid
        )) as role_safe
  from pg_catalog.pg_database database
  join pg_catalog.pg_roles database_owner on database_owner.oid = database.datdba
  join pg_catalog.pg_roles collector on collector.rolname = current_user
  left join pg_catalog.pg_database source_database on source_database.datname = $1
  left join pg_catalog.pg_roles source_owner on source_owner.oid = source_database.datdba
 where database.datname = current_database()`;

const relevantSchemasSql =
  "('public'),('profile'),('communities'),('integration'),('messaging'),('notifications'),('games'),('identity'),('community_content'),('eligibility')";

const categorySql: Readonly<Record<InventoryCategoryName, string>> = {
  databaseSchemaDefaultAcl: `/* communities-role-split-inventory:databaseSchemaDefaultAcl */
with relevant_schemas(name) as (values ${relevantSchemasSql}), records(record) as (
  select pg_catalog.jsonb_build_array('database', owner.rolname,
                                      coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(database.datacl) item), '[]'::jsonb))::text
    from pg_catalog.pg_database database join pg_catalog.pg_roles owner on owner.oid = database.datdba
   where database.datname = current_database()
  union all
  select pg_catalog.jsonb_build_array('schema', expected.name, namespace.oid is not null,
                                      coalesce(owner.rolname, ''),
                                      coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(namespace.nspacl) item), '[]'::jsonb))::text
    from relevant_schemas expected left join pg_catalog.pg_namespace namespace on namespace.nspname = expected.name
    left join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
  union all
  select pg_catalog.jsonb_build_array('default-acl', owner.rolname,
                                      coalesce(namespace.nspname, ''), defaults.defaclobjtype,
                                      coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(defaults.defaclacl) item), '[]'::jsonb))::text
    from pg_catalog.pg_default_acl defaults join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
    left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
   where defaults.defaclnamespace = 0 or namespace.nspname in (select name from relevant_schemas)
) select record from records order by record`,
  owners: `/* communities-role-split-inventory:owners */
with relevant_schemas(name) as (values ${relevantSchemasSql}), records(record) as (
  select pg_catalog.jsonb_build_array('database', owner.rolname)::text
    from pg_catalog.pg_database database join pg_catalog.pg_roles owner on owner.oid = database.datdba
   where database.datname = current_database()
  union all
  select pg_catalog.jsonb_build_array('schema', namespace.nspname, owner.rolname)::text
    from pg_catalog.pg_namespace namespace join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
   where namespace.nspname in (select name from relevant_schemas)
  union all
  select pg_catalog.jsonb_build_array('relation', namespace.nspname, relation.relname,
                                      relation.relkind, owner.rolname)::text
    from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = relation.relowner
   where namespace.nspname in (select name from relevant_schemas)
  union all
  select pg_catalog.jsonb_build_array('function', namespace.nspname, routine.proname,
                                      pg_catalog.pg_get_function_identity_arguments(routine.oid), owner.rolname)::text
    from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = routine.proowner
   where namespace.nspname in (select name from relevant_schemas)
  union all
  select pg_catalog.jsonb_build_array('type', namespace.nspname, object_type.typname,
                                      object_type.typtype, owner.rolname)::text
    from pg_catalog.pg_type object_type join pg_catalog.pg_namespace namespace on namespace.oid = object_type.typnamespace
    join pg_catalog.pg_roles owner on owner.oid = object_type.typowner
   where namespace.nspname in (select name from relevant_schemas)
) select record from records order by record`,
  roleCapabilitiesMemberships: `/* communities-role-split-inventory:roleCapabilitiesMemberships */
with records(record) as (
  select pg_catalog.jsonb_build_array('role', role.rolname, role.rolsuper, role.rolinherit,
                                      role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
                                      role.rolreplication, role.rolbypassrls)::text
    from pg_catalog.pg_roles role where role.rolname !~ '^pg_'
  union all
  select pg_catalog.jsonb_build_array('membership', granted.rolname, member.rolname,
                                      membership.admin_option, membership.inherit_option,
                                      membership.set_option)::text
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles member on member.oid = membership.member
   where granted.rolname !~ '^pg_' or member.rolname !~ '^pg_'
) select record from records order by record`,
  extensions: `/* communities-role-split-inventory:extensions */
select pg_catalog.jsonb_build_array(extension.extname, extension.extversion, namespace.nspname,
                                    owner.rolname, extension.extrelocatable)::text as record
  from pg_catalog.pg_extension extension join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  join pg_catalog.pg_roles owner on owner.oid = extension.extowner
 order by record`,
  tablesColumnsAcl: `/* communities-role-split-inventory:tablesColumnsAcl */
with relevant_schemas(name) as (values ${relevantSchemasSql}), records(record) as (
  select pg_catalog.jsonb_build_array('table', namespace.nspname, relation.relname,
                                      relation.relkind,
                                      coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(relation.relacl) item), '[]'::jsonb))::text
    from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname in (select name from relevant_schemas) and relation.relkind in ('r','p','v','m','f')
  union all
  select pg_catalog.jsonb_build_array('column', namespace.nspname, relation.relname,
                                      attribute.attnum, attribute.attname,
                                      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                                      attribute.attnotnull,
                                      coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(attribute.attacl) item), '[]'::jsonb))::text
    from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname in (select name from relevant_schemas)
     and relation.relkind in ('r','p','v','m','f') and attribute.attnum > 0 and not attribute.attisdropped
) select record from records order by record`,
  rlsPolicies: `/* communities-role-split-inventory:rlsPolicies */
with relevant_schemas(name) as (values ${relevantSchemasSql}), records(record) as (
  select pg_catalog.jsonb_build_array('rls', namespace.nspname, relation.relname,
                                      relation.relrowsecurity, relation.relforcerowsecurity)::text
    from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname in (select name from relevant_schemas) and relation.relkind in ('r','p')
  union all
  select pg_catalog.jsonb_build_array('policy', policy.schemaname, policy.tablename,
                                      policy.policyname, policy.permissive, policy.roles,
                                      policy.cmd, coalesce(policy.qual, ''), coalesce(policy.with_check, ''))::text
    from pg_catalog.pg_policies policy where policy.schemaname in (select name from relevant_schemas)
) select record from records order by record`,
  sequences: `/* communities-role-split-inventory:sequences */
with relevant_schemas(name) as (values ${relevantSchemasSql})
select pg_catalog.jsonb_build_array(namespace.nspname, relation.relname, owner.rolname,
                                    coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(relation.relacl) item), '[]'::jsonb), sequence.seqstart,
                                    sequence.seqincrement, sequence.seqmin, sequence.seqmax,
                                    sequence.seqcache, sequence.seqcycle)::text as record
  from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_roles owner on owner.oid = relation.relowner
  join pg_catalog.pg_sequence sequence on sequence.seqrelid = relation.oid
 where namespace.nspname in (select name from relevant_schemas) order by record`,
  functions: `/* communities-role-split-inventory:functions */
with relevant_schemas(name) as (values ${relevantSchemasSql})
select pg_catalog.jsonb_build_array(namespace.nspname, routine.proname,
                                    pg_catalog.pg_get_function_identity_arguments(routine.oid),
                                    routine.prokind, owner.rolname, language.lanname,
                                    coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(routine.proacl) item), '[]'::jsonb), routine.prosecdef,
                                    routine.proleakproof, routine.provolatile, routine.proparallel,
                                    coalesce(routine.proconfig::text, ''))::text as record
  from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  join pg_catalog.pg_roles owner on owner.oid = routine.proowner
  join pg_catalog.pg_language language on language.oid = routine.prolang
 where namespace.nspname in (select name from relevant_schemas) order by record`,
  types: `/* communities-role-split-inventory:types */
with relevant_schemas(name) as (values ${relevantSchemasSql})
select pg_catalog.jsonb_build_array(namespace.nspname, object_type.typname, object_type.typtype,
                                    object_type.typcategory, object_type.typispreferred,
                                    object_type.typnotnull, owner.rolname,
                                    coalesce((select pg_catalog.jsonb_agg(item::text order by item::text) from unnest(object_type.typacl) item), '[]'::jsonb),
                                    pg_catalog.format_type(object_type.oid, null))::text as record
  from pg_catalog.pg_type object_type join pg_catalog.pg_namespace namespace on namespace.oid = object_type.typnamespace
  join pg_catalog.pg_roles owner on owner.oid = object_type.typowner
 where namespace.nspname in (select name from relevant_schemas) order by record`,
};

const manifestCoverageSql = `/* communities-role-split-inventory:manifestCoverage */
with manifest as (
  select ordinal::integer, kind, object_name, expectation
    from pg_catalog.jsonb_to_recordset($1::jsonb) as item(ordinal integer, kind text, object_name text, expectation text)
), observed as (
  select manifest.*,
         case manifest.kind
           when 'schema' then exists (select 1 from pg_catalog.pg_namespace where nspname = manifest.object_name)
           when 'extension' then exists (select 1 from pg_catalog.pg_extension where extname = manifest.object_name)
           when 'table' then exists (
             select 1 from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
              where namespace.nspname = split_part(manifest.object_name, '.', 1)
                and relation.relname = split_part(manifest.object_name, '.', 2) and relation.relkind in ('r','p')
           )
           when 'catalog' then true else false
         end as present
    from manifest
)
select ordinal::text, kind, object_name, expectation, present,
       case
         when expectation like 'absent-%' then not present
         when kind in ('schema','table') then present
         when kind = 'catalog' then present
         else true
       end as expected_state_matches,
       pg_catalog.jsonb_build_array(kind, object_name, expectation, present)::text as record
  from observed order by ordinal`;

const anomalySql = `/* communities-role-split-inventory:anomalies */
with relevant_schemas(name) as (values ${relevantSchemasSql}), raw_acl(owner_oid, acl) as (
  select database.datdba, database.datacl from pg_catalog.pg_database database where database.datname = current_database()
  union all select namespace.nspowner, namespace.nspacl from pg_catalog.pg_namespace namespace where namespace.nspname in (select name from relevant_schemas)
  union all select relation.relowner, relation.relacl from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace where namespace.nspname in (select name from relevant_schemas)
  union all select relation.relowner, attribute.attacl from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid = attribute.attrelid join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace where namespace.nspname in (select name from relevant_schemas) and attribute.attnum > 0 and not attribute.attisdropped
  union all select routine.proowner, routine.proacl from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace where namespace.nspname in (select name from relevant_schemas)
  union all select object_type.typowner, object_type.typacl from pg_catalog.pg_type object_type join pg_catalog.pg_namespace namespace on namespace.oid = object_type.typnamespace where namespace.nspname in (select name from relevant_schemas)
  union all select defaults.defaclrole, defaults.defaclacl from pg_catalog.pg_default_acl defaults left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace where defaults.defaclnamespace = 0 or namespace.nspname in (select name from relevant_schemas)
), exploded_acl as (
  select raw_acl.owner_oid, privilege.grantee, privilege.is_grantable
    from raw_acl cross join lateral pg_catalog.aclexplode(raw_acl.acl) privilege
), object_owners(owner_name) as (
  select owner.rolname from pg_catalog.pg_database database join pg_catalog.pg_roles owner on owner.oid = database.datdba where database.datname = current_database()
  union all select owner.rolname from pg_catalog.pg_namespace namespace join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner where namespace.nspname in (select name from relevant_schemas)
  union all select owner.rolname from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace join pg_catalog.pg_roles owner on owner.oid = relation.relowner where namespace.nspname in (select name from relevant_schemas)
  union all select owner.rolname from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace join pg_catalog.pg_roles owner on owner.oid = routine.proowner where namespace.nspname in (select name from relevant_schemas)
  union all select owner.rolname from pg_catalog.pg_type object_type join pg_catalog.pg_namespace namespace on namespace.oid = object_type.typnamespace join pg_catalog.pg_roles owner on owner.oid = object_type.typowner where namespace.nspname in (select name from relevant_schemas)
  union all select owner.rolname from pg_catalog.pg_extension extension join pg_catalog.pg_roles owner on owner.oid = extension.extowner
), expected_tables(relation_name) as (
  select value::text from pg_catalog.jsonb_array_elements_text($1::jsonb)
), expected_table_state as (
  select relation.relrowsecurity, relation.relforcerowsecurity
    from expected_tables expected
    left join pg_catalog.pg_namespace namespace on namespace.nspname = split_part(expected.relation_name, '.', 1)
    left join pg_catalog.pg_class relation on relation.relnamespace = namespace.oid and relation.relname = split_part(expected.relation_name, '.', 2)
   where relation.relkind in ('r','p')
)
select (select count(*)::text from exploded_acl where grantee = 0) as public_acl_grants,
       (select count(*)::text from exploded_acl where is_grantable) as grant_options,
       (select count(*)::text from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid = attribute.attrelid join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace where namespace.nspname in (select name from relevant_schemas) and attribute.attnum > 0 and not attribute.attisdropped and attribute.attacl is not null) as column_acl_entries,
       (select count(*)::text from exploded_acl where grantee <> 0 and grantee <> owner_oid) as non_owner_acl_grants,
       (select count(*)::text from pg_catalog.pg_roles role where role.rolname !~ '^pg_' and (role.rolsuper or role.rolbypassrls or role.rolcreatedb or role.rolcreaterole or role.rolreplication)) as dangerous_role_capabilities,
       (select count(*)::text from pg_catalog.pg_auth_members membership join pg_catalog.pg_roles granted on granted.oid = membership.roleid join pg_catalog.pg_roles member on member.oid = membership.member where granted.rolname !~ '^pg_' or member.rolname !~ '^pg_') as role_memberships,
       greatest((select count(distinct owner_name) from object_owners) - 1, 0)::text as mixed_object_owners,
       (select count(*)::text from expected_table_state where not relrowsecurity) as manifest_tables_without_rls,
       (select count(*)::text from expected_table_state where not relforcerowsecurity) as manifest_tables_without_forced_rls`;

function assertConnectionBoundary(
  connectionString: string,
  request: CommunitiesStagingRoleSplitRestoreMarkerRequest,
): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    fail('CONNECTION_BOUNDARY_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    parsed.port !== '5432' ||
    parsed.search ||
    parsed.hash ||
    !parsed.username ||
    decodeURIComponent(parsed.pathname) !== `/${request.restoreDatabase}`
  )
    fail('CONNECTION_BOUNDARY_INVALID');
  return decodeURIComponent(parsed.username);
}

function payloadFromRequest(
  request: CommunitiesStagingRoleSplitRestoreMarkerRequest,
  requestSha256: string,
  identity: IdentityRow,
): CommunitiesStagingRoleSplitRestoreMarkerPayload {
  return {
    requestSha256,
    restoreDatabase: request.restoreDatabase,
    cloneDatabaseOid: identity.database_oid,
    cloneDatabaseOwner: identity.database_owner,
    cloneDatabaseOwnerOid: identity.database_owner_oid,
    sourceDatabase: request.sourceDatabase,
    sourceDatabaseOid: identity.source_database_oid ?? '',
    sourceDatabaseOwner: identity.source_database_owner ?? '',
    sourceDatabaseOwnerOid: identity.source_database_owner_oid ?? '',
    systemIdentifier: identity.system_identifier,
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
  };
}

function assertIdentity(
  identity: IdentityRow | undefined,
  request: CommunitiesStagingRoleSplitRestoreMarkerRequest,
  executorRole: string,
): asserts identity is IdentityRow {
  if (
    !identity ||
    identity.database_name !== request.restoreDatabase ||
    !positiveDecimalPattern.test(identity.database_oid) ||
    identity.database_owner !== request.expectedCloneDatabaseOwner ||
    identity.database_owner_oid !== request.expectedCloneDatabaseOwnerOid ||
    identity.source_database_oid !== request.sourceDatabaseOid ||
    identity.source_database_owner !== request.sourceDatabaseOwner ||
    identity.source_database_owner_oid !== request.sourceDatabaseOwnerOid ||
    identity.system_identifier !== request.systemIdentifier ||
    identity.postgres_major !== '16' ||
    identity.current_role !== executorRole ||
    identity.session_role !== executorRole ||
    identity.transaction_read_only !== 'on' ||
    identity.role_safe !== true
  )
    fail('DATABASE_BOUNDARY_INVALID');
}

function normalizeCategory(
  name: InventoryCategoryName,
  rows: readonly { readonly record: string }[],
): {
  readonly summary: CommunitiesStagingRoleSplitInventoryCategorySummary;
  readonly canonical: string;
} {
  if (
    rows.length > maximumCategoryRecords ||
    rows.some(
      (row) =>
        typeof row.record !== 'string' ||
        Buffer.byteLength(row.record, 'utf8') > maximumCanonicalRecordBytes ||
        row.record.includes('\n') ||
        row.record.includes('\r'),
    )
  )
    fail('CATALOG_RESULT_INVALID');
  const records = rows.map((row) => row.record).sort();
  const canonical = `${name}\n${records.join('\n')}\n`;
  return {
    canonical,
    summary: { count: records.length, digest: sha256(canonical), nonEmpty: records.length > 0 },
  };
}

function parseCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('CATALOG_RESULT_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('CATALOG_RESULT_INVALID');
  return parsed;
}

function finalReport(
  body: Omit<CommunitiesStagingRoleSplitInventoryReport, 'reportSha256'>,
): CommunitiesStagingRoleSplitInventoryReport {
  return { ...body, reportSha256: sha256(canonicalJson(body)) };
}

export async function produceCommunitiesStagingRoleSplitInventory(
  input: CommunitiesStagingRoleSplitInventoryInput,
  createClient: CommunitiesStagingRoleSplitInventoryClientFactory = (connectionString) =>
    new Client({
      connectionString,
      application_name: 'phub-communities-role-split-inventory-v1',
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    }) as unknown as InventoryClient,
): Promise<CommunitiesStagingRoleSplitInventoryReport> {
  if (input.confirmation !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION)
    fail('CONFIRMATION_INVALID');
  if (!sha256Pattern.test(input.expectedRequestSha256)) fail('REQUEST_PIN_INVALID');
  const request = parseCommunitiesStagingRoleSplitMarkerRequest(input.requestText);
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
  if (requestSha256 !== input.expectedRequestSha256) fail('REQUEST_PIN_INVALID');
  const executorRole = assertConnectionBoundary(input.connectionString, request);
  let client: InventoryClient;
  try {
    client = createClient(input.connectionString);
  } catch {
    fail('EXECUTION_FAILED');
  }
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query('begin transaction isolation level repeatable read read only');
    transactionOpen = true;
    await client.query("set local search_path = 'pg_catalog'");
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '30s'");

    const identityResult = await client.query<IdentityRow>(identitySql, [request.sourceDatabase]);
    const identity = identityResult.rows[0];
    assertIdentity(identity, request, executorRole);
    const payload = payloadFromRequest(request, requestSha256, identity);
    const marker = communitiesStagingRoleSplitRestoreMarker(payload);
    if (identity.marker !== marker) fail('MARKER_BINDING_INVALID');
    try {
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(payload, marker, input.markerEvidence);
    } catch {
      fail('EVIDENCE_BINDING_INVALID');
    }

    const ledgerResult = await client.query<{ filename: string; checksum: string }>(
      `/* communities-role-split-inventory:ledger */
       select filename, checksum from public.schema_migrations order by filename`,
    );
    let canonicalLedger: string;
    try {
      canonicalLedger = canonicalCommunitiesStagingRoleSplitLedger(ledgerResult.rows);
    } catch {
      fail('LEDGER_BINDING_INVALID');
    }
    if (
      ledgerResult.rows.length.toString() !== request.sourceLedgerCount ||
      sha256(canonicalLedger) !== request.sourceLedgerSha256
    )
      fail('LEDGER_BINDING_INVALID');

    const categories = {} as Record<
      InventoryCategoryName,
      CommunitiesStagingRoleSplitInventoryCategorySummary
    >;
    const canonicalCategories: string[] = [];
    for (const categoryName of COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES) {
      const result = await client.query<{ record: string }>(categorySql[categoryName]);
      const normalized = normalizeCategory(categoryName, result.rows);
      categories[categoryName] = normalized.summary;
      canonicalCategories.push(normalized.canonical);
    }

    const manifestInput = COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.map(
      ([kind, objectName, expectation], ordinal) => ({
        ordinal,
        kind,
        object_name: objectName,
        expectation,
      }),
    );
    const coverageResult = await client.query<{
      ordinal: string;
      kind: string;
      object_name: string;
      expectation: string;
      present: boolean;
      expected_state_matches: boolean;
      record: string;
    }>(manifestCoverageSql, [JSON.stringify(manifestInput)]);
    if (
      coverageResult.rows.length !== COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.length ||
      coverageResult.rows.some((row, ordinal) => {
        const expected = COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST[ordinal];
        return (
          row.ordinal !== ordinal.toString() ||
          !expected ||
          row.kind !== expected[0] ||
          row.object_name !== expected[1] ||
          row.expectation !== expected[2] ||
          typeof row.present !== 'boolean' ||
          typeof row.expected_state_matches !== 'boolean'
        );
      })
    )
      fail('MANIFEST_COVERAGE_INVALID');
    const coverageCanonical = `manifestCoverage\n${coverageResult.rows
      .map((row) => row.record)
      .join('\n')}\n`;
    const expectedStateMismatchCount = coverageResult.rows.filter(
      (row) => !row.expected_state_matches,
    ).length;
    const manifestCoverage = {
      entryCount: COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.length,
      observedEntryCount: coverageResult.rows.length,
      presentCount: coverageResult.rows.filter((row) => row.present).length,
      absentCount: coverageResult.rows.filter((row) => !row.present).length,
      expectedStateMismatchCount,
      exact: true as const,
      digest: sha256(coverageCanonical),
    };

    const expectedRelations = COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.filter(
      (entry) => entry[0] === 'table',
    ).map((entry) => entry[1]);
    const anomalyResult = await client.query<Record<string, string>>(anomalySql, [
      JSON.stringify(expectedRelations),
    ]);
    const anomalyRow = anomalyResult.rows[0];
    if (!anomalyRow || anomalyResult.rows.length !== 1) fail('CATALOG_RESULT_INVALID');
    const counts: Record<InventoryAnomalyName, number> = {
      publicAclGrants: parseCount(anomalyRow.public_acl_grants),
      grantOptions: parseCount(anomalyRow.grant_options),
      columnAclEntries: parseCount(anomalyRow.column_acl_entries),
      nonOwnerAclGrants: parseCount(anomalyRow.non_owner_acl_grants),
      dangerousRoleCapabilities: parseCount(anomalyRow.dangerous_role_capabilities),
      roleMemberships: parseCount(anomalyRow.role_memberships),
      mixedObjectOwners: parseCount(anomalyRow.mixed_object_owners),
      manifestExpectedStateMismatches: expectedStateMismatchCount,
      manifestTablesWithoutRls: parseCount(anomalyRow.manifest_tables_without_rls),
      manifestTablesWithoutForcedRls: parseCount(anomalyRow.manifest_tables_without_forced_rls),
    };
    const anomalyCanonical = `${COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ANOMALY_NAMES.map(
      (name) => `${name}|${counts[name]}`,
    ).join('\n')}\n`;
    const anomalies = {
      total: Object.values(counts).reduce((total, count) => total + count, 0),
      counts,
      digest: sha256(anomalyCanonical),
    };
    const inventoryDigest = sha256(
      `communities-staging-role-split-inventory-v1\n${COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256}\n${canonicalCategories.join('')}\n${coverageCanonical}${anomalyCanonical}`,
    );
    const markerValueSha256 = sha256(marker);
    const markerEvidenceSha256 = sha256(canonicalJson(input.markerEvidence));
    return finalReport({
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION,
      status: 'CAPTURED_REVIEW_REQUIRED',
      objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
      provenance: {
        requestSha256,
        markerPayloadSha256: communitiesStagingRoleSplitRestoreMarkerPayloadSha256(payload),
        markerValueSha256,
        markerEvidenceSha256,
        sourceLedgerSha256: request.sourceLedgerSha256,
        sourceLedgerCount: ledgerResult.rows.length,
        bindings: {
          request: true,
          marker: true,
          evidence: true,
          cloneDatabase: true,
          cloneOid: true,
          sourceDatabase: true,
          sourceOid: true,
          owners: true,
          systemIdentifier: true,
          postgres16: true,
          ledger: true,
          readOnlyTransaction: true,
        },
      },
      categories,
      manifestCoverage,
      anomalies,
      inventoryDigest,
      authorizes: {
        roleCreation: false,
        roleRepair: false,
        roleSplit: false,
        grantChange: false,
        schemaChange: false,
        sharedDatabaseMutation: false,
        migration: false,
        deploy: false,
        import: false,
        activation: false,
      },
    });
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitInventoryError) throw error;
    fail('EXECUTION_FAILED');
  } finally {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
  fail('EXECUTION_FAILED');
}

const reportKeys = [
  'schemaVersion',
  'status',
  'objectManifestSha256',
  'provenance',
  'categories',
  'manifestCoverage',
  'anomalies',
  'inventoryDigest',
  'reportSha256',
  'authorizes',
] as const;
const provenanceKeys = [
  'requestSha256',
  'markerPayloadSha256',
  'markerValueSha256',
  'markerEvidenceSha256',
  'sourceLedgerSha256',
  'sourceLedgerCount',
  'bindings',
] as const;
const provenanceBindingKeys = [
  'request',
  'marker',
  'evidence',
  'cloneDatabase',
  'cloneOid',
  'sourceDatabase',
  'sourceOid',
  'owners',
  'systemIdentifier',
  'postgres16',
  'ledger',
  'readOnlyTransaction',
] as const;
const manifestCoverageKeys = [
  'entryCount',
  'observedEntryCount',
  'presentCount',
  'absentCount',
  'expectedStateMismatchCount',
  'exact',
  'digest',
] as const;
const anomalyKeys = ['total', 'counts', 'digest'] as const;
const inventoryAuthorityKeys = [
  'roleCreation',
  'roleRepair',
  'roleSplit',
  'grantChange',
  'schemaChange',
  'sharedDatabaseMutation',
  'migration',
  'deploy',
  'import',
  'activation',
] as const;

export function assertCommunitiesStagingRoleSplitInventoryReport(
  value: unknown,
): asserts value is CommunitiesStagingRoleSplitInventoryReport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, reportKeys) ||
    value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION ||
    value.status !== 'CAPTURED_REVIEW_REQUIRED' ||
    value.objectManifestSha256 !== COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256 ||
    !sha256Pattern.test(String(value.inventoryDigest)) ||
    !sha256Pattern.test(String(value.reportSha256)) ||
    !isRecord(value.categories) ||
    !hasExactKeys(value.categories, COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES) ||
    !isRecord(value.provenance) ||
    !hasExactKeys(value.provenance, provenanceKeys) ||
    !isRecord(value.manifestCoverage) ||
    !hasExactKeys(value.manifestCoverage, manifestCoverageKeys) ||
    !isRecord(value.anomalies) ||
    !hasExactKeys(value.anomalies, anomalyKeys) ||
    !isRecord(value.authorizes) ||
    !hasExactKeys(value.authorizes, inventoryAuthorityKeys) ||
    Object.values(value.authorizes).some((entry) => entry !== false)
  )
    fail('REPORT_SHAPE_INVALID');
  const provenanceDigests = [
    value.provenance.requestSha256,
    value.provenance.markerPayloadSha256,
    value.provenance.markerValueSha256,
    value.provenance.markerEvidenceSha256,
    value.provenance.sourceLedgerSha256,
  ];
  if (
    provenanceDigests.some((entry) => !sha256Pattern.test(String(entry))) ||
    !Number.isSafeInteger(value.provenance.sourceLedgerCount) ||
    Number(value.provenance.sourceLedgerCount) < 1 ||
    !isRecord(value.provenance.bindings) ||
    !hasExactKeys(value.provenance.bindings, provenanceBindingKeys) ||
    Object.values(value.provenance.bindings).some((entry) => entry !== true)
  )
    fail('REPORT_SHAPE_INVALID');
  for (const categoryName of COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES) {
    const category = value.categories[categoryName];
    if (
      !isRecord(category) ||
      !hasExactKeys(category, ['count', 'digest', 'nonEmpty']) ||
      !Number.isSafeInteger(category.count) ||
      Number(category.count) < 0 ||
      !sha256Pattern.test(String(category.digest)) ||
      category.nonEmpty !== Number(category.count) > 0
    )
      fail('REPORT_SHAPE_INVALID');
  }
  const coverageCounts = [
    value.manifestCoverage.entryCount,
    value.manifestCoverage.observedEntryCount,
    value.manifestCoverage.presentCount,
    value.manifestCoverage.absentCount,
    value.manifestCoverage.expectedStateMismatchCount,
  ];
  if (
    coverageCounts.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0) ||
    value.manifestCoverage.entryCount !== COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.length ||
    value.manifestCoverage.observedEntryCount !== value.manifestCoverage.entryCount ||
    Number(value.manifestCoverage.presentCount) + Number(value.manifestCoverage.absentCount) !==
      value.manifestCoverage.entryCount ||
    Number(value.manifestCoverage.expectedStateMismatchCount) > value.manifestCoverage.entryCount ||
    value.manifestCoverage.exact !== true ||
    !sha256Pattern.test(String(value.manifestCoverage.digest)) ||
    !isRecord(value.anomalies.counts) ||
    !hasExactKeys(value.anomalies.counts, COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ANOMALY_NAMES) ||
    !sha256Pattern.test(String(value.anomalies.digest))
  )
    fail('REPORT_SHAPE_INVALID');
  const anomalyReport = value.anomalies;
  const anomalyCountRecord = anomalyReport.counts as Record<string, unknown>;
  const anomalyCounts = COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ANOMALY_NAMES.map(
    (name) => anomalyCountRecord[name],
  );
  if (
    anomalyCounts.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0) ||
    !Number.isSafeInteger(anomalyReport.total) ||
    anomalyReport.total !==
      anomalyCounts.reduce<number>((total, count) => total + Number(count), 0) ||
    anomalyCountRecord.manifestExpectedStateMismatches !==
      value.manifestCoverage.expectedStateMismatchCount
  )
    fail('REPORT_SHAPE_INVALID');
  const anomalyCanonical = `${COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_ANOMALY_NAMES.map(
    (name) => `${name}|${String(anomalyCountRecord[name])}`,
  ).join('\n')}\n`;
  if (sha256(anomalyCanonical) !== anomalyReport.digest) fail('REPORT_DIGEST_INVALID');
  const withoutDigest = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'reportSha256'),
  );
  if (sha256(canonicalJson(withoutDigest)) !== value.reportSha256) fail('REPORT_DIGEST_INVALID');
}

export interface CommunitiesStagingRoleSplitInventoryComparison {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_SCHEMA_VERSION;
  readonly status: 'UNCHANGED' | 'CHANGED_REVIEW_REQUIRED';
  readonly beforeReportSha256: string;
  readonly afterReportSha256: string;
  readonly inventoryUnchanged: boolean;
  readonly manifestCoverageUnchanged: boolean;
  readonly anomaliesUnchanged: boolean;
  readonly changedCategoryCount: number;
  readonly changedCategories: readonly InventoryCategoryName[];
  readonly comparisonSha256: string;
  readonly authorizes: {
    readonly roleCreation: false;
    readonly roleRepair: false;
    readonly roleSplit: false;
    readonly grantChange: false;
    readonly schemaChange: false;
    readonly sharedDatabaseMutation: false;
    readonly migration: false;
    readonly deploy: false;
    readonly import: false;
    readonly activation: false;
  };
}

export function compareCommunitiesStagingRoleSplitInventories(
  before: unknown,
  after: unknown,
): CommunitiesStagingRoleSplitInventoryComparison {
  assertCommunitiesStagingRoleSplitInventoryReport(before);
  assertCommunitiesStagingRoleSplitInventoryReport(after);
  if (
    before.objectManifestSha256 !== after.objectManifestSha256 ||
    before.provenance.requestSha256 !== after.provenance.requestSha256 ||
    before.provenance.markerPayloadSha256 !== after.provenance.markerPayloadSha256 ||
    before.provenance.markerValueSha256 !== after.provenance.markerValueSha256 ||
    before.provenance.markerEvidenceSha256 !== after.provenance.markerEvidenceSha256 ||
    before.provenance.sourceLedgerSha256 !== after.provenance.sourceLedgerSha256 ||
    before.provenance.sourceLedgerCount !== after.provenance.sourceLedgerCount
  )
    fail('COMPARISON_PROVENANCE_MISMATCH');
  const changedCategories = COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES.filter(
    (name) =>
      before.categories[name].digest !== after.categories[name].digest ||
      before.categories[name].count !== after.categories[name].count,
  );
  const inventoryUnchanged = before.inventoryDigest === after.inventoryDigest;
  const manifestCoverageUnchanged =
    before.manifestCoverage.digest === after.manifestCoverage.digest;
  const anomaliesUnchanged = before.anomalies.digest === after.anomalies.digest;
  const body = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_SCHEMA_VERSION,
    status: inventoryUnchanged ? ('UNCHANGED' as const) : ('CHANGED_REVIEW_REQUIRED' as const),
    beforeReportSha256: before.reportSha256,
    afterReportSha256: after.reportSha256,
    inventoryUnchanged,
    manifestCoverageUnchanged,
    anomaliesUnchanged,
    changedCategoryCount: changedCategories.length,
    changedCategories,
    authorizes: {
      roleCreation: false as const,
      roleRepair: false as const,
      roleSplit: false as const,
      grantChange: false as const,
      schemaChange: false as const,
      sharedDatabaseMutation: false as const,
      migration: false as const,
      deploy: false as const,
      import: false as const,
      activation: false as const,
    },
  } satisfies Omit<CommunitiesStagingRoleSplitInventoryComparison, 'comparisonSha256'>;
  return { ...body, comparisonSha256: sha256(canonicalJson(body)) };
}

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL = {
  identity: identitySql,
  categories: categorySql,
  manifestCoverage: manifestCoverageSql,
  anomalies: anomalySql,
} as const;
