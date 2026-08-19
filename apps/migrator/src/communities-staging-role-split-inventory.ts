import { createHash } from 'node:crypto';

import {
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION,
  COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
  COMMUNITIES_ROLE_SPLIT_FIELD_KINDS,
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION,
  COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS,
  COMMUNITIES_ROLE_SPLIT_MAPPING_VERSION as INPUT_C_MAPPING_VERSION,
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES,
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION,
  assertCommunitiesRoleSplitInputC,
  assertCommunitiesStagingRoleSplitRestoreMarkerEvidence,
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  canonicalCommunitiesStagingRoleSplitLedger,
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarker,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_REQUEST_VERSION,
  communitiesRoleSplitInputCManifestSha256,
  communitiesRoleSplitCanonicalJson,
  communitiesRoleSplitMappingSha256,
  compareCommunitiesRoleSplitUtf8Bytes,
  type CommunitiesRoleSplitAclEntry,
  type CommunitiesRoleSplitFieldKind,
  type CommunitiesRoleSplitInputC,
  type CommunitiesRoleSplitMappingArtifact,
  type CommunitiesRoleSplitMappingCategory,
  type CommunitiesRoleSplitNormalizedCategory,
  type CommunitiesRoleSplitNormalizedRecord,
  type CommunitiesStagingRoleSplitRestoreMarkerEvidence,
  type CommunitiesStagingRoleSplitRestoreMarkerPayload,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { Client, type QueryResult } from 'pg';

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION =
  'PRODUCE_COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_V1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION =
  COMMUNITIES_ROLE_SPLIT_INPUT_C_SCHEMA_VERSION;
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CANONICALIZATION_VERSION =
  COMMUNITIES_ROLE_SPLIT_CANONICALIZATION_VERSION;
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SORT_VERSION =
  COMMUNITIES_ROLE_SPLIT_SORT_VERSION;
export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_SCHEMA_VERSION =
  'communities-role-split-input-c-comparison-v1';
export const COMMUNITIES_STAGING_ROLE_SPLIT_MAPPING_VERSION =
  'PHUB_COMMUNITIES_ROLE_SPLIT_INVENTORY_ROLE_MAPPING_V1';

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES =
  COMMUNITIES_ROLE_SPLIT_NORMALIZED_CATEGORIES;

export const COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES =
  COMMUNITIES_ROLE_SPLIT_ROLE_CATEGORIES;

export const COMMUNITIES_STAGING_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT =
  COMMUNITIES_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT;

type CategoryName = CommunitiesRoleSplitNormalizedCategory;
type RoleCategory = (typeof COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES)[number];

const shaPattern = /^[a-f0-9]{64}$/;
const positiveDecimal = /^[1-9][0-9]*$/;
const relevantSchemas =
  "('public'),('profile'),('communities'),('integration'),('messaging'),('notifications'),('games'),('identity'),('community_content'),('eligibility')";

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

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function compareUtf8Bytes(left: string, right: string): number {
  return compareCommunitiesRoleSplitUtf8Bytes(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('REPORT_INVALID');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) fail('REPORT_INVALID');
  return `{${Object.keys(value)
    .sort(compareUtf8Bytes)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function parseExactLines(value: string, version: string): ReadonlyMap<string, string> {
  if (value.includes('\r') || !value.endsWith('\n')) fail('EVIDENCE_SHAPE_INVALID');
  const lines = value.slice(0, -1).split('\n');
  if (lines.shift() !== version) fail('EVIDENCE_SHAPE_INVALID');
  const result = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1 || line.indexOf('=', separator + 1) !== -1) fail('EVIDENCE_SHAPE_INVALID');
    const key = line.slice(0, separator);
    if (result.has(key)) fail('EVIDENCE_SHAPE_INVALID');
    result.set(key, line.slice(separator + 1));
  }
  return result;
}

export function parseCommunitiesStagingRoleSplitMarkerRequest(
  value: string,
): CommunitiesStagingRoleSplitRestoreMarkerRequest {
  const parsed = parseExactLines(
    value,
    COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_REQUEST_VERSION,
  );
  const request = Object.fromEntries(
    parsed,
  ) as unknown as CommunitiesStagingRoleSplitRestoreMarkerRequest;
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(request);
    if (canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(request) !== value)
      fail('REQUEST_SHAPE_INVALID');
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitInventoryError) throw error;
    fail('REQUEST_SHAPE_INVALID');
  }
  return request;
}

const markerEvidenceLines = [
  'status',
  'requestSha256',
  'creationReceiptSha256',
  'markerPayloadSha256',
  'markerValueSha256',
  'backupSha256',
  'sourceLedgerSha256',
  'sourceLedgerCount',
  'cloneDatabaseOid',
  'cloneBindingSha256',
  'sourceBindingSha256',
  'restoreRunId',
  'restoreRunAttempt',
  'restoreHelperSha256',
  'markerWriterSha256',
  'binding.request',
  'binding.backup',
  'binding.archiveOwnershipAcl',
  'binding.sourceStable',
  'binding.restoredLedger',
  'binding.cloneIdentity',
  'binding.markerReadback',
  'authorizes.roleCreation',
  'authorizes.roleSplit',
  'authorizes.sharedDatabaseMutation',
  'authorizes.migration',
  'authorizes.deploy',
  'authorizes.import',
  'authorizes.activation',
] as const;

export function parseCommunitiesStagingRoleSplitMarkerEvidence(
  value: string,
): CommunitiesStagingRoleSplitRestoreMarkerEvidence {
  const parsed = parseExactLines(
    value,
    'schemaVersion=communities-role-split-clone-marker-evidence-v2',
  );
  if (
    parsed.size !== markerEvidenceLines.length ||
    markerEvidenceLines.some((key, index) => [...parsed.keys()][index] !== key)
  )
    fail('EVIDENCE_SHAPE_INVALID');
  const required = (key: (typeof markerEvidenceLines)[number]): string => {
    const result = parsed.get(key);
    if (result === undefined) fail('EVIDENCE_SHAPE_INVALID');
    return result;
  };
  const truth = (key: (typeof markerEvidenceLines)[number]): true => {
    if (required(key) !== 'true') fail('EVIDENCE_SHAPE_INVALID');
    return true;
  };
  const falsity = (key: (typeof markerEvidenceLines)[number]): false => {
    if (required(key) !== 'false') fail('EVIDENCE_SHAPE_INVALID');
    return false;
  };
  if (required('status') !== 'MARKED') fail('EVIDENCE_SHAPE_INVALID');
  return {
    schemaVersion: 'communities-role-split-clone-marker-evidence-v2',
    status: required('status') as 'MARKED',
    requestSha256: required('requestSha256'),
    creationReceiptSha256: required('creationReceiptSha256'),
    markerPayloadSha256: required('markerPayloadSha256'),
    markerValueSha256: required('markerValueSha256'),
    backupSha256: required('backupSha256'),
    sourceLedgerSha256: required('sourceLedgerSha256'),
    sourceLedgerCount: required('sourceLedgerCount'),
    cloneDatabaseOid: required('cloneDatabaseOid'),
    cloneBindingSha256: required('cloneBindingSha256'),
    sourceBindingSha256: required('sourceBindingSha256'),
    restoreRunId: required('restoreRunId'),
    restoreRunAttempt: required('restoreRunAttempt'),
    restoreHelperSha256: required('restoreHelperSha256'),
    markerWriterSha256: required('markerWriterSha256'),
    bindings: {
      request: truth('binding.request'),
      backup: truth('binding.backup'),
      archiveOwnershipAcl: truth('binding.archiveOwnershipAcl'),
      sourceStable: truth('binding.sourceStable'),
      restoredLedger: truth('binding.restoredLedger'),
      cloneIdentity: truth('binding.cloneIdentity'),
      markerReadback: truth('binding.markerReadback'),
    },
    authorizes: {
      roleCreation: falsity('authorizes.roleCreation'),
      roleSplit: falsity('authorizes.roleSplit'),
      sharedDatabaseMutation: falsity('authorizes.sharedDatabaseMutation'),
      migration: falsity('authorizes.migration'),
      deploy: falsity('authorizes.deploy'),
      import: falsity('authorizes.import'),
      activation: falsity('authorizes.activation'),
    },
  };
}

export interface RoleMappingEntry {
  readonly category: RoleCategory;
  readonly roleName: string;
  readonly roleOid: string;
}

export function parseCommunitiesStagingRoleSplitRoleMapping(
  value: string,
): readonly RoleMappingEntry[] {
  const parsed = parseExactLines(value, COMMUNITIES_STAGING_ROLE_SPLIT_MAPPING_VERSION);
  if (
    parsed.size !== COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES.length ||
    COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES.some(
      (category, index) => [...parsed.keys()][index] !== category,
    )
  )
    fail('MAPPING_INVALID');
  const mapping = COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES.map((category) => {
    const fields = (parsed.get(category) ?? '').split('|');
    if (
      fields.length !== 2 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fields[0] ?? '') ||
      !positiveDecimal.test(fields[1] ?? '')
    )
      fail('MAPPING_INVALID');
    return { category, roleName: fields[0]!, roleOid: fields[1]! };
  });
  const runtime = mapping.find((entry) => entry.category === 'FUTURE_RUNTIME');
  const migrator = mapping.find((entry) => entry.category === 'FUTURE_MIGRATOR');
  if (
    !runtime ||
    !migrator ||
    runtime.roleName === migrator.roleName ||
    runtime.roleOid === migrator.roleOid
  )
    fail('MAPPING_INVALID');
  return mapping;
}

export type NormalizedRecord = CommunitiesRoleSplitNormalizedRecord;

export interface InventoryAnomaly {
  readonly code: string;
  readonly count: number;
  readonly evidenceSha256: string;
}

export type InventoryReport = CommunitiesRoleSplitInputC;

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

export interface InventoryInput {
  readonly confirmation: string;
  readonly connectionString: string;
  readonly requestText: string;
  readonly expectedRequestSha256: string;
  readonly markerEvidenceText: string;
  readonly expectedMarkerEvidenceSha256: string;
  readonly roleMappingText: string;
  readonly expectedRoleMappingSha256: string;
}

type IdentityRow = {
  database_name: string;
  database_oid: string;
  database_owner: string;
  database_owner_oid: string;
  source_database_oid: string | null;
  source_database_owner: string | null;
  source_database_owner_oid: string | null;
  system_identifier: string;
  postgres_major: string;
  marker: string | null;
  current_role: string;
  current_role_oid: string;
  session_role: string;
  transaction_read_only: string;
  role_safe: boolean;
};

const identitySql = `/* communities-role-split-input-c:identity */
select database.datname database_name, database.oid::text database_oid, owner.rolname database_owner,
       owner.oid::text database_owner_oid, source.oid::text source_database_oid,
       source_owner.rolname source_database_owner, source_owner.oid::text source_database_owner_oid,
       (select system_identifier::text from pg_catalog.pg_control_system()) system_identifier,
       (current_setting('server_version_num')::integer / 10000)::text postgres_major,
       pg_catalog.shobj_description(database.oid, 'pg_database') marker,
       current_user current_role, reader.oid::text current_role_oid, session_user session_role,
       current_setting('transaction_read_only') transaction_read_only,
       (reader.rolcanlogin and not reader.rolsuper and not reader.rolbypassrls and not reader.rolcreatedb
        and not reader.rolcreaterole and not reader.rolreplication) role_safe
  from pg_catalog.pg_database database join pg_catalog.pg_roles owner on owner.oid=database.datdba
  join pg_catalog.pg_roles reader on reader.rolname=current_user
  left join pg_catalog.pg_database source on source.datname=$1
  left join pg_catalog.pg_roles source_owner on source_owner.oid=source.datdba
 where database.datname=current_database()`;

const aclRows = (objectIdentity: string, acl: string, owner: string, code: string): string => `
select ${objectIdentity}::text object_identity,
       pg_catalog.jsonb_build_array('explicitAcl')::text field_identity,
       'ACL_EXPLICIT'::text field_kind,
       coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'granteeCategory',coalesce(mapped.category,case when entry.grantee=0 then 'PUBLIC' else 'THIRD_PARTY' end),
         'privilege',entry.privilege_type,'grantOption',entry.is_grantable)
         order by coalesce(mapped.category,case when entry.grantee=0 then 'PUBLIC' else 'THIRD_PARTY' end),entry.privilege_type,entry.is_grantable)
         filter (where entry.grantee is not null),'[]'::jsonb)::text value,
       null::text owner_oid
  from (select 1) seed left join lateral pg_catalog.aclexplode(coalesce(${acl},'{}'::aclitem[])) entry on true
  left join lateral (select value->>'category' category from pg_catalog.jsonb_array_elements($1::jsonb)
    where value->>'roleOid'=entry.grantee::text order by value->>'category' limit 1) mapped on true
