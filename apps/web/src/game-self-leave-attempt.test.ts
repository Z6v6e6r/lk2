import type { AuthGateway } from './auth-gateway.js';
import { describe, it, expect, vi } from 'vitest';
import { GameSelfLeaveAttempts } from './game-self-leave-attempt.js';
const game = '11111111-1111-4111-8111-111111111111',
  operation = '22222222-2222-4222-8222-222222222222';
function setup() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
  const locks = {
    request: async <T>(_n: string, _o: unknown, fn: () => T | PromiseLike<T>) => await fn(),
  };
  const result = {
    commandId: operation,
    operation: {
      id: operation,
      type: 'LEAVE_GAME',
      status: 'UNKNOWN',
      gameId: game,
      aggregateRevision: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 15 },
      error: null,
    },
    game: null,
    replayed: true,
  } as const;
  const gateway = {
    leaveGame: vi.fn<AuthGateway['leaveGame']>().mockResolvedValue(result),
    reconcileManagedLeaveOperation: vi
      .fn<NonNullable<AuthGateway['reconcileManagedLeaveOperation']>>()
      .mockResolvedValue(result),
    getManagedLeaveOperation: vi
      .fn<NonNullable<AuthGateway['getManagedLeaveOperation']>>()
      .mockResolvedValue(result),
  };
  const make = (userId = 'actor') =>
    new GameSelfLeaveAttempts({ tenantId: 'tenant', userId }, storage, locks, gateway);
  return { make, data, gateway, result, storage, locks };
}
describe('SELF leave browser custody', () => {
  it('keeps original key after lost response, reload and UNKNOWN; manual retry never creates a replacement', async () => {
    const x = setup();
    x.gateway.leaveGame.mockRejectedValueOnce(new TypeError('lost response'));
    await expect(x.make().submit(game)).rejects.toThrow();
    const original = x.make().load(game)!;
    await x.make().read(game);
    await x.make().submit(game);
    expect(x.make().load(game)?.idempotencyKey).toBe(original.idempotencyKey);
    expect(x.gateway.leaveGame).toHaveBeenCalledTimes(1);
    expect(x.gateway.reconcileManagedLeaveOperation).toHaveBeenCalledWith(
      game,
      original.idempotencyKey,
    );
    expect(x.gateway.getManagedLeaveOperation).toHaveBeenCalledWith(game, original.idempotencyKey);
  });
  it('404 or malformed/foreign success never releases custody', async () => {
    const x = setup();
    await x.make().submit(game);
    x.gateway.getManagedLeaveOperation.mockRejectedValueOnce(new Error('404'));
    await expect(x.make().read(game)).rejects.toThrow();
    expect(x.make().load(game)).not.toBeNull();
    x.gateway.getManagedLeaveOperation.mockResolvedValueOnce({
      ...x.result,
      operation: { ...x.result.operation, status: 'SUCCEEDED', gameId: operation },
    } as never);
    await expect(x.make().read(game)).rejects.toThrow();
    expect(x.make().load(game)).not.toBeNull();
  });
  it('terminal exact success closes custody; account switch cannot read another account key', async () => {
    const x = setup();
    await x.make().submit(game);
    expect(x.make('other').load(game)).toBeNull();
    x.gateway.getManagedLeaveOperation.mockResolvedValueOnce({
      ...x.result,
      operation: { ...x.result.operation, status: 'SUCCEEDED' },
    } as never);
    await x.make().read(game);
    expect(x.make().load(game)).toBeNull();
  });
  it('fails closed before dispatch when storage is malformed or unavailable', async () => {
    const x = setup();
    await x.make().submit(game);
    const key = [...x.data.keys()][0]!;
    x.data.set(key, '{}');
    await expect(x.make().submit(game)).rejects.toThrow();
    expect(x.gateway.leaveGame).toHaveBeenCalledTimes(1);
  });
});

