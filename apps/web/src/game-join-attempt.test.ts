import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GameJoinAttemptError,
  beginGameJoinAttempt,
  browserGameJoinAttemptLockManager,
  browserGameJoinAttemptStorage,
  discardGameJoinAttempt,
  gameJoinDispatchLockName,
  gameJoinRequestHash,
  loadGameJoinAttempt,
  markGameJoinAttemptDispatchStarted,
  readGameJoinAttemptLedger,
  resolveGameJoinAttempt,
  withGameJoinDispatchGuard,
  type GameJoinAttemptLockManager,
  type GameJoinAttemptPrincipal,
  type GameJoinAttemptInput,
} from './game-join-attempt.js';

const PRINCIPAL: GameJoinAttemptPrincipal = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
};
const OTHER_PRINCIPAL: GameJoinAttemptPrincipal = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
};
const GAME_ID = '55555555-5555-4555-8555-555555555555';
const SUBSCRIPTION_ID = '66666666-6666-4666-8666-666666666666';
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';
const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function input(overrides: Partial<GameJoinAttemptInput> = {}): GameJoinAttemptInput {
  return {
    gameId: GAME_ID,
    expectedRevision: 7,
    subscriptionInstanceId: SUBSCRIPTION_ID,
    priceConsent: { amountMinor: 70000, currency: 'RUB' },
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public raw(): string {
    const entries = [...this.values.entries()];
    if (entries.length !== 1) throw new Error('expected exactly one stored ledger');
    return entries[0]![1];
  }
}

function serialLockManager(): GameJoinAttemptLockManager {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request<TResult>(
      _name: string,
      _options: { readonly mode: 'exclusive' },
      callback: () => TResult | PromiseLike<TResult>,
    ): Promise<TResult> {
      const next = tail.then(callback);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

async function seedAttempt(
  storage: Storage,
  idempotencyKey = KEY,
): Promise<Awaited<ReturnType<typeof beginGameJoinAttempt>>> {
  return beginGameJoinAttempt(PRINCIPAL, input(), storage, {
    createIdempotencyKey: () => idempotencyKey,
    now: () => new Date('2026-10-21T08:00:00.000Z'),
  });
}

describe('game join attempt ledger', () => {
  beforeEach(() => vi.stubGlobal('navigator', { locks: serialLockManager() }));
  afterEach(() => vi.unstubAllGlobals());
  it('stores custody fields before dispatch and nothing credential-shaped', async () => {
    const storage = new MemoryStorage();
    const { attempt, created } = await seedAttempt(storage);

    expect(created).toBe(true);
    expect(attempt.idempotencyKey).toBe(KEY);
    expect(attempt.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.state).toBe('PENDING');
    expect(attempt.dispatchStartedAt).toBeUndefined();
    const stored = JSON.parse(storage.raw()) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['attempts', 'version']);
    const [persisted] = stored.attempts as [Record<string, unknown>];
    expect(Object.keys(persisted).sort()).toEqual(
      [
        'actorId',
        'gameId',
        'idempotencyKey',
        'priceConsent',
        'requestHash',
        'savedAt',
        'state',
        'subscriptionInstanceId',
        'tenantId',
      ].sort(),
    );
    const serialized = storage.raw().toLowerCase();
    for (const forbidden of [
      'authorization',
      'bearer',
      'access_token',
      'providertoken',
      'postMessage',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('reuses the same key and hash when the frozen request repeats (reload, retry click)', async () => {
    const storage = new MemoryStorage();
    const first = await seedAttempt(storage);
    const second = await beginGameJoinAttempt(PRINCIPAL, input(), storage, {
      createIdempotencyKey: () => 'ffffffff-1111-4222-8333-444444444444',
    });

    expect(second.created).toBe(false);
    expect(second.attempt.idempotencyKey).toBe(first.attempt.idempotencyKey);
    expect(second.attempt.requestHash).toBe(first.attempt.requestHash);
  });

  it('never replaces an unresolved attempt with a changed price; consent stays custody', async () => {
    const storage = new MemoryStorage();
    const { attempt } = await seedAttempt(storage);
    await markGameJoinAttemptDispatchStarted(PRINCIPAL, attempt, storage);

    await expect(
      beginGameJoinAttempt(
        PRINCIPAL,
        input({ priceConsent: { amountMinor: 90000, currency: 'RUB' } }),
        storage,
      ),
    ).rejects.toMatchObject({ code: 'ATTEMPT_UNRESOLVED' });

    const stored = loadGameJoinAttempt(PRINCIPAL, storage, GAME_ID);
    expect(stored?.idempotencyKey).toBe(attempt.idempotencyKey);
    expect(stored?.priceConsent.amountMinor).toBe(70000);
    expect(stored?.dispatchStartedAt).toBeDefined();
  });

  it('mirrors the server canonical request hash', async () => {
    const storage = new MemoryStorage();
    const { attempt } = await seedAttempt(storage);
    const canonical = JSON.stringify({
      command: 'JOIN_GAME',
      contract: 'game.join.paid.v1',
      tenantId: PRINCIPAL.tenantId,
      userId: PRINCIPAL.userId,
      gameId: GAME_ID,
      expectedRevision: 7,
      subscriptionInstanceId: SUBSCRIPTION_ID,
      amountMinor: 70000,
      currency: 'RUB',
      invitationId: null,
    });
    const expected = createHash('sha256').update(canonical).digest('hex');
    expect(attempt.requestHash).toBe(expected);
    expect(await gameJoinRequestHash(PRINCIPAL, input())).toBe(expected);
  });

  it('scopes custody to the principal and rejects a foreign stored ledger', async () => {
    const storage = new MemoryStorage();
    await seedAttempt(storage);

    expect(loadGameJoinAttempt(OTHER_PRINCIPAL, storage, GAME_ID)).toBeNull();

    // A ledger written for another principal under this principal's scoped key must fail closed.
    const foreignKey = `phub.game-join-attempt.v1:${encodeURIComponent(PRINCIPAL.tenantId)}:${encodeURIComponent(
      PRINCIPAL.userId,
    )}`;
    storage.setItem(
      foreignKey,
      JSON.stringify({
        version: 1,
        attempts: [
          {
            state: 'PENDING',
            tenantId: OTHER_PRINCIPAL.tenantId,
            actorId: OTHER_PRINCIPAL.userId,
            gameId: GAME_ID,
            idempotencyKey: KEY,
            requestHash: 'a'.repeat(64),
            subscriptionInstanceId: SUBSCRIPTION_ID,
            priceConsent: { amountMinor: 1, currency: 'RUB' },
            savedAt: '2026-10-21T08:00:00.000Z',
          },
        ],
      }),
    );
    expect(() => loadGameJoinAttempt(PRINCIPAL, storage, GAME_ID)).toThrow(
      expect.objectContaining({ code: 'ATTEMPT_FOREIGN_PRINCIPAL' }),
    );
  });

  it('strictly parses the ledger: malformed JSON, unknown fields and key reuse are rejected', async () => {
    const storage = new MemoryStorage();
    const scopedKey = `phub.game-join-attempt.v1:${encodeURIComponent(PRINCIPAL.tenantId)}:${encodeURIComponent(
      PRINCIPAL.userId,
    )}`;

    storage.setItem(scopedKey, '{not-json');
    expect(() => readGameJoinAttemptLedger(PRINCIPAL, storage)).toThrow(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );

    storage.setItem(scopedKey, JSON.stringify({ version: 2, attempts: [] }));
    expect(() => readGameJoinAttemptLedger(PRINCIPAL, storage)).toThrow(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );

    storage.clear();
    const { attempt } = await seedAttempt(storage);
    storage.setItem(
      scopedKey,
      JSON.stringify({
        version: 1,
        attempts: [{ ...attempt, providerResponse: '<html>secret</html>' }],
      }),
    );
    expect(() => readGameJoinAttemptLedger(PRINCIPAL, storage)).toThrow(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );

    storage.setItem(
      scopedKey,
      JSON.stringify({
        version: 1,
        attempts: [
          { ...attempt, gameId: GAME_ID },
          { ...attempt, gameId: '88888888-8888-4888-8888-888888888888' },
        ],
      }),
    );
    expect(() => readGameJoinAttemptLedger(PRINCIPAL, storage)).toThrow(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );
  });

  it('dispatches exactly once and keeps the durable marker on a lost response', async () => {
    const storage = new MemoryStorage();
    await seedAttempt(storage);
    const dispatch = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      withGameJoinDispatchGuard(PRINCIPAL, GAME_ID, storage, serialLockManager(), dispatch),
    ).rejects.toThrow('network down');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const retained = loadGameJoinAttempt(PRINCIPAL, storage, GAME_ID);
    expect(retained?.dispatchStartedAt).toBeDefined();
    expect(retained?.state).toBe('PENDING');

    const secondDispatch = vi.fn();
    const outcome = await withGameJoinDispatchGuard(
      PRINCIPAL,
      GAME_ID,
      storage,
      serialLockManager(),
      secondDispatch,
    );
    expect(outcome.dispatched).toBe(false);
    expect(outcome.dispatched ? null : outcome.reason).toBe('ALREADY_DISPATCHED');
    expect(secondDispatch).not.toHaveBeenCalled();
  });

  it('serializes two tabs on the Web Locks guard so only one POST is dispatched', async () => {
    const storage = new MemoryStorage();
    await seedAttempt(storage);
    const lockManager = serialLockManager();
    const dispatched: string[] = [];
    const dispatch = async (attempt: { readonly idempotencyKey: string }): Promise<string> => {
      dispatched.push(attempt.idempotencyKey);
      await Promise.resolve();
      return attempt.idempotencyKey;
    };

    const [first, second] = await Promise.all([
      withGameJoinDispatchGuard(PRINCIPAL, GAME_ID, storage, lockManager, dispatch),
      withGameJoinDispatchGuard(PRINCIPAL, GAME_ID, storage, lockManager, dispatch),
    ]);

    expect(dispatched).toEqual([KEY]);
    expect([first.dispatched, second.dispatched].filter(Boolean)).toHaveLength(1);
    expect(first.dispatched || second.dispatched).toBe(true);
  });

  it('uses one ledger lock across games of the same principal', () => {
    expect(gameJoinDispatchLockName(PRINCIPAL, GAME_ID)).toBe(
      gameJoinDispatchLockName(PRINCIPAL, '99999999-9999-4999-8999-999999999999'),
    );
  });

  it('refuses dispatch without a cross-tab lock and preserves the original attempt', async () => {
    const storage = new MemoryStorage();
    await seedAttempt(storage);
    const dispatch = vi.fn();
    await expect(
      withGameJoinDispatchGuard(PRINCIPAL, GAME_ID, storage, undefined, dispatch),
    ).rejects.toMatchObject({ code: 'ATTEMPT_LOCK_UNAVAILABLE' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(loadGameJoinAttempt(PRINCIPAL, storage, GAME_ID)?.idempotencyKey).toBe(KEY);
  });

  it('records the server operation and keeps custody until resolved', async () => {
    const storage = new MemoryStorage();
    const { attempt } = await seedAttempt(storage);
    await markGameJoinAttemptDispatchStarted(PRINCIPAL, attempt, storage, {
      now: () => new Date('2026-10-21T08:00:01.000Z'),
    });

    const unknown = await resolveGameJoinAttempt(
      PRINCIPAL,
      attempt,
      { state: 'UNKNOWN', operationId: OPERATION_ID },
      storage,
      { now: () => new Date('2026-10-21T08:00:02.000Z') },
    );
    expect(unknown.state).toBe('UNKNOWN');
    expect(unknown.operationId).toBe(OPERATION_ID);
    expect(unknown.dispatchStartedAt).toBe('2026-10-21T08:00:01.000Z');
    await expect(discardGameJoinAttempt(PRINCIPAL, attempt, storage)).rejects.toThrow(
      expect.objectContaining({ code: 'ATTEMPT_UNRESOLVED' }),
    );

    const succeeded = await resolveGameJoinAttempt(
      PRINCIPAL,
      unknown,
      { state: 'SUCCEEDED' },
      storage,
      {
        now: () => new Date('2026-10-21T08:00:03.000Z'),
      },
    );
    expect(succeeded.state).toBe('SUCCEEDED');
    expect(succeeded.resolvedAt).toBe('2026-10-21T08:00:03.000Z');

    await discardGameJoinAttempt(PRINCIPAL, succeeded, storage);
    expect(loadGameJoinAttempt(PRINCIPAL, storage, GAME_ID)).toBeNull();
  });

  it('retains a resolved identity when a later readback is nonfinal', async () => {
    const storage = new MemoryStorage();
    const { attempt } = await seedAttempt(storage);
    const succeeded = await resolveGameJoinAttempt(
      PRINCIPAL,
      attempt,
      { state: 'SUCCEEDED', operationId: OPERATION_ID },
      storage,
    );
    await resolveGameJoinAttempt(
      PRINCIPAL,
      succeeded,
      { state: 'UNKNOWN', operationId: OPERATION_ID },
      storage,
    );
    expect(loadGameJoinAttempt(PRINCIPAL, storage, GAME_ID)?.state).toBe('SUCCEEDED');
  });
  it('allows discarding custody only for a definite server rejection', async () => {
    const storage = new MemoryStorage();
    const { attempt } = await seedAttempt(storage);
    await discardGameJoinAttempt(PRINCIPAL, attempt, storage, { allowUnresolved: true });
    expect(loadGameJoinAttempt(PRINCIPAL, storage, GAME_ID)).toBeNull();
  });

  it('rejects a conflicting attempt record instead of overwriting it', async () => {
    const storage = new MemoryStorage();
    const { attempt } = await seedAttempt(storage);
    const tampered = { ...attempt, idempotencyKey: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' };
    await expect(
      resolveGameJoinAttempt(PRINCIPAL, tampered, { state: 'UNKNOWN' }, storage),
    ).rejects.toThrow(expect.objectContaining({ code: 'ATTEMPT_STATE_CHANGED' }));
    await expect(markGameJoinAttemptDispatchStarted(PRINCIPAL, tampered, storage)).rejects.toThrow(
      expect.objectContaining({ code: 'ATTEMPT_STATE_CHANGED' }),
    );
  });

  it('exposes browser storage/lock detection and stable lock names without throwing', () => {
    // This file runs in the node environment: no window storage.
    expect(browserGameJoinAttemptStorage()).toBeUndefined();
    // Web Locks may or may not exist (Node 24 exposes it); the guard must handle both.
    const locks = browserGameJoinAttemptLockManager();
    expect(locks === undefined || typeof locks.request === 'function').toBe(true);
    expect(browserGameJoinAttemptLockManager()).toBe(locks);
    expect(gameJoinDispatchLockName(PRINCIPAL, GAME_ID)).toBe(
      `phub.game-join-attempt.v1:ledger:${encodeURIComponent(PRINCIPAL.tenantId)}:${encodeURIComponent(
        PRINCIPAL.userId,
      )}`,
    );
  });

  it('evicts the oldest resolved success instead of writing a ledger strict parse would reject', async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 16; index += 1) {
      await beginGameJoinAttempt(
        PRINCIPAL,
        input({ gameId: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}` }),
        storage,
        {
          now: () => new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 60_000),
          createIdempotencyKey: () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, '0')}`,
        },
      );
    }
    const ledger = readGameJoinAttemptLedger(PRINCIPAL, storage);
    expect(ledger.attempts).toHaveLength(16);
    for (const attempt of ledger.attempts) {
      await resolveGameJoinAttempt(
        PRINCIPAL,
        attempt,
        { state: 'SUCCEEDED', operationId: OPERATION_ID },
        storage,
        { now: () => new Date('2026-10-21T08:00:00.000Z') },
      );
    }
    const nextAttempt = await beginGameJoinAttempt(PRINCIPAL, input(), storage, {
      createIdempotencyKey: () => KEY,
    });
    expect(nextAttempt.created).toBe(true);
    const reRead = readGameJoinAttemptLedger(PRINCIPAL, storage);
    expect(reRead.attempts).toHaveLength(16);
    expect(reRead.attempts.some((attempt) => attempt.idempotencyKey === KEY)).toBe(true);
  });

  it('surfaces storage failures as typed attempt errors', async () => {
    const failing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    await expect(seedAttempt(failing)).rejects.toBeInstanceOf(GameJoinAttemptError);
    await expect(beginGameJoinAttempt(PRINCIPAL, input(), failing)).rejects.toMatchObject({
      code: 'ATTEMPT_STORAGE_UNAVAILABLE',
    });
  });
});
