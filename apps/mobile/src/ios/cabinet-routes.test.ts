import { describe, expect, it, vi } from 'vitest';
import { cabinetReadRequest } from './cabinet-routes.js';
import { createIOSFetch } from './session.js';
import type { IOSSessionPlugin } from './session.js';
import { config, nativeResult, viewerId } from './testing/cabinet-fixtures.js';
import { isAppNavigation } from './cabinet-navigation.js';

const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;

describe('iOS cabinet request boundary', () => {
  it.each([
    ['/home', 'home'],
    ['/home/base', 'homeBase'],
    ['/profile', 'profile'],
    ['/profile/privacy', 'privacy'],
    ['/profile/booking-preferences', 'preferences'],
    ['/bookings/upcoming', 'bookings'],
    ['/bookings/history?kind=GAME&status=COMPLETED&limit=20', 'history'],
    ['/recommendations/bookings?limit=20', 'recommendations'],
    ['/locations', 'locations'],
    [`/locations/${viewerId}`, 'location'],
    [`/games/${viewerId}`, 'game'],
    ['/communities/mine?limit=20', 'communities'],
  ])('maps %s to a named native resource', (path, resource) => {
    expect(cabinetReadRequest(root + path, config)).toMatchObject({ operation: 'read', resource });
  });

  it('preserves public game filter values without attaching a URL or choosing a tenant', () => {
    const result = cabinetReadRequest(
      `${config.apiBaseUrl}/public/api/v1/local-padel/games?levelFrom=C%2B&startsFrom=2026-09-27T10%3A00%3A00.000Z`,
      config,
    );
    expect(result).toEqual({
      operation: 'read',
      resource: 'publicGames',
      query: { levelFrom: 'C+', startsFrom: '2026-09-27T10:00:00.000Z' },
    });
  });

  it.each([
    ['/home', 'POST'],
    ['/profile', 'PATCH'],
    ['/profile?userId=other', 'GET'],
    ['/home?limit=2', 'GET'],
    ['/recommendations/bookings?limit=21', 'GET'],
    ['/recommendations/bookings?localDate=2026-09-27', 'GET'],
    ['/communities/mine?limit=10&limit=20', 'GET'],
    ['/bookings/history?cursor=short', 'GET'],
    ['/bookings/history?cursor=aaaaaaaaaaaaaaaa%0A', 'GET'],
    ['/home#fragment', 'GET'],
    ['/home/../profile', 'GET'],
    ['/locations/%2e%2e', 'GET'],
    ['/games/not-a-uuid', 'GET'],
    [`/games/${viewerId}/join`, 'POST'],
    ['/realtime/tickets', 'POST'],
    ['/routing-plan', 'GET'],
  ])('rejects %s %s before the bridge', async (path, method) => {
    const request = vi.fn<IOSSessionPlugin['request']>();
    await expect(
      createIOSFetch(config, { configuration: async () => await Promise.resolve(config), request })(
        root + path,
        {
          method,
        },
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_REQUEST_REJECTED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects different origins and tenants, and body-bearing reads', async () => {
    const request = vi.fn<IOSSessionPlugin['request']>().mockResolvedValue(nativeResult({}));
    const fetch = createIOSFetch(config, {
      configuration: async () => await Promise.resolve(config),
      request,
    });
    for (const target of [
      'https://vivacrm.test/user/api/v1/local-padel/home',
      `${config.apiBaseUrl}/user/api/v1/another-tenant/home`,
      `${config.apiBaseUrl}.evil.test/user/api/v1/local-padel/home`,
    ])
      await expect(fetch(target)).rejects.toMatchObject({ code: 'NATIVE_REQUEST_REJECTED' });
    await expect(fetch(`${root}/home`, { method: 'GET', body: '{}' })).rejects.toMatchObject({
      code: 'NATIVE_REQUEST_REJECTED',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not confuse opaque native origins or credentials with app navigation', () => {
    const current = new URL('capacitor://localhost/');
    expect(isAppNavigation(new URL('capacitor://localhost/profile'), current)).toBe(true);
    for (const target of [
      'capacitor://evil.test/profile',
      'other://localhost/profile',
      'https://localhost/profile',
      'capacitor://user@localhost/profile',
    ])
      expect(isAppNavigation(new URL(target), current)).toBe(false);
  });
});
