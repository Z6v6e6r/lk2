/* eslint-disable @typescript-eslint/require-await -- Synthetic asynchronous boundary fixtures. */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createTournamentChatActorReader } from './tournament-chat-actor-context.js';
const actor = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  tenantKey: 'canonical',
  userId: '10000000-0000-4000-8000-000000000002',
  sessionId: '10000000-0000-4000-8000-000000000003',
  correlationId: '10000000-0000-4000-8000-000000000004',
};
function fixture(rows: unknown[]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('select m.external_id') ? rows : [],
  }));
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  return { read: createTournamentChatActorReader(pool), query, release };
}
const row = {
  external_id: 'synthetic-player',
  owner_tenant_key: 'different-owner',
  forward_count: '1',
  reverse_count: '1',
};
describe('tournament actor exact canonical identity', () => {
  it('binds session/tenant and both cardinalities in one timed tenant transaction', async () => {
    const x = fixture([row]);
    expect(await x.read(actor)).toEqual({
      providerClientId: row.external_id,
      ownerTenantKey: row.owner_tenant_key,
    });
    const call = x.query.mock.calls.find((c) => c[0].includes('select m.external_id'))!;
    expect(call[0]).toContain('s.revoked_at is null and s.rotated_at is null');
    expect(call[0]).toContain("u.status='ACTIVE'");
    expect(call[0]).toContain('limit 2');
    expect(x.release).toHaveBeenCalled();
  });
  it.each(
    [
      [],
      [row, row],
      [{ ...row, forward_count: '2' }],
      [{ ...row, reverse_count: '2' }],
      [{ ...row, owner_tenant_key: '' }],
      [{ ...row, external_id: 'unsafe value' }],
    ].map((rows) => ({ rows })),
  )('fails closed without any fallback for %j', async ({ rows }) => {
    const x = fixture(rows);
    await expect(x.read(actor)).rejects.toMatchObject({ status: 403 });
    expect(x.release).toHaveBeenCalled();
  });
});
