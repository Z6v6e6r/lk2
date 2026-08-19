import {
  ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_RELATIONS,
  ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES,
  assertEligibilityPaymentAclBoundary,
  type EligibilityPaymentAclRelation,
  type EligibilityPaymentPolicySnapshot,
  type EligibilityPaymentPreexistingRelationSnapshot,
  type EligibilityPaymentRelationAclSnapshot,
  type EligibilityPaymentRoleAclSnapshot,
  type EligibilityPaymentSchemaAclSnapshot,
} from '@phub/database';
import { Client, type QueryResult } from 'pg';

type Queryable = {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
};

type SchemaRow = {
  schema_name: EligibilityPaymentSchemaAclSnapshot['schemaName'];
  exists: boolean;
  owned_by_migrator: boolean;
  runtime_usage: boolean;
  runtime_create: boolean;
  migrator_create: boolean;
  runtime_grant_options: string;
  public_privileges: string;
  unexpected_grantee_privileges: string;
  non_owner_table_default_privileges: string;
};

type RoleRow = {
  migrator_session_identity_exact: boolean;
  runtime_exists: boolean;
  runtime_distinct_from_migrator: boolean;
  runtime_superuser: boolean;
  runtime_bypass_rls: boolean;
  runtime_memberships: string;
  migrator_superuser: boolean;
  migrator_bypass_rls: boolean;
  migrator_memberships: string;
};

type PreexistingRelationRow = {
  schema_name: 'games';
  relation_name: string;
  exists: boolean;
  owned_by_migrator: boolean;
};

type RelationRow = {
  schema_name: EligibilityPaymentRelationAclSnapshot['schemaName'];
  relation_name: string;
  exists: boolean;
  owned_by_migrator: boolean;
  force_rls: boolean;
  policy_inventory: EligibilityPaymentPolicySnapshot[];
  runtime_privileges: string[];
  runtime_grant_options: string;
  public_privileges: string;
  unexpected_grantee_privileges: string;
  column_privileges: string;
};

