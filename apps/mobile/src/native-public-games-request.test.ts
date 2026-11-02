import { expect, it } from 'vitest';
import { nativePublicGamesRequest } from './native-public-games-request.js';
const config = { apiBaseUrl: 'https://lk2.padlhub.su', tenantKey: 'local-padel' },
  root = `${config.apiBaseUrl}/public/api/v1/${config.tenantKey}/games`;
it('public catalogue is GET only, tenant pinned, bounded, no credentials or command headers', () => {
  expect(
    nativePublicGamesRequest(root + '?limit=20&availability=INCLUDE_FULL&cursor=YXNk', {}, config),
  ).toBe(true);
  for (const path of [
    '/other',
    '?',
    '?limit=51',
    '?limit=20&limit=20',
    '?source=viva',
    '?cursor=..',
  ])
    expect(() => nativePublicGamesRequest(root + path, {}, config)).toThrow();
  for (const init of [
    { method: 'POST' },
    { body: '{}' },
    { headers: { authorization: 'Bearer synthetic' } },
    { headers: { 'idempotency-key': 'synthetic' } },
    { headers: { cookie: 'synthetic' } },
  ])
    expect(() => nativePublicGamesRequest(root, init, config)).toThrow();
  expect(nativePublicGamesRequest(root.replace('local-padel', 'other'), {}, config)).toBe(false);
});
