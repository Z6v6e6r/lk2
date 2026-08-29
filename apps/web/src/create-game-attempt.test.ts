import { describe, expect, it, vi } from 'vitest';

import type { CreateGameRequest } from './auth-gateway.js';
import {
  clearCreateGameAttempt,
  createGameAttemptStorageKey,
  loadCreateGameAttempt,
  loadCreateGameAttemptLedger,
  prepareCreateGameAttempt,
  resolveCreateGameAttempt,
  type CreateGameAttemptLockManager,
  type PendingCreateGameAttempt,
} from './create-game-attempt.js';

const principal = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};
const otherTenant = {
  tenantId: '55555555-5555-4555-8555-555555555555',
  userId: principal.userId,
};
const otherUser = {
  tenantId: principal.tenantId,
  userId: '44444444-4444-4444-8444-444444444444',
};
const attemptId1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const attemptId2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const gameId1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

function payload(overrides: Partial<CreateGameRequest> = {}): CreateGameRequest {
  return {
    title: '  Открытая игра  ',
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    stationId: '11111111-1111-4111-8111-111111111111',
    startsAt: '2027-08-15T15:00:00.000Z',
    endsAt: '2027-08-15T16:30:00.000Z',
    timezone: 'Europe/Moscow',
    capacity: 4,
    levelRange: null,
    paymentMode: 'NO_PAYMENT',
    waitlistEnabled: true,
    ...overrides,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function serialLocks(): CreateGameAttemptLockManager {
  let tail = Promise.resolve<unknown>(undefined);
  return {
    request: (_name, _options, callback) => {
      const result = tail.then(callback);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function ids(attemptId: string, idempotencyKey: string) {
  return {
    createAttemptId: () => attemptId,
    createIdempotencyKey: () => idempotencyKey,
  };
}

async function pending(
  storage: Storage,
  locks: CreateGameAttemptLockManager,
  options: { attemptId?: string; key?: string; principalOverride?: typeof principal } = {},
): Promise<PendingCreateGameAttempt> {
  const result = await prepareCreateGameAttempt(
    options.principalOverride ?? principal,
    payload(),
    storage,
    locks,
    ids(options.attemptId ?? attemptId1, options.key ?? 'create-logical-attempt-key-0001'),
  );
  expect(result.state).toBe('PENDING');
  return result as PendingCreateGameAttempt;
}

describe('durable create game logical-attempt ledger', () => {
  it('normalizes a payload and reuses one pending key without time expiry', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const createIdempotencyKey = vi.fn().mockReturnValue('create-logical-attempt-key-0001');
    const first = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      createAttemptId: () => attemptId1,
      createIdempotencyKey,
      now: () => new Date('2026-08-27T10:00:00.000Z'),
    });
    const replay = await prepareCreateGameAttempt(
      principal,
      payload({ title: 'Открытая игра' }),
      storage,
      locks,
      {
        createAttemptId: () => attemptId2,
        createIdempotencyKey,
        now: () => new Date('2036-08-27T10:00:00.000Z'),
      },
    );

    expect(first).toMatchObject({ state: 'PENDING', attemptId: attemptId1 });
    expect(replay).toEqual(first);
    expect(createIdempotencyKey).toHaveBeenCalledOnce();
  });

  it('atomically assigns one attemptId and key to simultaneous same-principal tabs', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const createIdempotencyKey = vi
      .fn()
      .mockReturnValueOnce('create-logical-attempt-key-0001')
      .mockReturnValueOnce('create-logical-attempt-key-0002');
    const createAttemptId = vi.fn().mockReturnValue(attemptId1);

    const [first, second] = await Promise.all([
      prepareCreateGameAttempt(principal, payload(), storage, locks, {
        createAttemptId,
        createIdempotencyKey,
      }),
      prepareCreateGameAttempt(principal, payload(), storage, locks, {
        createAttemptId,
        createIdempotencyKey,
      }),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: 'PENDING',
      attemptId: attemptId1,
      idempotencyKey: 'create-logical-attempt-key-0001',
    });
    expect(createAttemptId).toHaveBeenCalledOnce();
    expect(createIdempotencyKey).toHaveBeenCalledOnce();
  });

  it('blocks changed payload without sending or minting another key', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    await pending(storage, locks);
    const createIdempotencyKey = vi.fn().mockReturnValue('create-logical-attempt-key-0002');

    await expect(
      prepareCreateGameAttempt(principal, payload({ capacity: 2 }), storage, locks, {
        createAttemptId: () => attemptId2,
        createIdempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_PAYLOAD_CHANGED' });
    expect(createIdempotencyKey).not.toHaveBeenCalled();
    expect(loadCreateGameAttempt(principal, storage)).toMatchObject({
      state: 'PENDING',
      idempotencyKey: 'create-logical-attempt-key-0001',
    });
  });

  it('survives a tab-close style new caller over the same durable storage', async () => {
    const storage = memoryStorage();
    const first = await pending(storage, serialLocks());
    expect(loadCreateGameAttempt(principal, storage)).toEqual(first);
    expect(loadCreateGameAttempt(principal, storage)).toMatchObject({
      state: 'PENDING',
      payload: { title: 'Открытая игра', capacity: 4 },
    });
  });

  it('isolates pending ledgers by tenant and actor', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    await pending(storage, locks);
    const tenantAttempt = await prepareCreateGameAttempt(otherTenant, payload(), storage, locks, {
      ...ids(attemptId1, 'create-logical-attempt-key-0002'),
    });
    const userAttempt = await prepareCreateGameAttempt(otherUser, payload(), storage, locks, {
      ...ids(attemptId2, 'create-logical-attempt-key-0003'),
    });

    expect(tenantAttempt).toMatchObject({ idempotencyKey: 'create-logical-attempt-key-0002' });
    expect(userAttempt).toMatchObject({ idempotencyKey: 'create-logical-attempt-key-0003' });
    expect(loadCreateGameAttempt(principal, storage)).toMatchObject({
      idempotencyKey: 'create-logical-attempt-key-0001',
    });
    expect(storage.length).toBe(3);
  });

  it('rejects malformed, version-invalid and foreign-principal ledgers', async () => {
    const storage = memoryStorage();
    const key = createGameAttemptStorageKey(principal);
    storage.setItem(key, '{bad-json');
    expect(() => loadCreateGameAttempt(principal, storage)).toThrowError(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );
    storage.setItem(key, JSON.stringify({ version: 2 }));
    expect(() => loadCreateGameAttempt(principal, storage)).toThrowError(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );

    const attempt = await pending(memoryStorage(), serialLocks());
    storage.setItem(
      key,
      JSON.stringify({
        version: 3,
        activeAttempt: { ...attempt, actorUserId: otherUser.userId },
        resolvedAttempts: [],
      }),
    );
    expect(() => loadCreateGameAttempt(principal, storage)).toThrowError(
      expect.objectContaining({ code: 'ATTEMPT_FOREIGN_PRINCIPAL' }),
    );
  });

  it('fails closed when the cross-tab lock is unavailable', async () => {
    await expect(
      prepareCreateGameAttempt(principal, payload(), memoryStorage(), undefined, {
        ...ids(attemptId1, 'create-logical-attempt-key-0001'),
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_LOCK_UNAVAILABLE' });
  });

  it('clears terminal no-commit pending state without deleting resolved history', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const first = await pending(storage, locks);
    await resolveCreateGameAttempt(principal, first, gameId1, storage, locks, {
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    });
    const second = (await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      ...ids(attemptId2, 'create-logical-attempt-key-0002'),
      allowNewIntent: true,
    })) as PendingCreateGameAttempt;

    await clearCreateGameAttempt(principal, second, storage, locks);
    const ledger = loadCreateGameAttemptLedger(principal, storage);
    expect(ledger.activeAttempt).toBeUndefined();
    expect(ledger.resolvedAttempts).toHaveLength(1);
    expect(ledger.resolvedAttempts[0]).toMatchObject({ gameId: gameId1 });
  });

  it('moves K1 atomically to a payload-free RESOLVED marker with evidence-backed retention', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const first = await pending(storage, locks);
    const resolved = await resolveCreateGameAttempt(principal, first, gameId1, storage, locks, {
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    });

    expect(resolved).toMatchObject({
      state: 'RESOLVED',
      attemptId: attemptId1,
      idempotencyKey: 'create-logical-attempt-key-0001',
      gameId: gameId1,
      expiresAt: '2027-08-16T15:00:00.000Z',
    });
    const raw = String(storage.getItem(createGameAttemptStorageKey(principal)));
    expect(raw).not.toContain('"payload"');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('cookie');
  });

  it('resolves a mounted ambiguous tab from fresh storage without K2 or another request', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const tabA = await pending(storage, locks);
    const tabB = await prepareCreateGameAttempt(principal, payload(), storage, locks);
    expect(tabB).toEqual(tabA);
    await resolveCreateGameAttempt(principal, tabA, gameId1, storage, locks);
    const createIdempotencyKey = vi.fn().mockReturnValue('create-logical-attempt-key-0002');

    const retry = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      mountedAttempt: tabB as PendingCreateGameAttempt,
      createAttemptId: () => attemptId2,
      createIdempotencyKey,
    });
    expect(retry).toMatchObject({ state: 'RESOLVED', gameId: gameId1 });
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('reopens directly to resolved G1 without allocating K2 or relying on an event', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const first = await pending(storage, locks);
    await resolveCreateGameAttempt(principal, first, gameId1, storage, locks);
    const createIdempotencyKey = vi.fn().mockReturnValue('create-logical-attempt-key-0002');

    expect(loadCreateGameAttempt(principal, storage)).toMatchObject({
      state: 'RESOLVED',
      gameId: gameId1,
    });
    const reopened = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      createAttemptId: () => attemptId2,
      createIdempotencyKey,
    });
    expect(reopened).toMatchObject({ state: 'RESOLVED', gameId: gameId1 });
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('allows only explicit new intent K2 while old tab B still resolves K1 to G1', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const oldTab = await pending(storage, locks);
    await resolveCreateGameAttempt(principal, oldTab, gameId1, storage, locks);
    const second = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      ...ids(attemptId2, 'create-logical-attempt-key-0002'),
      allowNewIntent: true,
    });
    expect(second).toMatchObject({
      state: 'PENDING',
      attemptId: attemptId2,
      idempotencyKey: 'create-logical-attempt-key-0002',
    });

    const oldRetry = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      mountedAttempt: oldTab,
    });
    expect(oldRetry).toMatchObject({ state: 'RESOLVED', gameId: gameId1 });
    expect(loadCreateGameAttemptLedger(principal, storage).resolvedAttempts).toHaveLength(1);
  });

  it('keeps resolved state principal-scoped and restores it when principal 1 returns', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const first = await pending(storage, locks);
    await resolveCreateGameAttempt(principal, first, gameId1, storage, locks);

    expect(loadCreateGameAttempt(otherUser, storage)).toBeNull();
    expect(loadCreateGameAttempt(otherTenant, storage)).toBeNull();
    expect(loadCreateGameAttempt(principal, storage)).toMatchObject({
      state: 'RESOLVED',
      gameId: gameId1,
    });
  });

  it('restores exact K1 when storage is missing but a mounted tab still holds it', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const mounted = await pending(storage, locks);
    storage.clear();
    const createIdempotencyKey = vi.fn().mockReturnValue('create-logical-attempt-key-0002');

    const restored = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      mountedAttempt: mounted,
      createAttemptId: () => attemptId2,
      createIdempotencyKey,
    });
    expect(restored).toEqual(mounted);
    expect(loadCreateGameAttempt(principal, storage)).toEqual(mounted);
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('persists only the allowlisted ledger and minimum pending payload', async () => {
    const storage = memoryStorage();
    await pending(storage, serialLocks());
    const raw = storage.getItem(createGameAttemptStorageKey(principal));
    const ledger = JSON.parse(String(raw)) as Record<string, unknown>;
    expect(Object.keys(ledger).sort()).toEqual(['activeAttempt', 'resolvedAttempts', 'version']);
    expect(Object.keys(ledger.activeAttempt as Record<string, unknown>).sort()).toEqual([
      'actorUserId',
      'attemptId',
      'createdAt',
      'idempotencyKey',
      'payload',
      'payloadFingerprint',
      'startsAt',
      'state',
      'tenantId',
    ]);
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('cookie');
    expect(raw).not.toContain('operationId');
  });
});
