import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

export interface EventCatalogSnapshot<TItem> {
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly queryHash: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly state: 'READY' | 'PARTIAL';
  readonly items: readonly TItem[];
  readonly metadata?: unknown;
}

export interface EventCatalogPage<TItem> {
  readonly snapshotVersion: string;
  readonly state: 'READY' | 'PARTIAL';
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
  readonly metadata?: unknown;
}

export type EventCatalogPageRead<TItem> =
  | { readonly outcome: 'PAGE'; readonly page: EventCatalogPage<TItem> }
  | { readonly outcome: 'EXPIRED' }
  | { readonly outcome: 'INVALID' };

interface EventCatalogCursorBinding {
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly queryHash: string;
  readonly offset: number;
  readonly limit: number;
}

export interface EventCatalogSnapshotStore<TItem> {
  create(snapshot: EventCatalogSnapshot<TItem>, ttlSeconds: number): Promise<boolean>;
  firstPage(input: {
    readonly snapshotId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly queryHash: string;
    readonly limit: number;
    readonly ttlSeconds: number;
  }): Promise<EventCatalogPageRead<TItem>>;
  continuePage(input: {
    readonly cursor: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly limit: number;
    readonly ttlSeconds: number;
  }): Promise<EventCatalogPageRead<TItem>>;
}

interface StoredValue<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function pageFromSnapshot<TItem>(input: {
  readonly snapshot: EventCatalogSnapshot<TItem>;
  readonly offset: number;
  readonly limit: number;
  readonly createCursor: (binding: EventCatalogCursorBinding) => Promise<string>;
}): Promise<EventCatalogPage<TItem>> {
  const items = input.snapshot.items.slice(input.offset, input.offset + input.limit);
  const nextOffset = input.offset + items.length;
  return (
    nextOffset < input.snapshot.items.length
      ? input.createCursor({
          snapshotId: input.snapshot.snapshotId,
          tenantId: input.snapshot.tenantId,
          userId: input.snapshot.userId,
          queryHash: input.snapshot.queryHash,
          offset: nextOffset,
          limit: input.limit,
        })
      : Promise.resolve(null)
  ).then((nextCursor) => ({
    snapshotVersion: input.snapshot.version,
    state: input.snapshot.state,
    generatedAt: input.snapshot.generatedAt,
    staleAt: input.snapshot.staleAt,
    items,
    nextCursor,
    ...(input.snapshot.metadata === undefined ? {} : { metadata: input.snapshot.metadata }),
  }));
}

function ownsSnapshot<TItem>(
  snapshot: EventCatalogSnapshot<TItem>,
  input: { readonly tenantId: string; readonly userId: string; readonly queryHash: string },
): boolean {
  return (
    snapshot.tenantId === input.tenantId &&
    snapshot.userId === input.userId &&
    snapshot.queryHash === input.queryHash
  );
}

export class MemoryEventCatalogSnapshotStore<TItem> implements EventCatalogSnapshotStore<TItem> {
  private readonly snapshots = new Map<string, StoredValue<EventCatalogSnapshot<TItem>>>();
  private readonly cursors = new Map<string, StoredValue<EventCatalogCursorBinding>>();

  public constructor(private readonly now: () => number = Date.now) {}

  private readStored<T>(values: Map<string, StoredValue<T>>, key: string): T | undefined {
    const stored = values.get(key);
    if (!stored) return undefined;
    if (stored.expiresAt <= this.now()) {
      values.delete(key);
      return undefined;
    }
    return stored.value;
  }

  private createCursor(binding: EventCatalogCursorBinding, ttlSeconds: number): string {
    const cursor = randomUUID();
    this.cursors.set(cursor, {
      value: binding,
      expiresAt: this.now() + ttlSeconds * 1_000,
    });
    return cursor;
  }

  public create(snapshot: EventCatalogSnapshot<TItem>, ttlSeconds: number): Promise<boolean> {
    if (this.readStored(this.snapshots, snapshot.snapshotId)) return Promise.resolve(false);
    this.snapshots.set(snapshot.snapshotId, {
      value: snapshot,
      expiresAt: this.now() + ttlSeconds * 1_000,
    });
    return Promise.resolve(true);
  }

  public async firstPage(input: {
    readonly snapshotId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly queryHash: string;
    readonly limit: number;
    readonly ttlSeconds: number;
  }): Promise<EventCatalogPageRead<TItem>> {
    const snapshot = this.readStored(this.snapshots, input.snapshotId);
    if (!snapshot) return { outcome: 'EXPIRED' };
    if (!ownsSnapshot(snapshot, input)) return { outcome: 'INVALID' };
    return {
      outcome: 'PAGE',
      page: await pageFromSnapshot({
        snapshot,
        offset: 0,
        limit: input.limit,
        createCursor: (binding) => Promise.resolve(this.createCursor(binding, input.ttlSeconds)),
      }),
    };
  }

