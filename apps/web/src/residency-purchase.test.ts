import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  isDefinitiveCreateRefusal,
  listResidencyAttempts,
  newResidencyAttempt,
  parseClientResidencyStatus,
  parseResidencyOrder,
  removeResidencyAttempt,
  residencyOrderPhase,
  residencyStatusView,
  saveResidencyAttempt,
  type ResidencyOrder,
} from './residency-purchase.js';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}
const A = { tenantId: 't', userId: 'a' };
const B = { tenantId: 't', userId: 'b' };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const order = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  orderId: '00000000-0000-4000-8000-0000000000d1',
  mode: 'NEW',
  state: 'PENDING_PAYMENT',
  product: { title: 'x', productId: '4037a3a3-e551-4f9a-a9db-1410e46b8635' },
  consent: null,
  recovery: {
    state: 'AWAITING_PAYMENT',
    required: true,
    reason: null,
    action: 'PAY',
    retryable: true,
    since: '2026-11-18T09:00:00Z',
  },
  pricing: { totalMinor: 79000, currency: 'RUB' },
  payment: {
    overdue: false,
    status: 'PENDING',
    paymentUrl: 'https://bank.example.test/p',
    expiresAt: null,
  },
  activation: { lastErrorCode: null },
  residency: null,
  ...over,
});
const apiError = (status: number, code: string) => new ApiClientError(code, status, code, 'c');

describe('status validation (D-2)', () => {
  it('rejects an HTML shell or junk instead of treating it as a status', () => {
    expect(() => parseClientResidencyStatus('<!doctype html>')).toThrow();
    expect(() => parseClientResidencyStatus({ state: 'ACTIVE' })).toThrow();
    expect(() =>
      parseClientResidencyStatus({
        state: 'ACTIVE',
        validFrom: null,
        validUntil: '<b>',
        checkedAt: '2026-11-18T08:00:00.000Z',
        unavailableReason: null,
        holder: null,
      }),
    ).toThrow();
  });
  it('accepts the ADR 0027 shape', () => {
    const s = parseClientResidencyStatus({
      state: 'ACTIVE',
      validFrom: '2026-11-01',
      validUntil: '2026-12-01',
      checkedAt: '2026-11-18T08:00:00.000Z',
      unavailableReason: null,
      holder: null,
    });
    expect(residencyStatusView(s).kind).toBe('active');
  });
});

describe('create refusal classification', () => {
  it.each([
    'RESIDENCY_ORDER_ALREADY_PENDING',
    'RESIDENCY_RENEWAL_REQUIRED',
    'RESIDENCY_RENEWAL_NOT_ELIGIBLE',
    'RESIDENCY_STATUS_UNAVAILABLE',
    'RESIDENCY_CATALOG_UNAVAILABLE',
  ])('%s proves no order exists for the key', (code) => {
    expect(isDefinitiveCreateRefusal(apiError(409, code))).toBe(true);
  });
  it.each([
    apiError(409, 'RESIDENCY_IDEMPOTENCY_CONFLICT'),
    apiError(409, 'RESIDENCY_ORDER_CONFLICT'),
    apiError(429, 'RESIDENCY_RATE_LIMITED'),
    apiError(401, 'AUTH_REQUIRED'),
    apiError(503, 'RESIDENCY_ORDERS_DISABLED'),
    new TypeError('Failed to fetch'),
    new SyntaxError('Unexpected token <'),
  ])('%s keeps the original key', (error) => {
    expect(isDefinitiveCreateRefusal(error)).toBe(false);
  });
});

describe('order DTO', () => {
  it('rejects a non-https link and an unnormalized internal payment status', () => {
    expect(() =>
      parseResidencyOrder(
        order({
          payment: {
            overdue: false,
            status: 'PENDING',
            paymentUrl: 'javascript:alert(1)',
            expiresAt: null,
          },
        }),
      ),
    ).toThrow();
    // The owner must expose DISPATCHING as UNKNOWN; an incompatible DTO is not masked.
    expect(() =>
      parseResidencyOrder(order({ payment: { status: 'DISPATCHING', expiresAt: null } })),
    ).toThrow();
  });
  it('requires the residency window on ACTIVE', () => {
    expect(() => parseResidencyOrder(order({ state: 'ACTIVE' }))).toThrow();
  });
});

