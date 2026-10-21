// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameJoinConditions } from '@phub/api-sdk';
import { GameJoinConditionsPanel } from './GameJoinConditionsPanel.js';

const gameId = '00000000-0000-4000-8000-000000000001';
const subscriptionInstanceId = '00000000-0000-4000-8000-000000000002';
function quote(): GameJoinConditions {
  return {
    gameId,
    revision: 8,
    ownerRevision: null,
    subscriptionInstanceId,
    eligibility: 'AVAILABLE',
    reasonCode: null,
    subscriptionApplied: true,
    price: { status: 'ADVISORY', amountMinor: 70000, currency: 'RUB', confirmed: false },
    freeMinutes: 60,
    paidMinutes: 30,
    evaluatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonBinding: true,
    requiresReservationRecheck: true,
    requiresPriceConsent: true,
    source: 'LK1_PRICE_PREVIEW',
    providerMode: 'MOCK',
  };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('C2 advisory conditions safety', () => {
  it('retries an error only on explicit activation and suppresses double tap while loading', async () => {
    const client = {
      getGameJoinConditions: vi
        .fn()
        .mockRejectedValueOnce(new Error('synthetic read failure'))
        .mockImplementation(() => new Promise<GameJoinConditions>(() => {})),
    };
    render(
      <GameJoinConditionsPanel
        gameId={gameId}
        revision={8}
        subscriptionInstanceId={subscriptionInstanceId}
        client={client}
      />,
    );
    expect(
      await screen.findByText('Условия и цена не подтверждены. Повторите проверку.'),
    ).toBeVisible();
    expect(client.getGameJoinConditions).toHaveBeenCalledTimes(1);
    await userEvent.setup().dblClick(screen.getByRole('button', { name: 'Обновить условия' }));
    expect(screen.getByText('Проверяем подписку…')).toBeVisible();
    expect(client.getGameJoinConditions).toHaveBeenCalledTimes(2);
  });

  it('does not read conditions without an explicit own-product selection', () => {
    const client = { getGameJoinConditions: vi.fn() };
    render(<GameJoinConditionsPanel gameId={gameId} revision={8} client={client} />);
    expect(
      screen.getByText('Проверка выбранной подписки пока недоступна. Цена не подтверждена.'),
    ).toBeVisible();
    expect(client.getGameJoinConditions).not.toHaveBeenCalled();
  });

  it('explains exhausted benefit without declaring the service forbidden or allowing full payment', async () => {
    const client = {
      getGameJoinConditions: vi
        .fn()
        .mockResolvedValue({ ...quote(), eligibility: 'LIMIT_USED', subscriptionApplied: false }),
    };
    render(
      <GameJoinConditionsPanel
        gameId={gameId}
        revision={8}
        subscriptionInstanceId={subscriptionInstanceId}
        client={client}
      />,
    );
    expect(
      await screen.findByText(
        'Лимит льготы по подписке исчерпан. Это не подтверждает запрет услуги или возможность оплаты по другой цене.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /оплатить|вступить|подтвердить/i })).toBeNull();
  });

  it('keeps a zero advisory amount distinct from a free game', async () => {
    const value = quote();
    const client = {
      getGameJoinConditions: vi
        .fn()
        .mockResolvedValue({ ...value, price: { ...value.price, amountMinor: 0 } }),
    };
    render(
      <GameJoinConditionsPanel
        gameId={gameId}
        revision={8}
        subscriptionInstanceId={subscriptionInstanceId}
        client={client}
      />,
    );
    expect(
      await screen.findByText(
        'Нулевая предварительная цена не означает бесплатную игру. Итоговые условия подтвердит сервер при записи.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /оплатить|вступить|подтвердить/i })).toBeNull();
  });

  it('does not display a price when the server says it is missing', async () => {
    const value = quote();
    const client = {
      getGameJoinConditions: vi
        .fn()
        .mockResolvedValue({ ...value, price: { ...value.price, status: 'MISSING' } }),
    };
    render(
      <GameJoinConditionsPanel
        gameId={gameId}
        revision={8}
        subscriptionInstanceId={subscriptionInstanceId}
        client={client}
      />,
    );
    expect(await screen.findByText('Подписка применима к этой игре.')).toBeVisible();
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
    expect(screen.getByText('Цена не подтверждена.')).toBeVisible();
  });

  it('bounds a stalled read and ignores its eventual response without automatic retry', async () => {
    vi.useFakeTimers();
    let complete!: (value: GameJoinConditions) => void;
    const client = {
      getGameJoinConditions: vi.fn(
        () =>
          new Promise<GameJoinConditions>((resolve) => {
            complete = resolve;
          }),
      ),
    };
    render(
      <GameJoinConditionsPanel
        gameId={gameId}
        revision={8}
        subscriptionInstanceId={subscriptionInstanceId}
        client={client}
      />,
    );
    expect(screen.getByText('Проверяем подписку…')).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(
      screen.getByText('Проверка заняла слишком много времени. Условия и цена не подтверждены.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Обновить условия' })).toBeEnabled();
    await act(async () => {
      complete(quote());
      await Promise.resolve();
    });
    expect(screen.queryByText(/Предварительная цена:/)).toBeNull();
    expect(client.getGameJoinConditions).toHaveBeenCalledTimes(1);
  });
});