union all
select ${objectIdentity}::text object_identity,
       pg_catalog.jsonb_build_array('effectiveAcl')::text field_identity,
       'ACL_EFFECTIVE'::text field_kind,
       coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'granteeCategory',coalesce(mapped.category,case when entry.grantee=0 then 'PUBLIC' else 'THIRD_PARTY' end),
         'privilege',entry.privilege_type,'grantOption',entry.is_grantable)
         order by coalesce(mapped.category,case when entry.grantee=0 then 'PUBLIC' else 'THIRD_PARTY' end),entry.privilege_type,entry.is_grantable)
         filter (where entry.grantee is not null),'[]'::jsonb)::text value,
       null::text owner_oid
  from pg_catalog.aclexplode(coalesce(${acl},pg_catalog.acldefault('${code}',${owner}))) entry
  left join lateral (select value->>'category' category from pg_catalog.jsonb_array_elements($1::jsonb)
    where value->>'roleOid'=entry.grantee::text order by value->>'category' limit 1) mapped on true`;

const categorySql: Readonly<Record<CategoryName, string>> = {
  roles: `/* communities-role-split-input-c:roles */
select pg_catalog.jsonb_build_array('role',role.rolname)::text object_identity,
 pg_catalog.jsonb_build_array('metadata')::text field_identity,'ROLE'::text field_kind,
 pg_catalog.jsonb_build_array(role.oid::text,role.rolsuper,role.rolinherit,role.rolcreaterole,
 role.rolcreatedb,role.rolcanlogin,role.rolreplication,role.rolbypassrls)::text value,
 null::text owner_oid from pg_catalog.pg_roles role where role.rolname !~ '^pg_'`,
  memberships: `/* communities-role-split-input-c:memberships */