describe('phase mapping', () => {
  const attempt = { ...newResidencyAttempt(A, 'NEW', 79000, uuid), orderId: 'x' };
  const parse = (over: Record<string, unknown>): ResidencyOrder => parseResidencyOrder(order(over));
  it('an unknown provider outcome is uncertain, not failed or cancelled', () => {
    expect(
      residencyOrderPhase(
        attempt,
        parse({
          state: 'CANCELLED',
          payment: { overdue: false, status: 'UNKNOWN', expiresAt: null },
          activation: { lastErrorCode: 'DISPATCH_OUTCOME_UNKNOWN' },
        }),
        null,
      ),
    ).toBe('uncertain');
  });
  it('a declined payment and a user cancel are known failures', () => {
    expect(
      residencyOrderPhase(
        attempt,
        parse({
          state: 'PAYMENT_FAILED',
          payment: { overdue: false, status: 'FAILED', expiresAt: null },
        }),
        null,
      ),
    ).toBe('failed');
    expect(
      residencyOrderPhase(
        attempt,
        parse({ state: 'CANCELLED', payment: { overdue: false, status: 'NONE', expiresAt: null } }),
        null,
      ),
    ).toBe('failed');
  });
  it('an old ACTIVE read does not confirm a renewed period', () => {
    const active = parse({
      state: 'ACTIVE',
      mode: 'RENEWAL',
      payment: { overdue: false, status: 'PAID', expiresAt: null },
      residency: { validUntil: '2026-12-31T09:00:00.000Z' },
    });
    const old = { kind: 'active' as const, validFrom: null, validUntil: '2026-12-01' };
    const fresh = { kind: 'active' as const, validFrom: null, validUntil: '2026-12-31' };
    expect(residencyOrderPhase(attempt, active, old)).toBe('confirming');
    expect(residencyOrderPhase(attempt, active, fresh)).toBe('activated');
  });
});

describe('attempt storage', () => {
  it('keeps attempts per key and per account; removing one never touches another', () => {
    const s = new MemoryStorage();
    const a1 = newResidencyAttempt(A, 'NEW', 79000, uuid);
    const a2 = newResidencyAttempt(A, 'NEW', 79000, uuid);
    const b1 = newResidencyAttempt(B, 'NEW', 79000, uuid);
    [a1, a2, b1].forEach((a) => saveResidencyAttempt(s, a));
    removeResidencyAttempt(s, a2);
    expect(listResidencyAttempts(s, A).map((a) => a.key)).toEqual([a1.key]);
    expect(listResidencyAttempts(s, B).map((a) => a.key)).toEqual([b1.key]);
  });
  it('fails closed on a tampered entry', () => {
    const s = new MemoryStorage();
    const a1 = newResidencyAttempt(A, 'NEW', 79000, uuid);
    saveResidencyAttempt(s, a1);
    s.setItem(`phub.residency-order.v3:t:a:${a1.key}`, JSON.stringify({ ...a1, userId: 'b' }));
    expect(() => listResidencyAttempts(s, A)).toThrow();
  });
});

describe('SDK transport', () => {
  it('sends the caller key on every command and never retries a residency POST', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    const client = new PadlHubApiClient({
      baseUrl: 'https://lk2.synthetic.test',
      tenantKey: 'synthetic',
      initialAccessToken: 'synthetic-token:a',
      platform: 'web',
      appVersion: 'test',
      sessionMode: 'memory',
      fetchImplementation,
    });
    const key = 'residency:00000000-0000-4000-8000-000000000001';
    await expect(
      client.createResidencyOrder({ mode: 'NEW', expectedTotalMinor: 79000 }, key),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.reconcileResidencyOrder('o', 'residency-reconcile:k-0000001'),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.cancelResidencyOrder('o', 'residency-cancel:k-00000001'),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    const sent = fetchImplementation.mock.calls.map(([url, init]) => ({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      key: (init?.headers as Record<string, string>)['Idempotency-Key'],
    }));
    expect(sent[0]).toEqual({
      url: 'https://lk2.synthetic.test/user/api/v1/synthetic/residency/orders',
      key,
    });
    expect(sent[1]!.url).toMatch(/\/residency\/orders\/o\/reconcile$/);
    expect(sent[2]!.url).toMatch(/\/residency\/orders\/o\/cancel$/);
    expect(sent.every((s) => typeof s.key === 'string')).toBe(true);
  });
});
