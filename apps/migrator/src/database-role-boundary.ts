import { Client } from 'pg';

export type DatabaseRoleSnapshot = {
  readonly roleName: string;
  readonly sessionRoleName: string;
  readonly wireRoleName: string;
  readonly roleOverrideActive: boolean;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly canAssumePrivilegedRole: boolean;
  readonly delegableRoles: number;
  readonly canCreateDatabaseObjects: boolean;
  readonly controllableBusinessSchemas: number;
  readonly controllableBusinessRelations: number;
  readonly dangerousBusinessRelationPrivileges: number;
  readonly writablePrimary: boolean;
  readonly requiredMigratorSchemaPrivileges: boolean;
  readonly ownsMigrationLedger: boolean;
  readonly canReadMigrationLedger: boolean;
  readonly canInsertMigrationLedger: boolean;
  readonly ownsNotificationEndpoints: boolean;
  readonly ownsNotificationTenantRuntimeSettings: boolean;
  readonly canSelectNotificationEndpoints: boolean;
  readonly canSelectIdentityTenants: boolean;
  readonly canReferenceIdentityTenants: boolean;
  readonly canReferenceIdentityUsers: boolean;
  readonly runtimeNotificationDefaultDml: boolean;
  readonly runtimeNotificationDefaultGrantOptions: number;
  readonly unexpectedNotificationDefaultPrivileges: number;
  readonly dangerousNotificationDefaultPrivileges: number;
  readonly publicNotificationDefaultPrivileges: number;
  readonly runtimeMessagingDefaultDml: boolean;
  readonly runtimeMessagingDefaultGrantOptions: number;
  readonly unexpectedMessagingDefaultPrivileges: number;
  readonly dangerousMessagingDefaultPrivileges: number;
  readonly publicMessagingDefaultPrivileges: number;
  readonly nonOwnerGlobalTableDefaultPrivileges: number;
};

export type DatabaseRoleBoundaryPhase = 'pre' | 'post';

export type PostMigrationRuntimeTableSnapshot = {
  readonly schemaName: 'notifications' | 'messaging';
  readonly relationName:
    | 'booking_notification_projection_fences'
    | 'booking_reminder_schedules'
    | 'booking_reminder_recipients'
    | 'user_blocks'
    | 'user_block_commands';
  readonly policyName:
    | 'booking_notification_projection_fences_tenant_isolation'
    | 'booking_reminder_schedules_tenant_isolation'
    | 'booking_reminder_recipients_tenant_isolation'
    | 'messaging_user_blocks_tenant_isolation'
    | 'messaging_user_block_commands_tenant_isolation';
  readonly exists: boolean;
  readonly ownedByMigrator: boolean;
  readonly forceRls: boolean;
  readonly policies: readonly NotificationReminderPolicySnapshot[];
  readonly runtimeDml: boolean;
  readonly runtimeGrantOptions: number;
  readonly dangerousRuntimePrivileges: number;
  readonly unexpectedRuntimePrivileges: number;
  readonly publicPrivileges: number;
  readonly unexpectedGranteePrivileges: number;
};

export type NotificationReminderPolicySnapshot = {
  readonly name: string;
  readonly command: string;
  readonly roles: readonly string[];
  readonly permissive: boolean;
  readonly qual: string | null;
  readonly withCheck: string | null;
};

const canonicalTenantIsolationExpression =
  "(tenant_id=(nullif(current_setting('app.tenant_id'::text,true),''::text))::uuid)";

function normalizePolicyExpression(expression: string | null): string | null {
  return expression?.toLowerCase().replaceAll(/\s+/g, '') ?? null;
}

export function hasExactTenantIsolationPolicy(
  policyName: PostMigrationRuntimeTableSnapshot['policyName'],
  policies: readonly NotificationReminderPolicySnapshot[],
): boolean {
  const policy = policies[0];
  return (
    policies.length === 1 &&
    policy !== undefined &&
    policy.name === policyName &&
    policy.command === '*' &&
    policy.roles.length === 1 &&
    policy.roles[0] === 'PUBLIC' &&
    policy.permissive &&
    normalizePolicyExpression(policy.qual) === canonicalTenantIsolationExpression &&
    normalizePolicyExpression(policy.withCheck) === canonicalTenantIsolationExpression
  );
}

