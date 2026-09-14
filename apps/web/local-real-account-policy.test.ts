import { describe, expect, it } from 'vitest';
import { isApiRequest, realAccountRequestAllowed } from './local-real-account-policy.js';
const root = '/user/api/v1/local-padel';
const id = '11111111-1111-4111-8111-111111111111';
describe('real-account development ingress', () => {
  it('allows phone/session auth and read-job relay, without allowing OAuth redirects', () => {
    for (const path of [
      `${root}/auth/challenges`,
      `${root}/auth/challenges/${id}/verify`,
      `${root}/auth/session/refresh`,
      `${root}/auth/viva/access`,
      `${root}/booking-screen-read-jobs`,
      `${root}/booking-screen-read-jobs/${id}/results/${id}`,
      `${root}/booking-screen-read-jobs/${id}/complete`,
    ]) {
      expect(realAccountRequestAllowed('POST', path)).toBe(true);
    }
    expect(realAccountRequestAllowed('DELETE', `${root}/auth/session`)).toBe(true);
    expect(realAccountRequestAllowed('GET', `${root}/profile?x=%20`)).toBe(true);
    for (const suffix of ['authorize', 'reauthorize', 'callback']) {
      for (const method of ['GET', 'POST'])
        expect(realAccountRequestAllowed(method, `${root}/auth/viva/${suffix}`)).toBe(false);
    }
  });
  it('denies every business write, other tenant, malformed path and method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT']) {
      for (const suffix of [
        'games',
        `games/${id}/join`,
        'profile/privacy',
        'profile/photo',
        'booking-preferences',
        'gift-certificates/sales',
        'messages',
      ]) {
        expect(realAccountRequestAllowed(method, `${root}/${suffix}`)).toBe(false);
      }
    }
    for (const path of [
      `${root}/auth/challenges/../session/refresh`,
      `${root}/auth//session/refresh`,
      `${root}/auth/%73ession/refresh`,
      `${root}/auth%2fsession/refresh`,
      `${root}/auth%252fsession/refresh`,
      `${root}/auth\\session/refresh`,
      `${root}/auth/session/refresh/`,
      `${root}/auth/session/refresh\n`,
      `${root}/games?path=/auth/session/refresh`,
      '/user/api/v1/other/auth/session/refresh',
      '//user/api/v1/local-padel/auth/session/refresh',
      'https://example.com/user/api/v1/local-padel/auth/session/refresh',
    ])
      expect(realAccountRequestAllowed('POST', path)).toBe(false);
    expect(realAccountRequestAllowed('GET', '/internal/api/v1/local-padel/profile')).toBe(false);
    expect(realAccountRequestAllowed('GET', '/realtime/connect')).toBe(false);
  });
  it('recognizes encoded and backslash API prefixes before Vite proxy processing', () => {
    for (const path of [
      '/%75ser/api',
      '/%2575ser/api',
      '//user/api',
      '/user/api',
      '/USER/api',
      '/user%2fapi',
      '/user\\api',
      '/public/api',
      '/internal/api',
      '/realtime',
    ])
      expect(isApiRequest(path)).toBe(true);
    expect(isApiRequest('/@vite/client')).toBe(false);
    expect(isApiRequest('/@fs/Users/Example%20Project/module.ts')).toBe(false);
  });
});
