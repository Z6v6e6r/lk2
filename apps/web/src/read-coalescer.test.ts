import { describe, expect, it, vi } from 'vitest';

import { createReadCoalescer } from './read-coalescer.js';

describe('createReadCoalescer', () => {
  it('shares one pending request between identical keys', async () => {
    const coalescer = createReadCoalescer();
    const start = vi.fn().mockResolvedValue({ items: [] });

    const first = coalescer.read('notifications:tenant:user', start);
    const second = coalescer.read('notifications:tenant:user', start);

    expect(first).toBe(second);
    await expect(second).resolves.toEqual({ items: [] });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not share a request between different keys', async () => {
    const coalescer = createReadCoalescer();
    const start = vi.fn().mockResolvedValue({ items: [] });

    await Promise.all([
      coalescer.read('notifications:tenant:user-a', start),
      coalescer.read('notifications:tenant:user-b', start),
    ]);

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a settled request', async () => {
    const coalescer = createReadCoalescer();
    const start = vi.fn().mockResolvedValue('value');

    await coalescer.read('notifications:tenant:user', start);
    await coalescer.read('notifications:tenant:user', start);

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('releases the entry after a failure so a retry reaches the API', async () => {
    const coalescer = createReadCoalescer();
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error('NOTIFICATIONS_UNAVAILABLE'))
      .mockResolvedValueOnce({ items: [] });

    await expect(coalescer.read('notifications:tenant:user', start)).rejects.toThrow(
      'NOTIFICATIONS_UNAVAILABLE',
    );
    await expect(coalescer.read('notifications:tenant:user', start)).resolves.toEqual({
      items: [],
    });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('drops pending entries when the session ends so another account cannot reuse them', async () => {
    const coalescer = createReadCoalescer();
    let resolveFirst: (value: { items: [] }) => void = () => undefined;
    const first = new Promise<{ items: [] }>((resolve) => {
      resolveFirst = resolve;
    });
    const start = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ items: [], marker: 'second-account' });

    const pending = coalescer.read('notifications:tenant:user-a', start);
    coalescer.clear();
    const afterLogout = coalescer.read('notifications:tenant:user-a', start);

    expect(afterLogout).not.toBe(pending);
    resolveFirst({ items: [] });
    await expect(afterLogout).resolves.toEqual({ items: [], marker: 'second-account' });
    expect(start).toHaveBeenCalledTimes(2);
  });
});
