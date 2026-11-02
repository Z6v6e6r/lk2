// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { auth, config, game as publicGame } from './ios/testing/cabinet-fixtures.js';
vi.mock('../../web/src/chat-realtime-client.js', () => ({
  connectChatRealtime: () => ({ stop: () => {} }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});
it('Android actual detail reaches original-key native DELETE and GET recovery without payment/waitlist controls', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_n: unknown, _o: unknown, fn: () => unknown) => await fn() },
  });
  const game = {
    ...publicGame,
    viewerRelation: 'PARTICIPANT',
    allowedActions: ['LEAVE', 'JOIN_WAITLIST', 'PAY'],
  };
  const op = '22222222-2222-4222-8222-222222222222';
  const receipt = {
    commandId: op,
    operation: {
      id: op,
      type: 'LEAVE_GAME',
      gameId: game.id,
      status: 'UNKNOWN',
      nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 15 },
    },
    game: null,
    replayed: true,
  };
  const request = vi.fn<AndroidSessionPlugin['request']>((v) =>
    Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify(
          v.path.endsWith('/auth/session/refresh')
            ? auth
            : v.path.endsWith('/participants/me') || v.path.endsWith('/leave-operation')
              ? receipt
              : v.path.endsWith('/games/' + game.id)
                ? { game }
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
  window.history.replaceState(null, '', `/games/${game.id}`);
  render(<App clientPlatform="android" gateway={gateway} tenantKey={config.tenantKey} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Выйти из игры' }));
  await screen.findByRole('button', { name: 'Проверить выход' });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить выход' }));
  await waitFor(() =>
    expect(request.mock.calls.some(([v]) => v.path.endsWith('/leave-operation'))).toBe(true),
  );
  const leave = request.mock.calls.find(([v]) => v.path.endsWith('/participants/me'))![0],
    read = request.mock.calls.find(([v]) => v.path.endsWith('/leave-operation'))![0];
  expect(leave.method).toBe('DELETE');
  expect(read.method).toBe('GET');
  expect(read.headers['idempotency-key']).toBe(leave.headers['idempotency-key']);
  expect(leave).not.toHaveProperty('body');
  expect(request.mock.calls.filter(([v]) => v.path.endsWith('/participants/me'))).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /Оплатить|Лист ожидания/ })).toBeNull();
});
