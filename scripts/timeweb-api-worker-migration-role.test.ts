import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  MIGRATION_ROLE_PROBE_SOURCE,
  validateMigrationRoleReadback,
} from './timeweb-api-worker-migration-role.js';
const target = { systemIdentifier: '123456789', databaseName: 'phub' };
const fixture = () => ({
  schema: 'PHUB_TIMEWEB_MIGRATION_ROLE_READBACK_V1',
  kind: 'migrator',
  wireRoleName: 'phub_migrator',
  currentRoleName: 'phub_migrator',
  sessionRoleName: 'phub_migrator',
  roleOverride: 'none',
  ...target,
  recovery: false,
  readOnly: 'on',
  superuser: false,
  createRole: false,
  createDatabase: false,
  replication: false,
  bypassRls: false,
  uuidExecute: true,
  privilegedMembership: false,
  delegableRoles: 0,
  canCreateDatabaseObjects: true,
  controllableBusinessSchemas: 2,
  controllableBusinessRelations: 1,
  dangerousBusinessRelationPrivileges: 1,
  publicUsage: true,
  publicCreate: true,
  profileUsage: true,
  identityUsage: true,
  profileCreate: true,
  identityCreate: true,
  runtimeRoleName: 'phub_runtime',
  capabilities: {
    plpgsqlUsage: true,
    uuidExecute: true,
    globalNonOwnerTableDefaultGrants: 0,
    ledgerOwner: true,
    ledgerSelect: true,
    ledgerInsert: true,
    tenantsReferences: true,
    usersReferences: true,
    sessionsReferences: true,
    sessionsTrigger: true,
    runtimeProfileUsage: true,
    runtimeIdentityUsage: true,
    runtimeCanAssumeMigrator: false,
  },
  defaultAcls: ['identity', 'profile'].map((schema) => ({
    schema,
    runtimeDmlCount: 4,
    unsafeRuntimeGrants: 0,
    publicGrants: 0,
    unexpectedGrantees: 0,
  })),
});
describe('derived catalog role proof', () => {
  it('requires exact migration privileges and restricted wire/session role identity', () => {
    const value = fixture();
    expect(() =>
      validateMigrationRoleReadback(value, 'migrator', target, 'phub_runtime'),
    ).not.toThrow();
    for (const edit of [
      { superuser: true },
      { delegableRoles: 1 },
      { canCreateDatabaseObjects: false },
      { publicCreate: false },
      { publicUsage: false },
      { uuidExecute: false },
      { bypassRls: true },
      { privilegedMembership: true },
      { roleOverride: 'other' },
      { currentRoleName: 'other' },
      { databaseName: 'other' },
      { systemIdentifier: 'other' },
      { profileCreate: false },
      { capabilities: { ...value.capabilities, plpgsqlUsage: false } },
      { capabilities: { ...value.capabilities, uuidExecute: false } },
      { capabilities: { ...value.capabilities, globalNonOwnerTableDefaultGrants: 1 } },
      { identityCreate: false },
      { capabilities: { ...value.capabilities, sessionsTrigger: false } },
      { capabilities: { ...value.capabilities, sessionsReferences: false } },
      { capabilities: { ...value.capabilities, runtimeCanAssumeMigrator: true } },
    ])
      expect(() =>
        validateMigrationRoleReadback({ ...value, ...edit }, 'migrator', target, 'phub_runtime'),
      ).toThrow();
  });
  it('rejects missing DML, public grants, grant option, unexpected grantees and reordered schemas', () => {
    const value = fixture();
    for (const edit of [
      { runtimeDmlCount: 3 },
      { publicGrants: 1 },
      { unsafeRuntimeGrants: 1 },
      { unexpectedGrantees: 1 },
    ])
      expect(() =>
        validateMigrationRoleReadback(
          { ...value, defaultAcls: [{ ...value.defaultAcls[0], ...edit }, value.defaultAcls[1]] },
          'migrator',
          target,
          'phub_runtime',
        ),
      ).toThrow();
    expect(() =>
      validateMigrationRoleReadback(
        { ...value, defaultAcls: [...value.defaultAcls].reverse() },
        'migrator',
        target,
        'phub_runtime',
      ),
    ).toThrow();
  });
  it('compiles the exact fixed probe and enforces read-only transaction/timeout and redacted error output', () => {
    const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: MIGRATION_ROLE_PROBE_SOURCE,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(MIGRATION_ROLE_PROBE_SOURCE).toContain(
      'begin transaction isolation level repeatable read read only',
    );
    expect(MIGRATION_ROLE_PROBE_SOURCE).toContain("statement_timeout='5s'");
    expect(MIGRATION_ROLE_PROBE_SOURCE).toContain('ROLE_PROOF_UNKNOWN');
    expect(MIGRATION_ROLE_PROBE_SOURCE).not.toContain('console.error');
  });
});

it('rejects runtime business DDL/ownership and predefined role identity', () => {
  const m = fixture();
  const value = {
    ...m,
    kind: 'runtime',
    wireRoleName: 'phub_runtime',
    currentRoleName: 'phub_runtime',
    sessionRoleName: 'phub_runtime',
    canCreateDatabaseObjects: false,
    profileCreate: false,
    identityCreate: false,
    publicCreate: false,
    controllableBusinessSchemas: 0,
    controllableBusinessRelations: 0,
    dangerousBusinessRelationPrivileges: 0,
    runtimeRoleName: null,
    capabilities: null,
    defaultAcls: [],
  };
  expect(() => validateMigrationRoleReadback(value, 'runtime', target)).not.toThrow();
  for (const edit of [
    { canCreateDatabaseObjects: true },
    { controllableBusinessSchemas: 1 },
    { controllableBusinessRelations: 1 },
    { dangerousBusinessRelationPrivileges: 1 },
    { privilegedMembership: true },
    {
      wireRoleName: 'pg_write_all_data',
      currentRoleName: 'pg_write_all_data',
      sessionRoleName: 'pg_write_all_data',
    },
  ])
    expect(() => validateMigrationRoleReadback({ ...value, ...edit }, 'runtime', target)).toThrow();
});
