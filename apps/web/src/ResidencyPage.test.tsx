// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ResidencyPage } from './ResidencyPage.js';
import {
  createOwnerWorld,
  verifyOwnerSnapshot,
  verifyConsumerSnapshot,
  type OwnerHarness,
} from './residency-owner.test-helper.js';
import {
  listResidencyAttempts,
  parseResidencyOrder,
  parseResidencyOrderEnvelope,
} from './residency-purchase.js';

// Every scenario below runs the real lk#443 owner state machine and HTTP contract (imported
// byte-identical) behind actual #684 routes/runtime/HTTP client and the real @phub/api-sdk client.
// Viva/CUP ports, the clock and the order store are synthetic and in memory.
const userA = { tenantId: 'synthetic-tenant', userId: 'user-a' };
const userB = { tenantId: 'synthetic-tenant', userId: 'user-b' };

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

let uuidSeq = 0;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const randomUuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;

function mount(
  h: OwnerHarness,
  storage: Storage = new MemoryStorage(),
  who = userA,
  principal?: () => string | null,
) {
  const g = h.gateway(who.userId, principal);
  const view = render(
    <ResidencyPage
      gateway={g.gateway}
      principal={who}
      storage={() => storage}
      randomUuid={randomUuid}
      pollIntervalMs={20}
      pollLimit={3}
      locks={null}
    />,
  );
  return { storage, opened: g.opened, view };
}
const posts = (h: OwnerHarness, path: string) =>
  h.world.log.filter((l) => l.method === 'POST' && l.path === path);
async function confirm(label = 'Оформить резидентство') {
  fireEvent.click(await screen.findByRole('button', { name: label }));
  return screen.findByRole('button', { name: /^Подтвердить/ });
}
async function buyAndOpenPayment(h: OwnerHarness, storage?: Storage) {
  const m = mount(h, storage);
  fireEvent.click(await confirm());
  await waitFor(() => expect(m.opened).toHaveLength(1));
  return m;
}

afterEach(() => cleanup());

describe('imported owner snapshot', () => {
  it('pins actual consumer modules to #684 7cd773f21', () => {
    expect(verifyConsumerSnapshot()).toEqual([
      'client-residency-order-routes.ts',
      'client-residency-order-runtime.ts',
      'client-residency-owner-client.ts',
      'residency-owner-paths.ts',
    ]);
  });
  it('is byte-identical to lk#443 @ 2f7c2d48', () => {
    expect(verifyOwnerSnapshot()).toEqual([
      'residency-lifecycle.mjs',
      'residency-lifecycle-http.mjs',
    ]);
  });
});

