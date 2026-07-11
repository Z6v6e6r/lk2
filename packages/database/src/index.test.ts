import { describe, expect, it, vi } from 'vitest';

import { checkDatabaseReady, withTenantTransaction } from './index.js';

describe('database boundaries', () => {
  it('checks readiness without leaking errors', async () => {
    const readyPool = { query: vi.fn().mockResolvedValue({ rows: [{ ready: 1 }] }) };
    const failedPool = { query: vi.fn().mockRejectedValue(new Error('connection detail')) };

    expect(await checkDatabaseReady(readyPool as never)).toBe(true);
    expect(await checkDatabaseReady(failedPool as never)).toBe(false);
  });

  it('sets tenant context and commits one transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    const result = await withTenantTransaction(
      pool as never,
      '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      () => Promise.resolve('done'),
    );

    expect(result).toBe('done');
    expect(query).toHaveBeenNthCalledWith(1, 'begin');
    expect(query).toHaveBeenNthCalledWith(2, "select set_config('app.tenant_id', $1, true)", [
      '86afbe01-0318-4dd2-bc25-303b7bf0d430',
    ]);
    expect(query).toHaveBeenNthCalledWith(3, 'commit');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back a failed tenant transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(
      withTenantTransaction(pool as never, '86afbe01-0318-4dd2-bc25-303b7bf0d430', () =>
        Promise.reject(new Error('domain failure')),
      ),
    ).rejects.toThrow('domain failure');
    expect(query).toHaveBeenCalledWith('rollback');
    expect(release).toHaveBeenCalledOnce();
  });
});
