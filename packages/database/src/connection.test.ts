import { describe, expect, it, vi } from 'vitest';

import { warmDatabasePool } from './connection.js';

describe('database pool warmup', () => {
  it('opens, verifies and releases every requested connection before readiness', async () => {
    const clients = Array.from({ length: 3 }, () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      release: vi.fn(),
    }));
    const connect = vi
      .fn()
      .mockResolvedValueOnce(clients[0])
      .mockResolvedValueOnce(clients[1])
      .mockResolvedValueOnce(clients[2]);

    await expect(warmDatabasePool({ connect } as never, 3, 5)).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(3);
    for (const client of clients) {
      expect(client.query).toHaveBeenCalledWith('select 1');
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it('rejects a warmup larger than the configured pool before connecting', async () => {
    const connect = vi.fn();
    await expect(warmDatabasePool({ connect } as never, 6, 5)).rejects.toThrow(
      'DATABASE_POOL_WARM_CONNECTIONS_INVALID',
    );
    expect(connect).not.toHaveBeenCalled();
  });
});