describe('status, catalog and unavailable backend', () => {
  it('shows the owner catalog and no residency', async () => {
    mount(createOwnerWorld());
    expect(screen.getByText('Проверяем статус…')).toBeInTheDocument();
    expect(await screen.findByText('Нет резидентства')).toBeInTheDocument();
    expect(await screen.findByText('Резидентство (синтетика)')).toBeInTheDocument();
    expect(screen.getByText('790 ₽')).toBeInTheDocument();
    expect(screen.getByText('30 дней')).toBeInTheDocument();
    // Structured owner benefits ({code, percent}) are not turned into invented text.
    expect(screen.queryByLabelText('Преимущества')).not.toBeInTheDocument();
  });

  it('shows the server early-renewal date without a payment confirmation', async () => {
    const h = createOwnerWorld();
    h.setResidency('user-a', {
      state: 'ACTIVE',
      validFrom: '2026-11-01T09:00:00.000Z',
      validUntil: '2026-12-01T09:00:00.000Z',
    });
    mount(h);
    expect(await screen.findByText('Активно')).toBeInTheDocument();
    expect(screen.getByText('1 декабря 2026 г.')).toBeInTheDocument();
    expect(await screen.findByText(/Продление доступно с/)).toHaveTextContent('01.12.2026');
    expect(screen.queryByRole('button', { name: 'Продлить резидентство' })).not.toBeInTheDocument();
    expect(h.world.providerCreates).toBe(0);
  });

  it('never shows a failed status read as absence and offers no purchase', async () => {
    const h = createOwnerWorld();
    h.setResidency('user-a', { state: 'UNAVAILABLE' });
    mount(h);
    expect(await screen.findByText(/Не удалось проверить статус/)).toBeInTheDocument();
    expect(screen.queryByText('Нет резидентства')).not.toBeInTheDocument();
    expect(await screen.findByText(/станет доступно, когда удастся проверить/)).toBeInTheDocument();
  });

  it.each(['absent', 'disabled', 'forbidden'] as const)(
    'consumer %s keeps the honest unavailable state',
    async (mode) => {
      const h = createOwnerWorld();
      h.world.consumer = mode;
      mount(h);
      expect(
        await screen.findByText(/Оформление резидентства пока недоступно/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Оформить резидентство' }),
      ).not.toBeInTheDocument();
    },
  );

  it('a 200 text/html SPA fallback is neither a status, a catalog nor an order (D-2)', async () => {
    const h = createOwnerWorld();
    h.world.consumer = 'html';
    mount(h);
    expect(await screen.findByText(/Не удалось проверить статус/)).toBeInTheDocument();
    expect(await screen.findByText(/Оформление резидентства пока недоступно/)).toBeInTheDocument();
    expect(screen.queryByText('Активно')).not.toBeInTheDocument();
    expect(screen.queryByText('Резидентство активно')).not.toBeInTheDocument();
  });

  it('renders the web-only message without a gateway (native shells)', () => {
    render(<ResidencyPage principal={userA} />);
    expect(screen.getByText(/в приложении пока недоступно/)).toBeInTheDocument();
  });
});

describe('order flow through the real owner', () => {
  it('confirms the server price, creates exactly one order on repeated taps and opens the owner link', async () => {
    const h = createOwnerWorld();
    const m = mount(h);
    const button = await confirm();
    expect(screen.getByText('Новое оформление')).toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(m.opened).toHaveLength(1));
    expect(m.opened[0]).toMatch(/^https:\/\/bank\.example\.test\/pay\//);
    expect(posts(h, '/residency/orders')).toHaveLength(1);
    expect(posts(h, '/residency/orders')[0]!.key).toMatch(/^residency:/);
    expect(h.world.providerCreates).toBe(1);
    const [attempt] = listResidencyAttempts(m.storage, userA);
    expect(attempt!.orderId).toBe(h.ordersOf('user-a')[0]!.orderId);
    expect(JSON.stringify(attempt)).not.toMatch(/bank\.example|txn-/);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
  });

  it('return from payment: reconcile, wait for the independent read, then success with the order period', async () => {
    const h = createOwnerWorld();
    h.world.lk2ReadLags = true;
    const { storage } = await buyAndOpenPayment(h);
    cleanup();
    h.bankSettles('PAID');
    mount(h, storage);
    expect(
      await screen.findByText(
        'Резидентство активировано. Ждём подтверждения нового срока в вашем статусе.',
      ),
    ).toBeInTheDocument();
    expect(
      posts(h, `/residency/orders/${h.ordersOf('user-a')[0]!.orderId}/reconcile`).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('Резидентство активно')).not.toBeInTheDocument();
    h.syncLk2Read('user-a');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить статус' }));
    expect(await screen.findByText('Резидентство активно')).toBeInTheDocument();
    expect(screen.getByText(/действует до 18 декабря 2026 г\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(listResidencyAttempts(storage, userA)).toHaveLength(0));
    expect(h.world.providerCreates).toBe(1);
  });

  it('renewal: an old ACTIVE read never stands in for the renewed period', async () => {
    const h = createOwnerWorld();
    h.setResidency('user-a', {
      state: 'ACTIVE',
      validFrom: '2026-11-01T09:00:00.000Z',
      validUntil: '2026-11-18T09:00:00.000Z',
    });
    h.world.lk2ReadLags = true;
    const m = mount(h);
    const button = await confirm('Продлить резидентство');
    expect(button).toHaveTextContent('Подтвердить продление и оплатить');
    expect(screen.getAllByText('Продление')).toHaveLength(2); // heading and order type
    expect(screen.getByText(/Новый срок клуб подтвердит после оплаты/)).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(m.opened).toHaveLength(1));
    expect(h.ordersOf('user-a')[0]!.mode).toBe('RENEWAL');
    cleanup();
    h.bankSettles('PAID');
    mount(h, m.storage);
    // The owner activated the extension, but the LK2 read still shows the old end date.
    expect(await screen.findByText(/Ждём подтверждения нового срока/)).toBeInTheDocument();
    expect(screen.getByText('18 ноября 2026 г.')).toBeInTheDocument();
    expect(screen.queryByText('Резидентство продлено')).not.toBeInTheDocument();
    h.syncLk2Read('user-a');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить статус' }));
    expect(await screen.findByText('Резидентство продлено')).toBeInTheDocument();
    expect(screen.getByText(/действует до 18 декабря 2026 г\./)).toBeInTheDocument();
  });

  it('a delayed bank confirmation keeps an honest, bounded wait', async () => {
    const h = createOwnerWorld();
    const { storage } = await buyAndOpenPayment(h);
    cleanup();
    mount(h, storage);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    const orderId = h.ordersOf('user-a')[0]!.orderId;
    await waitFor(() => expect(posts(h, `/residency/orders/${orderId}/reconcile`)).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 120));
    expect(posts(h, `/residency/orders/${orderId}/reconcile`)).toHaveLength(3);
    expect(screen.getByText('Ожидает оплаты')).toBeInTheDocument();
    expect(posts(h, '/residency/orders')).toHaveLength(1);
  });

  it('reload and reopen restore the pending order without a new create', async () => {
    const h = createOwnerWorld();
    const { storage, opened } = await buyAndOpenPayment(h);
    cleanup();
    const again = mount(h, storage);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Перейти к оплате' }));
    await waitFor(() => expect(again.opened).toHaveLength(1));
    expect(again.opened[0]).toBe(opened[0]);
    expect(posts(h, '/residency/orders')).toHaveLength(1);
  });

  it('offers no cancel while the bank still holds the payment (owner refuses it)', async () => {
    const h = createOwnerWorld();
    await buyAndOpenPayment(h);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    expect(screen.getByText(/ждёт оплаты\. Если вы уже оплатили/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить заказ' })).not.toBeInTheDocument();
    expect(screen.queryByText(/закроется\s+автоматически/)).not.toBeInTheDocument();
    // Contract evidence: the real owner refuses to cancel an order whose payment is PENDING.
    const { client } = h.gateway('user-a');
    const orderId = h.ordersOf('user-a')[0]!.orderId;
    await expect(
      client.cancelResidencyOrder(orderId, 'residency-cancel:00000000-0000-4000-8000-00000000ca01'),
    ).rejects.toMatchObject({ status: 409, code: 'RESIDENCY_PAYMENT_STATUS_UNKNOWN' });
    expect(h.ordersOf('user-a')[0]!.state).toBe('PENDING_PAYMENT');
  });

  it('a declined payment is a known failure and allows a new attempt', async () => {
    const h = createOwnerWorld();
    const { storage } = await buyAndOpenPayment(h);
    cleanup();
    h.bankSettles('FAILED');
    mount(h, storage);
    expect(
      await screen.findByText('Банк отклонил оплату. Резидентство не оформлено.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Оформить заново' }));
    expect(
      await screen.findByRole('button', { name: 'Оформить резидентство' }),
    ).toBeInTheDocument();
  });

  it('every command carries an Idempotency-Key and no POST is retried by the transport', async () => {
    const h = createOwnerWorld();
    await buyAndOpenPayment(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Проверить оплату' }));
    await waitFor(() => expect(h.world.log.some((l) => l.path.endsWith('/reconcile'))).toBe(true));
    const commands = h.world.log.filter((l) => l.method === 'POST');
    expect(commands.length).toBeGreaterThanOrEqual(2);
    expect(commands.every((l) => typeof l.key === 'string' && l.key.length >= 16)).toBe(true);
    expect(new Set(commands.map((l) => l.key)).size).toBe(commands.length);
  });
});

describe('lost responses and recovery', () => {
  it('a lost successful create is recovered with the same key after reload; one order, one charge', async () => {
    const h = createOwnerWorld();
    h.world.dropResponse = (method, path) => method === 'POST' && path === '/residency/orders';
    const storage = new MemoryStorage();
    mount(h, storage);
    fireEvent.click(await confirm());
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    expect(listResidencyAttempts(storage, userA)[0]!.orderId).toBeNull();
    cleanup();
    h.world.dropResponse = null;
    mount(h, storage); // reload: unresolved read restores the order, no automatic POST
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    expect(posts(h, '/residency/orders')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить сохранённую попытку' }));
    await waitFor(() => expect(posts(h, '/residency/orders')).toHaveLength(2));
    const keys = posts(h, '/residency/orders').map((l) => l.key);
    expect(keys[0]).toBe(keys[1]);
    expect(h.ordersOf('user-a')).toHaveLength(1);
    expect(h.world.providerCreates).toBe(1);
    expect(listResidencyAttempts(storage, userA)[0]!.orderId).toBe(
      h.ordersOf('user-a')[0]!.orderId,
    );
  });

  it('a lost definitive refusal is settled on recovery after reopen, not left as "sent"', async () => {
    const h = createOwnerWorld();
    // The client last read NONE, but CUP already sees ACTIVE: the owner refuses NEW.
    h.world.lk2ReadLags = true;
    h.setResidency('user-a', {
      state: 'ACTIVE',
      validFrom: '2026-11-01T09:00:00.000Z',
      validUntil: '2026-12-01T09:00:00.000Z',
    });
    h.world.dropResponse = (method, path) => method === 'POST' && path === '/residency/orders';
    const storage = new MemoryStorage();
    mount(h, storage);
    fireEvent.click(await confirm());
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    expect(h.world.log.at(-1)!.status).toBe('network');
    cleanup();
    h.world.dropResponse = null;
    h.syncLk2Read('user-a');
    mount(h, storage); // reopen
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('доступно только продление');
    expect(listResidencyAttempts(storage, userA)).toHaveLength(0);
    expect(await screen.findByText(/Продление доступно с/)).toBeInTheDocument();
    expect(posts(h, '/residency/orders').map((l) => l.key)).toEqual([
      posts(h, '/residency/orders')[0]!.key,
      posts(h, '/residency/orders')[0]!.key,
    ]);
    expect(h.ordersOf('user-a')).toHaveLength(0);
    expect(h.world.providerCreates).toBe(0);
  });

  it('a transport failure before the owner is not retried and keeps the key', async () => {
    const h = createOwnerWorld();
    h.world.failBeforeOwner = (method, path) => method === 'POST' && path === '/residency/orders';
    const storage = new MemoryStorage();
    mount(h, storage);
    fireEvent.click(await confirm());
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    expect(posts(h, '/residency/orders')).toHaveLength(1);
    expect(h.world.providerCreates).toBe(0);
    h.world.failBeforeOwner = null;
    fireEvent.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    expect(new Set(posts(h, '/residency/orders').map((l) => l.key)).size).toBe(1);
    expect(h.world.providerCreates).toBe(1);
  });

  it.each([
    ['unauthorized', 'Сессия истекла'],
    ['forbidden', 'Нет доступа'],
  ] as const)(
    'a %s create keeps the original attempt for the same operation',
    async (mode, text) => {
      const h = createOwnerWorld();
      const storage = new MemoryStorage();
      mount(h, storage);
      const button = await confirm();
      h.world.consumer = mode;
      fireEvent.click(button);
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByText('Заказ отправлен')).toBeInTheDocument();
      const [kept] = listResidencyAttempts(storage, userA);
      expect(kept!.orderId).toBeNull();
      h.world.consumer = 'ok';
      // A 401 ends the in-memory session; the user signs in again and reopens the screen.
      cleanup();
      mount(h, storage);
      fireEvent.click(await screen.findByRole('button', { name: 'Проверить заказ' }));
      expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
      expect(posts(h, '/residency/orders').at(-1)!.key).toBe(kept!.key);
    },
  );

  it('a total that differs from the confirmed price never opens payment silently', async () => {
    const h = createOwnerWorld();
    const m = mount(h);
    const button = await confirm();
    h.world.priceMinor = 99_000;
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Цена выросла до 990 ₽. Вы подтвердили 790 ₽',
    );
    expect(m.opened).toHaveLength(0);
  });
});

describe('concurrent tabs without Web Locks', () => {
  it('two tabs that both read an empty store keep the order of the tab that won', async () => {
    const h = createOwnerWorld();
    const storage = new MemoryStorage();
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    let arrived = 0;
    h.world.gate = async (method, path) => {
      if (method !== 'POST' || path !== '/residency/orders') return;
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    const tab1 = mount(h, storage);
    const tab2 = mount(h, storage);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Оформить резидентство' })).toHaveLength(2),
    );
    const buttons1 = screen.getAllByRole('button', { name: 'Оформить резидентство' });
    fireEvent.click(buttons1[0]!);
    fireEvent.click(buttons1[1]!);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Подтвердить и оплатить' })).toHaveLength(2),
    );
    const confirms = screen.getAllByRole('button', { name: 'Подтвердить и оплатить' });
    // Both clicks land before either tab has written: both read an empty store.
    await act(async () => {
      fireEvent.click(confirms[0]!);
      fireEvent.click(confirms[1]!);
      await both;
    });
    await waitFor(() => expect(tab1.opened.length + tab2.opened.length).toBe(1));
    const sent = posts(h, '/residency/orders');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.key).not.toBe(sent[1]!.key);
    expect(sent.map((l) => l.status).sort()).toEqual([200, 409]);
    expect(h.ordersOf('user-a')).toHaveLength(1);
    expect(h.world.providerCreates).toBe(1);
    await waitFor(() =>
      expect(screen.getAllByRole('alert')[0]).toHaveTextContent('незавершённый заказ'),
    );
    // The refused tab removed only its own attempt; the winner's order is still recoverable.
    const left = listResidencyAttempts(storage, userA);
    expect(left).toHaveLength(1);
    expect(left[0]!.orderId).toBe(h.ordersOf('user-a')[0]!.orderId);
    cleanup();
    mount(h, storage);
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
  });
});

