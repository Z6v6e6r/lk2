import {
  assertCommunitiesStagingRoleSplitCloneRequest,
  communitiesStagingRoleSplitInventorySha256,
  COMMUNITIES_STAGING_ROLE_SPLIT_INITIAL_PREEXISTING_RELATIONS,
  failCommunitiesStagingRoleSplit,
  requireCommunitiesStagingRoleSplitInventory,
  type CommunitiesStagingRoleSplitCloneRequest,
} from '@phub/database';
import { Client, type QueryResult } from 'pg';

type ProvisionClient = {
  connect(): Promise<void>;
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
};
export type CommunitiesStagingRoleSplitClientFactory = (
  connectionString: string,
) => ProvisionClient;
export { CommunitiesStagingRoleSplitError } from '@phub/database';

function assertConnection(
  input: CommunitiesStagingRoleSplitCloneRequest,
  connectionString: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    failCommunitiesStagingRoleSplit('CONNECTION_BOUNDARY_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'postgres' ||
    parsed.port !== '5432' ||
    parsed.search ||
    parsed.hash ||
    decodeURIComponent(parsed.pathname) !== `/${input.restoreDatabase}` ||
    decodeURIComponent(parsed.username) !== input.expectedExecutorRoleName
  )
    failCommunitiesStagingRoleSplit('CONNECTION_BOUNDARY_INVALID');
}

