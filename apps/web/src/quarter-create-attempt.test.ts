import { webcrypto } from 'node:crypto';
import { qcDraftId, qcHash, qcOperationId } from '@phub/domain/quarter-create';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthGateway } from './auth-gateway.js';
import {
  QuarterCreateAttempts,
  quarterStorageKey,
  quarterOperationId,
  quarterDraftId,
  validateQuarterView,
  type QuarterCustody,
} from './quarter-create-attempt.js';
import type { CreateGameAttemptLockManager } from './create-game-attempt.js';
import type { QuarterCreateResult } from '@phub/api-contracts';
const principal = {
    tenantId: '11111111-1111-4111-8111-000000000001',
    userId: '11111111-1111-4111-8111-000000000002',
  },
  input = {
    stationId: '11111111-1111-4111-8111-000000000003',
    courtId: '11111111-1111-4111-8111-000000000004',
    subscriptionId: '11111111-1111-4111-8111-000000000005',
    startsAt: '2030-01-01T12:00:00.000Z',
  };
function storage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (n) => [...m.keys()][n] ?? null,
    get length() {
      return m.size;
    },
  };
}
const locks: CreateGameAttemptLockManager = {
  request: async (_n, _o, fn) => {
    await Promise.resolve();
    return fn();
  },
};
async function result(
  c: QuarterCustody,
  status: QuarterCreateResult['operation']['status'] = 'UNKNOWN',
): Promise<QuarterCreateResult> {
  const h = Array.from(
    new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(c.key))),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  return {
    contractVersion: 1,
    request: c.request,
    keySha256: 'sha256:' + h,
    operation: {
      id: await quarterOperationId(c),
      draftId: await quarterDraftId(c),
      status,
    },
    gameProjection: { status: 'PENDING', gameId: null },
    registration: { status: 'UNKNOWN', asOf: null },
    reason: null,
  };
}
function setup() {
  let current = true;
  const s = storage(),
    gateway = {
      quarterCreatePrincipal: () => `${principal.tenantId}:${principal.userId}:0:0`,
      getQuarterCreateCapability: vi.fn(async () => {
        await Promise.resolve();
        return {
          contractVersion: 1 as const,
          available: true,
        };
      }),
      createQuarterGame: vi.fn(async () => {
        await Promise.resolve();
        return result(JSON.parse(s.getItem(quarterStorageKey(principal))!) as QuarterCustody);
      }),
      getQuarterCreateOperation: vi.fn(async () => {
        await Promise.resolve();
        return result(JSON.parse(s.getItem(quarterStorageKey(principal))!) as QuarterCustody);
      }),
      reconcileQuarterCreateOperation: vi.fn(async () => {
        await Promise.resolve();
        return result(JSON.parse(s.getItem(quarterStorageKey(principal))!) as QuarterCustody);
      }),
    };
  const attempts = new QuarterCreateAttempts(
    principal,
    s,
    locks,
    gateway as unknown as AuthGateway,
    () => current,
  );
  return {
    s,
    gateway,
    attempts,
    logout: () => {
      current = false;
    },
  };
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
describe('quarter CREATE durable browser custody', () => {
  it('matches server draft and operation identity domains for the exact original key', async () => {
    const c = { ...principal, key: 'synthetic-original-key-identity' };
    const keyHash = await qcHash(c.key);
    expect(await quarterOperationId(c)).toBe(await qcOperationId(c.tenantId, c.userId, keyHash));
    expect(await quarterDraftId(c)).toBe(await qcDraftId(c.tenantId, c.userId, keyHash));
  });
  it('persists original key/body/id before HTTP and never submits again while unknown', async () => {
    const t = setup();
    await t.attempts.submit(input);
    const c = t.attempts.load()!;
    expect(c.operationId).toBe(await quarterOperationId(c));
    expect(t.gateway.createQuarterGame).toHaveBeenCalledWith(input, c.key);
    await expect(t.attempts.submit(input)).rejects.toThrow('QUARTER_ORIGINAL_EXISTS');
    await t.attempts.recover();
    expect(t.gateway.reconcileQuarterCreateOperation).toHaveBeenCalledWith(
      c.operationId,
      input,
      c.key,
    );
    expect(t.gateway.createQuarterGame).toHaveBeenCalledOnce();
  });
  it('missing capability creates no key or mutation; storage failure also prevents HTTP', async () => {
    const t = setup();
    t.gateway.getQuarterCreateCapability.mockResolvedValue({
      contractVersion: 1,
      available: false,
    });
    await expect(t.attempts.submit(input)).rejects.toThrow();
    expect(t.s.length).toBe(0);
    expect(t.gateway.createQuarterGame).not.toHaveBeenCalled();
    t.gateway.getQuarterCreateCapability.mockResolvedValue({ contractVersion: 1, available: true });
    t.s.setItem = () => {
      throw new Error('denied');
    };
    await expect(t.attempts.submit(input)).rejects.toThrow();
    expect(t.gateway.createQuarterGame).not.toHaveBeenCalled();
  });
  it('401/network/lost ACK and old-server404 keep exact original custody with no auto retry', async () => {
    const t = setup();
    t.gateway.createQuarterGame.mockRejectedValueOnce(new Error('401'));
    await expect(t.attempts.submit(input)).rejects.toThrow();
    const c = t.attempts.load();
    t.gateway.getQuarterCreateOperation.mockRejectedValueOnce(new Error('404'));
    await expect(t.attempts.read()).rejects.toThrow();
    expect(t.attempts.load()).toEqual(c);
    expect(t.gateway.createQuarterGame).toHaveBeenCalledOnce();
  });
  it('logout during capability prevents custody and HTTP', async () => {
    const t = setup();
    t.gateway.getQuarterCreateCapability.mockImplementation(async () => {
      await Promise.resolve();
      t.logout();
      return { contractVersion: 1, available: true };
    });
    await expect(t.attempts.submit(input)).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    expect(t.s.length).toBe(0);
    expect(t.gateway.createQuarterGame).not.toHaveBeenCalled();
  });
  it('late success after account change never overwrites custody or acknowledges new account', async () => {
    const t = setup();
    t.gateway.createQuarterGame.mockImplementation(async () => {
      const r = await result(t.attempts.load()!, 'CONFIRMED');
      t.logout();
      return r;
    });
    await expect(t.attempts.submit(input)).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    expect(t.attempts.load()?.key).toBeDefined();
    await expect(t.attempts.recover()).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
    expect(t.gateway.reconcileQuarterCreateOperation).not.toHaveBeenCalled();
  });
  it('only exact durable terminal proof allows explicit replacement; original proof retained', async () => {
    const t = setup(),
      unknown = await t.attempts.submit(input),
      c = t.attempts.load()!;
    await expect(t.attempts.chooseNew(unknown)).rejects.toThrow();
    const refused = await result(c, 'REFUSED_NOT_DISPATCHED');
    await expect(
      t.attempts.chooseNew({ ...refused, keySha256: 'sha256:' + '0'.repeat(64) }),
    ).rejects.toThrow();
    expect(t.attempts.load()).toEqual(c);
    await t.attempts.chooseNew(refused);
    expect(t.attempts.load()).toBeNull();
    expect(t.s.getItem(quarterStorageKey(principal) + ':terminal:' + c.key)).toContain(
      'REFUSED_NOT_DISPATCHED',
    );
    expect(t.gateway.createQuarterGame).toHaveBeenCalledOnce();
  });
  it('rejects extra private IDs, wrong tuple and invented game projection', async () => {
    const t = setup(),
      v = await t.attempts.submit(input),
      c = t.attempts.load()!;
    for (const raw of [
      { ...v, providerExerciseId: 'synthetic-private' },
      { ...v, operation: { ...v.operation, status: ['UNKNOWN'] } },
      { ...v, gameProjection: { status: ['PENDING'], gameId: null } },
      { ...v, registration: { status: ['UNKNOWN'], asOf: null } },
      { ...v, request: { ...input, courtId: input.stationId } },
      { ...v, gameProjection: { status: 'AVAILABLE', gameId: input.courtId } },
    ])
      await expect(validateQuarterView(raw, c)).rejects.toThrow();
  });
  it('completed projected game requires explicit archive and a different target; history quota failure keeps current', async () => {
    const t = setup();
    await t.attempts.submit(input);
    const c = t.attempts.load()!,
      pending = await result(c, 'CONFIRMED');
    await expect(t.attempts.chooseAnother(pending)).rejects.toThrow();
    const confirmed = {
      ...pending,
      gameProjection: { status: 'AVAILABLE' as const, gameId: input.courtId },
    };
    const originalSet = t.s.setItem.bind(t.s);
    t.s.setItem = () => {
      throw new Error('quota');
    };
    await expect(t.attempts.chooseAnother(confirmed)).rejects.toThrow('quota');
    expect(t.attempts.load()).toEqual(c);
    t.s.setItem = originalSet;
    await t.attempts.chooseAnother(confirmed);
    expect(t.attempts.load()).toBeNull();
    await expect(t.attempts.submit(input)).rejects.toThrow('QUARTER_DIFFERENT_TARGET_REQUIRED');
    expect(t.gateway.createQuarterGame).toHaveBeenCalledOnce();
    await t.attempts.submit({ ...input, startsAt: '2030-01-02T12:00:00.000Z' });
    expect(t.gateway.createQuarterGame).toHaveBeenCalledTimes(2);
  });
  it('reload only reads original operation; no fresh POST or key', async () => {
    const t = setup();
    await t.attempts.submit(input);
    const c = t.attempts.load(),
      reloaded = new QuarterCreateAttempts(
        principal,
        t.s,
        locks,
        t.gateway as unknown as AuthGateway,
        () => true,
      );
    await reloaded.read();
    expect(reloaded.load()).toEqual(c);
    expect(t.gateway.createQuarterGame).toHaveBeenCalledOnce();
  });
});
