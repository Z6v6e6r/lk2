// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientResidencyStatus } from '@phub/api-sdk';

import { ResidencyPage } from './ResidencyPage.js';
import {
  residencyStorageKey,
  type ResidencyGateway,
  type ResidencyOrderState,
} from './residency-purchase.js';

// Synthetic fixtures only. The fake owner mirrors the semantics of the LK1 residency lifecycle
// contract (Z6v6e6r/lk#443): one key -> one order, one unresolved order per user, payment
// outcome only through reconcile, ACTIVE carries the residency window.
const principal = {
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  userId: '00000000-0000-4000-8000-0000000000b1',
};
const other = { ...principal, userId: '00000000-0000-4000-8000-0000000000b2' };
const PRODUCT = '00000000-0000-4000-8000-0000000000c1';

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

const status = (s: Partial<ClientResidencyStatus>): ClientResidencyStatus => ({
  state: 'NONE',
  validFrom: null,
  validUntil: null,
  checkedAt: '2026-11-18T08:00:00.000Z',
  unavailableReason: null,
  holder: null,
  ...s,
});
const catalog = (priceMinor = 123400) => ({
  schemaVersion: 1,
  product: {
    productId: PRODUCT,
    title: 'Синтетический продукт',
    termDays: 30,
    priceMinor,
    currency: 'RUB',
    benefits: ['Синтетическое преимущество'],
  },
  renewalEligible: false,
  checkedAt: '2026-11-18T09:00:00.000Z',
});
const apiError = (httpStatus: number, code: string) =>
  Object.assign(new Error(code), { status: httpStatus, code, correlationId: 'corr-synthetic' });

interface Order {
  orderId: string;
  mode: 'NEW' | 'RENEWAL';
  state: ResidencyOrderState;
  paymentStatus: 'NONE' | 'PENDING' | 'PAID' | 'FAILED' | 'UNKNOWN';
  paymentUrl: string;
}
const UNRESOLVED: readonly ResidencyOrderState[] = [
  'PENDING_PAYMENT',
  'PAID',
  'PAID_ACTIVATION_PENDING',
];