  public async continuePage(input: {
    readonly cursor: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly limit: number;
    readonly ttlSeconds: number;
  }): Promise<EventCatalogPageRead<TItem>> {
    const binding = this.readStored(this.cursors, input.cursor);
    if (!binding) return { outcome: 'EXPIRED' };
    if (binding.tenantId !== input.tenantId || binding.userId !== input.userId) {
      return { outcome: 'INVALID' };
    }
    const snapshot = this.readStored(this.snapshots, binding.snapshotId);
    if (!snapshot) return { outcome: 'EXPIRED' };
    if (!ownsSnapshot(snapshot, binding) || binding.limit !== input.limit) {
      return { outcome: 'INVALID' };
    }
    this.snapshots.set(binding.snapshotId, {
      value: snapshot,
      expiresAt: this.now() + input.ttlSeconds * 1_000,
    });
    return {
      outcome: 'PAGE',
      page: await pageFromSnapshot({
        snapshot,
        offset: binding.offset,
        limit: input.limit,
        createCursor: (nextBinding) =>
          Promise.resolve(this.createCursor(nextBinding, input.ttlSeconds)),
      }),
    };
  }
}

const SNAPSHOT_PREFIX = 'phub:event-catalog-snapshot:';
const CURSOR_PREFIX = 'phub:event-catalog-cursor:';

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export class RedisEventCatalogSnapshotStore<TItem> implements EventCatalogSnapshotStore<TItem> {
  public constructor(private readonly redis: Redis) {}

  private async createCursor(
    binding: EventCatalogCursorBinding,
    ttlSeconds: number,
  ): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cursor = randomUUID();
      const stored = await this.redis.set(
        `${CURSOR_PREFIX}${cursor}`,
        JSON.stringify(binding),
        'EX',
        ttlSeconds,
        'NX',
      );
      if (stored === 'OK') return cursor;
    }
    throw new Error('EVENT_CATALOG_CURSOR_CREATE_FAILED');
  }

  public async create(snapshot: EventCatalogSnapshot<TItem>, ttlSeconds: number): Promise<boolean> {
    return (
      (await this.redis.set(
        `${SNAPSHOT_PREFIX}${snapshot.snapshotId}`,
        JSON.stringify(snapshot),
        'EX',
        ttlSeconds,
        'NX',
      )) === 'OK'
    );
  }

  public async firstPage(input: {
    readonly snapshotId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly queryHash: string;
    readonly limit: number;
    readonly ttlSeconds: number;
  }): Promise<EventCatalogPageRead<TItem>> {
    const snapshot = parseJson<EventCatalogSnapshot<TItem>>(
      await this.redis.get(`${SNAPSHOT_PREFIX}${input.snapshotId}`),
    );
    if (!snapshot) return { outcome: 'EXPIRED' };
    if (!ownsSnapshot(snapshot, input)) return { outcome: 'INVALID' };
    return {
      outcome: 'PAGE',
      page: await pageFromSnapshot({
        snapshot,
        offset: 0,
        limit: input.limit,
        createCursor: (binding) => this.createCursor(binding, input.ttlSeconds),
      }),
    };
  }

  public async continuePage(input: {
    readonly cursor: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly limit: number;
    readonly ttlSeconds: number;
  }): Promise<EventCatalogPageRead<TItem>> {
    const binding = parseJson<EventCatalogCursorBinding>(
      await this.redis.get(`${CURSOR_PREFIX}${input.cursor}`),
    );
    if (!binding) return { outcome: 'EXPIRED' };
    if (binding.tenantId !== input.tenantId || binding.userId !== input.userId) {
      return { outcome: 'INVALID' };
    }
    const snapshotKey = `${SNAPSHOT_PREFIX}${binding.snapshotId}`;
    const snapshot = parseJson<EventCatalogSnapshot<TItem>>(await this.redis.get(snapshotKey));
    if (!snapshot) return { outcome: 'EXPIRED' };
    if (!ownsSnapshot(snapshot, binding) || binding.limit !== input.limit) {
      return { outcome: 'INVALID' };
    }
    await this.redis.expire(snapshotKey, input.ttlSeconds);
    return {
      outcome: 'PAGE',
      page: await pageFromSnapshot({
        snapshot,
        offset: binding.offset,
        limit: input.limit,
        createCursor: (nextBinding) => this.createCursor(nextBinding, input.ttlSeconds),
      }),
    };
  }
}
