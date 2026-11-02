// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { IOSCabinet } from './ios/IOSCabinet.js';
import {
  auth,
  config,
  homeDashboard,
  fixtureReply,
  nativeResult,
  syntheticSession,
} from './ios/testing/cabinet-fixtures.js';
import type { IOSSessionPlugin } from './ios/session.js';
vi.mock('../../web/src/chat-realtime-client.js', () => ({
  connectChatRealtime: () => ({ stop: () => {} }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});
it.each(['android', 'ios'] as const)(
  '%s subscription list/detail/refresh uses canonical home snapshot, preserving uncertain zero',
  async (platform) => {
    vi.stubGlobal('scrollTo', vi.fn());
    let reads = 0;
    const subscription = { ...homeDashboard.subscriptions[0]!, remainingUnits: 0 },
      dashboard = {
        ...homeDashboard,
        subscriptions: [
          subscription,
          {
            ...subscription,
            id: '22222222-2222-4222-8222-222222222222',
            title: 'Другой абонемент',
          },
        ],
      };
    if (platform === 'android') {
      const request: AndroidSessionPlugin['request'] = (v) => {
        if (v.path.endsWith('/home')) reads += 1;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            JSON.stringify(
              v.path.endsWith('/auth/session/refresh')
                ? auth
                : v.path.endsWith('/home')
                  ? dashboard
                  : { items: [] },
            ),
          ).toString('base64'),
        });
      };
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
      window.history.replaceState(null, '', '/subscriptions');
      render(<App gateway={gateway} tenantKey={config.tenantKey} clientPlatform="android" />);
    } else {
      const request: IOSSessionPlugin['request'] = (v) => {
        if (v.operation === 'read' && v.resource === 'home') {
          reads += 1;
          return Promise.resolve(nativeResult(dashboard));
        }
        return Promise.resolve(fixtureReply(v));
      };
      const session = syntheticSession(request);
      await session.restore();
      render(<IOSCabinet session={session} auth={auth} />);
      await screen.findByRole('main', { name: 'Главная' });
      fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
      fireEvent.click(await screen.findByRole('link', { name: 'Мои абонементы' }));
    }
    await screen.findByRole('heading', { level: 1, name: 'Мои абонементы' });
    const links = await screen.findAllByRole('link', {
      name: new RegExp(subscription.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    });
    fireEvent.click(links[0]!);
    await screen.findByRole('heading', { level: 1, name: subscription.title });
    expect(screen.queryByText('Другой абонемент')).toBeNull();
    expect(screen.getByText('Не подтверждён')).toBeDefined();
    const before = reads;
    fireEvent.click(screen.getByRole('button', { name: 'Обновить подборку абонементов' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    expect(screen.queryByRole('button', { name: /Купить|Оплатить/ })).toBeNull();
  },
);