function fakeOwner(opts: { residency?: ClientResidencyStatus | Error; catalog?: unknown } = {}) {
  let residency = opts.residency ?? status({});
  let catalogBody: unknown = opts.catalog ?? catalog();
  const orders = new Map<string, Order>(); // by idempotency key
  let seq = 0;
  let nextReconcile: Partial<Order> | null = null;
  const view = (o: Order) => ({
    schemaVersion: 1,
    orderId: o.orderId,
    mode: o.mode,
    state: o.state,
    product: { productId: PRODUCT, title: 'Синтетический продукт', termDays: 30, currency: 'RUB' },
    pricing: { baseAmountMinor: 123400, discountLines: [], totalMinor: 123400, currency: 'RUB' },
    payment: {
      status: o.paymentStatus,
      providerTransactionId: null,
      paymentUrl: o.paymentStatus === 'PENDING' ? o.paymentUrl : null,
      expiresAt: '2099-01-01T09:20:00.000Z',
      instruction: null,
    },
    activation: { state: 'NOT_STARTED', attempts: 0, lastErrorCode: null },
    residency:
      o.state === 'ACTIVE'
        ? {
            state: 'ACTIVE',
            validFrom: '2026-11-18T09:05:00.000Z',
            validUntil: '2026-12-18T09:05:00.000Z',
            source: 'CUP_RESIDENCY_POLICY',
            observedAt: '2026-11-18T09:06:00.000Z',
          }
        : null,
    createdAt: '2026-11-18T09:00:00.000Z',
    updatedAt: '2026-11-18T09:00:00.000Z',
    revision: 1,
  });
  const byId = (id: string) => {
    const o = [...orders.values()].find((x) => x.orderId === id);
    if (!o) throw apiError(404, 'RESIDENCY_ORDER_NOT_FOUND');
    return o;
  };
  const gateway = {
    residencyPrincipal: vi.fn(() => 'p1'),
    getClientResidency: vi.fn(() =>
      residency instanceof Error ? Promise.reject(residency) : Promise.resolve(residency),
    ),
    getResidencyCatalog: vi.fn(() =>
      catalogBody instanceof Error ? Promise.reject(catalogBody) : Promise.resolve(catalogBody),
    ),
    createResidencyOrder: vi.fn((mode: 'NEW' | 'RENEWAL', key: string): Promise<unknown> => {
      const replay = orders.get(key);
      if (replay) {
        if (replay.mode !== mode)
          return Promise.reject(apiError(409, 'RESIDENCY_IDEMPOTENCY_CONFLICT'));
        return Promise.resolve({ schemaVersion: 1, order: view(replay), idempotentReplay: true });
      }
      if ([...orders.values()].some((o) => UNRESOLVED.includes(o.state)))
        return Promise.reject(apiError(409, 'RESIDENCY_ORDER_ALREADY_PENDING'));
      seq += 1;
      const orderId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      const o: Order = {
        orderId,
        mode,
        state: 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
        paymentUrl: 'https://pay.example.test/s/' + orderId,
      };
      orders.set(key, o);
      return Promise.resolve({ schemaVersion: 1, order: view(o), idempotentReplay: false });
    }),
    getResidencyOrder: vi.fn((id: string) => Promise.resolve(view(byId(id)))),
    getResidencyOrderPayment: vi.fn((id: string) => {
      const o = byId(id);
      return Promise.resolve({
        schemaVersion: 1,
        orderId: id,
        state: o.state,
        paymentStatus: o.paymentStatus,
        paymentUrl: o.paymentStatus === 'PENDING' ? o.paymentUrl : null,
        expiresAt: '2099-01-01T09:20:00.000Z',
        instruction: null,
      });
    }),
    reconcileResidencyOrder: vi.fn((id: string) => {
      const o = byId(id);
      if (nextReconcile) Object.assign(o, nextReconcile);
      return Promise.resolve({
        schemaVersion: 1,
        order: view(o),
        idempotentReplay: false,
        retryable: o.state !== 'ACTIVE',
      });
    }),
    cancelResidencyOrder: vi.fn((id: string) => {
      const o = byId(id);
      if (o.paymentStatus === 'PAID') return Promise.reject(apiError(409, 'RESIDENCY_ORDER_PAID'));
      o.state = 'CANCELLED';
      o.paymentStatus = 'NONE';
      return Promise.resolve({ schemaVersion: 1, order: view(o), idempotentReplay: false });
    }),
    openResidencyPayment: vi.fn(),
  } satisfies ResidencyGateway;
  return {
    gateway,
    orders,
    setResidency(s: ClientResidencyStatus | Error) {
      residency = s;
    },
    setCatalog(c: unknown) {
      catalogBody = c;
    },
    /** What the provider says the next time the owner reconciles. */
    onReconcile(change: Partial<Order>) {
      nextReconcile = change;
    },
    /** The owner issues this link for the next order it creates. */
    nextLink: (url: string) => {
      const real = gateway.createResidencyOrder.getMockImplementation()!;
      gateway.createResidencyOrder.mockImplementationOnce(async (mode, key) => {
        await real(mode, key);
        orders.get(key)!.paymentUrl = url;
        return real(mode, key);
      });
    },
  };
}

let uuidSeq = 0;
const randomUuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;

function mount(
  owner: ReturnType<typeof fakeOwner>,
  storage = new MemoryStorage(),
  who = principal,
) {
  render(
    <ResidencyPage
      gateway={owner.gateway}
      principal={who}
      storage={() => storage}
      randomUuid={randomUuid}
      pollIntervalMs={20}
      pollLimit={3}
    />,
  );
  return storage;
}
const saved = (storage: Storage, who = principal) => {
  const raw = storage.getItem(residencyStorageKey(who));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};
