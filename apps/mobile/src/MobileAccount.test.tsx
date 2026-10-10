// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../web/src/App.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { IOSAuthApp } from './ios/IOSAuthApp.js';
import { selfProfile } from './ios/cabinet-data.js';
import {
  auth,
  config,
  fixtureReply,
  homeDashboard,
  nativeResult,
  syntheticSession,
  viewerId,
} from './ios/testing/cabinet-fixtures.js';

const photo =
  '/public/api/v1/media/profile-photos/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003';
const profile = { ...homeDashboard.profile, lastName: 'Петрова', avatarUrl: photo };

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  window.history.replaceState(null, '', `/profile/${viewerId}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it.each([
  ['android', false],
  ['ios', false],
  ['android', true],
  ['ios', true],
] as const)(
  'shows the canonical account on %s independently of unavailable subscriptions (%s)',
  async (platform, unavailableDashboard) => {
    if (platform === 'ios') {
      const session = syntheticSession(async (input) =>
        Promise.resolve(
          input.resource === 'profile'
            ? nativeResult(profile)
            : input.resource === 'home' && unavailableDashboard
              ? nativeResult({ code: 'UNAVAILABLE' }, 503)
              : fixtureReply(input),
        ),
      );
      await session.restore();
      render(<IOSAuthApp session={session} />);
      fireEvent.click(await screen.findByRole('link', { name: 'Профиль' }));
      expect(selfProfile(profile).profile.lastName).toBe('Петрова');
    } else {
      const request = vi.fn<AndroidSessionPlugin['request']>(async (input) => {
        const suffix = input.path.split('?')[0]?.replace(`/user/api/v1/${config.tenantKey}`, '');
        const body =
          suffix === '/auth/session/refresh'
            ? auth
            : suffix === '/profile'
              ? profile
              : suffix === '/home'
                ? homeDashboard
                : suffix === '/profile/booking-preferences'
                  ? fixtureReply({ operation: 'read', resource: 'preferences', headers: {} })
                  : suffix === '/profile/privacy'
                    ? fixtureReply({ operation: 'read', resource: 'privacy', headers: {} })
                    : { items: [] };
        const payload =
          typeof body === 'object' && 'body' in body ? (JSON.parse(body.body) as unknown) : body;
        return await Promise.resolve({
          status: suffix === '/home' && unavailableDashboard ? 503 : 200,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        });
      });
      const gateway = createBrowserAuthGateway({
        baseUrl: config.apiBaseUrl,
        tenantKey: config.tenantKey,
        platform: 'android',
        appVersion: 'test',
        nativeSessionTransport: true,
        fetchImplementation: createNativeApiFetch(config, {
          configuration: async () => Promise.resolve(config),
          request,
        }),
      });
      await gateway.restoreSession();
      expect((await gateway.getPlayerProfile(viewerId)).profile.lastName).toBe('Петрова');
      render(<App gateway={gateway} tenantKey={config.tenantKey} clientPlatform="android" />);
    }
    await screen.findByRole('region', { name: 'Подписки и абонементы' });
    expect(await screen.findByRole('heading', { name: profile.displayName })).toBeVisible();
    expect(
      screen.getByRole('img', { name: /Анна Петрова, уровень C\+/ }).querySelector('img'),
    ).toHaveAttribute('src', config.apiBaseUrl + photo);
    const account = screen.getByLabelText('Данные профиля');
    expect(within(account).getByText('C+')).toBeVisible();
    expect(account).toHaveTextContent('540');
    if (unavailableDashboard) {
      const subscriptions = screen.getByRole('region', { name: 'Подписки и абонементы' });
      expect(await within(subscriptions).findByRole('alert')).toBeVisible();
      expect(within(subscriptions).queryByText('Лето · Падел · Спорт')).toBeNull();
    } else expect(await screen.findByText('Лето · Падел · Спорт')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'продлить' })).toBeNull();
  },
);