export async function inspectEligibilityPaymentAclBoundary(
  client: Queryable,
  runtimeRoleName: string,
  phase: 'pre' | 'post',
  expectedRelations: readonly EligibilityPaymentAclRelation[] = ELIGIBILITY_PAYMENT_ACL_RELATIONS,
): Promise<{
  readonly roles: EligibilityPaymentRoleAclSnapshot;
  readonly schemas: readonly EligibilityPaymentSchemaAclSnapshot[];
  readonly preexistingRelations: readonly EligibilityPaymentPreexistingRelationSnapshot[];
  readonly relations?: readonly EligibilityPaymentRelationAclSnapshot[];
}> {
  const roleResult = await client.query<RoleRow>(
    `select session_user = current_user as migrator_session_identity_exact,
            runtime.oid is not null as runtime_exists,
            coalesce(runtime.rolname <> current_user, false) as runtime_distinct_from_migrator,
            coalesce(runtime.rolsuper, true) as runtime_superuser,
            coalesce(runtime.rolbypassrls, true) as runtime_bypass_rls,
            coalesce((
              select pg_catalog.count(*)
                from pg_catalog.pg_auth_members
               where member = runtime.oid or roleid = runtime.oid
            ), 0)::text as runtime_memberships,
            migrator.rolsuper as migrator_superuser,
            migrator.rolbypassrls as migrator_bypass_rls,
            coalesce((
              select pg_catalog.count(*)
                from pg_catalog.pg_auth_members
               where member = migrator.oid or roleid = migrator.oid
            ), 0)::text as migrator_memberships
       from pg_catalog.pg_roles migrator
       left join pg_catalog.pg_roles runtime on runtime.rolname = $1
      where migrator.rolname = current_user`,
    [runtimeRoleName],
  );
  const role = roleResult.rows[0];
  const roles: EligibilityPaymentRoleAclSnapshot = role
    ? {
        migratorSessionIdentityExact: role.migrator_session_identity_exact,
        runtimeExists: role.runtime_exists,
        runtimeDistinctFromMigrator: role.runtime_distinct_from_migrator,
        runtimeSuperuser: role.runtime_superuser,
        runtimeBypassRls: role.runtime_bypass_rls,
        runtimeMemberships: Number(role.runtime_memberships),
        migratorSuperuser: role.migrator_superuser,
        migratorBypassRls: role.migrator_bypass_rls,
        migratorMemberships: Number(role.migrator_memberships),
      }
    : {
        migratorSessionIdentityExact: false,
        runtimeExists: false,
        runtimeDistinctFromMigrator: false,
        runtimeSuperuser: true,
        runtimeBypassRls: true,
        runtimeMemberships: 1,
        migratorSuperuser: true,
        migratorBypassRls: true,
        migratorMemberships: 1,
      };
  const schemaResult = await client.query<SchemaRow>(
    `with expected(schema_name) as (
       select item.value
         from pg_catalog.jsonb_array_elements_text($2::jsonb) as item(value)
     )
     select expected.schema_name,
            namespace.oid is not null as exists,
            coalesce(
              namespace.nspowner = (select oid from pg_catalog.pg_roles where rolname = current_user),
              false
            ) as owned_by_migrator,
            coalesce(pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE'), false)
              as runtime_usage,
            coalesce(pg_catalog.has_schema_privilege($1, namespace.oid, 'CREATE'), false)
              as runtime_create,
            coalesce(pg_catalog.has_schema_privilege(current_user, namespace.oid, 'CREATE'), false)
              as migrator_create,
            coalesce((
              select pg_catalog.count(*)
                from unnest(array['USAGE', 'CREATE']) privilege_name
               where pg_catalog.has_schema_privilege(
                 $1,
                 namespace.oid,
                 privilege_name || ' WITH GRANT OPTION'
               )
            ), 0)::text as runtime_grant_options,
            coalesce((
              select pg_catalog.count(*)
                from pg_catalog.aclexplode(
                  coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
                ) privilege
               where privilege.grantee = 0
            ), 0)::text as public_privileges,
            coalesce((
              select pg_catalog.count(*)
                from pg_catalog.aclexplode(
                  coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
                ) privilege
               where privilege.grantee <> namespace.nspowner
                 and privilege.grantee <> 0
                 and privilege.grantee <> runtime_role.oid
            ), 0)::text as unexpected_grantee_privileges,
            coalesce((
              select pg_catalog.count(*)
                from pg_catalog.pg_default_acl default_acl
                cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) privilege
               where default_acl.defaclrole = runtime_role.migrator_oid
                 and default_acl.defaclobjtype = 'r'
                 and default_acl.defaclnamespace in (0, namespace.oid)
                 and privilege.grantee <> runtime_role.migrator_oid
            ), 0)::text as non_owner_table_default_privileges
       from expected
       cross join lateral (
         select runtime.oid, migrator.oid as migrator_oid
           from pg_catalog.pg_roles runtime
           cross join pg_catalog.pg_roles migrator
          where runtime.rolname = $1 and migrator.rolname = current_user
       ) runtime_role
       left join pg_catalog.pg_namespace namespace on namespace.nspname = expected.schema_name
      order by expected.schema_name`,
    [
      runtimeRoleName,
      JSON.stringify(ELIGIBILITY_PAYMENT_ACL_SCHEMA_PRIVILEGES.map((x) => x.schemaName)),
    ],
  );
  const schemas = schemaResult.rows.map((row) => ({
    schemaName: row.schema_name,
    exists: row.exists,
    ownedByMigrator: row.owned_by_migrator,
    runtimeUsage: row.runtime_usage,
    runtimeCreate: row.runtime_create,
    migratorCreate: row.migrator_create,
    runtimeGrantOptions: Number(row.runtime_grant_options),
    publicPrivileges: Number(row.public_privileges),
    unexpectedGranteePrivileges: Number(row.unexpected_grantee_privileges),
    nonOwnerTableDefaultPrivileges: Number(row.non_owner_table_default_privileges),
  }));
  const preexistingResult = await client.query<PreexistingRelationRow>(
    `with expected as (
       select schema_name, relation_name
         from pg_catalog.jsonb_to_recordset($1::jsonb)
              as item(schema_name text, relation_name text)
     )
     select expected.schema_name,
            expected.relation_name,
            relation.oid is not null as exists,
            coalesce(
              relation.relowner = (select oid from pg_catalog.pg_roles where rolname = current_user),
              false
            ) as owned_by_migrator
       from expected
       left join pg_catalog.pg_namespace namespace on namespace.nspname = expected.schema_name
       left join pg_catalog.pg_class relation
         on relation.relnamespace = namespace.oid
        and relation.relname = expected.relation_name
        and relation.relkind in ('r', 'p')
      order by expected.schema_name, expected.relation_name`,
    [JSON.stringify(ELIGIBILITY_PAYMENT_ACL_PREEXISTING_RELATIONS)],
  );
  const preexistingRelations = preexistingResult.rows.map((row) => ({
    schemaName: row.schema_name,
    relationName: row.relation_name,
    exists: row.exists,
    ownedByMigrator: row.owned_by_migrator,
  }));
  if (phase === 'pre') return { roles, schemas, preexistingRelations };

  const relationResult = await client.query<RelationRow>(
    `with expected as (
       select schema_name, relation_name
         from pg_catalog.jsonb_to_recordset($2::jsonb)
              as item(schema_name text, relation_name text)
     )
     select expected.schema_name,
            expected.relation_name,
            relation.oid is not null as exists,
            coalesce(
              relation.relowner = (select oid from pg_catalog.pg_roles where rolname = current_user),
              false
            ) as owned_by_migrator,
            coalesce(relation.relrowsecurity and relation.relforcerowsecurity, false) as force_rls,
            coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'name', policy.polname,
                  'command', policy.polcmd,
                  'roles', (
                    select pg_catalog.jsonb_agg(
                      case when role_id = 0 then 'PUBLIC' else role.rolname end
                      order by case when role_id = 0 then 'PUBLIC' else role.rolname end
                    )
                      from unnest(policy.polroles) role_id
                      left join pg_catalog.pg_roles role on role.oid = role_id
                  ),
                  'permissive', policy.polpermissive,
                  'qual', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
                  'withCheck', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
                ) order by policy.polname
              )
                from pg_catalog.pg_policy policy
               where policy.polrelid = relation.oid
            ), '[]'::jsonb) as policy_inventory,
            coalesce((
              select pg_catalog.array_agg(privilege_name order by privilege_name)
                from unnest(
                  array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                ) privilege_name
               where pg_catalog.has_table_privilege($1, relation.oid, privilege_name)
            ), array[]::text[]) as runtime_privileges,
            coalesce((
              select pg_catalog.count(*)
                from unnest(
                  array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                ) privilege_name
               where pg_catalog.has_table_privilege(
                 $1,
                 relation.oid,
                 privilege_name || ' WITH GRANT OPTION'
               )
            ), 0)::text as runtime_grant_options,
            coalesce((
              select pg_catalog.count(*)
                from pg_catalog.aclexplode(
                  coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
                ) privilege
               where privilege.grantee = 0
            ), 0) + coalesce((
              select pg_catalog.count(*)
                from pg_catalog.pg_attribute attribute
                cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
               where attribute.attrelid = relation.oid
                 and attribute.attnum > 0 and not attribute.attisdropped
                 and privilege.grantee = 0
            ), 0))::text as public_privileges,
            (coalesce((
              select pg_catalog.count(*)
                from pg_catalog.aclexplode(
                  coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
                ) privilege
               where privilege.grantee <> relation.relowner
                 and privilege.grantee <> 0
                 and privilege.grantee <> runtime_role.oid
            ), 0) + coalesce((
              select pg_catalog.count(*)
                from pg_catalog.pg_attribute attribute
                cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
               where attribute.attrelid = relation.oid
                 and attribute.attnum > 0 and not attribute.attisdropped
                 and privilege.grantee <> relation.relowner
                 and privilege.grantee <> 0
                 and privilege.grantee <> runtime_role.oid
            ), 0))::text as unexpected_grantee_privileges,
            coalesce((
              select pg_catalog.count(*)
                from pg_catalog.pg_attribute attribute
                cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
               where attribute.attrelid = relation.oid
                 and attribute.attnum > 0 and not attribute.attisdropped
            ), 0)::text as column_privileges
       from expected
       cross join lateral (
         select oid from pg_catalog.pg_roles where rolname = $1
       ) runtime_role
       left join pg_catalog.pg_namespace namespace on namespace.nspname = expected.schema_name
       left join pg_catalog.pg_class relation
         on relation.relnamespace = namespace.oid
        and relation.relname = expected.relation_name
        and relation.relkind in ('r', 'p')
      order by expected.schema_name, expected.relation_name`,
    [
      runtimeRoleName,
      JSON.stringify(
        expectedRelations.map((relation) => ({
          schema_name: relation.schemaName,
          relation_name: relation.relationName,
        })),
      ),
    ],
  );
  const relations = relationResult.rows.map((row) => ({
    schemaName: row.schema_name,
    relationName: row.relation_name,
    exists: row.exists,
    ownedByMigrator: row.owned_by_migrator,
    forceRls: row.force_rls,
    policies: row.policy_inventory,
    runtimePrivileges: row.runtime_privileges,
    runtimeGrantOptions: Number(row.runtime_grant_options),
    publicPrivileges: Number(row.public_privileges),
    unexpectedGranteePrivileges: Number(row.unexpected_grantee_privileges),
    columnPrivileges: Number(row.column_privileges),
  }));
  return { roles, schemas, preexistingRelations, relations };
}

export async function verifyEligibilityPaymentAclBoundary(input: {
  readonly migratorConnectionString: string;
  readonly runtimeRoleName: string;
  readonly phase: 'pre' | 'post';
  readonly expectedRelations?: readonly EligibilityPaymentAclRelation[];
}): Promise<void> {
  const client = new Client({
    connectionString: input.migratorConnectionString,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query('begin transaction read only');
    await client.query("set local search_path = 'pg_catalog'");
    await client.query("set local statement_timeout = '30s'");
    const snapshot = await inspectEligibilityPaymentAclBoundary(
      client,
      input.runtimeRoleName,
      input.phase,
      input.expectedRelations,
    );
    assertEligibilityPaymentAclBoundary({
      phase: input.phase,
      ...snapshot,
      ...(input.expectedRelations ? { expectedRelations: input.expectedRelations } : {}),
    });
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
}