export class DatabaseRoleBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DatabaseRoleBoundaryError';
  }
}

export function assertDatabaseRoleBoundary(
  runtime: DatabaseRoleSnapshot,
  migrator: DatabaseRoleSnapshot,
  runtimeCanAssumeMigrator: boolean,
): void {
  if (
    runtime.databaseName !== migrator.databaseName ||
    runtime.systemIdentifier !== migrator.systemIdentifier
  ) {
    throw new DatabaseRoleBoundaryError('DATABASE_TARGETS_NOT_IDENTICAL');
  }
  if (
    runtime.wireRoleName !== runtime.sessionRoleName ||
    migrator.wireRoleName !== migrator.sessionRoleName
  ) {
    throw new DatabaseRoleBoundaryError('DATABASE_ROLE_WIRE_IDENTITY_MISMATCH');
  }
  if (
    runtime.roleName !== runtime.sessionRoleName ||
    migrator.roleName !== migrator.sessionRoleName ||
    runtime.roleOverrideActive ||
    migrator.roleOverrideActive
  ) {
    throw new DatabaseRoleBoundaryError('DATABASE_ROLE_SESSION_OVERRIDE_FORBIDDEN');
  }
  if (runtime.roleName === migrator.roleName) {
    throw new DatabaseRoleBoundaryError('DATABASE_ROLES_NOT_DISTINCT');
  }
  if (
    runtime.superuser ||
    runtime.bypassRls ||
    runtime.createDatabase ||
    runtime.createRole ||
    runtime.replication ||
    runtime.roleName.startsWith('pg_') ||
    runtime.canAssumePrivilegedRole ||
    runtime.delegableRoles > 0 ||
    runtime.canCreateDatabaseObjects
  ) {
    throw new DatabaseRoleBoundaryError('RUNTIME_DATABASE_ROLE_PRIVILEGED');
  }
  if (
    runtime.controllableBusinessSchemas > 0 ||
    runtime.controllableBusinessRelations > 0 ||
    runtime.dangerousBusinessRelationPrivileges > 0
  ) {
    throw new DatabaseRoleBoundaryError('RUNTIME_DATABASE_ROLE_HAS_DDL_AUTHORITY');
  }
  if (runtimeCanAssumeMigrator) {
    throw new DatabaseRoleBoundaryError('RUNTIME_DATABASE_ROLE_CAN_ASSUME_MIGRATOR');
  }
  if (
    migrator.superuser ||
    migrator.bypassRls ||
    migrator.createDatabase ||
    migrator.createRole ||
    migrator.replication ||
    migrator.roleName.startsWith('pg_') ||
    migrator.canAssumePrivilegedRole ||
    migrator.delegableRoles > 0 ||
    migrator.canCreateDatabaseObjects
  ) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_OVERPRIVILEGED');
  }
  if (
    !migrator.writablePrimary ||
    !migrator.requiredMigratorSchemaPrivileges ||
    !migrator.ownsMigrationLedger ||
    !migrator.canReadMigrationLedger ||
    !migrator.canInsertMigrationLedger ||
    !migrator.ownsNotificationEndpoints ||
    !migrator.ownsNotificationTenantRuntimeSettings ||
    !migrator.canSelectNotificationEndpoints ||
    !migrator.canSelectIdentityTenants ||
    !migrator.canReferenceIdentityTenants ||
    !migrator.canReferenceIdentityUsers
  ) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY');
  }
  if (migrator.nonOwnerGlobalTableDefaultPrivileges > 0) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_UNSAFE_GLOBAL_DEFAULT_ACL');
  }
  if (migrator.publicNotificationDefaultPrivileges > 0) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_PUBLIC_NOTIFICATION_DEFAULT_ACL');
  }
  if (migrator.unexpectedNotificationDefaultPrivileges > 0) {
    throw new DatabaseRoleBoundaryError(
      'MIGRATOR_DATABASE_ROLE_UNEXPECTED_NOTIFICATION_DEFAULT_GRANTEE',
    );
  }
  if (migrator.runtimeNotificationDefaultGrantOptions > 0) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_NOTIFICATION_DEFAULT_GRANT_OPTION');
  }
  if (migrator.dangerousNotificationDefaultPrivileges > 0) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_UNSAFE_NOTIFICATION_DEFAULT_ACL');
  }
  if (!migrator.runtimeNotificationDefaultDml) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_MISSING_NOTIFICATION_DEFAULT_DML');
  }
  if (migrator.publicMessagingDefaultPrivileges > 0) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_PUBLIC_MESSAGING_DEFAULT_ACL');
  }
  if (migrator.unexpectedMessagingDefaultPrivileges > 0) {
    throw new DatabaseRoleBoundaryError(
      'MIGRATOR_DATABASE_ROLE_UNEXPECTED_MESSAGING_DEFAULT_GRANTEE',
    );
  }
  if (migrator.runtimeMessagingDefaultGrantOptions > 0) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_MESSAGING_DEFAULT_GRANT_OPTION');
  }
  if (migrator.dangerousMessagingDefaultPrivileges > 0) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_UNSAFE_MESSAGING_DEFAULT_ACL');
  }
  if (!migrator.runtimeMessagingDefaultDml) {
    throw new DatabaseRoleBoundaryError('MIGRATOR_DATABASE_ROLE_MISSING_MESSAGING_DEFAULT_DML');
  }
}

