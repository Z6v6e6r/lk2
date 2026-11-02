// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import type { GameCard, HomeDashboard } from '@phub/api-sdk';
import { NativeGameJoin } from './NativeGameJoin.js';
import { NativeSelfLeave } from './NativeSelfLeave.js';
import type { NativeJoinGateway } from './native-game-join-attempt.js';
const id = '11111111-1111-4111-8111-111111111111',
  sub = '22222222-2222-4222-8222-222222222222',
  scope = { tenantId: 'tenant', userId: 'actor' };
const free = {
  id,
  revision: 1,
  allowedActions: ['JOIN'],
  viewerRelation: 'NONE',
  priceSummary: null,
} as GameCard;
const quote = {
  gameId: id,
  revision: 1,
  subscriptionInstanceId: sub,
  eligibility: 'AVAILABLE',
  reasonCode: null,
  subscriptionApplied: true,
  price: { status: 'ADVISORY', amountMinor: 0, currency: 'RUB', confirmed: false },
  expiresAt: '2099-01-01T00:00:00Z',
  requiresPriceConsent: true,
};
function setup(paid = false) {
  const game = {
    ...free,
    priceSummary: paid ? { amountMinor: 10000, currency: 'RUB' as const } : null,
  };
  const request = vi.fn<NativeJoinGateway['request']>((v) =>
    v.resource === 'conditions' ? Promise.resolve(quote) : Promise.reject(new TypeError('lost')),
  );
  const gateway = {
    principal: () => 'original' as string | null,
    getGame: vi.fn(() => Promise.resolve(game)),
    getHomeDashboard: vi.fn(() =>
      Promise.resolve({
        subscriptions: [{ id: sub, title: 'Тестовый абонемент' }],
      } as HomeDashboard),
    ),
    request,
  };
  return { game, gateway, request };
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_n: unknown, _o: unknown, fn: () => unknown) => await fn() },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('free lost ACK survives remount; no automatic replay; explicit retry uses exact body/key', async () => {
  const s = setup();
  render(<NativeGameJoin {...s} scope={scope} />);
  fireEvent.click(screen.getByRole('button', { name: 'Присоединиться к игре' }));
  await screen.findByRole('button', { name: 'Повторить исходный запрос записи' });
  const original = s.request.mock.calls[0]![0];
  cleanup();
  render(<NativeGameJoin {...s} scope={scope} />);
  await screen.findByRole('button', { name: 'Проверить запись' });
  expect(s.request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить исходный запрос записи' }));
  await waitFor(() => expect(s.request).toHaveBeenCalledTimes(2));
  expect(s.request.mock.calls[1]![0]).toEqual(original);
});
it('paid zero price requires explicit consent; remount GET only; missing operation blocks reconcile', async () => {
  const s = setup(true);
  render(<NativeGameJoin {...s} scope={scope} />);
  await screen.findByRole('option', { name: 'Тестовый абонемент' });
  fireEvent.change(screen.getByLabelText('Выберите подписку'), { target: { value: sub } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить условия записи' }));
  const consent = await screen.findByRole('checkbox');
  expect(
    screen.getByRole('button', { name: 'Записаться по подписке' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(consent);
  fireEvent.click(screen.getByRole('button', { name: 'Записаться по подписке' }));
  await screen.findByRole('button', { name: 'Проверить запись' });
  const command = s.request.mock.calls.find(([v]) => v.resource === 'join')![0];
  expect(JSON.parse(command.body!)).toMatchObject({
    priceConsent: { amountMinor: 0, currency: 'RUB' },
  });
  cleanup();
  render(<NativeGameJoin {...s} scope={scope} />);
  await waitFor(() =>
    expect(
      s.request.mock.calls.some(([v]) => v.resource === 'paidStatus' && v.key === command.key),
    ).toBe(true),
  );
  expect(s.request.mock.calls.filter(([v]) => v.resource === 'join')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Сверить исходную запись' })).toBeNull();
});
it('pending JOIN blocks native SELF LEAVE even if a lagged card offers LEAVE', async () => {
  const s = setup();
  render(<NativeGameJoin {...s} scope={scope} />);
  fireEvent.click(screen.getByRole('button', { name: 'Присоединиться к игре' }));
  await screen.findByRole('button', { name: 'Проверить запись' });
  cleanup();
  const leave = vi.fn(),
    gateway = {
      principal: () => 'original',
      leaveGame: leave,
      getManagedLeaveOperation: vi.fn(),
      reconcileManagedLeaveOperation: vi.fn(),
    };
  render(
    <NativeSelfLeave
      game={{ ...free, allowedActions: ['LEAVE'], viewerRelation: 'PARTICIPANT' }}
      gateway={gateway}
      scope={scope}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Выйти из игры' }));
  await screen.findByText('Выход не подтверждён. Проверьте состояние исходного запроса.');
  expect(leave).not.toHaveBeenCalled();
});
it('missing locks and retired account cannot submit', () => {
  const s = setup();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  render(<NativeGameJoin {...s} scope={scope} />);
  expect(
    screen.getByRole('button', { name: 'Присоединиться к игре' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(s.request).not.toHaveBeenCalled();
});
it('malformed terminal JOIN custody cannot permit a fresh native LEAVE', async () => {
  localStorage.setItem(
    `phub.native-join.v1:tenant:actor:${id}`,
    JSON.stringify({ version: 1, gameId: id, state: 'CONFIRMED' }),
  );
  const leave = vi.fn(),
    gateway = {
      principal: () => 'original',
      leaveGame: leave,
      getManagedLeaveOperation: vi.fn(),
      reconcileManagedLeaveOperation: vi.fn(),
    };
  render(
    <NativeSelfLeave
      game={{ ...free, allowedActions: ['LEAVE'], viewerRelation: 'PARTICIPANT' }}
      gateway={gateway}
      scope={scope}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Выйти из игры' }));
  await screen.findByText('Выход не подтверждён. Проверьте состояние исходного запроса.');
  expect(leave).not.toHaveBeenCalled();
});
