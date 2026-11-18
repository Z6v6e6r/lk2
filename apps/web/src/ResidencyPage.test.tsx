// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientResidencyStatus } from '@phub/api-sdk';

import { ResidencyPage } from './ResidencyPage.js';
import {
  residencyStorageKey,
  type ResidencyGateway,
  type ResidencyOperationStatus,
} from './residency-purchase.js';

// Synthetic fixtures only: none of these values are real offers, prices or terms.
const principal = {
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  userId: '00000000-0000-4000-8000-0000000000b1',
};
const OFFER = '00000000-0000-4000-8000-0000000000c1';
const OFFER_2 = '00000000-0000-4000-8000-0000000000c2';
const OPERATION = '00000000-0000-4000-8000-0000000000d1';
const KEY_UUID = '00000000-0000-4000-8000-0000000000e1';

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
const offer = (id = OFFER, title = 'Синтетический тариф') => ({
  offerId: id,
  title,
  description: null,
  durationLabel: 'Синтетический срок',
  amountMinor: 123400,
  currency: 'RUB',
  benefits: ['Синтетическое преимущество A', 'Синтетическое преимущество B'],
});

function fakeServer(
  opts: {
    residency?: ClientResidencyStatus | Error;
    capability?: unknown;
    purchaseStatus?: ResidencyOperationStatus;
  } = {},
) {
  let residency = opts.residency ?? status({});
  let opStatus: ResidencyOperationStatus | null = null;
  let failureCode: string | null = null;
  const result = () => ({
    contractVersion: 1,
    operationId: OPERATION,
    offerId: OFFER,
    status: opStatus!,
    amountMinor: 123400,
    currency: 'RUB',
    canOpenPayment: opStatus === 'PAYMENT_PENDING',
    paymentExpiresAt: opStatus === 'PAYMENT_PENDING' ? '2099-01-01T00:00:00.000Z' : null,
    failureCode,
  });
  const gateway = {
    residencyPrincipal: vi.fn(() => 'p1'),
    getClientResidency: vi.fn(() =>
      residency instanceof Error ? Promise.reject(residency) : Promise.resolve(residency),
    ),
    getResidencyPurchaseCapability: vi.fn(() =>
      opts.capability instanceof Error
        ? Promise.reject(opts.capability)
        : Promise.resolve(
            opts.capability ?? { contractVersion: 1, available: true, offers: [offer()] },
          ),
    ),
    quoteResidencyPurchase: vi.fn((offerId: string) => {
      opStatus ??= 'QUOTED';
      return Promise.resolve({
        contractVersion: 1,
        operationId: OPERATION,
        offerId,
        title: 'Синтетический тариф',
        revision: 'rev-1',
        amountMinor: 123400,
        currency: 'RUB',
        validFrom: '2026-11-18',
        validUntil: '2026-12-17',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }),
    purchaseResidency: vi.fn(() => {
      opStatus = opts.purchaseStatus ?? 'PAYMENT_PENDING';
      return Promise.resolve(result());
    }),
    getResidencyPurchase: vi.fn(() => Promise.resolve(result())),
    reconcileResidencyPurchase: vi.fn(() => Promise.resolve(result())),
    launchResidencyPayment: vi.fn(() =>
      Promise.resolve({
        contractVersion: 1,
        operationId: OPERATION,
        paymentUrl: 'https://pay.example.test/session/synthetic',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    ),
    openResidencyPayment: vi.fn(),
  } satisfies ResidencyGateway;
  return {
    gateway,
    setResidency(s: ClientResidencyStatus) {
      residency = s;
    },
    setOperation(s: ResidencyOperationStatus, code: string | null = null) {
      opStatus = s;
      failureCode = code;
    },
  };
}

function mount(server: ReturnType<typeof fakeServer>, storage = new MemoryStorage()) {
  render(
    <ResidencyPage
      gateway={server.gateway}
      principal={principal}
      storage={() => storage}
      randomUuid={() => KEY_UUID}
      pollIntervalMs={20}
      pollLimit={3}
    />,
  );
  return storage;
}

afterEach(() => cleanup());

describe('ResidencyPage status', () => {
  it('shows loading, then no residency with server conditions', async () => {
    const server = fakeServer();
    mount(server);
    expect(screen.getByText('Проверяем статус…')).toBeInTheDocument();
    expect(await screen.findByText('Нет резидентства')).toBeInTheDocument();
    expect(await screen.findByText('Синтетический тариф')).toBeInTheDocument();
    expect(screen.getByText('Синтетическое преимущество A')).toBeInTheDocument();
    expect(screen.getByText('Синтетический срок')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Оформить резидентство' })).toBeEnabled();
  });

  it('shows active residency with its end date and offers renewal', async () => {
    mount(
      fakeServer({
        residency: status({ state: 'ACTIVE', validFrom: '2026-11-01', validUntil: '2026-11-30' }),
      }),
    );
    expect(await screen.findByText('Активно')).toBeInTheDocument();
    expect(screen.getByText('30 ноября 2026 г.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Продлить резидентство' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Продление' })).toBeInTheDocument();
  });

  it('shows an expired residency distinctly from none', async () => {
    mount(fakeServer({ residency: status({ state: 'NONE', validUntil: '2026-10-01' }) }));
    expect(await screen.findByText('Истёк срок')).toBeInTheDocument();
    expect(screen.getByText(/Срок закончился/)).toBeInTheDocument();
  });

  it('never presents an unavailable read or an API failure as absence', async () => {
    mount(
      fakeServer({
        residency: status({
          state: 'UNAVAILABLE',
          checkedAt: null,
          unavailableReason: 'SOURCE_TIMEOUT',
        }),
      }),
    );
    expect(await screen.findByText(/Не удалось проверить статус/)).toBeInTheDocument();
    expect(screen.queryByText('Нет резидентства')).not.toBeInTheDocument();
    cleanup();
    mount(fakeServer({ residency: new Error('network') }));
    expect(await screen.findByText(/Не удалось проверить статус/)).toBeInTheDocument();
    expect(screen.queryByText('Нет резидентства')).not.toBeInTheDocument();
  });

  it('says purchase is unavailable when the purchase API is absent, inventing no offers', async () => {
    mount(fakeServer({ capability: new Error('404') }));
    expect(await screen.findByText(/Оформление резидентства пока недоступно/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Оформить резидентство' })).not.toBeInTheDocument();
  });

  it('rejects an invalid capability payload instead of rendering it', async () => {
    mount(
      fakeServer({
        capability: {
          contractVersion: 1,
          available: true,
          offers: [{ ...offer(), amountMinor: 0 }],
        },
      }),
    );
    expect(await screen.findByText(/Оформление резидентства пока недоступно/)).toBeInTheDocument();
  });

  it('renders the native fallback without a gateway', () => {
    render(<ResidencyPage principal={principal} />);
    expect(screen.getByText(/в приложении пока недоступно/)).toBeInTheDocument();
  });
});

describe('ResidencyPage purchase', () => {
  it('quotes the server price, confirms once and opens the payment page', async () => {
    const server = fakeServer();
    const storage = mount(server);
    fireEvent.click(await screen.findByRole('button', { name: 'Оформить резидентство' }));
    expect(await screen.findByText('Подтвердить и оплатить')).toBeInTheDocument();
    expect(screen.getAllByText('1 234 ₽').length).toBeGreaterThan(0);
    expect(screen.getByText(/18 ноября 2026 г\. — 17 декабря 2026 г\./)).toBeInTheDocument();
    expect(server.gateway.quoteResidencyPurchase).toHaveBeenCalledWith(
      OFFER,
      'residency:' + KEY_UUID,
    );

    const confirm = screen.getByRole('button', { name: 'Подтвердить и оплатить' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(server.gateway.openResidencyPayment).toHaveBeenCalledTimes(1));
    expect(server.gateway.purchaseResidency).toHaveBeenCalledTimes(1);
    expect(server.gateway.purchaseResidency).toHaveBeenCalledWith(
      { offerId: OFFER, expectedRevision: 'rev-1', amountMinor: 123400, currency: 'RUB' },
      'residency:' + KEY_UUID,
    );
    expect(server.gateway.openResidencyPayment).toHaveBeenCalledWith(
      'https://pay.example.test/session/synthetic',
    );
    const saved = JSON.parse(storage.getItem(residencyStorageKey(principal))!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(saved).sort()).toEqual(
      ['key', 'quote', 'submitted', 'tenantId', 'userId', 'version'].sort(),
    );
    expect(saved.submitted).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/pay\.example|card|pan/i);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
  });

  it('after return from payment waits for confirmation, then shows success only when the read is ACTIVE', async () => {
    const server = fakeServer();
    const storage = mount(server);
    fireEvent.click(await screen.findByRole('button', { name: 'Оформить резидентство' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить и оплатить' }));
    await waitFor(() => expect(server.gateway.openResidencyPayment).toHaveBeenCalled());
    cleanup();

    // The user returns: the operation is paid but the residency read is not yet active.
    server.setOperation('ACTIVATED');
    mount(server, storage);
    expect(await screen.findByText('Проверяем оплату')).toBeInTheDocument();
    expect(screen.getByText(/Ждём подтверждения резидентства/)).toBeInTheDocument();
    expect(screen.queryByText('Резидентство активно')).not.toBeInTheDocument();

    server.setResidency(
      status({ state: 'ACTIVE', validFrom: '2026-11-18', validUntil: '2026-12-17' }),
    );
    expect(await screen.findByText('Резидентство активно')).toBeInTheDocument();
    expect(screen.getByText(/действует до 17 декабря 2026 г\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(storage.getItem(residencyStorageKey(principal))).toBeNull());
    expect(server.gateway.purchaseResidency).toHaveBeenCalledTimes(1);
  });

  it('reopening during pending payment restores the same operation without a new POST', async () => {
    const server = fakeServer();
    const storage = mount(server);
    fireEvent.click(await screen.findByRole('button', { name: 'Оформить резидентство' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить и оплатить' }));
    await waitFor(() => expect(server.gateway.openResidencyPayment).toHaveBeenCalledTimes(1));
    cleanup();
    mount(server, storage);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    expect(server.gateway.getResidencyPurchase).toHaveBeenCalledWith('residency:' + KEY_UUID);
    fireEvent.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(server.gateway.openResidencyPayment).toHaveBeenCalledTimes(2));
    expect(server.gateway.purchaseResidency).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить статус оплаты' }));
    await waitFor(() => expect(server.gateway.reconcileResidencyPurchase).toHaveBeenCalled());
  });

  it('shows a payment failure and lets the user start over', async () => {
    const server = fakeServer();
    const storage = mount(server);
    fireEvent.click(await screen.findByRole('button', { name: 'Оформить резидентство' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить и оплатить' }));
    await waitFor(() => expect(server.gateway.openResidencyPayment).toHaveBeenCalled());
    cleanup();
    server.setOperation('PAYMENT_FAILED', 'PAYMENT_DECLINED');
    mount(server, storage);
    expect(await screen.findByText('Оплата не прошла')).toBeInTheDocument();
    expect(screen.getByText(/Платёж отклонён банком/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать заново' }));
    expect(
      await screen.findByRole('button', { name: 'Оформить резидентство' }),
    ).toBeInTheDocument();
    expect(storage.getItem(residencyStorageKey(principal))).toBeNull();
  });

  it('keeps the submitted operation when the purchase response is lost', async () => {
    const server = fakeServer();
    server.gateway.purchaseResidency.mockRejectedValueOnce(new Error('timeout'));
    server.gateway.getResidencyPurchase.mockRejectedValue(new Error('offline'));
    const storage = mount(server);
    fireEvent.click(await screen.findByRole('button', { name: 'Оформить резидентство' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить и оплатить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Повторная оплата не создаётся');
    expect(screen.getByText('Проверяем оплату')).toBeInTheDocument();
    expect(
      (JSON.parse(storage.getItem(residencyStorageKey(principal))!) as { submitted: boolean })
        .submitted,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: /Подтвердить/ })).not.toBeInTheDocument();
  });

  it('does not open a non-https payment link', async () => {
    const server = fakeServer();
    server.gateway.launchResidencyPayment.mockResolvedValue({
      contractVersion: 1,
      operationId: OPERATION,
      paymentUrl: 'javascript:alert(1)',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    mount(server);
    fireEvent.click(await screen.findByRole('button', { name: 'Оформить резидентство' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить и оплатить' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(server.gateway.openResidencyPayment).not.toHaveBeenCalled();
  });

  it('discards results that arrive after the account changed', async () => {
    const server = fakeServer();
    let resolve!: (v: unknown) => void;
    server.gateway.getClientResidency.mockImplementation(
      () => new Promise((r) => (resolve = r)) as never,
    );
    mount(server);
    await waitFor(() => expect(server.gateway.getClientResidency).toHaveBeenCalled());
    server.gateway.residencyPrincipal.mockReturnValue('p2');
    await act(() => {
      resolve(status({ state: 'ACTIVE', validUntil: '2026-12-01' }));
      return Promise.resolve();
    });
    expect(screen.queryByText('Активно')).not.toBeInTheDocument();
  });

  it('switching offers hides the other offer price and quotes the new one', async () => {
    const server = fakeServer({
      capability: {
        contractVersion: 1,
        available: true,
        offers: [offer(OFFER, 'Тариф A'), offer(OFFER_2, 'Тариф B')],
      },
    });
    mount(server);
    fireEvent.click(await screen.findByRole('radio', { name: /Тариф A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Оформить резидентство' }));
    expect(await screen.findByRole('button', { name: 'Подтвердить и оплатить' })).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: /Тариф B/ }));
    expect(
      screen.queryByRole('button', { name: 'Подтвердить и оплатить' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Оформить резидентство' }));
    await waitFor(() =>
      expect(server.gateway.quoteResidencyPurchase).toHaveBeenLastCalledWith(
        OFFER_2,
        expect.any(String),
      ),
    );
    expect(server.gateway.purchaseResidency).not.toHaveBeenCalled();
  });

  it('lets the user choose among several server offers', async () => {
    const server = fakeServer({
      capability: {
        contractVersion: 1,
        available: true,
        offers: [offer(OFFER, 'Тариф A'), offer(OFFER_2, 'Тариф B')],
      },
    });
    mount(server);
    const button = await screen.findByRole('button', { name: 'Оформить резидентство' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Тариф B/ }));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(server.gateway.quoteResidencyPurchase).toHaveBeenCalledWith(
        OFFER_2,
        expect.any(String),
      ),
    );
  });
});
