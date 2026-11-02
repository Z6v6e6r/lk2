// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { afterEach, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../web/src/App.js';
import { IOSCabinet } from './ios/IOSCabinet.js';
import { MonthlyPurchasePanel } from '../../web/src/MonthlyPurchasePanel.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import {
  auth,
  config,
  homeDashboard,
  homeBase,
  fixtureReply,
  nativeResult,
  syntheticSession,
} from './ios/testing/cabinet-fixtures.js';
import {
  monthlyStorageKey,
  monthlyIdentity,
  monthlyOffer,
  loadMonthlyCustody,
  type MonthlyCustody,
  type MonthlyPurchaseGateway,
} from '../../web/src/monthly-purchase-attempt.js';
vi.mock('../../web/src/chat-realtime-client.js', () => ({
  connectChatRealtime: () => ({ stop: () => {} }),
}));
const principal = { tenantId: auth.context.tenantId, userId: auth.context.userId };
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});
async function setup(platform: 'android' | 'ios', lost = true, locks = true) {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('scrollTo', vi.fn());
  let tail = Promise.resolve();
  vi.stubGlobal('navigator', {
    ...navigator,
    locks: locks
      ? {
          request: async (_name: string, fn: () => Promise<void>) => {
            const v = tail.then(fn);
            tail = v.catch(() => {});
            return await Promise.resolve(v);
          },
        }
      : undefined,
  });
  let state = 'UNKNOWN',
    purchaseCount = 0,
    reconciles = 0;
  const opened = vi.fn((input: { operationId: string; launchCode: string }) => {
    expect(input.operationId).toMatch(/^[a-f0-9-]{36}$/);
    return Promise.resolve({ opened: true as const });
  });
  async function monthly(resource: string, key: string) {
    if (resource === 'capability')
      return {
        contractVersion: 1,
        available: true,
        offers: [{ id: monthlyOffer, title: 'Абонемент «Дружба»' }],
      };
    const c = loadMonthlyCustody(localStorage, principal)!;
    expect(c).not.toBeNull();
    expect(key).toBe(c.key);
    const id = await monthlyIdentity(c);
    if (resource === 'quote')
      return {
        contractVersion: 1,
        ...id,
        offerId: monthlyOffer,
        title: 'Абонемент «Дружба»',
        revision: 'sha256:' + 'a'.repeat(64),
        amountMinor: 100000,
        currency: 'RUB',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      };
    if (resource === 'purchase') {
      expect(c.submitted).toBe(true);
      purchaseCount++;
      if (lost) throw new Error('Lost ACK');
      state = 'PAYMENT_PENDING';
    }
    if (resource === 'reconcile') {
      reconciles++;
      if (state === 'UNKNOWN') state = 'PAYMENT_PENDING';
    }
    if (resource === 'launch')
      return {
        contractVersion: 1,
        operationId: id.operationId,
        launchCode: principal.tenantId + '.' + 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    return {
      contractVersion: 1,
      ...id,
      offerId: monthlyOffer,
      status: state,
      amountMinor: 100000,
      currency: 'RUB',
      canOpenPayment: state === 'PAYMENT_PENDING',
      paymentExpiresAt:
        state === 'PAYMENT_PENDING' ? new Date(Date.now() + 3600000).toISOString() : null,
    };
  }
  async function open() {
    window.history.replaceState(null, '', '/subscriptions');
    if (platform === 'android') {
      const request: AndroidSessionPlugin['request'] = async (v) => {
        let value: unknown;
        if (v.path.includes('/subscription-purchase-operations')) {
          const suffix = v.path.split('/subscription-purchase-operations')[1]!,
            resource =
              suffix === ''
                ? 'purchase'
                : suffix === '/by-key'
                  ? 'byKey'
                  : suffix.endsWith('/payment-launch')
                    ? 'launch'
                    : suffix.endsWith('/reconcile')
                      ? 'reconcile'
                      : suffix.slice(1);
          value = await monthly(resource, new Headers(v.headers).get('idempotency-key') ?? '');
        } else
          value = v.path.endsWith('/auth/session/refresh')
            ? auth
            : v.path.endsWith('/home')
              ? homeDashboard
              : v.path.endsWith('/home/base')
                ? homeBase
                : v.path.endsWith('/profile')
                  ? homeDashboard.profile
                  : { items: [] };
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(value)).toString('base64'),
        };
      };
      const g = createBrowserAuthGateway({
        baseUrl: config.apiBaseUrl,
        tenantKey: config.tenantKey,
        appVersion: 'test',
        platform: 'android',
        nativeSessionTransport: true,
        fetchImplementation: createNativeApiFetch(config, {
          request,
          configuration: async () => await Promise.resolve(config),
        }),
        openSubscriptionPayment: async (input) => {
          await opened(input);
        },
      });
      render(<App gateway={g} tenantKey={config.tenantKey} clientPlatform="android" />);
    } else {
      const session = syntheticSession(
        async (v) =>
          v.operation === 'monthlyPurchase'
            ? nativeResult(
                await monthly(v.resource!, new Headers(v.headers).get('idempotency-key') ?? ''),
              )
            : fixtureReply(v),
        opened,
      );
      await session.restore();
      render(<IOSCabinet session={session} auth={auth} />);
      await screen.findByRole('main', { name: 'Главная' });
      fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
      fireEvent.click(await screen.findByRole('link', { name: 'Мои абонементы' }));
    }
    await screen.findByRole('heading', { name: 'Абонемент «Дружба»' });
  }
  await open();
  return {
    open,
    opened,
    purchases: () => purchaseCount,
    reconciles: () => reconciles,
    paid: () => {
      state = 'PAID';
    },
  };
}
it.each(['android', 'ios'] as const)(
  '%s lost purchase response survives relaunch without another purchase; explicit recovery and one-use launch',
  async (platform) => {
    const f = await setup(platform);
    fireEvent.click(await screen.findByRole('button', { name: 'Узнать стоимость' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить покупку' }));
    await screen.findByRole('alert');
    expect(f.purchases()).toBe(1);
    const original = localStorage.getItem(monthlyStorageKey(principal));
    cleanup();
    await f.open();
    await screen.findByText('Результат покупки уточняется.');
    expect(localStorage.getItem(monthlyStorageKey(principal))).toBe(original);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Проверить статус покупки' })).toBeEnabled(),
    );
    expect(f.purchases()).toBe(1);
    expect(f.reconciles()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить статус покупки' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(f.opened).toHaveBeenCalledTimes(1));
    expect(Object.keys(f.opened.mock.calls[0]![0]).sort()).toEqual(['launchCode', 'operationId']);
    expect(localStorage.getItem(monthlyStorageKey(principal))).not.toContain('launchCode');
    expect(screen.queryByText(/Оплата подтверждена/)).not.toBeInTheDocument();
    f.paid();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Проверить статус покупки' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Проверить статус покупки' }));
    await screen.findByText(/Оплата подтверждена/);
    expect(f.purchases()).toBe(1);
    expect(screen.queryByRole('button', { name: 'Перейти к оплате' })).not.toBeInTheDocument();
  },
);
it.each(['android', 'ios'] as const)(
  '%s storage/lock unavailable blocks quote and purchase before bridge mutation',
  async (platform) => {
    const f = await setup(platform, false, false);
    fireEvent.click(await screen.findByRole('button', { name: 'Узнать стоимость' }));
    await screen.findByRole('alert');
    expect(f.purchases()).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(f.opened).not.toHaveBeenCalled();
  },
);
it('a late payment response after closing the original account cannot show a receipt or launch', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('navigator', {
    locks: { request: async (_n: string, fn: () => Promise<void>) => await Promise.resolve(fn()) },
  });
  let active = true,
    resolve!: (v: unknown) => void;
  const c: MonthlyCustody = {
      version: 1,
      ...principal,
      key: 'monthly:' + crypto.randomUUID(),
      submitted: false,
      quote: null,
    },
    id = await monthlyIdentity(c);
  const q = {
    contractVersion: 1 as const,
    ...id,
    offerId: monthlyOffer,
    title: 'Абонемент «Дружба»',
    revision: 'sha256:' + 'a'.repeat(64),
    amountMinor: 100000,
    currency: 'RUB' as const,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  };
  c.quote = q;
  localStorage.setItem(monthlyStorageKey(principal), JSON.stringify(c));
  const g = {
    monthlyPurchasePrincipal: () => (active ? 'epoch' : null),
    getSubscriptionPurchaseCapability: async () =>
      await Promise.resolve({
        contractVersion: 1,
        available: true,
        offers: [{ id: monthlyOffer, title: q.title }],
      }),
    purchaseSubscription: vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
    openSubscriptionPayment: vi.fn(),
  } as unknown as MonthlyPurchaseGateway;
  render(<MonthlyPurchasePanel gateway={g} principal={principal} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Подтвердить покупку' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить покупку' }));
  await waitFor(() => expect(g.purchaseSubscription).toHaveBeenCalledTimes(1));
  active = false;
  resolve({
    contractVersion: 1,
    ...id,
    offerId: monthlyOffer,
    status: 'PAID',
    amountMinor: 100000,
    currency: 'RUB',
    canOpenPayment: false,
    paymentExpiresAt: null,
  });
  await screen.findByText('Покупка пока недоступна.');
  expect(screen.queryByText(/Оплата подтверждена/)).not.toBeInTheDocument();
  expect(g.openSubscriptionPayment).not.toHaveBeenCalled();
});

