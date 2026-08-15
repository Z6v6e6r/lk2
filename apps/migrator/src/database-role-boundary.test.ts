import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertDatabaseRoleBoundary,
  hasExactTenantIsolationPolicy,
  assertPreMigrationMediaRuntimeBoundary,
  assertPostMigrationRuntimeBoundary,
  type DatabaseRoleSnapshot,
  type PostMigrationRuntimeTableSnapshot,
} from './database-role-boundary.js';

const runtime: DatabaseRoleSnapshot = {
  roleName: 'runtime',
  sessionRoleName: 'runtime',
  wireRoleName: 'runtime',
  roleOverrideActive: false,
  databaseName: 'padlhub',
  systemIdentifier: '1234567890',
  superuser: false,
  bypassRls: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  canAssumePrivilegedRole: false,
  delegableRoles: 0,
  canCreateDatabaseObjects: false,
  controllableBusinessSchemas: 0,
  controllableBusinessRelations: 0,
  dangerousBusinessRelationPrivileges: 0,
  writablePrimary: true,
  requiredMigratorSchemaPrivileges: false,
  ownsMigrationLedger: false,
  canReadMigrationLedger: false,
  canInsertMigrationLedger: false,
  ownsNotificationEndpoints: false,
  ownsNotificationTenantRuntimeSettings: false,
  canSelectNotificationEndpoints: false,
  canSelectIdentityTenants: false,
  canReferenceIdentityTenants: false,
  canReferenceIdentityUsers: false,
  runtimeNotificationDefaultDml: false,
  runtimeNotificationDefaultGrantOptions: 0,
  unexpectedNotificationDefaultPrivileges: 0,
  dangerousNotificationDefaultPrivileges: 0,
  publicNotificationDefaultPrivileges: 0,
  runtimeMessagingDefaultDml: false,
  runtimeMessagingDefaultGrantOptions: 0,
  unexpectedMessagingDefaultPrivileges: 0,
  dangerousMessagingDefaultPrivileges: 0,
  publicMessagingDefaultPrivileges: 0,
  ownsUserProfilePhotoSync: false,
  ownsCommunityLogoSync: false,
  runtimeIntegrationDefaultDml: false,
  runtimeIntegrationDefaultGrantOptions: 0,
  unexpectedIntegrationDefaultPrivileges: 0,
  dangerousIntegrationDefaultPrivileges: 0,
  publicIntegrationDefaultPrivileges: 0,
  nonOwnerGlobalTableDefaultPrivileges: 0,
};

const migrator: DatabaseRoleSnapshot = {
  roleName: 'migrator',
  sessionRoleName: 'migrator',
  wireRoleName: 'migrator',
  roleOverrideActive: false,
  databaseName: 'padlhub',
  systemIdentifier: '1234567890',
  superuser: false,
  bypassRls: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  canAssumePrivilegedRole: false,
  delegableRoles: 0,
  canCreateDatabaseObjects: false,
  controllableBusinessSchemas: 4,
  controllableBusinessRelations: 4,
  dangerousBusinessRelationPrivileges: 4,
  writablePrimary: true,
  requiredMigratorSchemaPrivileges: true,
  ownsMigrationLedger: true,
  canReadMigrationLedger: true,
  canInsertMigrationLedger: true,
  ownsNotificationEndpoints: true,
  ownsNotificationTenantRuntimeSettings: true,
  canSelectNotificationEndpoints: true,
  canSelectIdentityTenants: true,
  canReferenceIdentityTenants: true,
  canReferenceIdentityUsers: true,
  runtimeNotificationDefaultDml: true,
  runtimeNotificationDefaultGrantOptions: 0,
  unexpectedNotificationDefaultPrivileges: 0,
  dangerousNotificationDefaultPrivileges: 0,
  publicNotificationDefaultPrivileges: 0,
  runtimeMessagingDefaultDml: true,
  runtimeMessagingDefaultGrantOptions: 0,
  unexpectedMessagingDefaultPrivileges: 0,
  dangerousMessagingDefaultPrivileges: 0,
  publicMessagingDefaultPrivileges: 0,
  ownsUserProfilePhotoSync: true,
  ownsCommunityLogoSync: true,
  runtimeIntegrationDefaultDml: true,
  runtimeIntegrationDefaultGrantOptions: 0,
  unexpectedIntegrationDefaultPrivileges: 0,
  dangerousIntegrationDefaultPrivileges: 0,
  publicIntegrationDefaultPrivileges: 0,
  nonOwnerGlobalTableDefaultPrivileges: 0,
};