it('queued custody lock cannot send an old account intent after logout/account switch', async () => {
  const x = setup();
  let active = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locks = {
    request: async <T>(_name: string, _options: unknown, fn: () => T | PromiseLike<T>) => {
      await gate;
      return fn();
    },
  };
  const old = new GameSelfLeaveAttempts(
    { tenantId: 'tenant', userId: 'actor' },
    x.storage,
    locks,
    x.gateway,
    () => active,
  );
  const pending = old.submit(game);
  active = false;
  release();
  await expect(pending).rejects.toThrow('SELF_LEAVE_SCOPE_CHANGED');
  expect(x.gateway.leaveGame).not.toHaveBeenCalled();
  expect(x.data.size).toBe(0);
});
it('a response arriving after account replacement cannot clear or rewrite stored custody', async () => {
  const x = setup();
  let active = true;
  const old = new GameSelfLeaveAttempts(
    { tenantId: 'tenant', userId: 'actor' },
    x.storage,
    x.locks,
    x.gateway,
    () => active,
  );
  let release!: (value: never) => void;
  const response = new Promise<never>((resolve) => {
    release = resolve;
  });
  x.gateway.leaveGame.mockReturnValueOnce(response);
  const pending = old.submit(game);
  await vi.waitFor(() => expect(x.gateway.leaveGame).toHaveBeenCalledOnce());
  const saved = old.load(game);
  active = false;
  release({ ...x.result, operation: { ...x.result.operation, status: 'SUCCEEDED' } } as never);
  await expect(pending).rejects.toThrow('SELF_LEAVE_SCOPE_CHANGED');
  expect(old.load(game)).toEqual(saved);
});

async function refusal(x: ReturnType<typeof setup>, key: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return {
    ...x.result,
    operation: {
      ...x.result.operation,
      status: 'FAILED' as const,
      nextAction: { type: 'NONE' as const },
      error: { code: 'GAME_NOT_LEAVABLE' as const, message: 'synthetic' },
      noDispatch: {
        schemaVersion: 1 as const,
        outcome: 'NOT_DISPATCHED' as const,
        idempotencyKeySha256:
          'sha256:' +
          Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
      },
    },
  };
}
it('exact durable no-dispatch proof closes only its key; next command requires a new explicit choice', async () => {
  const x = setup();
  x.gateway.leaveGame.mockRejectedValueOnce(new Error('unsupported'));
  await expect(x.make().submit(game)).rejects.toThrow();
  const original = x.make().load(game)!;
  x.gateway.reconcileManagedLeaveOperation.mockResolvedValueOnce(
    await refusal(x, original.idempotencyKey),
  );
  await x.make().submit(game);
  expect(x.make().load(game)).toBeNull();
  expect(x.gateway.leaveGame).toHaveBeenCalledTimes(1);
  await x.make().submit(game);
  expect(x.gateway.leaveGame).toHaveBeenCalledTimes(2);
  expect(x.make().load(game)?.idempotencyKey).not.toBe(original.idempotencyKey);
});
it.each(['404', '409', 'FAILED', 'wrong-key', 'extra-proof'])(
  'retains custody for %s without exact durable proof',
  async (condition) => {
    const x = setup();
    await x.make().submit(game);
    const original = x.make().load(game)!;
    if (condition === '404' || condition === '409')
      x.gateway.reconcileManagedLeaveOperation.mockRejectedValueOnce(new Error(condition));
    else {
      const result = await refusal(
        x,
        condition === 'wrong-key' ? 'foreign-key' : original.idempotencyKey,
      );
      if (condition === 'FAILED') delete (result.operation as { noDispatch?: unknown }).noDispatch;
      if (condition === 'extra-proof') Object.assign(result.operation.noDispatch, { extra: true });
      x.gateway.reconcileManagedLeaveOperation.mockResolvedValueOnce(result);
    }
    await x
      .make()
      .submit(game)
      .catch(() => undefined);
    expect(x.make().load(game)?.idempotencyKey).toBe(original.idempotencyKey);
    expect(x.gateway.leaveGame).toHaveBeenCalledTimes(1);
  },
);
it('late refusal cannot clear a replaced custody key', async () => {
  const x = setup();
  await x.make().submit(game);
  const original = x.make().load(game)!;
  let release!: (v: Awaited<ReturnType<typeof refusal>>) => void;
  x.gateway.reconcileManagedLeaveOperation.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = x.make().submit(game);
  await vi.waitFor(() => expect(x.gateway.reconcileManagedLeaveOperation).toHaveBeenCalled());
  const key = [...x.data.keys()][0]!;
  const replacement = { ...original, idempotencyKey: crypto.randomUUID() };
  x.data.set(key, JSON.stringify(replacement));
  release(await refusal(x, original.idempotencyKey));
  await expect(pending).rejects.toThrow('SELF_LEAVE_CUSTODY_CHANGED');
  expect(x.make().load(game)).toEqual(replacement);
});