it.each(['expired', 'lost-renewal', 'reset-without-quote'] as const)(
  'original-key quote recovery after %s never replays a purchase',
  async (mode) => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_n: string, fn: () => Promise<void>) => await Promise.resolve(fn()),
      },
    });
    const c: MonthlyCustody = {
        version: 1,
        ...principal,
        key: 'monthly:' + crypto.randomUUID(),
        submitted: true,
        quote: null,
      },
      id = await monthlyIdentity(c);
    const quote = {
      contractVersion: 1 as const,
      ...id,
      offerId: monthlyOffer,
      title: 'Абонемент «Дружба»',
      revision: 'sha256:' + 'a'.repeat(64),
      amountMinor: 100000,
      currency: 'RUB' as const,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    c.quote = quote;
    localStorage.setItem(monthlyStorageKey(principal), JSON.stringify(c));
    const fresh = {
        ...quote,
        revision: 'sha256:' + 'b'.repeat(64),
        amountMinor: 110000,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      },
      receipt = {
        contractVersion: 1 as const,
        ...id,
        offerId: monthlyOffer,
        status: mode === 'reset-without-quote' ? ('QUOTING' as const) : ('QUOTED' as const),
        amountMinor:
          mode === 'reset-without-quote' ? null : mode === 'lost-renewal' ? 110000 : 100000,
        currency: 'RUB' as const,
        canOpenPayment: false,
        paymentExpiresAt: null,
      };
    const g = {
      monthlyPurchasePrincipal: () => 'original-account',
      getSubscriptionPurchaseCapability: async () =>
        await Promise.resolve({
          contractVersion: 1 as const,
          available: true,
          offers: [{ id: monthlyOffer, title: quote.title }],
        }),
      getSubscriptionPurchase: vi.fn(async () => await Promise.resolve(receipt)),
      quoteSubscriptionPurchase: vi.fn(async () => await Promise.resolve(fresh)),
      purchaseSubscription: vi.fn(
        async () =>
          await Promise.resolve({
            ...receipt,
            status: 'UNKNOWN' as const,
            amountMinor: 110000,
          }),
      ),
      openSubscriptionPayment: vi.fn(),
    } as unknown as MonthlyPurchaseGateway;
    render(<MonthlyPurchasePanel gateway={g} principal={principal} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Обновить цену этой покупки' }));
    const confirm = await screen.findByRole('button', { name: 'Подтвердить покупку' });
    expect(loadMonthlyCustody(localStorage, principal)?.key).toBe(c.key);
    expect(loadMonthlyCustody(localStorage, principal)?.quote?.amountMinor).toBe(110000);
    expect(g.purchaseSubscription).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(g.purchaseSubscription).toHaveBeenCalledWith(
        {
          offerId: monthlyOffer,
          expectedRevision: fresh.revision,
          amountMinor: 110000,
          currency: 'RUB',
        },
        c.key,
      ),
    );
  },
);