const expectedPostMigrationTables = [
  {
    schemaName: 'notifications',
    relationName: 'booking_notification_projection_fences',
    policyName: 'booking_notification_projection_fences_tenant_isolation',
  },
  {
    schemaName: 'notifications',
    relationName: 'booking_reminder_schedules',
    policyName: 'booking_reminder_schedules_tenant_isolation',
  },
  {
    schemaName: 'notifications',
    relationName: 'booking_reminder_recipients',
    policyName: 'booking_reminder_recipients_tenant_isolation',
  },
  {
    schemaName: 'messaging',
    relationName: 'user_blocks',
    policyName: 'messaging_user_blocks_tenant_isolation',
  },
  {
    schemaName: 'messaging',
    relationName: 'user_block_commands',
    policyName: 'messaging_user_block_commands_tenant_isolation',
  },
] as const satisfies readonly Pick<
  PostMigrationRuntimeTableSnapshot,
  'schemaName' | 'relationName' | 'policyName'
>[];

export function assertPostMigrationRuntimeBoundary(
  tables: readonly PostMigrationRuntimeTableSnapshot[],
): void {
  for (const expected of expectedPostMigrationTables) {
    const table = tables.find(
      (candidate) =>
        candidate.schemaName === expected.schemaName &&
        candidate.relationName === expected.relationName,
    );
    if (!table?.exists) throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_MISSING');
    if (!table.ownedByMigrator) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_OWNER_INVALID');
    }
    if (!table.forceRls) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_RLS_INVALID');
    }
    if (!hasExactTenantIsolationPolicy(expected.policyName, table.policies)) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_POLICY_INVALID');
    }
    if (!table.runtimeDml) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_DML_MISSING');
    }
    if (table.runtimeGrantOptions > 0) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_GRANT_OPTION_UNSAFE');
    }
    if (table.dangerousRuntimePrivileges > 0 || table.unexpectedRuntimePrivileges > 0) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_PRIVILEGE_UNSAFE');
    }
    if (table.publicPrivileges > 0) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_PUBLIC_ACL');
    }
    if (table.unexpectedGranteePrivileges > 0) {
      throw new DatabaseRoleBoundaryError('POST_MIGRATION_RUNTIME_TABLE_UNEXPECTED_GRANTEE');
    }
  }
}