export async function provisionCommunitiesStagingRoleSplitClone(
  input: CommunitiesStagingRoleSplitCloneRequest & { readonly connectionString: string },
  createClient: CommunitiesStagingRoleSplitClientFactory = (connectionString) =>
    new Client({
      connectionString,
      application_name: 'phub-communities-staging-role-split-clone-v1',
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    }) as unknown as ProvisionClient,
): Promise<void> {
  assertCommunitiesStagingRoleSplitCloneRequest(input);
  assertConnection(input, input.connectionString);
  const client = createClient(input.connectionString);
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    transactionOpen = true;
    await client.query("set local search_path = 'pg_catalog'");
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '30s'");
    const identity = await client.query<{
      database_name: string;
      system_identifier: string;
      current_role: string;
      session_role: string;
      transaction_read_only: string;
      current_role_oid: string;
      clone_owner: string;
      shared_owner: string;
      clone_source_marker: string | null;
    }>(
      `select pg_catalog.current_database() as database_name, (select system_identifier::text from pg_catalog.pg_control_system()) as system_identifier,
              current_user as current_role, session_user as session_role, current_setting('transaction_read_only') as transaction_read_only,
              (select oid::text from pg_catalog.pg_roles where rolname = current_user) as current_role_oid,
              (select owner.rolname from pg_catalog.pg_database database join pg_catalog.pg_roles owner on owner.oid = database.datdba where database.datname = current_database()) as clone_owner,
              (select owner.rolname from pg_catalog.pg_database database join pg_catalog.pg_roles owner on owner.oid = database.datdba where database.datname = $1) as shared_owner,
              pg_catalog.shobj_description((select oid from pg_catalog.pg_database where datname = current_database()), 'pg_database') as clone_source_marker`,
      [input.sharedDatabase],
    );
    const current = identity.rows[0];
    if (
      !current ||
      current.database_name !== input.restoreDatabase ||
      current.system_identifier !== input.expectedSystemIdentifier ||
      current.current_role !== input.expectedExecutorRoleName ||
      current.session_role !== input.expectedExecutorRoleName ||
      current.current_role_oid !== input.expectedExecutorRoleOid ||
      current.transaction_read_only !== 'on' ||
      current.clone_owner !== input.expectedCloneDatabaseOwner ||
      current.shared_owner !== input.expectedSharedDatabaseOwner ||
      current.clone_source_marker !== input.cloneSourceBindingMarker
    )
      failCommunitiesStagingRoleSplit('DATABASE_BOUNDARY_INVALID');
    await client.query(
      `select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('communities-staging-role-split-clone-v1'), pg_catalog.hashtext($1))`,
      [input.restoreDatabase],
    );
    const roles = await client.query<{
      role_name: string;
      role_oid: string;
      valid: boolean;
      memberships: string;
    }>(
      `select role.rolname as role_name, role.oid::text as role_oid, (role.rolcanlogin and not role.rolsuper and not role.rolbypassrls and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication) as valid,
              (select count(*)::text from pg_catalog.pg_auth_members membership where membership.member = role.oid or membership.roleid = role.oid) as memberships
         from pg_catalog.pg_roles role where role.rolname = any($1::text[])`,
      [[input.runtimeRoleName, input.migratorRoleName]],
    );
    const expectedRoles = new Map([
      [input.runtimeRoleName, input.runtimeRoleOid],
      [input.migratorRoleName, input.migratorRoleOid],
    ]);
    if (
      roles.rows.length !== 2 ||
      roles.rows.some(
        (role) =>
          !role.valid ||
          role.memberships !== '0' ||
          expectedRoles.get(role.role_name) !== role.role_oid,
      )
    )
      failCommunitiesStagingRoleSplit('ROLE_BOUNDARY_INVALID');
    const ledger = await client.query<{ ledger: string; count: string }>(
      `select coalesce(string_agg(filename || '|' || checksum, E'\n' order by filename), '') as ledger, count(*)::text as count from public.schema_migrations`,
    );
    if (
      ledger.rows[0] === undefined ||
      communitiesStagingRoleSplitInventorySha256(ledger.rows[0].ledger) !==
        input.sourceLedgerSha256 ||
      ledger.rows[0].count !== input.sourceLedgerCount
    )
      failCommunitiesStagingRoleSplit('LEDGER_BINDING_INVALID');
    const inventory = await client.query<{
      inventory: string;
      legacy_owner_mismatches: string;
    }>(
      `with relevant_schemas(name) as (
         values ('public'),('profile'),('communities'),('integration'),('messaging'),
                ('notifications'),('games'),('identity'),('community_content'),('eligibility')
       ), expected_relations(relation_name) as (
         select value::text from jsonb_array_elements_text($2::jsonb)
       )
       select jsonb_build_object(
         'database', (select jsonb_build_object('name', database.datname, 'owner', owner.rolname, 'acl', database.datacl)
                        from pg_catalog.pg_database database join pg_catalog.pg_roles owner on owner.oid = database.datdba
                       where database.datname = current_database()),
         'schemas', (select coalesce(jsonb_agg(jsonb_build_object('name', schemas.name, 'exists', namespace.oid is not null, 'owner', owner.rolname, 'acl', namespace.nspacl) order by schemas.name), '[]'::jsonb)
                       from relevant_schemas schemas left join pg_catalog.pg_namespace namespace on namespace.nspname = schemas.name
                       left join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner),
         'default_acls', (select coalesce(jsonb_agg(jsonb_build_object('role', owner.rolname, 'schema', namespace.nspname, 'type', defaults.defaclobjtype, 'acl', defaults.defaclacl) order by owner.rolname, namespace.nspname, defaults.defaclobjtype), '[]'::jsonb)
                            from pg_catalog.pg_default_acl defaults join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
                            left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
                           where defaults.defaclnamespace = 0 or namespace.nspname in (select name from relevant_schemas)),
         'relations', (select coalesce(jsonb_agg(jsonb_build_object('schema', namespace.nspname, 'name', relation.relname, 'kind', relation.relkind, 'owner', owner.rolname, 'acl', relation.relacl, 'rls', relation.relrowsecurity, 'force_rls', relation.relforcerowsecurity) order by namespace.nspname, relation.relname), '[]'::jsonb)
                         from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                         join pg_catalog.pg_roles owner on owner.oid = relation.relowner where namespace.nspname in (select name from relevant_schemas)),
         'column_acls', (select coalesce(jsonb_agg(jsonb_build_object('schema', namespace.nspname, 'relation', relation.relname, 'column', attribute.attname, 'acl', attribute.attacl) order by namespace.nspname, relation.relname, attribute.attnum), '[]'::jsonb)
                           from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
                           join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                          where namespace.nspname in (select name from relevant_schemas) and attribute.attnum > 0 and not attribute.attisdropped and attribute.attacl is not null),
         'policies', (select coalesce(jsonb_agg(jsonb_build_object('schema', policy.schemaname, 'table', policy.tablename, 'name', policy.policyname, 'permissive', policy.permissive, 'roles', policy.roles, 'command', policy.cmd, 'qual', policy.qual, 'check', policy.with_check) order by policy.schemaname, policy.tablename, policy.policyname), '[]'::jsonb)
                        from pg_catalog.pg_policies policy where policy.schemaname in (select name from relevant_schemas)),
         'routines', (select coalesce(jsonb_agg(jsonb_build_object('schema', namespace.nspname, 'name', routine.proname, 'identity_args', pg_catalog.pg_get_function_identity_arguments(routine.oid), 'kind', routine.prokind, 'owner', owner.rolname, 'acl', routine.proacl, 'security_definer', routine.prosecdef, 'config', routine.proconfig) order by namespace.nspname, routine.proname, pg_catalog.pg_get_function_identity_arguments(routine.oid)), '[]'::jsonb)
                         from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
                         join pg_catalog.pg_roles owner on owner.oid = routine.proowner where namespace.nspname in (select name from relevant_schemas)),
         'types', (select coalesce(jsonb_agg(jsonb_build_object('schema', namespace.nspname, 'name', object_type.typname, 'kind', object_type.typtype, 'owner', owner.rolname, 'acl', object_type.typacl) order by namespace.nspname, object_type.typname), '[]'::jsonb)
                      from pg_catalog.pg_type object_type join pg_catalog.pg_namespace namespace on namespace.oid = object_type.typnamespace
                      join pg_catalog.pg_roles owner on owner.oid = object_type.typowner where namespace.nspname in (select name from relevant_schemas)),
         'extensions', (select coalesce(jsonb_agg(jsonb_build_object('name', extension.extname, 'version', extension.extversion, 'schema', namespace.nspname, 'owner', owner.rolname) order by extension.extname), '[]'::jsonb)
                           from pg_catalog.pg_extension extension join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
                           join pg_catalog.pg_roles owner on owner.oid = extension.extowner where extension.extname = 'pg_trgm')
       )::text as inventory,
       (select count(*)::text from expected_relations expected
         left join pg_catalog.pg_namespace namespace on namespace.nspname = split_part(expected.relation_name, '.', 1)
         left join pg_catalog.pg_class relation on relation.relnamespace = namespace.oid and relation.relname = split_part(expected.relation_name, '.', 2)
         left join pg_catalog.pg_roles owner on owner.oid = relation.relowner
        where relation.oid is null or relation.relkind <> 'r' or owner.rolname <> $1) as legacy_owner_mismatches`,
      [
        input.legacyOwnerRoleName,
        JSON.stringify(COMMUNITIES_STAGING_ROLE_SPLIT_INITIAL_PREEXISTING_RELATIONS),
      ],
    );
    if (
      !inventory.rows[0] ||
      inventory.rows[0].legacy_owner_mismatches !== '0' ||
      communitiesStagingRoleSplitInventorySha256(inventory.rows[0].inventory) !==
        input.expectedInventorySha256
    )
      failCommunitiesStagingRoleSplit('INVENTORY_BINDING_INVALID');
    requireCommunitiesStagingRoleSplitInventory();
  } catch (error) {
    if (error instanceof Error && error.name === 'CommunitiesStagingRoleSplitError') throw error;
    failCommunitiesStagingRoleSplit('EXECUTION_FAILED');
  } finally {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