select pg_catalog.jsonb_build_array('membership',granted.rolname,member.rolname)::text object_identity,
 pg_catalog.jsonb_build_array('membership')::text field_identity,'MEMBERSHIP'::text field_kind,
 pg_catalog.jsonb_build_array(granted.oid::text,member.oid::text,membership.admin_option,
 membership.inherit_option,membership.set_option)::text value,null::text owner_oid
 from pg_catalog.pg_auth_members membership join pg_catalog.pg_roles granted on granted.oid=membership.roleid
 join pg_catalog.pg_roles member on member.oid=membership.member`,
  databaseAcl: `/* communities-role-split-input-c:databaseAcl */
select pg_catalog.jsonb_build_array('database',database.datname)::text object_identity,
 pg_catalog.jsonb_build_array('owner')::text field_identity,'OWNER'::text field_kind,
 owner.rolname value,owner.oid::text owner_oid from pg_catalog.pg_database database
join pg_catalog.pg_roles owner on owner.oid=database.datdba where database.datname=current_database()
union all
select rows.* from pg_catalog.pg_database database
cross join lateral (${aclRows("pg_catalog.jsonb_build_array('database',database.datname)", 'database.datacl', 'database.datdba', 'd')}) rows
where database.datname=current_database()`,
  schemas: `/* communities-role-split-input-c:schemas */
with relevant(name) as (values ${relevantSchemas})
select pg_catalog.jsonb_build_array('schema',namespace.nspname)::text object_identity,
 pg_catalog.jsonb_build_array('owner')::text field_identity,'OWNER'::text field_kind,
 owner.rolname value,owner.oid::text owner_oid
 from pg_catalog.pg_namespace namespace join pg_catalog.pg_roles owner on owner.oid=namespace.nspowner
 where namespace.nspname in (select name from relevant)
union all
select rows.*
 from pg_catalog.pg_namespace namespace
 cross join lateral (${aclRows("pg_catalog.jsonb_build_array('schema',namespace.nspname)", 'namespace.nspacl', 'namespace.nspowner', 'n')}) rows
 where namespace.nspname in (select name from relevant)`,
  defaultAcls: `/* communities-role-split-input-c:defaultAcls */
with relevant(name) as (values ${relevantSchemas})
select pg_catalog.jsonb_build_array('defaultAcl',owner.rolname,namespace.nspname,defaults.defaclobjtype)::text object_identity,
 pg_catalog.jsonb_build_array('definition')::text field_identity,'DEFAULT_ACL'::text field_kind,
 coalesce(pg_catalog.jsonb_agg(item::text order by item::text),'[]'::jsonb)::text value,null::text owner_oid
 from pg_catalog.pg_default_acl defaults join pg_catalog.pg_roles owner on owner.oid=defaults.defaclrole
 left join pg_catalog.pg_namespace namespace on namespace.oid=defaults.defaclnamespace
 left join lateral unnest(defaults.defaclacl) item on true
 where defaults.defaclnamespace=0 or namespace.nspname in (select name from relevant)
 group by owner.rolname,namespace.nspname,defaults.defaclobjtype`,
  relations: `/* communities-role-split-input-c:relations */
with relevant(name) as (values ${relevantSchemas}), base as (
 select namespace.nspname, relation.* from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
 where namespace.nspname in (select name from relevant) and relation.relkind in ('r','p','v','m','f'))
select pg_catalog.jsonb_build_array('relation',nspname,relname,relkind)::text object_identity,
 pg_catalog.jsonb_build_array('owner')::text field_identity,'OWNER'::text field_kind,
 owner.rolname value,owner.oid::text owner_oid from base
join pg_catalog.pg_roles owner on owner.oid=base.relowner
union all select pg_catalog.jsonb_build_array('relation',nspname,relname,relkind)::text,
 pg_catalog.jsonb_build_array('metadata')::text,'METADATA'::text,
 pg_catalog.jsonb_build_array(relkind)::text,null::text from base
union all select rows.* from base cross join lateral
 (${aclRows("pg_catalog.jsonb_build_array('relation',base.nspname,base.relname,base.relkind)", 'base.relacl', 'base.relowner', 'r')}) rows`,
  columnAcls: `/* communities-role-split-input-c:columnAcls */