const reminderSchedule: PostMigrationRuntimeTableSnapshot = {
  schemaName: 'notifications',
  relationName: 'booking_reminder_schedules',
  policyName: 'booking_reminder_schedules_tenant_isolation',
  requiresTenantRls: true,
  exists: true,
  ownedByMigrator: true,
  forceRls: true,
  policies: [
    {
      name: 'booking_reminder_schedules_tenant_isolation',
      command: '*',
      roles: ['PUBLIC'],
      permissive: true,
      qual: "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
      withCheck:
        "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
    },
  ],
  runtimeDml: true,
  runtimeGrantOptions: 0,
  dangerousRuntimePrivileges: 0,
  unexpectedRuntimePrivileges: 0,
  publicPrivileges: 0,
  unexpectedGranteePrivileges: 0,
};

const reminderRecipients: PostMigrationRuntimeTableSnapshot = {
  schemaName: 'notifications',
  relationName: 'booking_reminder_recipients',
  policyName: 'booking_reminder_recipients_tenant_isolation',
  requiresTenantRls: true,
  exists: true,
  ownedByMigrator: true,
  forceRls: true,
  policies: [
    {
      name: 'booking_reminder_recipients_tenant_isolation',
      command: '*',
      roles: ['PUBLIC'],
      permissive: true,
      qual: "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
      withCheck:
        "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
    },
  ],
  runtimeDml: true,
  runtimeGrantOptions: 0,
  dangerousRuntimePrivileges: 0,
  unexpectedRuntimePrivileges: 0,
  publicPrivileges: 0,
  unexpectedGranteePrivileges: 0,
};

const projectionFence: PostMigrationRuntimeTableSnapshot = {
  ...reminderSchedule,
  relationName: 'booking_notification_projection_fences',
  policyName: 'booking_notification_projection_fences_tenant_isolation',
  policies: [
    {
      ...reminderSchedule.policies[0]!,
      name: 'booking_notification_projection_fences_tenant_isolation',
    },
  ],
};

const userBlocks: PostMigrationRuntimeTableSnapshot = {
  ...reminderSchedule,
  schemaName: 'messaging',
  relationName: 'user_blocks',
  policyName: 'messaging_user_blocks_tenant_isolation',
  policies: [
    {
      ...reminderSchedule.policies[0]!,
      name: 'messaging_user_blocks_tenant_isolation',
    },
  ],
};

const userBlockCommands: PostMigrationRuntimeTableSnapshot = {
  ...userBlocks,
  relationName: 'user_block_commands',
  policyName: 'messaging_user_block_commands_tenant_isolation',
  policies: [
    {
      ...userBlocks.policies[0]!,
      name: 'messaging_user_block_commands_tenant_isolation',
    },
  ],
};

const runtimeTables: readonly PostMigrationRuntimeTableSnapshot[] = [
  projectionFence,
  reminderSchedule,
  reminderRecipients,
  userBlocks,
  userBlockCommands,
];

function mediaTenantTable(
  relationName: PostMigrationRuntimeTableSnapshot['relationName'],
  policyName: Exclude<PostMigrationRuntimeTableSnapshot['policyName'], null>,
): PostMigrationRuntimeTableSnapshot {
  return {
    ...reminderSchedule,
    schemaName: 'integration',
    relationName,
    policyName,
    policies: [{ ...reminderSchedule.policies[0]!, name: policyName }],
  };
}

const mediaRuntimeTables: readonly PostMigrationRuntimeTableSnapshot[] = [
  ...runtimeTables,
  mediaTenantTable('user_profile_photo_sync', 'user_profile_photo_sync_tenant_isolation'),
  mediaTenantTable('community_logo_sync', 'community_logo_sync_tenant_isolation'),
  mediaTenantTable(
    'profile_photo_client_commands',
    'profile_photo_client_commands_tenant_isolation',
  ),
  mediaTenantTable(
    'profile_photo_observation_watermarks',
    'profile_photo_observation_watermarks_tenant_isolation',
  ),
  mediaTenantTable(
    'community_logo_observation_watermarks',
    'community_logo_observation_watermarks_tenant_isolation',
  ),
  {
    ...reminderSchedule,
    schemaName: 'integration',
    relationName: 'media_cutover_state',
    policyName: null,
    requiresTenantRls: false,
    forceRls: false,
    policies: [],
  },
];

