import { describe, expect, it, vi } from 'vitest';

import type { CreateGameRequest } from './auth-gateway.js';
import {
  clearCreateGameAttempt,
  createGameAttemptStorageKey,
  loadCreateGameAttempt,
  prepareCreateGameAttempt,
  type CreateGameAttemptLockManager,
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

describe('durable create game logical attempt', () => {
  it('normalizes a payload and reuses one key without time expiry', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const createIdempotencyKey = vi.fn().mockReturnValue('create-logical-attempt-key-0001');
    const first = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      createIdempotencyKey,
      now: () => new Date('2026-08-27T10:00:00.000Z'),
    });
    const replay = await prepareCreateGameAttempt(
      principal,
      payload({ title: 'Открытая игра' }),
      storage,
      locks,
      {
        createIdempotencyKey,
        now: () => new Date('2036-08-27T10:00:00.000Z'),
      },
    );

    expect(first.payload.title).toBe('Открытая игра');
    expect(replay).toEqual(first);
    expect(createIdempotencyKey).toHaveBeenCalledOnce();
  });

  it('atomically assigns one key to simultaneous same-principal tabs', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const createIdempotencyKey = vi
      .fn()
      .mockReturnValueOnce('create-logical-attempt-key-0001')
      .mockReturnValueOnce('create-logical-attempt-key-0002');

    const [first, second] = await Promise.all([
      prepareCreateGameAttempt(principal, payload(), storage, locks, { createIdempotencyKey }),
      prepareCreateGameAttempt(principal, payload(), storage, locks, { createIdempotencyKey }),
    ]);

    expect(first.idempotencyKey).toBe('create-logical-attempt-key-0001');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(createIdempotencyKey).toHaveBeenCalledOnce();
  });

  it('blocks changed payload without sending or minting another key', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      createIdempotencyKey: () => 'create-logical-attempt-key-0001',
    });
    const createIdempotencyKey = vi.fn().mockReturnValue('create-logical-attempt-key-0002');

    await expect(
      prepareCreateGameAttempt(principal, payload({ capacity: 2 }), storage, locks, {
        createIdempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_PAYLOAD_CHANGED' });
    expect(createIdempotencyKey).not.toHaveBeenCalled();
    expect(loadCreateGameAttempt(principal, storage)?.idempotencyKey).toBe(
      'create-logical-attempt-key-0001',
    );
  });

  it('survives a tab-close style new caller over the same durable storage', async () => {
    const durableStorage = memoryStorage();
    const first = await prepareCreateGameAttempt(
      principal,
      payload(),
      durableStorage,
      serialLocks(),
      { createIdempotencyKey: () => 'create-logical-attempt-key-0001' },
    );

    const reopened = loadCreateGameAttempt(principal, durableStorage);
    expect(reopened).toEqual(first);
    expect(reopened).toMatchObject({
      recoveryState: 'PENDING',
      payload: { title: 'Открытая игра', capacity: 4 },
    });
  });

  it('isolates records by tenant and actor without deleting a foreign attempt', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      createIdempotencyKey: () => 'create-logical-attempt-key-0001',
    });
    const tenantAttempt = await prepareCreateGameAttempt(otherTenant, payload(), storage, locks, {
      createIdempotencyKey: () => 'create-logical-attempt-key-0002',
    });
    const userAttempt = await prepareCreateGameAttempt(otherUser, payload(), storage, locks, {
      createIdempotencyKey: () => 'create-logical-attempt-key-0003',
    });

    expect(tenantAttempt.idempotencyKey).toBe('create-logical-attempt-key-0002');
    expect(userAttempt.idempotencyKey).toBe('create-logical-attempt-key-0003');
    expect(loadCreateGameAttempt(principal, storage)?.idempotencyKey).toBe(
      'create-logical-attempt-key-0001',
    );
    expect(storage.length).toBe(3);
  });

  it('rejects malformed, version-invalid and foreign-principal records', async () => {
    const storage = memoryStorage();
    const key = createGameAttemptStorageKey(principal);
    storage.setItem(key, '{bad-json');
    expect(() => loadCreateGameAttempt(principal, storage)).toThrowError(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );

    storage.setItem(key, JSON.stringify({ version: 1 }));
    expect(() => loadCreateGameAttempt(principal, storage)).toThrowError(
      expect.objectContaining({ code: 'ATTEMPT_MALFORMED' }),
    );

    const attempt = await prepareCreateGameAttempt(
      principal,
      payload(),
      memoryStorage(),
      serialLocks(),
      {
        createIdempotencyKey: () => 'create-logical-attempt-key-0001',
      },
    );
    storage.setItem(key, JSON.stringify({ ...attempt, actorUserId: otherUser.userId }));
    expect(() => loadCreateGameAttempt(principal, storage)).toThrowError(
      expect.objectContaining({ code: 'ATTEMPT_FOREIGN_PRINCIPAL' }),
    );
  });

  it('fails closed when the cross-tab lock is unavailable', async () => {
    await expect(
      prepareCreateGameAttempt(principal, payload(), memoryStorage(), undefined, {
        createIdempotencyKey: () => 'create-logical-attempt-key-0001',
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_LOCK_UNAVAILABLE' });
  });

  it('clears only the matching authoritative attempt and gives a later intent a new key', async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const first = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      createIdempotencyKey: () => 'create-logical-attempt-key-0001',
    });
    await clearCreateGameAttempt(principal, first, storage, locks);
    const second = await prepareCreateGameAttempt(principal, payload(), storage, locks, {
      createIdempotencyKey: () => 'create-logical-attempt-key-0002',
    });

    expect(second.idempotencyKey).toBe('create-logical-attempt-key-0002');
  });

  it('persists only the minimal allowlisted recovery record', async () => {
    const storage = memoryStorage();
    await prepareCreateGameAttempt(principal, payload(), storage, serialLocks(), {
      createIdempotencyKey: () => 'create-logical-attempt-key-0001',
    });
    const raw = storage.getItem(createGameAttemptStorageKey(principal));

    expect(Object.keys(JSON.parse(String(raw)) as Record<string, unknown>).sort()).toEqual([
      'actorUserId',
      'createdAt',
      'idempotencyKey',
      'payload',
      'payloadFingerprint',
      'recoveryState',
      'tenantId',
      'version',
    ]);
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('cookie');
    expect(raw).not.toContain('operationId');
  });
});