with relevant(name) as (values ${relevantSchemas})
select pg_catalog.jsonb_build_array('column',namespace.nspname,relation.relname,relation.relkind,
 attribute.attname,attribute.attnum)::text object_identity,
 pg_catalog.jsonb_build_array(kind.field_name)::text field_identity,kind.field_kind,
 coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'granteeCategory',coalesce(mapped.category,case when entry.grantee=0 then 'PUBLIC' else 'THIRD_PARTY' end),
  'privilege',entry.privilege_type,'grantOption',entry.is_grantable)
  order by coalesce(mapped.category,case when entry.grantee=0 then 'PUBLIC' else 'THIRD_PARTY' end),entry.privilege_type,entry.is_grantable)
  filter (where entry.grantee is not null),'[]'::jsonb)::text value,null::text owner_oid
 from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
 join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
 cross join (values ('explicitAcl','ACL_EXPLICIT'),('effectiveAcl','ACL_EFFECTIVE')) kind(field_name,field_kind)
 left join lateral pg_catalog.aclexplode(coalesce(attribute.attacl,'{}'::aclitem[])) entry on true
 left join lateral (select value->>'category' category from pg_catalog.jsonb_array_elements($1::jsonb)
  where value->>'roleOid'=entry.grantee::text order by value->>'category' limit 1) mapped on true
 where namespace.nspname in (select name from relevant) and relation.relkind in ('r','p','v','m','f')
 and attribute.attnum>0 and not attribute.attisdropped
 group by namespace.nspname,relation.relname,relation.relkind,attribute.attname,attribute.attnum,kind.field_name,kind.field_kind`,
  rlsPolicies: `/* communities-role-split-input-c:rlsPolicies */
with relevant(name) as (values ${relevantSchemas})
select pg_catalog.jsonb_build_array('relation',namespace.nspname,relation.relname,relation.relkind)::text object_identity,
 pg_catalog.jsonb_build_array('rls')::text field_identity,'RLS'::text field_kind,
 pg_catalog.jsonb_build_array(relation.relrowsecurity,relation.relforcerowsecurity)::text value,null::text owner_oid
 from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
 where namespace.nspname in (select name from relevant) and relation.relkind in ('r','p')
union all select pg_catalog.jsonb_build_array('relation',policy.schemaname,policy.tablename,relation.relkind)::text,
 pg_catalog.jsonb_build_array('policy',policy.policyname)::text,'POLICY'::text,
 pg_catalog.jsonb_build_array(policy.permissive,policy.roles,policy.cmd,policy.qual,policy.with_check)::text,null::text
 from pg_catalog.pg_policies policy join pg_catalog.pg_namespace namespace on namespace.nspname=policy.schemaname
 join pg_catalog.pg_class relation on relation.relnamespace=namespace.oid and relation.relname=policy.tablename
 where policy.schemaname in (select name from relevant)`,
  sequences: `/* communities-role-split-input-c:sequences */
with relevant(name) as (values ${relevantSchemas}), base as (
 select namespace.nspname, relation.*, sequence.* from pg_catalog.pg_class relation
 join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
 join pg_catalog.pg_sequence sequence on sequence.seqrelid=relation.oid where namespace.nspname in (select name from relevant))
select pg_catalog.jsonb_build_array('sequence',nspname,relname)::text object_identity,
 pg_catalog.jsonb_build_array('owner')::text field_identity,'OWNER'::text field_kind,
 owner.rolname value,owner.oid::text owner_oid from base
join pg_catalog.pg_roles owner on owner.oid=base.relowner
union all select pg_catalog.jsonb_build_array('sequence',nspname,relname)::text,
 pg_catalog.jsonb_build_array('metadata')::text,'METADATA'::text,
 pg_catalog.jsonb_build_array(seqstart,seqincrement,seqmin,seqmax,seqcache,seqcycle)::text,null::text from base
union all select rows.* from base cross join lateral
 (${aclRows("pg_catalog.jsonb_build_array('sequence',base.nspname,base.relname)", 'base.relacl', 'base.relowner', 's')}) rows`,
  functions: `/* communities-role-split-input-c:functions */
with relevant(name) as (values ${relevantSchemas}), base as (
 select namespace.nspname, routine.* from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid=routine.pronamespace
 where namespace.nspname in (select name from relevant))
select pg_catalog.jsonb_build_array('function',nspname,proname,pg_catalog.pg_get_function_identity_arguments(base.oid))::text object_identity,
 pg_catalog.jsonb_build_array('owner')::text field_identity,'OWNER'::text field_kind,
 owner.rolname value,owner.oid::text owner_oid from base join pg_catalog.pg_roles owner on owner.oid=base.proowner
union all select pg_catalog.jsonb_build_array('function',nspname,proname,pg_catalog.pg_get_function_identity_arguments(oid))::text,
 pg_catalog.jsonb_build_array('metadata')::text,'METADATA'::text,
 pg_catalog.jsonb_build_array(prokind,prosecdef,proleakproof,provolatile,proparallel,proconfig)::text,null::text from base
union all select rows.* from base cross join lateral
 (${aclRows("pg_catalog.jsonb_build_array('function',base.nspname,base.proname,pg_catalog.pg_get_function_identity_arguments(base.oid))", 'base.proacl', 'base.proowner', 'f')}) rows`,
  types: `/* communities-role-split-input-c:types */
with relevant(name) as (values ${relevantSchemas}), base as (
 select namespace.nspname, object_type.* from pg_catalog.pg_type object_type join pg_catalog.pg_namespace namespace on namespace.oid=object_type.typnamespace
 where namespace.nspname in (select name from relevant))
select pg_catalog.jsonb_build_array('type',nspname,typname)::text object_identity,
 pg_catalog.jsonb_build_array('owner')::text field_identity,'OWNER'::text field_kind,
 owner.rolname value,owner.oid::text owner_oid from base
join pg_catalog.pg_roles owner on owner.oid=base.typowner
union all select pg_catalog.jsonb_build_array('type',nspname,typname)::text,
 pg_catalog.jsonb_build_array('metadata')::text,'METADATA'::text,
 pg_catalog.jsonb_build_array(typtype,typcategory,typnotnull)::text,null::text from base
union all select rows.* from base cross join lateral
 (${aclRows("pg_catalog.jsonb_build_array('type',base.nspname,base.typname)", 'base.typacl', 'base.typowner', 'T')}) rows`,
  extensions: `/* communities-role-split-input-c:extensions */
select pg_catalog.jsonb_build_array('extension',extension.extname)::text object_identity,
 pg_catalog.jsonb_build_array('owner')::text field_identity,'OWNER'::text field_kind,
 owner.rolname value,owner.oid::text owner_oid
 from pg_catalog.pg_extension extension join pg_catalog.pg_roles owner on owner.oid=extension.extowner
