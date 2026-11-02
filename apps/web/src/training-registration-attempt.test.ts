import { it, expect, vi } from 'vitest';
import { TrainingRegistrationAttempts } from './training-registration-attempt.js';
import type { TrainingRegistrationResult } from '@phub/api-contracts';
type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`;
function setup() {
  const memory = new Map<string, string>();
  let current = true;
  const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memory.set(k, v);
      },
      removeItem: (k: string) => {
        memory.delete(k);
      },
    },
    result: Mutable<TrainingRegistrationResult> = {
      trainingId: id(3),
      subscriptionId: id(4),
      dateHint: '2035-04-02',
      operation: { id: id(5), status: 'UNKNOWN' },
      registration: { status: 'UNKNOWN', asOf: null },
      retryAfterSeconds: 15,
    };
  const gateway = {
    registerTraining: vi.fn<
      (
        id: string,
        input: { dateHint: string; subscriptionId: string },
        key: string,
      ) => Promise<TrainingRegistrationResult>
    >(() => Promise.resolve(result)),
    getTrainingRegistration: vi.fn(() => Promise.resolve(result)),
  };
  const locks = {
    request: async <T>(_n: string, _o: unknown, cb: () => T | PromiseLike<T>) => await cb(),
  };
  const a = new TrainingRegistrationAttempts(
    { tenantId: id(1), userId: id(2) },
    storage,
    locks,
    gateway,
    () => current,
  );
  return {
    a,
    memory,
    storage,
    gateway,
    result,
    locks,
    expire: () => {
      current = false;
    },
  };
}
it('persists one original key before HTTP and keeps it through loss, reload and observed confirmation', async () => {
  const h = setup();
  h.gateway.registerTraining.mockImplementationOnce(async () => {
    await Promise.resolve();
    expect(h.memory.size).toBe(1);
    throw new Error('offline');
  });
  await expect(
    h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) }),
  ).rejects.toThrow();
  const key = h.a.load(id(3))!.idempotencyKey;
  await h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) });
  expect(h.gateway.registerTraining.mock.calls[1]?.[2]).toBe(key);
  h.result.operation.status = 'CONFIRMED';
  h.result.registration = { status: 'CONFIRMED', asOf: '2035-04-01T10:00:00.000Z' };
  await h.a.read(id(3));
  expect(h.a.load(id(3))?.idempotencyKey).toBe(key);
  await expect(
    h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(6) }),
  ).rejects.toThrow('TRAINING_ORIGINAL_ATTEMPT_REQUIRED');
});
it('only exact expired-no-dispatch proof clears matching custody, not malformed/unknown', async () => {
  const h = setup();
  await h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) });
  h.result.operation.status = 'EXPIRED_NOT_DISPATCHED';
  await expect(h.a.read(id(3))).rejects.toThrow('TRAINING_RESPONSE_INVALID');
  expect(h.memory.size).toBe(1);
  h.result.retryAfterSeconds = null;
  await h.a.read(id(3));
  expect(h.memory.size).toBe(0);
});
it('account change while queued for lock or awaiting response cannot dispatch/commit', async () => {
  const h = setup();
  const key = h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) });
  h.expire();
  await expect(key).rejects.toThrow('TRAINING_ACCOUNT_CHANGED');
  expect(h.gateway.registerTraining).not.toHaveBeenCalled();
});
it('same target concurrent clicks converge on same key and changed target response is denied', async () => {
  const h = setup();
  await Promise.all([
    h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) }),
    h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) }),
  ]);
  expect(new Set(h.gateway.registerTraining.mock.calls.map((c) => c[2])).size).toBe(1);
  h.result.trainingId = id(8);
  await expect(h.a.read(id(3))).rejects.toThrow();
  expect(h.memory.size).toBe(1);
});

it('explicit refusal needs exact matching terminal proof; missing owner or foreign operation never clears custody', async () => {
  const h = setup();
  await h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) });
  const key = h.a.load(id(3))!.idempotencyKey;
  h.gateway.getTrainingRegistration.mockRejectedValueOnce(new Error('404 no owner'));
  await expect(h.a.read(id(3))).rejects.toThrow();
  expect(h.a.load(id(3))!.idempotencyKey).toBe(key);
  h.result.operation.status = 'REJECTED_NOT_DISPATCHED';
  h.result.operation.id = id(8);
  h.result.retryAfterSeconds = null;
  await expect(h.a.read(id(3))).rejects.toThrow();
  expect(h.memory.size).toBe(1);
  h.result.operation.id = id(5);
  await h.a.read(id(3));
  expect(h.memory.size).toBe(0);
  h.result.operation.status = 'UNKNOWN';
  h.result.retryAfterSeconds = 15;
  await h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) });
  expect(h.a.load(id(3))!.idempotencyKey).not.toBe(key);
});
it('accepts fresh confirmed observation with unfinished operation without releasing original custody', async () => {
  const h = setup();
  await h.a.submit(id(3), { dateHint: '2035-04-02', subscriptionId: id(4) });
  h.result.registration = { status: 'CONFIRMED', asOf: '2035-04-01T10:00:00.000Z' };
  const result = await h.a.read(id(3));
  expect(result?.operation.status).toBe('UNKNOWN');
  expect(result?.registration.status).toBe('CONFIRMED');
  expect(h.memory.size).toBe(1);
});
