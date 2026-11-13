// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../web/src/App.js';
import {
  createBrowserAuthGateway,
  type GameCard,
  type UserUpcomingBookings,
} from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { auth, config, game as publicGame, viewerId } from './ios/testing/cabinet-fixtures.js';

vi.mock('../../web/src/chat-realtime-client.js', () => ({
  connectChatRealtime: () => ({ stop: () => {} }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(navigator, 'share');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const nativeGame: GameCard = {
  ...publicGame,
  surface: 'MY_UPCOMING',
  viewerRelation: 'PARTICIPANT',
  viewerPaymentState: 'NOT_REQUIRED',
  levelRange: publicGame.levelRange ?? null,
  priceSummary: null,
  capacity: { ...publicGame.capacity, total: 4 },
  participants: publicGame.participants.map((p, index) => ({
    ...p,
    userId: index === 1 ? viewerId : `00000000-0000-4000-8000-00000000000${index + 2}`,
  })),
  allowedActions: ['OPEN_DETAILS', 'LEAVE'],
  conversation: null,
  resultSummary: null,
};
function setup(overrides: Partial<GameCard> = {}, booking?: UserUpcomingBookings['items'][number]) {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: unknown, _options: unknown, action: () => unknown) => await action(),
    },
  });
  const game = { ...nativeGame, ...overrides };
  const operationId = '22222222-2222-4222-8222-222222222222';
  const pendingLeave = {
    commandId: operationId,
    operation: {
      id: operationId,
      type: 'LEAVE_GAME',
      gameId: game.id,
      status: 'UNKNOWN',
      nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 15 },
    },
    game: null,
    replayed: true,
  };
  const request = vi.fn<AndroidSessionPlugin['request']>((input) =>
    Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify(
          input.path.endsWith('/auth/session/refresh')
            ? auth
            : input.path.endsWith('/participants/me') || input.path.endsWith('/leave-operation')
              ? pendingLeave
              : input.path.endsWith('/games/' + game.id)
                ? { game }
                : input.path.endsWith('/bookings/upcoming')
                  ? {
                      state: 'READY',
                      version: 'synthetic-booking',
                      generatedAt: '2026-11-13T00:00:00Z',
                      staleAt: '2099-01-01T00:00:00Z',
                      items: booking ? [booking] : [],
                    }
                  : { items: [] },
        ),
      ).toString('base64'),
    }),
  );
  const gateway = createBrowserAuthGateway({
    baseUrl: config.apiBaseUrl,
    tenantKey: config.tenantKey,
    appVersion: 'test',
    platform: 'android',
    nativeSessionTransport: true,
    fetchImplementation: createNativeApiFetch(config, {
      request,
      configuration: () => Promise.resolve(config),
    }),
  });
  window.history.replaceState(
    null,
    '',
    booking
      ? `/games?event=${booking.id}`
      : `/games/${game.id}?invitationId=do-not-share#private-state`,
  );
  render(
    <App
      clientPlatform="android"
      gateway={gateway}
      tenantKey={config.tenantKey}
      realtimeBaseUrl={config.apiBaseUrl}
    />,
  );
  return request;
}