describe('uncertain payment and club review', () => {
  it('an unknown provider outcome is not "failed", blocks a new payment and survives reload', async () => {
    const h = createOwnerWorld();
    h.world.providerCreateLost = true;
    const storage = new MemoryStorage();
    const m = mount(h, storage);
    fireEvent.click(await confirm());
    expect(await screen.findByText('Результат оплаты не подтверждён')).toBeInTheDocument();
    const order = h.ordersOf('user-a')[0]!;
    const reconciled = await h
      .gateway(userA.userId)
      .client.reconcileResidencyOrder(order.orderId, 'reconcile:' + randomUuid());
    expect(parseResidencyOrderEnvelope(reconciled)).toMatchObject({
      state: 'PENDING_PAYMENT',
      paymentStatus: 'UNKNOWN',
      recovery: { state: 'UNKNOWN_OUTCOME' },
    });
    expect(screen.queryByText(/Оплата получена|Оплата подтверждена/)).not.toBeInTheDocument();
    expect(screen.queryByText(/отклонил|не прошла|Заказ отменён/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Оформить|Перейти к оплате/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Номер заказа:/)).toBeInTheDocument();
    expect(m.opened).toHaveLength(0);
    cleanup();
    mount(h, storage); // reload / new sign-in: GET order, not the create response flag
    expect(await screen.findByText('Результат оплаты не подтверждён')).toBeInTheDocument();
    expect(listResidencyAttempts(storage, userA)).toHaveLength(1);
    expect(posts(h, '/residency/orders')).toHaveLength(1);
  });

  it.each(['reconciled', 'conflicting'] as const)(
    'preserves a late create result after the %s revision wins CAS',
    async (writer) => {
      const h = createOwnerWorld();
      const entered = deferred();
      const provider = deferred();
      h.world.holdProviderCreate = () => {
        entered.resolve();
        return provider.promise;
      };
      const m = mount(h);
      fireEvent.click(await confirm());
      await entered.promise;
      const order = h.ordersOf(userA.userId)[0]!;
      const { client } = h.gateway(userA.userId);
      const conflicting = writer === 'conflicting';
      let winningRevision: number;
      try {
        if (conflicting) {
          // Simulate a concurrent writer that already stored a different transaction reference.
          expect(
            await h.world.store.updateOrder(order.tenantId, order.orderId, order.revision, {
              ...order,
              revision: order.revision + 1,
              payment: {
                ...order.payment,
                status: 'PENDING',
                providerTransactionId: 'txn-existing',
              },
            }),
          ).toEqual({ ok: true });
        } else {
          const reconciled = await client.reconcileResidencyOrder(
            order.orderId,
            'reconcile:' + randomUuid(),
          );
          expect(parseResidencyOrderEnvelope(reconciled)).toMatchObject({
            state: 'PENDING_PAYMENT',
            paymentStatus: 'UNKNOWN',
            recovery: { state: 'UNKNOWN_OUTCOME' },
          });
        }
        winningRevision = h.ordersOf(userA.userId)[0]!.revision;
        expect(winningRevision).toBeGreaterThan(order.revision);
      } finally {
        provider.resolve();
      }

      await screen.findByText(conflicting ? 'Нужна проверка клуба' : 'Ожидает оплаты');
      const row = h.ordersOf(userA.userId)[0]!;
      expect(row.revision).toBeGreaterThan(winningRevision);
      expect(row.activeSlot).toBe(1);
      expect(row.payment.providerTransactionId).toBe(
        conflicting ? 'txn-existing' : [...h.world.bank.keys()][0],
      );
      const recovered = parseResidencyOrder(await client.getResidencyOrder(order.orderId));
      expect(recovered).toMatchObject({
        paymentStatus: 'PENDING',
        recovery: { state: conflicting ? 'REVIEW_REQUIRED' : 'AWAITING_PAYMENT' },
      });
      if (conflicting) {
        expect(recovered.activationErrorCode).toBe('TRANSACTION_MISMATCH');
        expect(screen.getByText(/Оплата пока не подтверждена/)).toBeInTheDocument();
        expect(screen.queryByText(/Оплата получена|Оплата подтверждена/)).not.toBeInTheDocument();
        expect(
          screen.queryByRole('button', { name: /Оформить|Перейти к оплате/ }),
        ).not.toBeInTheDocument();
        expect(m.opened).toHaveLength(0);
      } else {
        await waitFor(() => expect(m.opened).toEqual([recovered.paymentUrl]));
      }
      await expect(
        client.createResidencyOrder(
          { mode: 'NEW', expectedTotalMinor: 79000 },
          'residency:' + randomUuid(),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'RESIDENCY_ORDER_ALREADY_PENDING' });
      expect(h.world.providerCreates).toBe(1);
    },
  );

  it('a paid order that needs club review offers no second payment after return', async () => {
    const h = createOwnerWorld();
    h.world.activationRejects = true;
    const { storage } = await buyAndOpenPayment(h);
    cleanup();
    h.bankSettles('PAID');
    mount(h, storage);
    expect(await screen.findByText('Нужна проверка клуба')).toBeInTheDocument();
    expect(screen.getByText(/Оплата получена/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Оформить|Перейти к оплате/ }),
    ).not.toBeInTheDocument();
    expect(listResidencyAttempts(storage, userA)).toHaveLength(1);
  });
});