async function confirmPurchase(label = 'Оформить резидентство') {
  fireEvent.click(await screen.findByRole('button', { name: label }));
  return screen.findByRole('button', { name: /^Подтвердить/ });
}

afterEach(() => cleanup());

describe('ResidencyPage status and catalog', () => {
  it('shows loading, then no residency with the server product', async () => {
    mount(fakeOwner());
    expect(screen.getByText('Проверяем статус…')).toBeInTheDocument();
    expect(await screen.findByText('Нет резидентства')).toBeInTheDocument();
    expect(await screen.findByText('Синтетический продукт')).toBeInTheDocument();
    expect(screen.getByText('30 дней')).toBeInTheDocument();
    expect(screen.getByText('1 234 ₽')).toBeInTheDocument();
    expect(screen.getByText('Синтетическое преимущество')).toBeInTheDocument();
  });

  it('shows active residency with its end date and offers renewal', async () => {
    mount(fakeOwner({ residency: status({ state: 'ACTIVE', validUntil: '2026-11-30' }) }));
    expect(await screen.findByText('Активно')).toBeInTheDocument();
    expect(screen.getByText('30 ноября 2026 г.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Продлить резидентство' })).toBeEnabled();
  });

  it('shows an expired residency distinctly from none', async () => {
    mount(fakeOwner({ residency: status({ state: 'NONE', validUntil: '2026-10-01' }) }));
    expect(await screen.findByText('Истёк срок')).toBeInTheDocument();
  });

  it('never presents a failed status read as absence and offers no purchase', async () => {
    mount(fakeOwner({ residency: new Error('network') }));
    expect(await screen.findByText(/Не удалось проверить статус/)).toBeInTheDocument();
    expect(screen.queryByText('Нет резидентства')).not.toBeInTheDocument();
    expect(await screen.findByText(/станет доступно, когда удастся проверить/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Оформить резидентство' })).not.toBeInTheDocument();
    cleanup();
    mount(
      fakeOwner({
        residency: status({
          state: 'UNAVAILABLE',
          checkedAt: null,
          unavailableReason: 'SOURCE_TIMEOUT',
        }),
      }),
    );
    expect(await screen.findByText(/Не удалось проверить статус/)).toBeInTheDocument();
    expect(screen.queryByText('Нет резидентства')).not.toBeInTheDocument();
  });

  it('says purchase is unavailable when the order API is absent, inventing no product', async () => {
    mount(fakeOwner({ catalog: apiError(404, 'NOT_FOUND') }));
    expect(await screen.findByText(/Оформление резидентства пока недоступно/)).toBeInTheDocument();
    expect(screen.queryByText('Синтетический продукт')).not.toBeInTheDocument();
  });

  it('rejects an invalid catalog instead of rendering it', async () => {
    mount(
      fakeOwner({ catalog: { ...catalog(), product: { ...catalog().product, priceMinor: 0 } } }),
    );
    expect(await screen.findByText(/Оформление резидентства пока недоступно/)).toBeInTheDocument();
  });

  it('renders the native fallback without a gateway', () => {
    render(<ResidencyPage principal={principal} />);
    expect(screen.getByText(/в приложении пока недоступно/)).toBeInTheDocument();
  });
});

describe('ResidencyPage order flow', () => {
  it('re-reads the server price, creates one order on repeated taps and opens the server link', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    await screen.findByText('Синтетический продукт');
    owner.setCatalog(catalog(150000));
    const confirm = await confirmPurchase();
    expect(owner.gateway.getResidencyCatalog).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('1 500 ₽').length).toBeGreaterThan(0);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalledTimes(1));
    expect(owner.gateway.createResidencyOrder).toHaveBeenCalledTimes(1);
    expect(owner.gateway.createResidencyOrder).toHaveBeenCalledWith(
      'NEW',
      expect.stringMatching(/^residency:/),
    );
    expect(owner.gateway.openResidencyPayment.mock.calls[0]![0]).toMatch(
      /^https:\/\/pay\.example\.test\//,
    );
    const c = saved(storage)!;
    expect(Object.keys(c).sort()).toEqual([
      'key',
      'mode',
      'orderId',
      'tenantId',
      'userId',
      'version',
    ]);
    expect(JSON.stringify(c)).not.toMatch(/pay\.example|1234|1500/);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
  });

  it('after returning from payment reconciles and shows success only when the read is ACTIVE', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalled());
    cleanup();

    // Return to /residency: bank confirmed and CUP activated, but the LK2 read is not ACTIVE yet.
    owner.onReconcile({ state: 'ACTIVE', paymentStatus: 'PAID' });
    mount(owner, storage);
    await waitFor(() => expect(owner.gateway.reconcileResidencyOrder).toHaveBeenCalled());
    expect(await screen.findByText('Проверяем оплату')).toBeInTheDocument();
    expect(screen.queryByText('Резидентство активно')).not.toBeInTheDocument();

    owner.setResidency(
      status({ state: 'ACTIVE', validFrom: '2026-11-18', validUntil: '2026-12-17' }),
    );
    expect(await screen.findByText('Резидентство активно')).toBeInTheDocument();
    expect(screen.getByText(/действует до 17 декабря 2026 г\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(saved(storage)).toBeNull());
    expect(owner.gateway.createResidencyOrder).toHaveBeenCalledTimes(1);
  });

  it('a delayed bank confirmation keeps an honest, bounded waiting state', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalled());
    cleanup();
    owner.onReconcile({ state: 'PAID_ACTIVATION_PENDING', paymentStatus: 'PAID' });
    mount(owner, storage);
    expect(
      await screen.findByText('Оплата получена. Ждём активации резидентства клубом.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(owner.gateway.reconcileResidencyOrder).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 120));
    expect(owner.gateway.reconcileResidencyOrder).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Проверяем оплату')).toBeInTheDocument();
    expect(screen.queryByText('Резидентство активно')).not.toBeInTheDocument();
  });

  it('a reload during pending payment restores the same order without a new create', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalledTimes(1));
    cleanup();
    mount(owner, storage);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalledTimes(2));
    expect(owner.gateway.createResidencyOrder).toHaveBeenCalledTimes(1);
  });

  it('a lost create response is recovered with the same key and yields the same order', async () => {
    const owner = fakeOwner();
    const real = owner.gateway.createResidencyOrder.getMockImplementation()!;
    owner.gateway.createResidencyOrder.mockImplementationOnce(async (mode, key) => {
      await real(mode, key); // reached the owner, response lost
      throw new Error('network');
    });
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    expect(saved(storage)!.orderId).toBeNull();
    cleanup();
    mount(owner, storage); // reload: no automatic POST
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    expect(owner.gateway.createResidencyOrder).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    const keys = owner.gateway.createResidencyOrder.mock.calls.map((c) => c[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(owner.orders.size).toBe(1);
    expect(saved(storage)!.orderId).toBe([...owner.orders.values()][0]!.orderId);
  });

  it('a second tab cannot start a second order', async () => {
    const owner = fakeOwner();
    const storage = new MemoryStorage();
    mount(owner, storage);
    const confirm = await confirmPurchase();
    // Another tab already created an order under this account.
    storage.setItem(
      residencyStorageKey(principal),
      JSON.stringify({
        version: 2,
        ...principal,
        key: 'residency:00000000-0000-4000-8000-0000000000ff',
        mode: 'NEW',
        orderId: null,
      }),
    );
    fireEvent.click(confirm);
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    expect(owner.gateway.createResidencyOrder).not.toHaveBeenCalled();
  });

  it('a pending order from another device is explained, not duplicated', async () => {
    const owner = fakeOwner();
    await owner.gateway.createResidencyOrder('NEW', 'residency:other-device-key-0001');
    owner.gateway.createResidencyOrder.mockClear();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    expect(await screen.findByRole('alert')).toHaveTextContent('уже есть неоплаченный заказ');
    expect(saved(storage)).toBeNull();
    expect(owner.orders.size).toBe(1);
  });

  it('renewal uses the server rule and is refused cleanly when not eligible', async () => {
    const owner = fakeOwner({ residency: status({ state: 'ACTIVE', validUntil: '2026-11-30' }) });
    owner.gateway.createResidencyOrder.mockRejectedValueOnce(
      apiError(409, 'RESIDENCY_RENEWAL_NOT_ELIGIBLE'),
    );
    const storage = mount(owner);
    const confirm = await confirmPurchase('Продлить резидентство');
    expect(confirm).toHaveTextContent('Подтвердить продление и оплатить');
    expect(screen.getByText(/даты нового периода клуб определит после оплаты/)).toBeInTheDocument();
    fireEvent.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent('Продление недоступно');
    expect(owner.gateway.createResidencyOrder).toHaveBeenCalledWith('RENEWAL', expect.any(String));
    expect(saved(storage)).toBeNull();
  });

  it('shows a payment failure and lets the user start over', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalled());
    cleanup();
    owner.onReconcile({ state: 'PAYMENT_FAILED', paymentStatus: 'FAILED' });
    mount(owner, storage);
    expect(await screen.findByText('Оплата не прошла')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Оформить заново' }));
    expect(
      await screen.findByRole('button', { name: 'Оформить резидентство' }),
    ).toBeInTheDocument();
    expect(saved(storage)).toBeNull();
  });

  it('a paid order that needs review never offers a second payment', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalled());
    cleanup();
    owner.onReconcile({ state: 'PAID_REQUIRES_REVIEW', paymentStatus: 'PAID' });
    mount(owner, storage);
    expect(await screen.findByText('Нужна проверка клуба')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Оформить|Перейти к оплате/ }),
    ).not.toBeInTheDocument();
    expect(saved(storage)).not.toBeNull();
  });

  it('cancels an unpaid order through the owner', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить заказ' }));
    expect(await screen.findByText('Заказ отменён')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Оформить заново' }));
    await waitFor(() => expect(saved(storage)).toBeNull());
  });

  it('does not open a non-https payment link', async () => {
    const owner = fakeOwner();
    owner.nextLink('javascript:alert(1)');
    mount(owner);
    fireEvent.click(await confirmPurchase());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(owner.gateway.openResidencyPayment).not.toHaveBeenCalled();
  });

  it('a saved order of one account is never shown to another account', async () => {
    const owner = fakeOwner();
    const storage = mount(owner);
    fireEvent.click(await confirmPurchase());
    await waitFor(() => expect(owner.gateway.openResidencyPayment).toHaveBeenCalled());
    cleanup();
    mount(owner, storage, other);
    expect(
      await screen.findByRole('button', { name: 'Оформить резидентство' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Ожидает оплаты')).not.toBeInTheDocument();
    expect(saved(storage, other)).toBeNull();
    expect(saved(storage)).not.toBeNull();
  });

  it('discards results that arrive after the account changed', async () => {
    const owner = fakeOwner();
    let resolve!: (v: unknown) => void;
    owner.gateway.getClientResidency.mockImplementation(
      () => new Promise((r) => (resolve = r)) as never,
    );
    mount(owner);
    await waitFor(() => expect(owner.gateway.getClientResidency).toHaveBeenCalled());
    owner.gateway.residencyPrincipal.mockReturnValue('p2');
    await act(() => {
      resolve(status({ state: 'ACTIVE', validUntil: '2026-12-01' }));
      return Promise.resolve();
    });
    expect(screen.queryByText('Активно')).not.toBeInTheDocument();
  });
});