it('renders the approved participant card, invite and starting lineup through the actual Android route', async () => {
  const request = setup();
  const participants = await screen.findByRole('region', { name: 'Участники игры' });
  expect(screen.getByRole('tab', { name: 'Игра' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Результат' })).toBeVisible();
  expect(within(participants).getByRole('button', { name: 'Пригласить в игру' })).toBeVisible();
  expect(within(participants).getByText('Организатор')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Стартовый состав' })).toBeVisible();
  expect(within(participants).queryByRole('button', { name: 'Покинуть игру' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Выйти из игры' })).toHaveLength(1);
  expect(request.mock.calls.some(([v]) => v.method === 'DELETE')).toBe(false);
});

it('shares a public canonical URL from Android, without local WebView origin or private query', async () => {
  const request = setup();
  const share = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  fireEvent.click(await screen.findByRole('button', { name: 'Пригласить в игру' }));
  await waitFor(() =>
    expect(share).toHaveBeenCalledExactlyOnceWith({
      title: nativeGame.title,
      url: `${config.apiBaseUrl}/games/${nativeGame.id}`,
    }),
  );
  expect(request.mock.calls.some(([v]) => /\/participants\/me|\/join$|\/result/.test(v.path))).toBe(
    false,
  );
});

it('does not expose Web-only result writes in the actual Android result tab', async () => {
  const request = setup({
    allowedActions: ['SUBMIT_RESULT', 'CONFIRM_RESULT', 'DISPUTE_RESULT'],
    resultSummary: { state: 'AWAITING_SUBMISSION' },
  });
  fireEvent.click(await screen.findByRole('tab', { name: 'Результат' }));
  expect(screen.getByRole('region', { name: 'Результат матча' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Пары и счёт по сетам' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: /Подтвердить результат|Оспорить результат|Отправить/ }),
  ).toBeNull();
  expect(request.mock.calls.some(([v]) => v.path.includes('/result'))).toBe(false);
});

it('preserves the existing native leave controller and original-key recovery across tab switches', async () => {
  const request = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Выйти из игры' }));
  const recovery = await screen.findByRole('button', { name: 'Проверить выход' });
  const original = request.mock.calls.find(([v]) => v.path.endsWith('/participants/me'))![0];
  fireEvent.click(screen.getByRole('tab', { name: 'Результат' }));
  expect(screen.queryByRole('button', { name: 'Проверить выход' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Игра' }));
  expect(screen.getByRole('button', { name: 'Проверить выход' })).toBe(recovery);
  fireEvent.click(recovery);
  await waitFor(() =>
    expect(request.mock.calls.some(([v]) => v.path.endsWith('/leave-operation'))).toBe(true),
  );
  const read = request.mock.calls.find(([v]) => v.path.endsWith('/leave-operation'))![0];
  expect(read.method).toBe('GET');
  expect(read.headers['idempotency-key']).toBe(original.headers['idempotency-key']);
  expect(request.mock.calls.filter(([v]) => v.path.endsWith('/participants/me'))).toHaveLength(1);
});

const snapshotBooking: UserUpcomingBookings['items'][number] = {
  id: '88888888-8888-4888-8888-888888888888',
  kind: 'game',
  title: 'Утренняя игра',
  startsAt: '2026-11-15T04:00:00Z',
  endsAt: '2026-11-15T05:00:00Z',
  venue: 'Терехово',
  status: 'confirmed',
  route: '/games?event=88888888-8888-4888-8888-888888888888',
  roster: { state: 'UNAVAILABLE' },
};

it('opens an unlinked My bookings snapshot with the detail design through Android transport', async () => {
  const request = setup({}, snapshotBooking);
  expect(await screen.findByRole('heading', { name: 'Детали матча' })).toBeVisible();
  expect(await screen.findByRole('region', { name: 'Участники игры' })).toBeVisible();
  expect(screen.getByText('Состав временно недоступен')).toBeVisible();
  expect(screen.queryByText('Свободное место')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Результат' }));
  expect(screen.getByText('Результат пока недоступен')).toBeVisible();
  expect(request.mock.calls.some(([v]) => v.path.endsWith('/bookings/upcoming'))).toBe(true);
  expect(
    request.mock.calls.every(
      ([v]) => v.method === 'GET' || v.path.endsWith('/auth/session/refresh'),
    ),
  ).toBe(true);
});

it('resolves an explicitly linked legacy booking to the canonical Android card', async () => {
  const request = setup({}, { ...snapshotBooking, gameId: nativeGame.id });
  expect(await screen.findByRole('heading', { name: 'Стартовый состав' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Пригласить в игру' })).toBeVisible();
  expect(window.location.pathname).toBe(`/games/${nativeGame.id}`);
  expect(window.location.search).toBe('');
  expect(request.mock.calls.some(([v]) => v.path.endsWith('/games/' + nativeGame.id))).toBe(true);
  expect(request.mock.calls.some(([v]) => /\/participants\/me|\/join$|\/result/.test(v.path))).toBe(
    false,
  );
});
