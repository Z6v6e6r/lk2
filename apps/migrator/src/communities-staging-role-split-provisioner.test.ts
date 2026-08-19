import {
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  communitiesStagingRoleSplitInventorySha256,
} from '@phub/database';
import type { QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  provisionCommunitiesStagingRoleSplitClone,
  type CommunitiesStagingRoleSplitClientFactory,
} from './communities-staging-role-split-provisioner.js';

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}
const ledger = '0053_profile_visibility_sections.sql|abc';
const inventory = '[]';
const exact = {
  connectionString: 'postgresql://phub_executor@postgres:5432/phub_restore_123_1',
  confirmation: 'PREPARE_COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_V1',
  restoreDatabase: 'phub_restore_123_1',
  sharedDatabase: 'phub_staging',
  expectedSystemIdentifier: '123456',
  manifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  expectedExecutorRoleName: 'phub_executor',
  expectedExecutorRoleOid: '333',
  expectedCloneDatabaseOwner: 'phub_staging',
  expectedSharedDatabaseOwner: 'phub_staging',
  legacyOwnerRoleName: 'phub_staging',
  runtimeRoleName: 'phub_runtime',
  runtimeRoleOid: '111',
  migratorRoleName: 'phub_migrator',
  migratorRoleOid: '222',
  sourceLedgerSha256: communitiesStagingRoleSplitInventorySha256(ledger),
  sourceLedgerCount: '1',
  cloneSourceBindingMarker: 'clone-source-binding-1234',
  expectedInventorySha256: communitiesStagingRoleSplitInventorySha256(inventory),
};
function fake(
  input: {
    database?: boolean;
    role?: boolean;
    ledger?: boolean;
    inventory?: boolean;
    readOnly?: boolean;
    unknown?: boolean;
  } = {},
) {
  const queries: string[] = [];
  const connect = vi.fn(() => Promise.resolve());
  const query = vi.fn(<T extends Record<string, unknown>>(text: string) => {
    queries.push(text);
    if (input.unknown && text === 'begin transaction isolation level repeatable read read only')
      return Promise.reject(new Error('password=leak'));
    if (text.includes('pg_control_system()'))
      return Promise.resolve(
        result([
          {
            database_name: input.database ? 'phub_staging' : 'phub_restore_123_1',
            system_identifier: '123456',
            current_role: 'phub_executor',
            session_role: 'phub_executor',
            transaction_read_only: input.readOnly ? 'off' : 'on',
            current_role_oid: '333',
            clone_owner: 'phub_staging',
            shared_owner: 'phub_staging',
            clone_source_marker: 'clone-source-binding-1234',
          },
        ]) as unknown as QueryResult<T>,
      );
    if (text.includes('from pg_catalog.pg_roles role'))
      return Promise.resolve(
        result([
          { role_name: 'phub_runtime', role_oid: '111', valid: !input.role, memberships: '0' },
          { role_name: 'phub_migrator', role_oid: '222', valid: true, memberships: '0' },
        ]) as unknown as QueryResult<T>,
      );
    if (text.includes('from public.schema_migrations'))
      return Promise.resolve(
        result([
          { ledger: input.ledger ? 'drift' : ledger, count: '1' },
        ]) as unknown as QueryResult<T>,
      );
    if (text.includes('jsonb_agg'))
      return Promise.resolve(
        result([
          {
            inventory: input.inventory ? '[{"acl":"PUBLIC"}]' : inventory,
            legacy_owner_mismatches: '0',
          },
        ]) as unknown as QueryResult<T>,
      );
    return Promise.resolve(result([]) as QueryResult<T>);
  });
  return {
    queries,
    connect,
    client: {
      connect,
      query,
      end: vi.fn(() => Promise.resolve()),
    } as unknown as ReturnType<CommunitiesStagingRoleSplitClientFactory>,
  };
}
describe('Communities staging role split clone provisioner', () => {
  it('is repeatable-read/read-only and unconditionally inventory-gated with no mutation keywords', async () => {
    const target = fake();
    await expect(
      provisionCommunitiesStagingRoleSplitClone(exact, () => target.client),
    ).rejects.toThrow('INVENTORY_REQUIRED');
    expect(target.queries).toContain('begin transaction isolation level repeatable read read only');
    expect(target.queries.join('\n')).not.toMatch(
      /grant\s|alter\s|create\s|drop\s|reassign|insert\s|update\s|delete\s/i,
    );
    expect(target.queries.at(-1)).toBe('rollback');
  });
  it('rejects database, role, ledger, inventory and read-only binding drift before the terminal inventory gate', async () => {
    for (const input of [
      { database: true },
      { role: true },
      { ledger: true },
      { inventory: true },
      { readOnly: true },
    ])
      await expect(
        provisionCommunitiesStagingRoleSplitClone(exact, () => fake(input).client),
      ).rejects.not.toThrow('INVENTORY_REQUIRED');
  });
  it('rejects bad manifest, executor URL and unknown errors with stable redaction', async () => {
    const target = fake();
    await expect(
      provisionCommunitiesStagingRoleSplitClone(
        { ...exact, manifestSha256: '0'.repeat(64) },
        () => target.client,
      ),
    ).rejects.toThrow('MANIFEST_BINDING_INVALID');
    await expect(
      provisionCommunitiesStagingRoleSplitClone(
        { ...exact, connectionString: exact.connectionString.replace('phub_executor', 'other') },
        () => target.client,
      ),
    ).rejects.toThrow('CONNECTION_BOUNDARY_INVALID');
    await expect(
      provisionCommunitiesStagingRoleSplitClone(exact, () => fake({ unknown: true }).client),
    ).rejects.toThrow('COMMUNITIES_STAGING_ROLE_SPLIT_EXECUTION_FAILED');
  });
});
