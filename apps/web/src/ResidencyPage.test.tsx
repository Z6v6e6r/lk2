// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ResidencyPage } from './ResidencyPage.js';
import {
  createOwnerWorld,
  verifyOwnerSnapshot,
  type OwnerHarness,
} from './residency-owner.test-helper.js';
import { listResidencyAttempts } from './residency-purchase.js';

// Every scenario below runs the real lk#443 owner state machine and HTTP contract (imported
// byte-identical) behind a synthetic LK2 consumer transport and the real @phub/api-sdk client.
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
  it('is byte-identical to lk#443 @ adc9c644', () => {
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

  it('offers renewal for an active residency', async () => {
    const h = createOwnerWorld();
    h.setResidency('user-a', {
      state: 'ACTIVE',
      validFrom: '2026-11-01T09:00:00.000Z',
      validUntil: '2026-12-01T09:00:00.000Z',
    });
    mount(h);
    expect(await screen.findByText('Активно')).toBeInTheDocument();
    expect(screen.getByText('1 декабря 2026 г.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Продлить резидентство' })).toBeEnabled();
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
      validUntil: '2026-12-01T09:00:00.000Z',
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
    expect(screen.getByText('1 декабря 2026 г.')).toBeInTheDocument();
    expect(screen.queryByText('Резидентство продлено')).not.toBeInTheDocument();
    h.syncLk2Read('user-a');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить статус' }));
    expect(await screen.findByText('Резидентство продлено')).toBeInTheDocument();
    expect(screen.getByText(/действует до 31 декабря 2026 г\./)).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Отменить заказ' })).not.toBeInTheDocument();
    expect(screen.getByText(/закроется\s+автоматически/)).toBeInTheDocument();
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
    mount(h, storage); // reload: no automatic POST
    expect(await screen.findByText('Заказ отправлен')).toBeInTheDocument();
    expect(posts(h, '/residency/orders')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить заказ' }));
    expect(await screen.findByText('Ожидает оплаты')).toBeInTheDocument();
    const keys = posts(h, '/residency/orders').map((l) => l.key);
    expect(keys).toHaveLength(2);
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
    expect(
      await screen.findByRole('button', { name: 'Продлить резидентство' }),
    ).toBeInTheDocument();
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
      'Сумма заказа 990 ₽ отличается от подтверждённой 790 ₽',
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
    expect(order.state).toBe('CANCELLED');
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

  it('a paid order that needs club review offers no second payment after return', async () => {
    const h = createOwnerWorld();
    h.world.activationRejects = true;
    const { storage } = await buyAndOpenPayment(h);
    cleanup();
    h.bankSettles('PAID');
    mount(h, storage);
    expect(await screen.findByText('Нужна проверка клуба')).toBeInTheDocument();
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
