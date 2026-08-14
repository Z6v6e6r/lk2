import { describe, expect, it } from 'vitest';

import { buildCommunityRealtimeUrl } from './community-realtime-url.js';

describe('community realtime URL', () => {
  it.each([
    ['https://lk.padlhub.test', 'wss://lk.padlhub.test/realtime/v1/local-padel'],
    ['http://127.0.0.1:8080/api', 'ws://127.0.0.1:8080/realtime/v1/local-padel'],
    ['wss://socket.padlhub.test', 'wss://socket.padlhub.test/realtime/v1/local-padel'],
  ])('derives a credential-free tenant route from %s', (baseUrl, expected) => {
    expect(buildCommunityRealtimeUrl(baseUrl, 'local-padel')).toBe(expected);
  });

  it.each([
    'ftp://socket.padlhub.test',
    'https://user:secret@socket.padlhub.test',
    'https://socket.padlhub.test?ticket=secret',
    'https://socket.padlhub.test#secret',
  ])('rejects an unsafe base URL: %s', (baseUrl) => {
    expect(() => buildCommunityRealtimeUrl(baseUrl, 'local-padel')).toThrow(
      'COMMUNITY_REALTIME_BASE_URL_INVALID',
    );
  });

  it('rejects a tenant key outside the public contract', () => {
    expect(() => buildCommunityRealtimeUrl('https://socket.padlhub.test', '../other')).toThrow(
      'COMMUNITY_REALTIME_TENANT_KEY_INVALID',
    );
  });
});
