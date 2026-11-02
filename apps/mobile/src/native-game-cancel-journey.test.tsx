// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
function setup(relation = 'ORGANIZER', allowed = true, lost = false, deferInitial = false) {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('scrollTo', vi.fn());
  let cancelled = false,
    reads = 0;
  let releaseInitial = () => {};
  const game = () => ({
    ...publicGame,
    revision: publicGame.revision + (cancelled ? 1 : 0),
    viewerRelation: relation,
    allowedActions: allowed && !cancelled ? ['CANCEL'] : [],
    displayState: cancelled ? 'CANCELLED' : publicGame.displayState,
  });
  const request = vi.fn<AndroidSessionPlugin['request']>((v) => {
    if (v.path.endsWith('/cancel')) {
      cancelled = true;
      if (lost) return Promise.reject(new TypeError('synthetic lost ACK'));
    }
    const data = v.path.endsWith('/auth/session/refresh')
      ? auth
      : v.path.endsWith('/games/' + publicGame.id)
        ? { game: game() }
        : { items: [] };
    if (v.path.endsWith('/games/' + publicGame.id) && ++reads === 1 && deferInitial) {
      return new Promise((resolve) => {
        releaseInitial = () =>
          resolve({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(data)).toString('base64'),
          });
      });
    }
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(data)).toString('base64'),
    });
  });
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
  window.history.replaceState(null, '', '/games/' + publicGame.id);
  render(<App clientPlatform="android" gateway={gateway} tenantKey={config.tenantKey} />);
  return Object.assign(request, { releaseInitial: () => releaseInitial() });
}
it.each([false, true])(
  'Android organizer cancel is attempted once and canonical GET proves outcome, lost ACK=%s',
  async (lost) => {
    const request = setup('ORGANIZER', true, lost);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить игру' }));
    await screen.findByText('Игра отменена.');
    expect(request.mock.calls.filter(([v]) => v.path.endsWith('/cancel'))).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Отменить игру' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Обновить статус игры' }));
    expect(request.mock.calls.filter(([v]) => v.path.endsWith('/cancel'))).toHaveLength(1);
  },
);
it.each([
  ['PARTICIPANT', true],
  ['NONE', true],
  ['ORGANIZER', false],
] as const)('requires organizer AND server CANCEL action: %s/%s', async (relation, allowed) => {
  const request = setup(relation, allowed);
  await screen.findByText(publicGame.title);
  expect(screen.queryByRole('button', { name: 'Отменить игру' })).toBeNull();
  expect(request.mock.calls.some(([v]) => v.path.endsWith('/cancel'))).toBe(false);
});
it('declining confirmation sends no command', async () => {
  const request = setup();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить игру' }));
  expect(request.mock.calls.some(([v]) => v.path.endsWith('/cancel'))).toBe(false);
});
it('late initial card cannot resurrect CANCEL after a confirmed cancellation', async () => {
  const request = setup('ORGANIZER', true, false, true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Обновить статус игры' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить игру' }));
  await screen.findByText('Игра отменена.');
  await act(async () => {
    request.releaseInitial();
    await Promise.resolve();
  });
  expect(screen.queryByRole('button', { name: 'Отменить игру' })).toBeNull();
  expect(request.mock.calls.filter(([v]) => v.path.endsWith('/cancel'))).toHaveLength(1);
});
