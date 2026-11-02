import { afterEach, expect, it, vi } from 'vitest';
import { ApiClientError, type GameCard } from '@phub/api-sdk';
import {
  NativeGameJoinAttempts,
  type NativeJoinGateway,
  type NativeJoinRequest,
} from './native-game-join-attempt.js';
const id = '11111111-1111-4111-8111-111111111111',
  sub = '22222222-2222-4222-8222-222222222222',
  op = '33333333-3333-4333-8333-333333333333';
const conditions = {
  gameId: id,
  revision: 1,
  subscriptionInstanceId: sub,
  eligibility: 'AVAILABLE' as const,
  reasonCode: null,
  subscriptionApplied: true,
  price: {
    status: 'ADVISORY' as const,
    amountMinor: 0,
    currency: 'RUB' as const,
    confirmed: false,
  },
  expiresAt: '2099-01-01T00:00:00Z',
  requiresPriceConsent: true,
};
function receipt(paid = false, status = 'SUCCEEDED') {
  return {
    commandId: op,
    operation: {
      id: op,
      type: 'JOIN_GAME',
      gameId: id,
      status,
      aggregateRevision: 2,
      nextAction: { type: 'NONE' },
      error: null,
      commercial: paid ? { attemptState: 'OWNER_CONFIRMED', receipt: null, reason: null } : null,
    },
    replayed: false,
    game: null,
  };
}
function setup(paid = false) {
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
  let card = {
    id,
    revision: 1,
    allowedActions: ['JOIN'],
    viewerRelation: 'NONE',
    priceSummary: paid ? { amountMinor: 10000, currency: 'RUB' } : null,
  } as GameCard;
  let principal: string | null = 'original',
    tail = Promise.resolve();
  const locks = {
    request: async <T>(_name: string, _o: unknown, fn: () => T | PromiseLike<T>): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise((r) => {
        release = r;
      });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
  const gateway: NativeJoinGateway = {
    principal: () => principal,
    getGame: vi.fn(() => Promise.resolve(card)),
    getHomeDashboard: vi.fn(),
    request: vi.fn((r: NativeJoinRequest) =>
      Promise.resolve(r.resource === 'conditions' ? conditions : receipt(paid)),
    ),
  };
  const make = () =>
    new NativeGameJoinAttempts({ tenantId: 'tenant', userId: 'actor' }, storage, locks, gateway);
  return {
    make,
    gateway,
    data,
    storage,
    card: (v: GameCard) => {
      card = v;
    },
    close: () => {
      principal = null;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
it('free lost ACK keeps exact original body/key; reload is read-only until explicit same-key retry', async () => {
  const x = setup();
  vi.mocked(x.gateway.request).mockRejectedValueOnce(new TypeError('lost ACK'));
  await expect(x.make().submit(id)).rejects.toThrow();
  const original = x.make().load(id)!;
  expect(original.dispatchStarted).toBe(true);
  await x.make().recover(id);
  expect(x.gateway.request).toHaveBeenCalledTimes(1);
  const done = await x.make().recover(id, true);
  expect(done.state).toBe('CONFIRMED');
  expect(x.gateway.request).toHaveBeenLastCalledWith({
    resource: 'join',
    resourceId: id,
    key: original.key,
    body: original.body,
  });
});
it('paid missing ACK/404 never replays JOIN and explicit reconcile binds the observed operation', async () => {
  const x = setup(true),
    c = await x.make().conditions(id, sub);
  vi.mocked(x.gateway.request).mockRejectedValueOnce(new TypeError('lost'));
  await expect(x.make().submit(id, c)).rejects.toThrow();
  const original = x.make().load(id)!;
  vi.mocked(x.gateway.request).mockRejectedValueOnce(
    new ApiClientError('missing', 404, 'GAME_OPERATION_NOT_FOUND', 'synthetic'),
  );
  await expect(x.make().recover(id, true)).rejects.toThrow();
  expect(x.make().load(id)?.key).toBe(original.key);
  vi.mocked(x.gateway.request).mockResolvedValueOnce(receipt(false, 'UNKNOWN'));
  await x.make().recover(id);
  await x.make().recover(id, true);
  expect(x.gateway.request).toHaveBeenLastCalledWith({
    resource: 'reconcile',
    resourceId: op,
    key: `join-reconcile:${op}`,
  });
  expect(
    vi.mocked(x.gateway.request).mock.calls.filter(([r]) => r.resource === 'join'),
  ).toHaveLength(1);
});
it('bare paid SUCCEEDED is not confirmation; receipt-bound owner success is', async () => {
  const x = setup(true),
    c = await x.make().conditions(id, sub);
  vi.mocked(x.gateway.request).mockResolvedValueOnce(receipt(false));
  expect((await x.make().submit(id, c)).state).toBe('PENDING');
  expect((await x.make().recover(id)).state).toBe('CONFIRMED');
});
it('one admission lock rejects concurrent fresh intents before a second POST', async () => {
  const x = setup();
  let release!: (v: unknown) => void;
  vi.mocked(x.gateway.request).mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const first = x.make().submit(id);
  await vi.waitFor(() => expect(release).toBeDefined());
  await expect(x.make().submit(id)).rejects.toThrow('NATIVE_JOIN_PENDING');
  release(receipt());
  await first;
  expect(x.gateway.request).toHaveBeenCalledTimes(1);
});
it('changed revision or expired consent cannot write and cannot downgrade paid to free', async () => {
  const x = setup(true),
    c = await x.make().conditions(id, sub);
  await expect(x.make().submit(id, { ...c, expiresAt: '2000-01-01T00:00:00Z' })).rejects.toThrow();
  await expect(x.make().submit(id)).rejects.toThrow();
  expect(x.data.size).toBe(0);
  x.card({
    id,
    revision: 2,
    allowedActions: ['JOIN'],
    priceSummary: { amountMinor: 20000, currency: 'RUB' },
  } as GameCard);
  await expect(x.make().submit(id, c)).rejects.toThrow();
  expect(x.gateway.request).toHaveBeenCalledTimes(1);
});
it('pending SELF LEAVE and missing durable storage prevent new JOIN', async () => {
  const x = setup();
  x.data.set(`phub.self-leave.v1:tenant:actor:${id}`, '{}');
  await expect(x.make().submit(id)).rejects.toThrow('NATIVE_JOIN_PENDING_LEAVE');
  x.data.clear();
  vi.spyOn(x.storage, 'setItem').mockImplementation(() => {
    throw new Error('full');
  });
  await expect(x.make().submit(id)).rejects.toThrow();
  expect(x.gateway.request).not.toHaveBeenCalled();
});
it('foreign operation or changed local mode cannot clear original custody', async () => {
  const x = setup();
  vi.mocked(x.gateway.request).mockResolvedValueOnce({
    ...receipt(),
    operation: { ...receipt().operation, gameId: sub },
  });
  await expect(x.make().submit(id)).rejects.toThrow();
  expect(x.make().load(id)?.state).toBe('PENDING');
  const [key, value] = [...x.data][0]!;
  x.data.set(key, JSON.stringify({ ...JSON.parse(value), paid: true }));
  expect(() => x.make().load(id)).toThrow('NATIVE_JOIN_CUSTODY_INVALID');
});
it('completed JOIN cannot reopen on projection lag; observed membership then fresh leave revision enables a new intent', async () => {
  const x = setup();
  const first = await x.make().submit(id);
  await expect(x.make().submit(id)).rejects.toThrow('NATIVE_JOIN_PROJECTION_PENDING');
  x.card({
    id,
    revision: 2,
    allowedActions: ['LEAVE'],
    viewerRelation: 'PARTICIPANT',
    priceSummary: null,
  } as GameCard);
  await x.make().recover(id);
  x.card({
    id,
    revision: 3,
    allowedActions: ['JOIN'],
    viewerRelation: 'NONE',
    priceSummary: null,
  } as GameCard);
  const second = await x.make().submit(id);
  expect(second.key).not.toBe(first.key);
});
it('known pre-dispatch price refusal releases only for a new explicit conditions/consent flow', async () => {
  const x = setup(true),
    c = await x.make().conditions(id, sub);
  vi.mocked(x.gateway.request).mockRejectedValueOnce(
    new ApiClientError('price changed', 409, 'GAME_PRICE_CONFIRMATION_REQUIRED', 'synthetic'),
  );
  expect((await x.make().submit(id, c)).state).toBe('REJECTED');
});
it.each(['GAME_PAYMENT_REQUIRED', 'GAME_SERVICE_BLOCKED'])(
  'paid recovery %s is not evidence of non-dispatch',
  async (code) => {
    const x = setup(true),
      c = await x.make().conditions(id, sub);
    vi.mocked(x.gateway.request).mockRejectedValueOnce(new TypeError('lost'));
    await expect(x.make().submit(id, c)).rejects.toThrow();
    const key = x.make().load(id)!.key;
    vi.mocked(x.gateway.request).mockRejectedValueOnce(
      new ApiClientError('owner disabled', 409, code, 'synthetic'),
    );
    await expect(x.make().recover(id)).rejects.toThrow();
    expect(x.make().load(id)?.state).toBe('PENDING');
    expect(x.make().load(id)?.key).toBe(key);
    await expect(x.make().submit(id, c)).rejects.toThrow('NATIVE_JOIN_PENDING');
  },
);
it('late recovery UNKNOWN cannot downgrade an already confirmed operation', async () => {
  const x = setup(true),
    c = await x.make().conditions(id, sub);
  vi.mocked(x.gateway.request).mockResolvedValueOnce(receipt(false, 'UNKNOWN'));
  await x.make().submit(id, c);
  let finish!: (v: unknown) => void;
  vi.mocked(x.gateway.request).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const late = x.make().recover(id);
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect((await x.make().recover(id)).state).toBe('CONFIRMED');
  finish(receipt(false, 'UNKNOWN'));
  expect((await late).state).toBe('CONFIRMED');
});
it('lagging membership and outsider projections below the confirmed aggregate cannot authorize a fresh key', async () => {
  const x = setup();
  vi.mocked(x.gateway.request).mockResolvedValueOnce({
    ...receipt(),
    operation: { ...receipt().operation, aggregateRevision: 10 },
  });
  await x.make().submit(id);
  x.card({
    id,
    revision: 2,
    allowedActions: ['LEAVE'],
    viewerRelation: 'PARTICIPANT',
    priceSummary: null,
  } as GameCard);
  await x.make().recover(id);
  expect(x.make().load(id)?.membershipRevision).toBeUndefined();
  x.card({
    id,
    revision: 3,
    allowedActions: ['JOIN'],
    viewerRelation: 'NONE',
    priceSummary: null,
  } as GameCard);
  await expect(x.make().submit(id)).rejects.toThrow('NATIVE_JOIN_PROJECTION_PENDING');
  expect(x.gateway.request).toHaveBeenCalledTimes(1);
});
it('two recovery reads started without operation ID cannot replace the first bound operation', async () => {
  const x = setup(true),
    c = await x.make().conditions(id, sub);
  vi.mocked(x.gateway.request).mockRejectedValueOnce(new TypeError('lost'));
  await expect(x.make().submit(id, c)).rejects.toThrow();
  let finish!: (v: unknown) => void;
  vi.mocked(x.gateway.request).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const late = x.make().recover(id),
    denied = expect(late).rejects.toThrow('NATIVE_JOIN_RESPONSE_INVALID');
  await vi.waitFor(() => expect(finish).toBeDefined());
  await x.make().recover(id);
  const other = '44444444-4444-4444-8444-444444444444';
  finish({
    ...receipt(true),
    commandId: other,
    operation: { ...receipt(true).operation, id: other },
  });
  await denied;
  expect(x.make().load(id)).toMatchObject({ operationId: op, state: 'CONFIRMED' });
});