describe('database role boundary', () => {
  it('accepts distinct least-privilege runtime and bounded DDL roles', () => {
    expect(() => assertDatabaseRoleBoundary(runtime, migrator, false)).not.toThrow();
  });

  it('accepts the extra bounded media ownership and integration default ACL only in media scope', () => {
    expect(() => assertDatabaseRoleBoundary(runtime, migrator, false, 'media')).not.toThrow();
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, ownsUserProfilePhotoSync: false },
        false,
        'core',
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_MEDIA_DDL_AUTHORITY',
      { ...migrator, ownsCommunityLogoSync: false },
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_INTEGRATION_DEFAULT_DML',
      { ...migrator, runtimeIntegrationDefaultDml: false },
    ],
    [
      'MIGRATOR_DATABASE_ROLE_INTEGRATION_DEFAULT_GRANT_OPTION',
      { ...migrator, runtimeIntegrationDefaultGrantOptions: 1 },
    ],
    [
      'MIGRATOR_DATABASE_ROLE_UNEXPECTED_INTEGRATION_DEFAULT_GRANTEE',
      { ...migrator, unexpectedIntegrationDefaultPrivileges: 1 },
    ],
    [
      'MIGRATOR_DATABASE_ROLE_UNSAFE_INTEGRATION_DEFAULT_ACL',
      { ...migrator, dangerousIntegrationDefaultPrivileges: 1 },
    ],
    [
      'MIGRATOR_DATABASE_ROLE_PUBLIC_INTEGRATION_DEFAULT_ACL',
      { ...migrator, publicIntegrationDefaultPrivileges: 1 },
    ],
  ] as const)('rejects %s in media scope', (code, mediaMigrator) => {
    expect(() => assertDatabaseRoleBoundary(runtime, mediaMigrator, false, 'media')).toThrow(code);
  });

  it('rejects a broad notification default ACL that includes TRUNCATE or TRIGGER', () => {
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, dangerousNotificationDefaultPrivileges: 2 },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_UNSAFE_NOTIFICATION_DEFAULT_ACL');
  });

  it('rejects every PUBLIC notifications default table grant', () => {
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, publicNotificationDefaultPrivileges: 1 },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_PUBLIC_NOTIFICATION_DEFAULT_ACL');
  });

  it('rejects runtime grant options and unexpected default ACL grantees before DDL', () => {
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, runtimeNotificationDefaultGrantOptions: 1 },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_NOTIFICATION_DEFAULT_GRANT_OPTION');
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, unexpectedMessagingDefaultPrivileges: 1 },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_UNEXPECTED_MESSAGING_DEFAULT_GRANTEE');
  });

  it('rejects roles that can delegate membership through ADMIN OPTION', () => {
    expect(() =>
      assertDatabaseRoleBoundary(runtime, { ...migrator, delegableRoles: 1 }, false),
    ).toThrow('MIGRATOR_DATABASE_ROLE_OVERPRIVILEGED');
    expect(() =>
      assertDatabaseRoleBoundary({ ...runtime, delegableRoles: 1 }, migrator, false),
    ).toThrow('RUNTIME_DATABASE_ROLE_PRIVILEGED');
  });

  it('requires direct grants to the exact runtime role for default and actual DML', () => {
    const source = readFileSync(new URL('./database-role-boundary.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /privilege\.grantee = \(\s*select oid from pg_catalog\.pg_roles where rolname = \$1\s*\)\s*\), false\) as runtime_notification_default_dml/,
    );
    expect(source).toMatch(
      /privilege\.grantee = \(\s*select oid from pg_catalog\.pg_roles where rolname = \$1\s*\)\s*\), false\) as runtime_messaging_default_dml/,
    );
    expect(source).toMatch(
      /privilege\.grantee = \(\s*select oid from pg_catalog\.pg_roles where rolname = \$1\s*\)\s*\), false\) as runtime_integration_default_dml/,
    );
    expect(source).not.toContain("pg_has_role($1, privilege.grantee, 'USAGE')");
  });

  it('does not resolve an absent runtime ACL target as an empty PostgreSQL role name', () => {
    const source = readFileSync(new URL('./database-role-boundary.ts', import.meta.url), 'utf8');
    expect(source).toContain('[runtimeRoleName ?? null]');
    expect(source).not.toContain("[runtimeRoleName ?? '']");
  });

  it('rejects missing or dangerous messaging default table grants', () => {
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, runtimeMessagingDefaultDml: false },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_MISSING_MESSAGING_DEFAULT_DML');
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, dangerousMessagingDefaultPrivileges: 1 },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_UNSAFE_MESSAGING_DEFAULT_ACL');
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, publicMessagingDefaultPrivileges: 1 },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_PUBLIC_MESSAGING_DEFAULT_ACL');
  });

  it('rejects non-owner global table default grants before migration', () => {
    expect(() =>
      assertDatabaseRoleBoundary(
        runtime,
        { ...migrator, nonOwnerGlobalTableDefaultPrivileges: 1 },
        false,
      ),
    ).toThrow('MIGRATOR_DATABASE_ROLE_UNSAFE_GLOBAL_DEFAULT_ACL');
  });

  it.each([
    [
      'DATABASE_TARGETS_NOT_IDENTICAL',
      runtime,
      { ...migrator, systemIdentifier: 'different-cluster' },
      false,
    ],
    [
      'DATABASE_ROLE_WIRE_IDENTITY_MISMATCH',
      { ...runtime, wireRoleName: 'superuser_login' },
      migrator,
      false,
    ],
    [
      'DATABASE_ROLE_SESSION_OVERRIDE_FORBIDDEN',
      { ...runtime, sessionRoleName: 'migrator', wireRoleName: 'migrator' },
      migrator,
      false,
    ],
    [
      'DATABASE_ROLE_SESSION_OVERRIDE_FORBIDDEN',
      { ...runtime, roleOverrideActive: true },
      migrator,
      false,
    ],
    [
      'DATABASE_ROLES_NOT_DISTINCT',
      runtime,
      {
        ...migrator,
        roleName: runtime.roleName,
        sessionRoleName: runtime.sessionRoleName,
        wireRoleName: runtime.wireRoleName,
      },
      false,
    ],
    ['RUNTIME_DATABASE_ROLE_PRIVILEGED', { ...runtime, bypassRls: true }, migrator, false],
    [
      'RUNTIME_DATABASE_ROLE_PRIVILEGED',
      { ...runtime, canAssumePrivilegedRole: true },
      migrator,
      false,
    ],
    ['RUNTIME_DATABASE_ROLE_PRIVILEGED', { ...runtime, replication: true }, migrator, false],
    ['RUNTIME_DATABASE_ROLE_PRIVILEGED', { ...runtime, delegableRoles: 1 }, migrator, false],
    [
      'RUNTIME_DATABASE_ROLE_PRIVILEGED',
      { ...runtime, canCreateDatabaseObjects: true },
      migrator,
      false,
    ],
    [
      'RUNTIME_DATABASE_ROLE_PRIVILEGED',
      {
        ...runtime,
        roleName: 'pg_read_server_files',
        sessionRoleName: 'pg_read_server_files',
        wireRoleName: 'pg_read_server_files',
      },
      migrator,
      false,
    ],
    [
      'RUNTIME_DATABASE_ROLE_HAS_DDL_AUTHORITY',
      { ...runtime, controllableBusinessSchemas: 1 },
      migrator,
      false,
    ],
    [
      'RUNTIME_DATABASE_ROLE_HAS_DDL_AUTHORITY',
      { ...runtime, controllableBusinessRelations: 1 },
      migrator,
      false,
    ],
    [
      'RUNTIME_DATABASE_ROLE_HAS_DDL_AUTHORITY',
      { ...runtime, dangerousBusinessRelationPrivileges: 1 },
      migrator,
      false,
    ],
    ['RUNTIME_DATABASE_ROLE_CAN_ASSUME_MIGRATOR', runtime, migrator, true],
    ['MIGRATOR_DATABASE_ROLE_OVERPRIVILEGED', runtime, { ...migrator, superuser: true }, false],
    ['MIGRATOR_DATABASE_ROLE_OVERPRIVILEGED', runtime, { ...migrator, replication: true }, false],
    ['MIGRATOR_DATABASE_ROLE_OVERPRIVILEGED', runtime, { ...migrator, delegableRoles: 1 }, false],
    [
      'MIGRATOR_DATABASE_ROLE_OVERPRIVILEGED',
      runtime,
      { ...migrator, canCreateDatabaseObjects: true },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_OVERPRIVILEGED',
      runtime,
      {
        ...migrator,
        roleName: 'pg_write_server_files',
        sessionRoleName: 'pg_write_server_files',
        wireRoleName: 'pg_write_server_files',
      },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, ownsNotificationEndpoints: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, ownsNotificationTenantRuntimeSettings: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, canReadMigrationLedger: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_UNSAFE_NOTIFICATION_DEFAULT_ACL',
      runtime,
      { ...migrator, dangerousNotificationDefaultPrivileges: 2 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_NOTIFICATION_DEFAULT_DML',
      runtime,
      { ...migrator, runtimeNotificationDefaultDml: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_PUBLIC_NOTIFICATION_DEFAULT_ACL',
      runtime,
      { ...migrator, publicNotificationDefaultPrivileges: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_NOTIFICATION_DEFAULT_GRANT_OPTION',
      runtime,
      { ...migrator, runtimeNotificationDefaultGrantOptions: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_UNEXPECTED_NOTIFICATION_DEFAULT_GRANTEE',
      runtime,
      { ...migrator, unexpectedNotificationDefaultPrivileges: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_UNSAFE_MESSAGING_DEFAULT_ACL',
      runtime,
      { ...migrator, dangerousMessagingDefaultPrivileges: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_MESSAGING_DEFAULT_DML',
      runtime,
      { ...migrator, runtimeMessagingDefaultDml: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_PUBLIC_MESSAGING_DEFAULT_ACL',
      runtime,
      { ...migrator, publicMessagingDefaultPrivileges: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MESSAGING_DEFAULT_GRANT_OPTION',
      runtime,
      { ...migrator, runtimeMessagingDefaultGrantOptions: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_UNEXPECTED_MESSAGING_DEFAULT_GRANTEE',
      runtime,
      { ...migrator, unexpectedMessagingDefaultPrivileges: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_UNSAFE_GLOBAL_DEFAULT_ACL',
      runtime,
      { ...migrator, nonOwnerGlobalTableDefaultPrivileges: 1 },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, canInsertMigrationLedger: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, canSelectNotificationEndpoints: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, requiredMigratorSchemaPrivileges: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, canSelectIdentityTenants: false },
      false,
    ],
    [
      'MIGRATOR_DATABASE_ROLE_MISSING_DDL_AUTHORITY',
      runtime,
      { ...migrator, writablePrimary: false },
      false,
    ],
  ] as const)('rejects %s', (code, runtimeRole, migratorRole, canAssume) => {
    expect(() => assertDatabaseRoleBoundary(runtimeRole, migratorRole, canAssume)).toThrow(code);
  });

  it('accepts the complete post-migration runtime table boundary', () => {
    expect(() => assertPostMigrationRuntimeBoundary(runtimeTables)).not.toThrow();
  });

  it('accepts exact media ownership, runtime DML and tenant policies in media scope', () => {
    expect(() => assertPostMigrationRuntimeBoundary(mediaRuntimeTables, 'media')).not.toThrow();
    expect(() => assertPreMigrationMediaRuntimeBoundary(mediaRuntimeTables)).not.toThrow();
  });

  it('rejects missing runtime DML on an altered media mapping before migration', () => {
    expect(() =>
      assertPreMigrationMediaRuntimeBoundary(
        mediaRuntimeTables.map((table) =>
          table.relationName === 'community_logo_sync' ? { ...table, runtimeDml: false } : table,
        ),
      ),
    ).toThrow('POST_MIGRATION_RUNTIME_TABLE_DML_MISSING');
  });

  it('rejects a missing media runtime grant and a policy on the global cutover table', () => {
    expect(() =>
      assertPostMigrationRuntimeBoundary(
        mediaRuntimeTables.map((table) =>
          table.relationName === 'profile_photo_observation_watermarks'
            ? { ...table, runtimeDml: false }
            : table,
        ),
        'media',
      ),
    ).toThrow('POST_MIGRATION_RUNTIME_TABLE_DML_MISSING');
    expect(() =>
      assertPostMigrationRuntimeBoundary(
        mediaRuntimeTables.map((table) =>
          table.relationName === 'media_cutover_state'
            ? { ...table, policies: [reminderSchedule.policies[0]!] }
            : table,
        ),
        'media',
      ),
    ).toThrow('POST_MIGRATION_RUNTIME_TABLE_POLICY_INVALID');
  });

  it.each([
    ['a wrong policy name', { ...reminderSchedule.policies[0]!, name: 'other_tenant_isolation' }],
    [
      'an OR true variant',
      {
        ...reminderSchedule.policies[0]!,
        qual: "(tenant_id = current_setting('app.tenant_id', true)::uuid OR true)",
      },
    ],
    [
      'a non-equality variant',
      {
        ...reminderSchedule.policies[0]!,
        qual: "(tenant_id <> (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
      },
    ],
    ['a wrong command', { ...reminderSchedule.policies[0]!, command: 'r' }],
    ['a non-PUBLIC role', { ...reminderSchedule.policies[0]!, roles: ['runtime'] }],
    ['a restrictive policy', { ...reminderSchedule.policies[0]!, permissive: false }],
    [
      'a different with check expression',
      { ...reminderSchedule.policies[0]!, withCheck: '(tenant_id = tenant_id)' },
    ],
  ] as const)('rejects %s', (_description, policy) => {
    expect(
      hasExactTenantIsolationPolicy('booking_reminder_schedules_tenant_isolation', [policy]),
    ).toBe(false);
  });

  it('rejects an extra policy even when the canonical policy is present', () => {
    expect(
      hasExactTenantIsolationPolicy('booking_reminder_schedules_tenant_isolation', [
        reminderSchedule.policies[0]!,
        { ...reminderSchedule.policies[0]!, name: 'booking_reminder_schedules_extra' },
      ]),
    ).toBe(false);
  });

  it.each([
    [
      'POST_MIGRATION_RUNTIME_TABLE_MISSING',
      runtimeTables.map((table) =>
        table.relationName === 'booking_reminder_schedules' ? { ...table, exists: false } : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_OWNER_INVALID',
      runtimeTables.map((table) =>
        table.relationName === 'user_blocks' ? { ...table, ownedByMigrator: false } : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_RLS_INVALID',
      runtimeTables.map((table) =>
        table.relationName === 'booking_notification_projection_fences'
          ? { ...table, forceRls: false }
          : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_POLICY_INVALID',
      runtimeTables.map((table) =>
        table.relationName === 'user_block_commands' ? { ...table, policies: [] } : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_DML_MISSING',
      runtimeTables.map((table) =>
        table.relationName === 'booking_reminder_recipients'
          ? { ...table, runtimeDml: false }
          : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_PRIVILEGE_UNSAFE',
      runtimeTables.map((table) =>
        table.relationName === 'user_blocks' ? { ...table, dangerousRuntimePrivileges: 1 } : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_PRIVILEGE_UNSAFE',
      runtimeTables.map((table) =>
        table.relationName === 'booking_reminder_schedules'
          ? { ...table, unexpectedRuntimePrivileges: 1 }
          : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_PUBLIC_ACL',
      runtimeTables.map((table) =>
        table.relationName === 'booking_reminder_schedules'
          ? { ...table, publicPrivileges: 1 }
          : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_GRANT_OPTION_UNSAFE',
      runtimeTables.map((table) =>
        table.relationName === 'user_block_commands' ? { ...table, runtimeGrantOptions: 1 } : table,
      ),
    ],
    [
      'POST_MIGRATION_RUNTIME_TABLE_UNEXPECTED_GRANTEE',
      runtimeTables.map((table) =>
        table.relationName === 'booking_reminder_recipients'
          ? { ...table, unexpectedGranteePrivileges: 1 }
          : table,
      ),
    ],
  ] as const)('rejects %s after the migration', (code, tables) => {
    expect(() => assertPostMigrationRuntimeBoundary(tables)).toThrow(code);
  });
});
