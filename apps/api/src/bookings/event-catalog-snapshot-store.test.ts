import { describe, expect, it } from 'vitest';

import { MemoryEventCatalogSnapshotStore } from './event-catalog-snapshot-store.js';

interface Item {
  readonly id: string;
}

function snapshot(items: readonly Item[]) {
  return {
    snapshotId: 'snapshot-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    queryHash: 'query-1',
    version: 'version-1',
    generatedAt: '2026-08-01T12:00:00.000Z',
    staleAt: '2026-08-01T12:10:00.000Z',
    state: 'READY' as const,
    items,
  };
}

describe('MemoryEventCatalogSnapshotStore', () => {
  it.each([0, 1, 20, 21, 50, 51, 501])(
    'paginates %i rows without gaps or duplicates',
    async (itemCount) => {
      const store = new MemoryEventCatalogSnapshotStore<Item>();
      const items = Array.from({ length: itemCount }, (_, index) => ({
        id: `item-${String(index + 1).padStart(3, '0')}`,
      }));
      await expect(store.create(snapshot(items), 600)).resolves.toBe(true);

      const first = await store.firstPage({
        snapshotId: 'snapshot-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        queryHash: 'query-1',
        limit: 20,
        ttlSeconds: 600,
      });
      expect(first.outcome).toBe('PAGE');
      if (first.outcome !== 'PAGE') throw new Error('expected first page');

      const pages = [first.page];
      let cursor = first.page.nextCursor;
      while (cursor) {
        const continued = await store.continuePage({
          cursor,
          tenantId: 'tenant-1',
          userId: 'user-1',
          limit: 20,
          ttlSeconds: 600,
        });
        expect(continued.outcome).toBe('PAGE');
        if (continued.outcome !== 'PAGE') throw new Error('expected continuation page');
        pages.push(continued.page);
        cursor = continued.page.nextCursor;
      }

      const receivedIds = pages.flatMap((page) => page.items.map((item) => item.id));
      expect(receivedIds).toEqual(items.map((item) => item.id));
      expect(new Set(receivedIds)).toHaveLength(itemCount);
      expect(pages).toHaveLength(Math.max(1, Math.ceil(itemCount / 20)));
      expect(pages.every((page) => page.items.length <= 20)).toBe(true);
      expect(pages.at(-1)?.nextCursor).toBeNull();
    },
  );

  it('paginates one immutable snapshot without gaps or duplicates', async () => {
    const store = new MemoryEventCatalogSnapshotStore<Item>();
    const items = Array.from({ length: 51 }, (_, index) => ({ id: `item-${index + 1}` }));
    await expect(store.create(snapshot(items), 600)).resolves.toBe(true);

    const first = await store.firstPage({
      snapshotId: 'snapshot-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      queryHash: 'query-1',
      limit: 20,
      ttlSeconds: 600,
    });
    expect(first.outcome).toBe('PAGE');
    if (first.outcome !== 'PAGE') throw new Error('expected first page');

    const second = await store.continuePage({
      cursor: first.page.nextCursor!,
      tenantId: 'tenant-1',
      userId: 'user-1',
      limit: 20,
      ttlSeconds: 600,
    });
    expect(second.outcome).toBe('PAGE');
    if (second.outcome !== 'PAGE') throw new Error('expected second page');

    const third = await store.continuePage({
      cursor: second.page.nextCursor!,
      tenantId: 'tenant-1',
      userId: 'user-1',
      limit: 20,
      ttlSeconds: 600,
    });
    expect(third.outcome).toBe('PAGE');
    if (third.outcome !== 'PAGE') throw new Error('expected third page');

    const ids = [...first.page.items, ...second.page.items, ...third.page.items].map(
      (item) => item.id,
    );
    expect(ids).toEqual(items.map((item) => item.id));
    expect(new Set(ids)).toHaveLength(51);
    expect(first.page.nextCursor).not.toBeNull();
    expect(second.page.nextCursor).not.toBeNull();
    expect(third.page.nextCursor).toBeNull();
  });

  it('replays a cursor against the same immutable offset', async () => {
    const store = new MemoryEventCatalogSnapshotStore<Item>();
    await store.create(snapshot([{ id: 'one' }, { id: 'two' }, { id: 'three' }]), 600);
    const first = await store.firstPage({
      snapshotId: 'snapshot-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      queryHash: 'query-1',
      limit: 1,
      ttlSeconds: 600,
    });
    if (first.outcome !== 'PAGE') throw new Error('expected first page');
    const cursor = first.page.nextCursor!;
    const input = {
      cursor,
      tenantId: 'tenant-1',
      userId: 'user-1',
      limit: 1,
      ttlSeconds: 600,
    };

    const replayOne = await store.continuePage(input);
    const replayTwo = await store.continuePage(input);
    expect(replayOne.outcome).toBe('PAGE');
    expect(replayTwo.outcome).toBe('PAGE');
    if (replayOne.outcome === 'PAGE' && replayTwo.outcome === 'PAGE') {
      expect(replayOne.page.items).toEqual([{ id: 'two' }]);
      expect(replayTwo.page.items).toEqual([{ id: 'two' }]);
    }
  });

  it('keeps snapshot identity and freshness unchanged across continuation pages', async () => {
    const store = new MemoryEventCatalogSnapshotStore<Item>();
    await store.create(snapshot([{ id: 'one' }, { id: 'two' }, { id: 'three' }]), 600);
    const first = await store.firstPage({
      snapshotId: 'snapshot-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      queryHash: 'query-1',
      limit: 1,
      ttlSeconds: 600,
    });
    if (first.outcome !== 'PAGE') throw new Error('expected first page');

    const continued = await store.continuePage({
      cursor: first.page.nextCursor!,
      tenantId: 'tenant-1',
      userId: 'user-1',
      limit: 1,
      ttlSeconds: 600,
    });
    if (continued.outcome !== 'PAGE') throw new Error('expected continuation page');

    expect(continued.page).toMatchObject({
      snapshotVersion: first.page.snapshotVersion,
      state: first.page.state,
      generatedAt: first.page.generatedAt,
      staleAt: first.page.staleAt,
    });
    expect(first.page.items).toEqual([{ id: 'one' }]);
    expect(continued.page.items).toEqual([{ id: 'two' }]);
    expect(continued.page.nextCursor).not.toBeNull();
  });

  it('rejects a continuation page size that differs from the snapshot policy', async () => {
    const store = new MemoryEventCatalogSnapshotStore<Item>();
    await store.create(snapshot([{ id: 'one' }, { id: 'two' }, { id: 'three' }]), 600);
    const first = await store.firstPage({
      snapshotId: 'snapshot-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      queryHash: 'query-1',
      limit: 1,
      ttlSeconds: 600,
    });
    if (first.outcome !== 'PAGE') throw new Error('expected first page');
    await expect(
      store.continuePage({
        cursor: first.page.nextCursor!,
        tenantId: 'tenant-1',
        userId: 'user-1',
        limit: 2,
        ttlSeconds: 600,
      }),
    ).resolves.toEqual({ outcome: 'INVALID' });
  });

  it('refreshes the in-memory snapshot TTL after a valid continuation', async () => {
    let now = 0;
    const store = new MemoryEventCatalogSnapshotStore<Item>(() => now);
    await store.create(snapshot([{ id: 'one' }, { id: 'two' }, { id: 'three' }]), 2);
    const first = await store.firstPage({
      snapshotId: 'snapshot-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      queryHash: 'query-1',
      limit: 1,
      ttlSeconds: 2,
    });
    if (first.outcome !== 'PAGE') throw new Error('expected first page');
    now = 1_500;
    const second = await store.continuePage({
      cursor: first.page.nextCursor!,
      tenantId: 'tenant-1',
      userId: 'user-1',
      limit: 1,
      ttlSeconds: 2,
    });
    if (second.outcome !== 'PAGE') throw new Error('expected second page');
    now = 2_500;
    await expect(
      store.continuePage({
        cursor: second.page.nextCursor!,
        tenantId: 'tenant-1',
        userId: 'user-1',
        limit: 1,
        ttlSeconds: 2,
      }),
    ).resolves.toMatchObject({ outcome: 'PAGE' });
  });

  it('binds snapshots and cursors to query, tenant and user', async () => {
    const store = new MemoryEventCatalogSnapshotStore<Item>();
    await store.create(snapshot([{ id: 'one' }, { id: 'two' }]), 600);

    await expect(
      store.firstPage({
        snapshotId: 'snapshot-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        queryHash: 'another-query',
        limit: 1,
        ttlSeconds: 600,
      }),
    ).resolves.toEqual({ outcome: 'INVALID' });

    const first = await store.firstPage({
      snapshotId: 'snapshot-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      queryHash: 'query-1',
      limit: 1,
      ttlSeconds: 600,
    });
    if (first.outcome !== 'PAGE') throw new Error('expected first page');
    await expect(
      store.continuePage({
        cursor: first.page.nextCursor!,
        tenantId: 'tenant-1',
        userId: 'another-user',
        limit: 1,
        ttlSeconds: 600,
      }),
    ).resolves.toEqual({ outcome: 'INVALID' });
  });

  it('expires both first-page snapshots and continuation cursors', async () => {
    let now = 0;
    const store = new MemoryEventCatalogSnapshotStore<Item>(() => now);
    await store.create(snapshot([{ id: 'one' }, { id: 'two' }]), 1);
    const first = await store.firstPage({
      snapshotId: 'snapshot-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      queryHash: 'query-1',
      limit: 1,
      ttlSeconds: 1,
    });
    if (first.outcome !== 'PAGE') throw new Error('expected first page');
    now = 1_000;

    await expect(
      store.continuePage({
        cursor: first.page.nextCursor!,
        tenantId: 'tenant-1',
        userId: 'user-1',
        limit: 1,
        ttlSeconds: 1,
      }),
    ).resolves.toEqual({ outcome: 'EXPIRED' });
    await expect(
      store.firstPage({
        snapshotId: 'snapshot-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        queryHash: 'query-1',
        limit: 1,
        ttlSeconds: 1,
      }),
    ).resolves.toEqual({ outcome: 'EXPIRED' });
  });
});
