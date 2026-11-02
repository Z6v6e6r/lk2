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
  homeBase,
  bookingPreferences,
  profilePrivacy,
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
  '%s privacy and preferences saves use canonical version; explicit retry recovers lost ACK',
  async (platform) => {
    vi.stubGlobal('scrollTo', vi.fn());
    const writes: { resource: string; body: string; key: string }[] = [];
    let privacy = { ...profilePrivacy },
      preferences = { ...bookingPreferences },
      lose = true;
    function write(resource: string, body: string, key: string) {
      writes.push({ resource, body, key });
      const input = JSON.parse(body) as Record<string, unknown>;
      if (resource === 'privacy') {
        privacy = {
          ...privacy,
          contactPolicy: input.contactPolicy as typeof privacy.contactPolicy,
          chatPolicy: input.chatPolicy as typeof privacy.chatPolicy,
          version: Number(input.expectedVersion) + 1,
        };
        if (lose) {
          lose = false;
          throw new Error('lost ACK');
        }
        return privacy;
      }
      preferences = { ...preferences, ...input, version: Number(input.expectedVersion) + 1 };
      return preferences;
    }
    if (platform === 'android') {
      const request: AndroidSessionPlugin['request'] = (v) =>
        Promise.resolve().then(() => {
          const value =
            v.method === 'PUT'
              ? write(
                  v.path.endsWith('/privacy') ? 'privacy' : 'preferences',
                  v.body!,
                  new Headers(v.headers).get('idempotency-key')!,
                )
              : v.path.endsWith('/auth/session/refresh')
                ? auth
                : v.path.endsWith('/profile/privacy')
                  ? privacy
                  : v.path.endsWith('/profile/booking-preferences')
                    ? preferences
                    : v.path.endsWith('/home/base')
                      ? homeBase
                      : v.path.endsWith('/home')
                        ? homeDashboard
                        : v.path.endsWith('/profile')
                          ? homeDashboard.profile
                          : { items: [] };
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(value)).toString('base64'),
          };
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
      window.history.replaceState(null, '', '/profile');
      render(<App gateway={gateway} tenantKey={config.tenantKey} clientPlatform="android" />);
    } else {
      const request: IOSSessionPlugin['request'] = (v) =>
        Promise.resolve().then(() =>
          v.operation === 'profileSettings'
            ? nativeResult(
                write(v.resource!, v.body!, new Headers(v.headers).get('idempotency-key')!),
              )
            : fixtureReply(v),
        );
      const session = syntheticSession(request);
      await session.restore();
      render(<IOSCabinet session={session} auth={auth} />);
      await screen.findByRole('main', { name: 'Главная' });
      fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
    }
    fireEvent.click(await screen.findByRole('button', { name: /Видимость профиля/ }));
    const contact = await screen.findByRole('checkbox', { name: /Запрос на связь/ });
    await waitFor(() => expect((contact as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(contact);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await screen.findByRole('alert');
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Сохранить' }).disabled).toBe(
        true,
      ),
    );
    expect(writes[0]).toEqual(writes[1]);
    expect(JSON.parse(writes[1]!.body)).toMatchObject({
      expectedVersion: 1,
      contactPolicy: 'NOBODY',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Запрос на связь/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(JSON.parse(writes[2]!.body)).toMatchObject({ expectedVersion: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' }));
    fireEvent.click(screen.getByRole('button', { name: /Предпочтения/ }));
    const history = await screen.findByRole('checkbox', { name: /Учитывать историю игр/ });
    await waitFor(() => expect((history as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(history);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(writes).toHaveLength(4));
    expect(writes[3]!.resource).toBe('preferences');
  },
);
it('iOS profile history follows the existing self-only link and rejects another viewer response', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  let wrong = false;
  const request = vi.fn<IOSSessionPlugin['request']>((v) =>
    Promise.resolve(
      v.operation === 'read' && v.resource === 'levelHistory'
        ? nativeResult({
            userId: wrong ? '22222222-2222-4222-8222-222222222222' : homeDashboard.profile.userId,
            items: [{ changedAt: '2026-10-01T09:00:00.000Z', levelLabel: 'C', levelValue: 3.1 }],
          })
        : fixtureReply(v),
    ),
  );
  const session = syntheticSession(request);
  await session.restore();
  render(<IOSCabinet session={session} auth={auth} />);
  await screen.findByRole('main', { name: 'Главная' });
  fireEvent.click(screen.getByRole('link', { name: 'Профиль' }));
  fireEvent.click(await screen.findByRole('link', { name: /История изменения уровня/ }));
  await screen.findByRole('heading', { name: 'История уровня' });
  await screen.findByRole('img', { name: /График/ });
  const call = request.mock.calls.find(([v]) => v.resource === 'levelHistory')?.[0];
  expect(call).toMatchObject({ operation: 'read', query: { limit: '100' } });
  expect(call).not.toHaveProperty('resourceId');
  fireEvent.click(screen.getByRole('link', { name: 'Назад в профиль' }));
  wrong = true;
  fireEvent.click(await screen.findByRole('link', { name: /История изменения уровня/ }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('img', { name: /График/ })).toBeNull();
});
