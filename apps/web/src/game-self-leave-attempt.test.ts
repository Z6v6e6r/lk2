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
    expect(x.gateway.leaveGame.mock.calls[1]?.[1]).toEqual({
      idempotencyKey: original.idempotencyKey,
    });
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