union all
select pg_catalog.jsonb_build_array('extension',extension.extname)::text,
 pg_catalog.jsonb_build_array('metadata')::text,'METADATA'::text,
 pg_catalog.jsonb_build_array(extension.extversion,extension.extnamespace::text,extension.extrelocatable)::text,null::text
 from pg_catalog.pg_extension extension
union all
select pg_catalog.jsonb_build_array('extension',extension.extname)::text,
 pg_catalog.jsonb_build_array('member',dependency.classid::text,dependency.objid::text,dependency.objsubid)::text,
 'EXTENSION_MEMBER'::text,
 pg_catalog.jsonb_build_array(pg_catalog.pg_describe_object(dependency.classid,dependency.objid,dependency.objsubid),dependency.deptype)::text,null::text
 from pg_catalog.pg_depend dependency join pg_catalog.pg_extension extension on extension.oid=dependency.refobjid
 where dependency.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass and dependency.deptype='e'`,
};

const mappingSql = `/* communities-role-split-input-c:mapping */
select role.rolname role_name,role.oid::text role_oid,role.rolcanlogin can_login,
 role.rolsuper superuser,role.rolbypassrls bypass_rls,role.rolcreatedb create_database,
 role.rolcreaterole create_role,role.rolreplication replication
 from pg_catalog.pg_roles role where role.rolname=any($1::text[])`;

const anomalySql = `/* communities-role-split-input-c:anomalies */
with mapped(category,rolname,role_oid) as (select value->>'category',value->>'roleName',(value->>'roleOid')::oid from pg_catalog.jsonb_array_elements($1::jsonb)),
dangerous as (select count(*)::text count from pg_catalog.pg_roles role join mapped on mapped.role_oid=role.oid
 where role.rolsuper or role.rolbypassrls or role.rolcreatedb or role.rolcreaterole or role.rolreplication),
memberships as (select count(*)::text count from pg_catalog.pg_auth_members membership
 join pg_catalog.pg_roles granted on granted.oid=membership.roleid join pg_catalog.pg_roles member on member.oid=membership.member
 where granted.oid in (select role_oid from mapped) or member.oid in (select role_oid from mapped)),