async function withClient<T>(connectionString: string, operation: (client: Client) => Promise<T>) {
  const client = new Client({
    connectionString,
    application_name: 'phub-migrator-role-boundary',
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  try {
    await client.query(`select pg_catalog.set_config('search_path', 'pg_catalog', false)`);
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function inspectDatabaseRole(
  connectionString: string,
  runtimeRoleName?: string,
): Promise<DatabaseRoleSnapshot> {
  return withClient(connectionString, async (client) => {
    const result = await client.query<{
      role_name: string;
      session_role_name: string;
      role_override_active: boolean;
      database_name: string;
      system_identifier: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      can_assume_privileged_role: boolean;
      delegable_roles: string;
      can_create_database_objects: boolean;
      controllable_business_schemas: string;
      controllable_business_relations: string;
      dangerous_business_relation_privileges: string;
      writable_primary: boolean;
      required_migrator_schema_privileges: boolean;
      owns_migration_ledger: boolean;
      can_read_migration_ledger: boolean;
      can_insert_migration_ledger: boolean;
      owns_notification_endpoints: boolean;
      owns_notification_tenant_runtime_settings: boolean;
      can_select_notification_endpoints: boolean;
      can_select_identity_tenants: boolean;
      can_reference_identity_tenants: boolean;
      can_reference_identity_users: boolean;
      runtime_notification_default_dml: boolean;
      runtime_notification_default_grant_options: string;
      unexpected_notification_default_privileges: string;
      dangerous_notification_default_privileges: string;
      public_notification_default_privileges: string;
      runtime_messaging_default_dml: boolean;
      runtime_messaging_default_grant_options: string;
      unexpected_messaging_default_privileges: string;
      dangerous_messaging_default_privileges: string;
      public_messaging_default_privileges: string;
      non_owner_global_table_default_privileges: string;
    }>(
      `
      select current_user as role_name,
             session_user as session_role_name,
             pg_catalog.current_setting('role') <> 'none' as role_override_active,
             pg_catalog.current_database() as database_name,
             (
               select system_identifier::text
                 from pg_catalog.pg_control_system()
             ) as system_identifier,
             roles.rolsuper,
             roles.rolbypassrls,
             roles.rolcreatedb,
             roles.rolcreaterole,
             roles.rolreplication,
             exists (
               select 1
                 from pg_catalog.pg_roles privileged_role
                where privileged_role.oid <> roles.oid
                  and (
                    privileged_role.rolsuper
                    or privileged_role.rolbypassrls
                    or privileged_role.rolcreatedb
                    or privileged_role.rolcreaterole
                    or privileged_role.rolreplication
                    or privileged_role.rolname like 'pg\\_%' escape '\\'
                  )
                  and pg_catalog.pg_has_role(
                    session_user,
                    privileged_role.oid,
                    'MEMBER'
                  )
             ) as can_assume_privileged_role,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_roles delegable_role
                where delegable_role.oid <> roles.oid
                  and pg_catalog.pg_has_role(
                    session_user,
                    delegable_role.oid,
                    'MEMBER WITH ADMIN OPTION'
                  )
             )::text as delegable_roles,
             exists (
               select 1
                 from pg_catalog.pg_roles reachable_role
                where pg_catalog.pg_has_role(
                        session_user,
                        reachable_role.oid,
                        'MEMBER'
                      )
                  and pg_catalog.has_database_privilege(
                    reachable_role.oid,
                    pg_catalog.current_database(),
                    'CREATE'
                  )
             ) as can_create_database_objects,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_namespace namespace
                where namespace.nspname not like 'pg\\_%' escape '\\'
                  and namespace.nspname <> 'information_schema'
                  and exists (
                    select 1
                      from pg_catalog.pg_roles reachable_role
                     where pg_catalog.pg_has_role(
                             session_user,
                             reachable_role.oid,
                             'MEMBER'
                           )
                       and pg_catalog.has_schema_privilege(
                         reachable_role.oid,
                         namespace.oid,
                         'CREATE'
                       )
                  )
             )::text as controllable_business_schemas,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
                  and pg_catalog.pg_has_role(session_user, relation.relowner, 'MEMBER')
                  and namespace.nspname not like 'pg\\_%' escape '\\'
                  and namespace.nspname <> 'information_schema'
             )::text as controllable_business_relations,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where relation.relkind in ('r', 'p', 'v', 'f')
                  and namespace.nspname not like 'pg\\_%' escape '\\'
                  and namespace.nspname <> 'information_schema'
                  and exists (
                    select 1
                      from pg_catalog.pg_roles reachable_role
                     where pg_catalog.pg_has_role(
                             session_user,
                             reachable_role.oid,
                             'MEMBER'
                           )
                       and (
                         (
                           relation.relkind in ('r', 'p', 'f')
                           and pg_catalog.has_table_privilege(
                             reachable_role.oid,
                             relation.oid,
                             'TRUNCATE'
                           )
                         )
                         or (
                           relation.relkind in ('r', 'p', 'v', 'f')
                           and pg_catalog.has_table_privilege(
                             reachable_role.oid,
                             relation.oid,
                             'TRIGGER'
                           )
                         )
                       )
                  )
             )::text as dangerous_business_relation_privileges,
             (
               not pg_catalog.pg_is_in_recovery()
               and pg_catalog.current_setting('transaction_read_only') = 'off'
             ) as writable_primary,
             (
               select pg_catalog.count(*) = 5
                      and pg_catalog.bool_and(
                        pg_catalog.has_schema_privilege(
                          current_user,
                          namespace.oid,
                          'USAGE'
                        )
                        and (
                          namespace.nspname = 'identity'
                          or pg_catalog.has_schema_privilege(
                            current_user,
                            namespace.oid,
                            'CREATE'
                          )
                        )
                      )
                 from pg_catalog.pg_namespace namespace
                where namespace.nspname in (
                  'identity',
                  'public',
                  'integration',
                  'messaging',
                  'notifications'
                )
             ) as required_migrator_schema_privileges,
             coalesce((
               select pg_catalog.pg_has_role(current_user, relation.relowner, 'USAGE')
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'public'
                  and relation.relname = 'schema_migrations'
             ), false) as owns_migration_ledger,
             coalesce((
               select pg_catalog.has_table_privilege(
                        current_user,
                        relation.oid,
                        'SELECT'
                      )
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'public'
                  and relation.relname = 'schema_migrations'
             ), false) as can_read_migration_ledger,
             coalesce((
               select pg_catalog.has_table_privilege(
                        current_user,
                        relation.oid,
                        'INSERT'
                      )
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'public'
                  and relation.relname = 'schema_migrations'
             ), false) as can_insert_migration_ledger,
             coalesce((
               select pg_catalog.pg_has_role(current_user, relation.relowner, 'USAGE')
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'integration'
                  and relation.relname = 'notification_endpoints'
             ), false) as owns_notification_endpoints,
             coalesce((
               select relation.relowner = roles.oid
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'notifications'
                  and relation.relname = 'tenant_runtime_settings'
             ), false) as owns_notification_tenant_runtime_settings,
             coalesce((
               select pg_catalog.has_table_privilege(
                        current_user,
                        relation.oid,
                        'SELECT'
                      )
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'integration'
                  and relation.relname = 'notification_endpoints'
             ), false) as can_select_notification_endpoints,
             coalesce((
               select pg_catalog.has_table_privilege(
                        current_user,
                        relation.oid,
                        'SELECT'
                      )
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'identity'
                  and relation.relname = 'tenants'
             ), false) as can_select_identity_tenants,
             coalesce((
               select pg_catalog.has_table_privilege(
                        current_user,
                        relation.oid,
                        'REFERENCES'
                      )
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'identity'
                  and relation.relname = 'tenants'
             ), false) as can_reference_identity_tenants,
             coalesce((
               select pg_catalog.has_table_privilege(
                        current_user,
                        relation.oid,
                        'REFERENCES'
                      )
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where namespace.nspname = 'identity'
                  and relation.relname = 'users'
             ), false) as can_reference_identity_users,
             coalesce((
               select pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE')
                 from pg_catalog.pg_namespace namespace
                where namespace.nspname = 'notifications'
             ), false) and coalesce((
               select pg_catalog.count(distinct privilege.privilege_type) = 4
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'notifications')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
                  and privilege.grantee = (
                    select oid from pg_catalog.pg_roles where rolname = $1
                  )
             ), false) as runtime_notification_default_dml,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'notifications')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.is_grantable
                  and privilege.grantee = (
                    select oid from pg_catalog.pg_roles where rolname = $1
                  )
             )::text as runtime_notification_default_grant_options,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'notifications')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.grantee <> 0
                  and privilege.grantee <> defaults.defaclrole
                  and privilege.grantee <> (
                    select oid from pg_catalog.pg_roles where rolname = $1
                  )
             )::text as unexpected_notification_default_privileges,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'notifications')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
                  and (
                    privilege.grantee = 0
                    or privilege.grantee = (
                      select oid from pg_catalog.pg_roles where rolname = $1
                    )
                  )
             )::text as dangerous_notification_default_privileges,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'notifications')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.grantee = 0
             )::text as public_notification_default_privileges,
             coalesce((
               select pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE')
                 from pg_catalog.pg_namespace namespace
                where namespace.nspname = 'messaging'
             ), false) and coalesce((
               select pg_catalog.count(distinct privilege.privilege_type) = 4
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'messaging')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
                  and privilege.grantee = (
                    select oid from pg_catalog.pg_roles where rolname = $1
                  )
             ), false) as runtime_messaging_default_dml,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'messaging')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.is_grantable
                  and privilege.grantee = (
                    select oid from pg_catalog.pg_roles where rolname = $1
                  )
             )::text as runtime_messaging_default_grant_options,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'messaging')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.grantee <> 0
                  and privilege.grantee <> defaults.defaclrole
                  and privilege.grantee <> (
                    select oid from pg_catalog.pg_roles where rolname = $1
                  )
             )::text as unexpected_messaging_default_privileges,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'messaging')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
                  and (
                    privilege.grantee = 0
                    or privilege.grantee = (
                      select oid from pg_catalog.pg_roles where rolname = $1
                    )
                  )
             )::text as dangerous_messaging_default_privileges,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = defaults.defaclnamespace
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where (defaults.defaclnamespace = 0 or namespace.nspname = 'messaging')
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and privilege.grantee = 0
             )::text as public_messaging_default_privileges,
             (
               select pg_catalog.count(*)
                 from pg_catalog.pg_default_acl defaults
                 cross join lateral pg_catalog.aclexplode(defaults.defaclacl) privilege
                where defaults.defaclnamespace = 0
                  and defaults.defaclrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and defaults.defaclobjtype = 'r'
                  and (privilege.grantee = 0 or privilege.grantee <> defaults.defaclrole)
             )::text as non_owner_global_table_default_privileges
        from pg_catalog.pg_roles roles
       where roles.rolname = current_user
    `,
      // Runtime inspection has no separate runtime-role target. NULL keeps the
      // migrator-only ACL predicates non-applicable without resolving an invalid role name.
      [runtimeRoleName ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseRoleBoundaryError('DATABASE_ROLE_NOT_FOUND');
    return {
      roleName: row.role_name,
      sessionRoleName: row.session_role_name,
      wireRoleName: client.user ?? '',
      roleOverrideActive: row.role_override_active,
      databaseName: row.database_name,
      systemIdentifier: row.system_identifier,
      superuser: row.rolsuper,
      bypassRls: row.rolbypassrls,
      createDatabase: row.rolcreatedb,
      createRole: row.rolcreaterole,
      replication: row.rolreplication,
      canAssumePrivilegedRole: row.can_assume_privileged_role,
      delegableRoles: Number(row.delegable_roles),
      canCreateDatabaseObjects: row.can_create_database_objects,
      controllableBusinessSchemas: Number(row.controllable_business_schemas),
      controllableBusinessRelations: Number(row.controllable_business_relations),
      dangerousBusinessRelationPrivileges: Number(row.dangerous_business_relation_privileges),
      writablePrimary: row.writable_primary,
      requiredMigratorSchemaPrivileges: row.required_migrator_schema_privileges,
      ownsMigrationLedger: row.owns_migration_ledger,
      canReadMigrationLedger: row.can_read_migration_ledger,
      canInsertMigrationLedger: row.can_insert_migration_ledger,
      ownsNotificationEndpoints: row.owns_notification_endpoints,
      ownsNotificationTenantRuntimeSettings: row.owns_notification_tenant_runtime_settings,
      canSelectNotificationEndpoints: row.can_select_notification_endpoints,
      canSelectIdentityTenants: row.can_select_identity_tenants,
      canReferenceIdentityTenants: row.can_reference_identity_tenants,
      canReferenceIdentityUsers: row.can_reference_identity_users,
      runtimeNotificationDefaultDml: row.runtime_notification_default_dml,
      runtimeNotificationDefaultGrantOptions: Number(
        row.runtime_notification_default_grant_options,
      ),
      unexpectedNotificationDefaultPrivileges: Number(
        row.unexpected_notification_default_privileges,
      ),
      dangerousNotificationDefaultPrivileges: Number(row.dangerous_notification_default_privileges),
      publicNotificationDefaultPrivileges: Number(row.public_notification_default_privileges),
      runtimeMessagingDefaultDml: row.runtime_messaging_default_dml,
      runtimeMessagingDefaultGrantOptions: Number(row.runtime_messaging_default_grant_options),
      unexpectedMessagingDefaultPrivileges: Number(row.unexpected_messaging_default_privileges),
      dangerousMessagingDefaultPrivileges: Number(row.dangerous_messaging_default_privileges),
      publicMessagingDefaultPrivileges: Number(row.public_messaging_default_privileges),
      nonOwnerGlobalTableDefaultPrivileges: Number(row.non_owner_global_table_default_privileges),
    };
  });
}

async function inspectPostMigrationRuntimeTables(
  migratorConnectionString: string,
  runtimeRoleName: string,
): Promise<readonly PostMigrationRuntimeTableSnapshot[]> {
  return withClient(migratorConnectionString, async (client) => {
    const result = await client.query<{
      schema_name: PostMigrationRuntimeTableSnapshot['schemaName'];
      relation_name: PostMigrationRuntimeTableSnapshot['relationName'];
      policy_name: PostMigrationRuntimeTableSnapshot['policyName'];
      exists: boolean;
      owned_by_migrator: boolean;
      force_rls: boolean;
      policy_inventory: NotificationReminderPolicySnapshot[];
      runtime_dml: boolean;
      runtime_grant_options: string;
      dangerous_runtime_privileges: string;
      unexpected_runtime_privileges: string;
      public_privileges: string;
      unexpected_grantee_privileges: string;
    }>(
      `with expected(schema_name, relation_name, policy_name) as (
         values
           (
             'notifications'::text,
             'booking_notification_projection_fences'::text,
             'booking_notification_projection_fences_tenant_isolation'::text
           ),
           (
             'notifications'::text,
             'booking_reminder_schedules'::text,
             'booking_reminder_schedules_tenant_isolation'::text
           ),
           (
             'notifications'::text,
             'booking_reminder_recipients'::text,
             'booking_reminder_recipients_tenant_isolation'::text
           ),
           (
             'messaging'::text,
             'user_blocks'::text,
             'messaging_user_blocks_tenant_isolation'::text
           ),
           (
             'messaging'::text,
             'user_block_commands'::text,
             'messaging_user_block_commands_tenant_isolation'::text
           )
       )
       select expected.schema_name,
              expected.relation_name,
              expected.policy_name,
              relation.oid is not null and namespace.oid is not null as exists,
              coalesce(
                relation.relowner = (select oid from pg_catalog.pg_roles where rolname = current_user),
                false
              )
                as owned_by_migrator,
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
              coalesce(
                pg_catalog.has_schema_privilege($1, namespace.oid, 'USAGE')
                and (
                  select pg_catalog.count(distinct privilege.privilege_type) = 4
                    from pg_catalog.aclexplode(
                      coalesce(
                        relation.relacl,
                        pg_catalog.acldefault('r', relation.relowner)
                      )
                    ) privilege
                   where privilege.grantee = (
                     select oid from pg_catalog.pg_roles where rolname = $1
                   )
                     and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
                ),
                false
              ) as runtime_dml,
              (
                select pg_catalog.count(*)
                  from pg_catalog.aclexplode(
                    coalesce(
                      relation.relacl,
                      pg_catalog.acldefault('r', relation.relowner)
                    )
                  ) privilege
                 where privilege.grantee = (
                   select oid from pg_catalog.pg_roles where rolname = $1
                 )
                   and privilege.is_grantable
              ) + (
                select pg_catalog.count(*)
                  from pg_catalog.pg_attribute attribute
                  cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
                 where attribute.attrelid = relation.oid
                   and attribute.attnum > 0
                   and not attribute.attisdropped
                   and privilege.grantee = (
                     select oid from pg_catalog.pg_roles where rolname = $1
                   )
                   and privilege.is_grantable
              )::bigint as runtime_grant_options,
              coalesce((
                select pg_catalog.count(*)
                  from unnest(array['TRUNCATE', 'TRIGGER']) privilege_name
                 where pg_catalog.has_table_privilege($1, relation.oid, privilege_name)
              ), 0)::text as dangerous_runtime_privileges,
              (
                select pg_catalog.count(*)
                  from pg_catalog.aclexplode(
                    coalesce(
                      relation.relacl,
                      pg_catalog.acldefault('r', relation.relowner)
                    )
                  ) privilege
                 where privilege.grantee = (
                   select oid from pg_catalog.pg_roles where rolname = $1
                 )
                   and privilege.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
              ) + (
                select pg_catalog.count(*)
                  from pg_catalog.pg_attribute attribute
                  cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
                 where attribute.attrelid = relation.oid
                   and attribute.attnum > 0
                   and not attribute.attisdropped
                   and privilege.grantee = (
                     select oid from pg_catalog.pg_roles where rolname = $1
                   )
              )::bigint as unexpected_runtime_privileges,
              (
                select pg_catalog.count(*)
                  from pg_catalog.aclexplode(
                    coalesce(
                      relation.relacl,
                      pg_catalog.acldefault('r', relation.relowner)
                    )
                  ) privilege
                 where privilege.grantee = 0
              ) + (
                select pg_catalog.count(*)
                  from pg_catalog.pg_attribute attribute
                  cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
                 where attribute.attrelid = relation.oid
                   and attribute.attnum > 0
                   and not attribute.attisdropped
                   and privilege.grantee = 0
              )::bigint as public_privileges,
              (
                select pg_catalog.count(*)
                  from pg_catalog.aclexplode(
                    coalesce(
                      relation.relacl,
                      pg_catalog.acldefault('r', relation.relowner)
                    )
                  ) privilege
                 where privilege.grantee <> relation.relowner
                   and privilege.grantee <> 0
                   and privilege.grantee <> (
                     select oid from pg_catalog.pg_roles where rolname = $1
                   )
              ) + (
                select pg_catalog.count(*)
                  from pg_catalog.pg_attribute attribute
                  cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
                 where attribute.attrelid = relation.oid
                   and attribute.attnum > 0
                   and not attribute.attisdropped
                   and privilege.grantee <> relation.relowner
                   and privilege.grantee <> 0
                   and privilege.grantee <> (
                     select oid from pg_catalog.pg_roles where rolname = $1
                   )
              )::bigint as unexpected_grantee_privileges
         from expected
         left join pg_catalog.pg_namespace namespace
           on namespace.nspname = expected.schema_name
         left join pg_catalog.pg_class relation
           on relation.relnamespace = namespace.oid
          and relation.relname = expected.relation_name
          and relation.relkind in ('r', 'p')
        order by expected.schema_name, expected.relation_name`,
      [runtimeRoleName],
    );
    return result.rows.map((row) => ({
      schemaName: row.schema_name,
      relationName: row.relation_name,
      policyName: row.policy_name,
      exists: row.exists,
      ownedByMigrator: row.owned_by_migrator,
      forceRls: row.force_rls,
      policies: row.policy_inventory,
      runtimeDml: row.runtime_dml,
      runtimeGrantOptions: Number(row.runtime_grant_options),
      dangerousRuntimePrivileges: Number(row.dangerous_runtime_privileges),
      unexpectedRuntimePrivileges: Number(row.unexpected_runtime_privileges),
      publicPrivileges: Number(row.public_privileges),
      unexpectedGranteePrivileges: Number(row.unexpected_grantee_privileges),
    }));
  });
}

export async function verifyDatabaseRoleBoundary(input: {
  readonly runtimeConnectionString: string;
  readonly migratorConnectionString: string;
  readonly phase: DatabaseRoleBoundaryPhase;
}): Promise<void> {
  const runtime = await inspectDatabaseRole(input.runtimeConnectionString);
  const migrator = await inspectDatabaseRole(input.migratorConnectionString, runtime.roleName);
  const runtimeCanAssumeMigrator = await withClient(
    input.runtimeConnectionString,
    async (client) => {
      const result = await client.query<{ can_assume: boolean }>(
        `select pg_catalog.pg_has_role(session_user, $1, 'MEMBER') as can_assume`,
        [migrator.roleName],
      );
      return result.rows[0]?.can_assume ?? true;
    },
  );
  assertDatabaseRoleBoundary(runtime, migrator, runtimeCanAssumeMigrator);
  if (input.phase === 'post') {
    assertPostMigrationRuntimeBoundary(
      await inspectPostMigrationRuntimeTables(input.migratorConnectionString, runtime.roleName),
    );
  }
}