describe('account boundaries', () => {
  it('a saved order of one account is never shown to another account', async () => {
    const h = createOwnerWorld();
    const { storage } = await buyAndOpenPayment(h);
    cleanup();
    mount(h, storage, userB);
    expect(
      await screen.findByRole('button', { name: 'Оформить резидентство' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Ожидает оплаты')).not.toBeInTheDocument();
    expect(listResidencyAttempts(storage, userB)).toHaveLength(0);
    expect(listResidencyAttempts(storage, userA)).toHaveLength(1);
  });

  it('three price refusals for one user do not open the shared breaker for another', async () => {
    const h = createOwnerWorld();
    const a = h.gateway(userA.userId).client;
    const b = h.gateway(userB.userId).client;
    const created = parseResidencyOrderEnvelope(
      await b.createResidencyOrder(
        { mode: 'NEW', expectedTotalMinor: 79000 },
        'residency:' + randomUuid(),
      ),
    );
    for (let refusal = 0; refusal < 3; refusal += 1) {
      await expect(
        a.createResidencyOrder(
          { mode: 'NEW', expectedTotalMinor: 69000 },
          'residency:' + randomUuid(),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'RESIDENCY_PRICE_CHANGED' });
    }
    expect(parseResidencyOrder(await b.getResidencyOrder(created.orderId))).toMatchObject({
      orderId: created.orderId,
      paymentStatus: 'PENDING',
    });
    expect(h.ordersOf(userA.userId)).toHaveLength(0);
    expect(h.world.providerCreates).toBe(1);
  });

  it('discards results that arrive after the account changed', async () => {
    const h = createOwnerWorld();
    h.setResidency('user-a', {
      state: 'ACTIVE',
      validFrom: '2026-11-01T09:00:00.000Z',
      validUntil: '2026-12-01T09:00:00.000Z',
    });
    let epoch = 'epoch-1';
    mount(h, new MemoryStorage(), userA, () => epoch);
    // The account changes before the first status and catalog responses are applied.
    epoch = 'epoch-2';
    await waitFor(() =>
      expect(h.world.log.filter((l) => l.method === 'GET').length).toBeGreaterThanOrEqual(1),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Активно')).not.toBeInTheDocument();
    expect(screen.queryByText('Резидентство (синтетика)')).not.toBeInTheDocument();
  });
});

describe('contract v2 composed chain: web → SDK → consumer routes/runtime/client → owner HTTP/domain', () => {
  const productId = '4037a3a3-e551-4f9a-a9db-1410e46b8635';
  it('rejects missing consent in the actual consumer before any provider POST', async () => {
    const h = createOwnerWorld();
    const response = await h.fetchImplementation(
      'https://lk2.synthetic.test/user/api/v1/synthetic/residency/orders',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-token:user-a',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'residency:' + randomUuid(),
        },
        body: JSON.stringify({ mode: 'NEW' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'RESIDENCY_PRICE_CONSENT_REQUIRED' });
    expect(h.world.providerCreates).toBe(0);
  });
  it('requires fresh consent for a decrease, then replays the confirmed exact price unchanged', async () => {
    const h = createOwnerWorld();
    const m = mount(h);
    const button = await confirm();
    h.world.priceMinor = 69000;
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Цена снизилась до 690 ₽');
    expect(m.opened).toHaveLength(0);
    expect(h.world.providerCreates).toBe(0);
    expect(listResidencyAttempts(m.storage, userA)).toHaveLength(0);
    const refused = posts(h, '/residency/orders')[0]!;
    expect(refused.body).toEqual({
      mode: 'NEW',
      expectedTotalMinor: 79000,
      expectedProductId: productId,
    });
    fireEvent.click(await confirm());
    await waitFor(() => expect(m.opened).toHaveLength(1));
    const attempt = listResidencyAttempts(m.storage, userA)[0]!;
    expect(attempt.key).not.toBe(refused.key);
    expect(attempt.createPayload).toEqual({
      mode: 'NEW',
      expectedTotalMinor: 69000,
      expectedProductId: productId,
    });
    h.world.priceMinor = 99000;
    const replay = await h
      .gateway('user-a')
      .client.createResidencyOrder(attempt.createPayload!, attempt.key);
    expect(replay).toMatchObject({
      idempotentReplay: true,
      order: { pricing: { totalMinor: 69000 }, consent: { expectedTotalMinor: 69000 } },
    });
    expect(
      posts(h, '/residency/orders')
        .slice(1)
        .map((l) => l.body),
    ).toEqual([attempt.createPayload, attempt.createPayload]);
    expect(h.world.providerCreates).toBe(1);
  });
  it('lost response replay uses the original payload after a catalog change', async () => {
    const h = createOwnerWorld();
    h.world.dropResponse = (method, path) => method === 'POST' && path === '/residency/orders';
    const m = mount(h);
    fireEvent.click(await confirm());
    await screen.findByRole('alert');
    const original = listResidencyAttempts(m.storage, userA)[0]!;
    h.world.dropResponse = null;
    h.world.priceMinor = 99000;
    fireEvent.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByText('Ожидает оплаты');
    expect(posts(h, '/residency/orders').map((l) => [l.key, l.body])).toEqual([
      [original.key, original.createPayload],
      [original.key, original.createPayload],
    ]);
    expect(h.world.providerCreates).toBe(1);
  });
  it('early-renewal refusal exposes eligibleAt details and sends zero provider POSTs', async () => {
    const h = createOwnerWorld();
    h.setResidency('user-a', {
      state: 'ACTIVE',
      validFrom: '2026-11-01T09:00:00.000Z',
      validUntil: '2026-12-01T09:00:00.000Z',
    });
    await expect(
      h
        .gateway('user-a')
        .client.createResidencyOrder(
          { mode: 'RENEWAL', expectedTotalMinor: 79000, expectedProductId: productId },
          'residency:' + randomUuid(),
        ),
    ).rejects.toMatchObject({
      code: 'RESIDENCY_RENEWAL_TOO_EARLY',
      details: {
        eligibleAt: '2026-12-01T09:00:00.000Z',
        reason: 'REMAINING_DAYS_NOT_TRANSFERABLE',
      },
    });
    expect(h.world.providerCreates).toBe(0);
    expect(h.ordersOf('user-a')).toHaveLength(0);
  });
  it('finds an unresolved order on a new device with no local state and no create', async () => {
    const h = createOwnerWorld();
    await buyAndOpenPayment(h);
    cleanup();
    const other = mount(h, new MemoryStorage());
    await screen.findByText('Ожидает оплаты');
    expect(posts(h, '/residency/orders')).toHaveLength(1);
    expect(listResidencyAttempts(other.storage, userA)[0]!.key).toMatch(/^residency-lookup:/);
    expect(h.world.log.some((l) => l.method === 'GET' && l.path === '/residency/orders')).toBe(
      true,
    );
  });
  it('overdue PENDING stays unresolved and offers no payment even though owner retains its URL', async () => {
    const h = createOwnerWorld();
    const { storage } = await buyAndOpenPayment(h);
    cleanup();
    h.world.now += 60 * 60 * 1000;
    mount(h, storage);
    await screen.findByText(/Время ожидания истекло/);
    expect(
      screen.queryByRole('button', { name: /Оформить|Перейти к оплате/ }),
    ).not.toBeInTheDocument();
    expect(h.ordersOf('user-a')[0]!.state).toBe('PENDING_PAYMENT');
    expect(h.world.providerCreates).toBe(1);
  });
  it('reauth provides a Viva action and preserves the original operation through a new session', async () => {
    const h = createOwnerWorld();
    const m = mount(h);
    const button = await confirm();
    h.world.consumer = 'reauth';
    fireEvent.click(button);
    const login = await screen.findByRole('button', { name: 'Войти повторно через Viva' });
    const original = listResidencyAttempts(m.storage, userA)[0]!;
    fireEvent.click(login);
    await waitFor(() => expect(h.world.reauthorizations).toBe(1));
    expect(listResidencyAttempts(m.storage, userA)).toEqual([original]);
    cleanup();
    h.world.consumer = 'ok';
    mount(h, m.storage);
    fireEvent.click(await screen.findByRole('button', { name: 'Проверить заказ' }));
    await screen.findByText('Ожидает оплаты');
    expect(posts(h, '/residency/orders').map((l) => l.key)).toEqual([original.key, original.key]);
    expect(h.world.providerCreates).toBe(1);
  });
  it('cancelled Viva reauthorization keeps the key and the existing orderId', async () => {
    const h = createOwnerWorld();
    const { storage } = await buyAndOpenPayment(h);
    const [original] = listResidencyAttempts(storage, userA);
    expect(original?.orderId).toBe(h.ordersOf(userA.userId)[0]!.orderId);
    cleanup();
    h.world.consumer = 'reauth';
    h.world.reauthorizationError = Object.assign(new Error('cancelled'), {
      code: 'VIVA_OAUTH_CANCELLED',
    });
    mount(h, storage);
    fireEvent.click(await screen.findByRole('button', { name: 'Войти повторно через Viva' }));
    expect(await screen.findByText(/Повторный вход через Viva прерван/)).toBeInTheDocument();
    expect(screen.queryByText(/Не удалось получить ответ сервера/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Войти повторно через Viva' })).toBeEnabled();
    expect(listResidencyAttempts(storage, userA)).toEqual([original]);
    expect(h.world.reauthorizations).toBe(1);
    expect(posts(h, '/residency/orders')).toHaveLength(1);
  });

  it.each(['page reload', 'browser back'] as const)(
    'reports interrupted reauthorization on %s while Viva still requires sign-in',
    async (returnMode) => {
      const h = createOwnerWorld();
      const { storage } = await buyAndOpenPayment(h);
      const saved = listResidencyAttempts(storage, userA);
      h.world.consumer = 'reauth';
      h.world.reauthorizationInterrupted = true;
      if (returnMode === 'browser back') {
        fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
      } else {
        cleanup();
        mount(h, storage);
      }
      expect(await screen.findByText(/Повторный вход через Viva прерван/)).toBeInTheDocument();
      expect(
        await screen.findByRole('button', { name: 'Войти повторно через Viva' }),
      ).toBeEnabled();
      expect(listResidencyAttempts(storage, userA)).toEqual(saved);
      expect(h.world.reauthorizations).toBe(0);
      expect(posts(h, '/residency/orders')).toHaveLength(1);
    },
  );

  it('legacy records never acquire consent from a fresh catalog and never replay a create', async () => {
    const h = createOwnerWorld();
    h.world.failBeforeOwner = (method, path) => method === 'POST' && path === '/residency/orders';
    const m = mount(h);
    fireEvent.click(await confirm());
    await screen.findByRole('alert');
    cleanup();
    const key = m.storage.key(0)!;
    const value = JSON.parse(m.storage.getItem(key)!) as Record<string, unknown>;
    delete value.createPayload;
    m.storage.setItem(key, JSON.stringify(value));
    h.world.failBeforeOwner = null;
    mount(h, m.storage);
    await screen.findByText(/Сохранена прежняя попытка/);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    await screen.findByRole('alert');
    expect(posts(h, '/residency/orders')).toHaveLength(1);
    expect(h.world.providerCreates).toBe(0);
    expect(m.storage.getItem(key)).toBe(JSON.stringify(value));
  });
  it.each(['orderId', 'removed'] as const)(
    'two visible windows: recover synchronizes %s without visibilitychange',
    async (outcome) => {
      const h = createOwnerWorld();
      h.world.failBeforeOwner = (method, path) => method === 'POST' && path === '/residency/orders';
      const store = new MemoryStorage();
      const a = mount(h, store);
      fireEvent.click(await confirm());
      await within(a.view.container).findByRole('alert');
      const b = mount(h, store);
      await within(b.view.container).findByText('Заказ отправлен');
      h.world.failBeforeOwner = null;
      if (outcome === 'removed') {
        h.setResidency('user-a', {
          state: 'ACTIVE',
          validFrom: '2026-11-01T09:00:00.000Z',
          validUntil: '2026-12-01T09:00:00.000Z',
        });
      }
      fireEvent.click(within(b.view.container).getByRole('button', { name: 'Проверить заказ' }));
      if (outcome === 'orderId') await within(b.view.container).findByText('Ожидает оплаты');
      else await waitFor(() => expect(listResidencyAttempts(store, userA)).toHaveLength(0));
      const before = posts(h, '/residency/orders').length;
      fireEvent.click(within(a.view.container).getByRole('button', { name: 'Проверить заказ' }));
      await waitFor(() =>
        expect(within(a.view.container).queryByText('Заказ отправлен')).not.toBeInTheDocument(),
      );
      if (outcome === 'orderId') await within(a.view.container).findByText('Ожидает оплаты');
      expect(posts(h, '/residency/orders')).toHaveLength(before);
    },
  );
});

it('a competing device create after initial lookup is found immediately on pending refusal', async () => {
  const h = createOwnerWorld();
  mount(h);
  const confirmButton = await confirm();
  await h
    .gateway('user-a')
    .client.createResidencyOrder(
      { mode: 'NEW', expectedTotalMinor: 79000 },
      'residency:' + randomUuid(),
    );
  fireEvent.click(confirmButton);
  await screen.findByText('Ожидает оплаты');
  expect(screen.queryByRole('button', { name: 'Оформить резидентство' })).not.toBeInTheDocument();
  expect(h.world.providerCreates).toBe(1);
});

it('retries an initially unavailable unresolved lookup without reload', async () => {
  const h = createOwnerWorld();
  h.world.failBeforeOwner = (method, path) => method === 'GET' && path === '/residency/orders';
  mount(h);
  const retry = await screen.findByRole('button', { name: 'Проверить заказы' });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Оформить резидентство' })).not.toBeInTheDocument();
  h.world.failBeforeOwner = null;
  fireEvent.click(retry);
  await screen.findByRole('button', { name: 'Оформить резидентство' });
  expect(posts(h, '/residency/orders')).toHaveLength(0);
});

it('a malformed consent echo never launches payment and retains custody', async () => {
  const h = createOwnerWorld();
  const g = h.gateway('user-a');
  const storage = new MemoryStorage();
  const gateway = {
    ...g.gateway,
    createResidencyOrder: async (...args: Parameters<typeof g.gateway.createResidencyOrder>) => {
      const result = (await g.gateway.createResidencyOrder(...args)) as {
        order: { consent: { expectedTotalMinor: number } };
      };
      result.order.consent.expectedTotalMinor = 69000;
      return result;
    },
  };
  render(
    <ResidencyPage
      gateway={gateway}
      principal={userA}
      storage={() => storage}
      randomUuid={randomUuid}
      pollLimit={0}
    />,
  );
  fireEvent.click(await confirm());
  await screen.findByRole('alert');
  expect(g.opened).toHaveLength(0);
  expect(listResidencyAttempts(storage, userA)).toHaveLength(1);
});