relevant(name) as (values ${relevantSchemas}), acl(owner_oid,acl_value,source) as (
 select database.datdba,coalesce(database.datacl,pg_catalog.acldefault('d',database.datdba)),'database' from pg_catalog.pg_database database where database.datname=current_database()
 union all select namespace.nspowner,coalesce(namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)),'schema' from pg_catalog.pg_namespace namespace where namespace.nspname in (select name from relevant)
 union all select relation.relowner,coalesce(relation.relacl,pg_catalog.acldefault(case when relation.relkind='S' then 's'::"char" else 'r'::"char" end,relation.relowner)),'relation' from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace where namespace.nspname in (select name from relevant)
 union all select routine.proowner,coalesce(routine.proacl,pg_catalog.acldefault('f',routine.proowner)),'function' from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid=routine.pronamespace where namespace.nspname in (select name from relevant)
 union all select object_type.typowner,coalesce(object_type.typacl,pg_catalog.acldefault('T',object_type.typowner)),'type' from pg_catalog.pg_type object_type join pg_catalog.pg_namespace namespace on namespace.oid=object_type.typnamespace where namespace.nspname in (select name from relevant)
), exploded as (select acl.owner_oid,acl.source,entry.* from acl cross join lateral pg_catalog.aclexplode(acl.acl_value) entry)
select (select count from dangerous) dangerous_roles,(select count from memberships) mapped_memberships,
 (select count(*)::text from exploded where grantee=0) public_grants,
 (select count(*)::text from exploded where grantee<>0 and not exists (select 1 from mapped where role_oid=grantee)) third_party_grants,
 (select count(*)::text from exploded where is_grantable) grant_options,
 (select count(*)::text from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid=attribute.attrelid join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace where namespace.nspname in (select name from relevant) and attribute.attnum>0 and not attribute.attisdropped and cardinality(attribute.attacl)>0) column_grants,
 (select count(*)::text from pg_catalog.pg_default_acl defaults left join pg_catalog.pg_namespace namespace on namespace.oid=defaults.defaclnamespace where defaults.defaclnamespace=0 or namespace.nspname in (select name from relevant)) default_acls`;

function connectionRole(connectionString: string, databaseName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    fail('CONNECTION_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    parsed.port !== '5432' ||
    parsed.search ||
    parsed.hash ||
    !parsed.username ||
    decodeURIComponent(parsed.pathname) !== `/${databaseName}`
  )
    fail('CONNECTION_INVALID');
  return decodeURIComponent(parsed.username);
}

function payloadFrom(
  request: CommunitiesStagingRoleSplitRestoreMarkerRequest,
  requestDigest: string,
  creationReceiptSha256: string,
  row: IdentityRow,
): CommunitiesStagingRoleSplitRestoreMarkerPayload {
  return {
    requestSha256: requestDigest,
    creationReceiptSha256,
    restoreDatabase: request.restoreDatabase,
    cloneDatabaseOid: row.database_oid,
    cloneDatabaseOwner: row.database_owner,
    cloneDatabaseOwnerOid: row.database_owner_oid,
    sourceDatabase: request.sourceDatabase,
    sourceDatabaseOid: row.source_database_oid ?? '',
    sourceDatabaseOwner: row.source_database_owner ?? '',
    sourceDatabaseOwnerOid: row.source_database_owner_oid ?? '',
    systemIdentifier: row.system_identifier,
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

function parseCount(value: unknown): number {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    fail('CATALOG_INVALID');
  return Number(value);
}

type CatalogRow = {
  object_identity: string;
  field_identity: string;
  field_kind: string;
  value: string;
  owner_oid: string | null;
};

type ObservedMappingRow = {
  role_name: string;
  role_oid: string;
  can_login: boolean;
  superuser: boolean;
  bypass_rls: boolean;
  create_database: boolean;
  create_role: boolean;
  replication: boolean;
};

function buildMappingArtifact(
  mapping: readonly RoleMappingEntry[],
  observed: readonly ObservedMappingRow[],
  evidenceBase: string,
): CommunitiesRoleSplitMappingArtifact {
  const byName = new Map(observed.map((row) => [row.role_name, row]));
  if (byName.size !== new Set(mapping.map((entry) => entry.roleName)).size) fail('MAPPING_INVALID');
  const categories: CommunitiesRoleSplitMappingCategory[] = mapping.map((entry) => {
    const row = byName.get(entry.roleName);
    if (!row || row.role_oid !== entry.roleOid) fail('MAPPING_INVALID');
    const capabilities = {
      canLogin: row.can_login,
      superuser: row.superuser,
      bypassRls: row.bypass_rls,
      createDatabase: row.create_database,
      createRole: row.create_role,
      replication: row.replication,
    };
    if (Object.values(capabilities).some((value) => typeof value !== 'boolean'))
      fail('MAPPING_INVALID');
    const roleNameSha256 = sha256(entry.roleName);
    const roleOidSha256 = sha256(entry.roleOid);
    return {
      category: entry.category,
      roleNameSha256,
      roleOidSha256,
      capabilities,
      evidenceSha256: sha256(
        communitiesRoleSplitCanonicalJson([
          evidenceBase,
          entry.category,
          roleNameSha256,
          roleOidSha256,
          capabilities,
        ]),
      ),
    };
  });
  const identityRelations = COMMUNITIES_ROLE_SPLIT_IDENTITY_RELATION_SPECS.map(
    ([left, right, requirement]) => {
      const leftEntry = categories.find((entry) => entry.category === left)!;
      const rightEntry = categories.find((entry) => entry.category === right)!;
      const relation =
        leftEntry.roleNameSha256 === rightEntry.roleNameSha256 &&
        leftEntry.roleOidSha256 === rightEntry.roleOidSha256
          ? ('SAME' as const)
          : ('DISTINCT' as const);
      if (requirement === 'REQUIRED_DISTINCT' && relation !== 'DISTINCT') fail('MAPPING_INVALID');
      return {
        left,
        right,
        requirement,
        relation,
        evidenceSha256: sha256(
          communitiesRoleSplitCanonicalJson([
            evidenceBase,
            left,
            right,
            requirement,
            relation,
            leftEntry.roleNameSha256,
            leftEntry.roleOidSha256,
            rightEntry.roleNameSha256,
            rightEntry.roleOidSha256,
          ]),
        ),
      };
    },
  );
  const draft = {
    schemaVersion: INPUT_C_MAPPING_VERSION,
    categories,
    identityRelations,
  } satisfies Omit<CommunitiesRoleSplitMappingArtifact, 'mappingDigest'>;
  return { ...draft, mappingDigest: communitiesRoleSplitMappingSha256(draft) };
}

function parseIdentity(value: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('CATALOG_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail('CATALOG_INVALID');
  return parsed;
}

function parseAclEntries(value: string): readonly CommunitiesRoleSplitAclEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('CATALOG_INVALID');
  }
  if (!Array.isArray(parsed)) fail('CATALOG_INVALID');
  const entries = parsed.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.granteeCategory !== 'string' ||
      ![...COMMUNITIES_STAGING_ROLE_SPLIT_ROLE_CATEGORIES, 'PUBLIC', 'THIRD_PARTY'].includes(
        entry.granteeCategory,
      ) ||
      typeof entry.privilege !== 'string' ||
      !/^[A-Z][A-Z_]*$/u.test(entry.privilege) ||
      typeof entry.grantOption !== 'boolean'
    )
      fail('CATALOG_INVALID');
    return {
      granteeCategory: entry.granteeCategory as CommunitiesRoleSplitAclEntry['granteeCategory'],
      privilege: entry.privilege,
      grantOption: entry.grantOption,
    };
  });
  const uniqueEntries = [
    ...new Map(entries.map((entry) => [communitiesRoleSplitCanonicalJson(entry), entry])).values(),
  ];
  uniqueEntries.sort((left, right) =>
    compareUtf8Bytes(
      communitiesRoleSplitCanonicalJson(left),
      communitiesRoleSplitCanonicalJson(right),
    ),
  );
  return uniqueEntries;
}

function normalizeRows(
  category: CategoryName,
  rows: readonly CatalogRow[],
  provenanceDigest: string,
  mapping: CommunitiesRoleSplitMappingArtifact,
  mixedOwnerObjects: Set<string>,
): readonly NormalizedRecord[] {
  const seen = new Set<string>();
  const records = rows.map((row) => {
    if (
      typeof row.object_identity !== 'string' ||
      typeof row.field_identity !== 'string' ||
      typeof row.field_kind !== 'string' ||
      typeof row.value !== 'string' ||
      (row.owner_oid !== null && typeof row.owner_oid !== 'string') ||
      row.object_identity.includes('\n') ||
      row.field_identity.includes('\n') ||
      row.value.includes('\n')
    )
      fail('CATALOG_INVALID');
    const objectIdentity = parseIdentity(row.object_identity);
    const fieldIdentity = parseIdentity(row.field_identity);
    if (
      !COMMUNITIES_ROLE_SPLIT_FIELD_KINDS.includes(row.field_kind as CommunitiesRoleSplitFieldKind)
    )
      fail('CATALOG_INVALID');
    const fieldKind = row.field_kind as CommunitiesRoleSplitFieldKind;
    const objectKeySha256 = sha256(communitiesRoleSplitCanonicalJson([category, objectIdentity]));
    const fieldKeySha256 = sha256(
      communitiesRoleSplitCanonicalJson([category, objectIdentity, fieldIdentity]),
    );
    const recordKey = `${objectKeySha256}|${fieldKeySha256}`;
    if (seen.has(recordKey)) fail('DUPLICATE_RECORD');
    seen.add(recordKey);
    let semantic: NormalizedRecord['semantic'] = null;
    let valueSha256 = sha256(row.value);
    if (fieldKind === 'ACL_EXPLICIT' || fieldKind === 'ACL_EFFECTIVE') {
      const entries = parseAclEntries(row.value);
      semantic = { entries };
      valueSha256 = sha256(communitiesRoleSplitCanonicalJson(entries));
    } else if (fieldKind === 'OWNER') {
      const owners = mapping.categories.filter(
        (entry) => entry.roleOidSha256 === sha256(row.owner_oid ?? ''),
      );
      if (owners.length !== 1) mixedOwnerObjects.add(objectKeySha256);
      const selected = owners[0] ?? mapping.categories[0];
      if (!selected) fail('MAPPING_INVALID');
      semantic = { ownerCategory: selected.category };
    }
    return {
      objectKeySha256,
      fieldKeySha256,
      fieldKind,
      observationState: 'OBSERVED' as const,
      valueSha256,
      provenanceSha256: sha256(
        communitiesRoleSplitCanonicalJson([
          provenanceDigest,
          category,
          objectIdentity,
          fieldIdentity,
          fieldKind,
        ]),
      ),
      semantic,
    };
  });
  return records.sort((a, b) =>
    compareUtf8Bytes(
      `${a.objectKeySha256}|${a.fieldKeySha256}`,
      `${b.objectKeySha256}|${b.fieldKeySha256}`,
    ),
  );
}

function anomaly(code: string, count: number, provenanceDigest: string): InventoryAnomaly {
  return { code, count, evidenceSha256: sha256(`${provenanceDigest}\0${code}\0${count}`) };
}

export async function produceCommunitiesStagingRoleSplitInventory(
  input: InventoryInput,
  createClient: CommunitiesStagingRoleSplitInventoryClientFactory = (connectionString) =>
    new Client({
      connectionString,
      application_name: 'phub-communities-role-split-input-c-v1',
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    }) as unknown as InventoryClient,
): Promise<InventoryReport> {
  if (input.confirmation !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CONFIRMATION)
    fail('CONFIRMATION_INVALID');
  if (
    !shaPattern.test(input.expectedRequestSha256) ||
    !shaPattern.test(input.expectedMarkerEvidenceSha256)
  )
    fail('PIN_INVALID');
  const request = parseCommunitiesStagingRoleSplitMarkerRequest(input.requestText);
  const requestDigest = communitiesStagingRoleSplitRestoreMarkerRequestSha256(request);
  if (
    requestDigest !== input.expectedRequestSha256 ||
    sha256(input.markerEvidenceText) !== input.expectedMarkerEvidenceSha256
  )
    fail('PIN_INVALID');
  const evidence = parseCommunitiesStagingRoleSplitMarkerEvidence(input.markerEvidenceText);
  if (
    !input.roleMappingText ||
    !input.expectedRoleMappingSha256 ||
    !shaPattern.test(input.expectedRoleMappingSha256) ||
    sha256(input.roleMappingText) !== input.expectedRoleMappingSha256
  )
    fail('MAPPING_INVALID');
  const rawMapping = parseCommunitiesStagingRoleSplitRoleMapping(input.roleMappingText);
  const executor = connectionRole(input.connectionString, request.restoreDatabase);
  let client: InventoryClient;
  try {
    client = createClient(input.connectionString);
  } catch {
    fail('EXECUTION_FAILED');
  }
  let transaction = false;
  try {
    await client.connect();
    await client.query('begin transaction isolation level repeatable read read only');
    transaction = true;
    await client.query("set local search_path='pg_catalog'");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    const identity = (await client.query<IdentityRow>(identitySql, [request.sourceDatabase]))
      .rows[0];
    if (
      !identity ||
      identity.database_name !== request.restoreDatabase ||
      identity.database_owner !== request.expectedCloneDatabaseOwner ||
      identity.database_owner_oid !== request.expectedCloneDatabaseOwnerOid ||
      identity.source_database_oid !== request.sourceDatabaseOid ||
      identity.source_database_owner !== request.sourceDatabaseOwner ||
      identity.source_database_owner_oid !== request.sourceDatabaseOwnerOid ||
      identity.system_identifier !== request.systemIdentifier ||
      identity.postgres_major !== '16' ||
      identity.current_role !== executor ||
      identity.session_role !== executor ||
      identity.transaction_read_only !== 'on' ||
      !identity.role_safe
    )
      fail('BOUNDARY_INVALID');
    const observedMapping = (
      await client.query<ObservedMappingRow>(mappingSql, [
        rawMapping.map((entry) => entry.roleName),
      ])
    ).rows;
    const inventoryReader = rawMapping.find((entry) => entry.category === 'INVENTORY_READER');
    if (
      !inventoryReader ||
      inventoryReader.roleName !== identity.current_role ||
      inventoryReader.roleOid !== identity.current_role_oid
    )
      fail('MAPPING_INVALID');
    const payload = payloadFrom(request, requestDigest, evidence.creationReceiptSha256, identity);
    const marker = communitiesStagingRoleSplitRestoreMarker(payload);
    if (identity.marker !== marker) fail('MARKER_INVALID');
    try {
      assertCommunitiesStagingRoleSplitRestoreMarkerEvidence(payload, marker, evidence);
    } catch {
      fail('EVIDENCE_INVALID');
    }
    const ledgerRows = (
      await client.query<{ filename: string; checksum: string }>(
        '/* communities-role-split-input-c:ledger */ select filename,checksum from public.schema_migrations order by filename',
      )
    ).rows;
    let ledger: string;
    try {
      ledger = canonicalCommunitiesStagingRoleSplitLedger(ledgerRows);
    } catch {
      fail('LEDGER_INVALID');
    }
    if (
      ledgerRows.length.toString() !== request.sourceLedgerCount ||
      sha256(ledger) !== request.sourceLedgerSha256
    )
      fail('LEDGER_INVALID');
    const mappingEvidenceBase = sha256(
      communitiesRoleSplitCanonicalJson([
        requestDigest,
        sha256(marker),
        input.expectedMarkerEvidenceSha256,
        evidence.creationReceiptSha256,
        request.sourceLedgerSha256,
        input.expectedRoleMappingSha256,
      ]),
    );
    const mapping = buildMappingArtifact(rawMapping, observedMapping, mappingEvidenceBase);
    const provenanceBase = sha256(
      communitiesRoleSplitCanonicalJson([mappingEvidenceBase, mapping.mappingDigest]),
    );
    const mappingQueryValue = JSON.stringify(rawMapping);
    const normalized = {} as Record<CategoryName, readonly NormalizedRecord[]>;
    const mixedOwnerObjects = new Set<string>();
    for (const category of COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES)
      normalized[category] = normalizeRows(
        category,
        (
          await client.query<CatalogRow>(
            categorySql[category],
            categorySql[category].includes('$1') ? [mappingQueryValue] : undefined,
          )
        ).rows,
        provenanceBase,
        mapping,
        mixedOwnerObjects,
      );
    const anomalyRow = (await client.query<Record<string, string>>(anomalySql, [mappingQueryValue]))
      .rows[0];
    if (!anomalyRow) fail('CATALOG_INVALID');
    const anomalies: InventoryAnomaly[] = [];
    if (mixedOwnerObjects.size > 0)
      anomalies.push(anomaly('MIXED_OWNER_FORBIDDEN', mixedOwnerObjects.size, provenanceBase));
    const findings: [string, unknown][] = [
      ['ROLE_CAPABILITY_FORBIDDEN', anomalyRow.dangerous_roles],
      ['ROLE_MEMBERSHIP_FORBIDDEN', anomalyRow.mapped_memberships],
      ['PUBLIC_GRANT_FORBIDDEN', anomalyRow.public_grants],
      ['THIRD_PARTY_GRANT_FORBIDDEN', anomalyRow.third_party_grants],
      ['GRANT_OPTION_FORBIDDEN', anomalyRow.grant_options],
      ['COLUMN_GRANT_FORBIDDEN', anomalyRow.column_grants],
      ['DEFAULT_ACL_CHANGE_FORBIDDEN', anomalyRow.default_acls],
    ];
    for (const [code, value] of findings) {
      const count = parseCount(value);
      if (count > 0) anomalies.push(anomaly(code, count, provenanceBase));
    }
    anomalies.sort((a, b) => compareUtf8Bytes(a.code, b.code));
    const provenance = {
      contractVersion: 'communities-role-split-clone-marker-evidence-v2' as const,
      markerDigest: sha256(marker),
      markerEvidenceDigest: input.expectedMarkerEvidenceSha256,
      requestDigest,
      creationReceiptSha256: evidence.creationReceiptSha256,
      cloneNamePatternValid: true as const,
      cloneOidBound: true as const,
      sourceOidBound: true as const,
      systemIdentifierDigest: sha256(identity.system_identifier),
      pgMajor: 16 as const,
      objectManifestDigest: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
      ledgerDigest: request.sourceLedgerSha256,
      ledgerCount: ledgerRows.length,
      mappingDigest: mapping.mappingDigest,
    };
    const draft = {
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SCHEMA_VERSION,
      canonicalizationVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CANONICALIZATION_VERSION,
      sortVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SORT_VERSION,
      provenance,
      mapping,
      normalized,
      anomalies,
      forbiddenCodeContract: COMMUNITIES_STAGING_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
      manifestSha256: '0'.repeat(64),
      authorizes: {
        roleCreation: false as const,
        roleRepair: false as const,
        roleSplit: false as const,
        aclMutation: false as const,
        schemaMutation: false as const,
        sharedDatabaseMutation: false as const,
        migration: false as const,
        deploy: false as const,
        activation: false as const,
      },
    } satisfies InventoryReport;
    return {
      ...draft,
      manifestSha256: communitiesRoleSplitInputCManifestSha256(draft),
    };
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitInventoryError) throw error;
    fail('EXECUTION_FAILED');
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
  fail('EXECUTION_FAILED');
}

export interface InventoryComparison {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_SCHEMA_VERSION;
  readonly canonicalizationVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CANONICALIZATION_VERSION;
  readonly sortVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SORT_VERSION;
  readonly beforeManifestSha256: string;
  readonly afterManifestSha256: string;
  readonly changedRecordCount: number;
  readonly addedRecordCount: number;
  readonly removedRecordCount: number;
  readonly forbiddenTransitionCodes: readonly string[];
  readonly forbiddenCodeContract: typeof COMMUNITIES_STAGING_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT;
  readonly comparisonSha256: string;
}

function assertReport(value: unknown): asserts value is InventoryReport {
  try {
    assertCommunitiesRoleSplitInputC(value);
  } catch {
    fail('REPORT_INVALID');
  }
}

export function compareCommunitiesStagingRoleSplitInventories(
  before: unknown,
  after: unknown,
): InventoryComparison {
  assertReport(before);
  assertReport(after);
  if (
    before.schemaVersion !== after.schemaVersion ||
    before.canonicalizationVersion !== after.canonicalizationVersion ||
    before.sortVersion !== after.sortVersion ||
    canonicalJson(before.provenance) !== canonicalJson(after.provenance)
  )
    fail('COMPARISON_BINDING_INVALID');
  let changed = 0,
    added = 0,
    removed = 0;
  const changedCategories = new Set<CategoryName>();
  for (const category of COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CATEGORY_NAMES) {
    const left = new Map(
      before.normalized[category].map((record) => [
        `${record.objectKeySha256}|${record.fieldKeySha256}`,
        record,
      ]),
    );
    const right = new Map(
      after.normalized[category].map((record) => [
        `${record.objectKeySha256}|${record.fieldKeySha256}`,
        record,
      ]),
    );
    for (const [key, record] of left) {
      const candidate = right.get(key);
      if (!candidate) {
        removed++;
        changedCategories.add(category);
      } else if (
        record.fieldKind !== candidate.fieldKind ||
        record.valueSha256 !== candidate.valueSha256 ||
        record.provenanceSha256 !== candidate.provenanceSha256
      ) {
        changed++;
        changedCategories.add(category);
      }
    }
    for (const key of right.keys())
      if (!left.has(key)) {
        added++;
        changedCategories.add(category);
      }
  }
  const codes = new Set<string>();
  if (added || removed) codes.add('OUT_OF_MANIFEST_CHANGE_FORBIDDEN');
  for (const category of changedCategories) {
    if (category === 'roles') codes.add('ROLE_CAPABILITY_FORBIDDEN');
    else if (category === 'memberships') codes.add('ROLE_MEMBERSHIP_FORBIDDEN');
    else if (category === 'defaultAcls') codes.add('DEFAULT_ACL_CHANGE_FORBIDDEN');
    else if (category === 'columnAcls') codes.add('COLUMN_GRANT_FORBIDDEN');
    else if (category === 'rlsPolicies') codes.add('RLS_POLICY_CHANGE_FORBIDDEN');
    else if (category === 'extensions') codes.add('EXTENSION_CHANGE_FORBIDDEN');
    else codes.add('OUT_OF_MANIFEST_CHANGE_FORBIDDEN');
  }
  const forbiddenTransitionCodes = [...codes].sort(compareUtf8Bytes);
  const body = {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_SCHEMA_VERSION,
    canonicalizationVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_CANONICALIZATION_VERSION,
    sortVersion: COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SORT_VERSION,
    beforeManifestSha256: before.manifestSha256,
    afterManifestSha256: after.manifestSha256,
    changedRecordCount: changed,
    addedRecordCount: added,
    removedRecordCount: removed,
    forbiddenTransitionCodes,
    forbiddenCodeContract: COMMUNITIES_STAGING_ROLE_SPLIT_FORBIDDEN_CODE_CONTRACT,
  } satisfies Omit<InventoryComparison, 'comparisonSha256'>;
  return { ...body, comparisonSha256: sha256(canonicalJson(body)) };
}

export const COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_SQL = {
  identity: identitySql,
  mapping: mappingSql,
  categories: categorySql,
  anomalies: anomalySql,
} as const;
