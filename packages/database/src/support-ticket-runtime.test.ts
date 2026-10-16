import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  assertSupportDatabaseConnection,
  openSupportTicketRuntimePool,
} from './support-ticket-runtime.js';
import {
  supportAclFixture,
  supportCatalogClientFixture,
} from './support-ticket-activation.fixture.js';
const main = 'postgres://legacy:synthetic@localhost:5432/phub';
const support = 'postgres://support_runtime:synthetic@localhost:5432/phub';
function poolFixture(options: Parameters<typeof supportCatalogClientFixture>[0] = {}) {
  const client = supportCatalogClientFixture(options);
  const pool = {
    on: vi.fn(),
    connect: vi.fn(() => Promise.resolve(client)),
    end: vi.fn(() => Promise.resolve()),
  };
  return {
    pool: pool as unknown as Pool,
    client,
    create: vi.fn(() => pool as unknown as Pool),
    end: pool.end,
  };
}
describe('isolated support runtime connection', () => {
  it('does not parse main, create a pool or touch the database when absent', async () => {
    const create = vi.fn();
    expect(await openSupportTicketRuntimePool('unused', undefined, create)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });
  it('requires the same database target and a distinct decoded principal', () => {
    expect(assertSupportDatabaseConnection(main, support)).toEqual({
      runtimeRoleName: 'support_runtime',
      databaseName: 'phub',
    });
    for (const value of [
      main,
      'postgres://%6cegacy:synthetic@localhost:5432/phub',
      support.replace('/phub', '/other'),
      support + '?options=role',
      support + '#fragment',
      support.replace('localhost', 'other'),
      support.replace(':synthetic@', '@'),
    ])
      expect(() => assertSupportDatabaseConnection(main, value)).toThrow();
  });
  it('opens only the support URL, verifies catalog boundaries read-only, and returns the separate pool', async () => {
    const f = poolFixture();
    expect(await openSupportTicketRuntimePool(main, support, f.create)).toBe(f.pool);
    expect(f.create).toHaveBeenCalledWith(support);
    const statements = f.client.query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toContain('read only');
    expect(statements.at(-1)).toBe('commit');
    expect(f.end).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it.each([
    { membershipCount: 1 },
    { ownerMemberships: 1 },
    { ownerUnsafe: true },
    { owner: 'unapproved_owner' },
    { roleName: 'legacy' },
    { sessionRole: 'legacy' },
    { databaseName: 'other' },
    { recovery: true },
  ])('rejects changed identity/owner/membership, rolls back and closes: %j', async (identity) => {
    const f = poolFixture({ identity });
    await expect(openSupportTicketRuntimePool(main, support, f.create)).rejects.toThrow(
      'SUPPORT_RUNTIME_BOUNDARY_INVALID',
    );
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.client.query).toHaveBeenLastCalledWith('rollback');
  });
  it('rejects bypassRLS, an extra identity UPDATE grant, missing prerequisites and redacts raw errors', async () => {
    for (const options of [
      {
        snapshot: {
          ...supportAclFixture(),
          runtime: { ...supportAclFixture().runtime, bypassRls: true },
        },
      },
      { extra: true },
      { failAt: 'jsonb_to_recordset' },
    ]) {
      const f = poolFixture(options);
      await expect(openSupportTicketRuntimePool(main, support, f.create)).rejects.toThrow(
        'SUPPORT_RUNTIME_BOUNDARY_INVALID',
      );
      expect(f.end).toHaveBeenCalledOnce();
    }
  });
});
