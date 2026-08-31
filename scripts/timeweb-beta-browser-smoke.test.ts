import { describe, expect, it } from 'vitest';

import {
  buildBrowserFixturePrelude,
  emptyBrowserWriteCounters,
  incrementWriteCounter,
  TIMEWEB_BROWSER_SMOKE_ROUTES,
} from './timeweb-beta-browser-smoke.js';

describe('Timeweb beta browser smoke', () => {
  it('covers login, home, profile, games, detail, notifications and chats', () => {
    expect(TIMEWEB_BROWSER_SMOKE_ROUTES.map(({ name }) => name)).toEqual([
      'login',
      'home',
      'profile',
      'games',
      'game-detail',
      'notifications',
      'chats',
    ]);
  });

  it('ships a fail-closed browser fixture with mutation counters', () => {
    const source = buildBrowserFixturePrelude();
    for (const marker of [
      'REHEARSAL_WRITE_BLOCKED',
      'CREATE_ATTEMPTS',
      'JOIN_ATTEMPTS',
      'PAYMENT_ATTEMPTS',
      'PROVIDER_WRITES',
      'UNKNOWN_READS',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('window.fetch = async');
    expect(source).toContain('window.WebSocket = class RehearsalWebSocket');
  });

  it('counts every write class while allowing only reads and session refresh', () => {
    let counters = emptyBrowserWriteCounters();
    for (const [method, path] of [
      ['POST', '/user/api/v1/padlhub/games'],
      ['POST', '/user/api/v1/padlhub/games/game-id/join'],
      ['POST', '/public/api/v1/padlhub/gift-certificate-orders'],
      ['POST', '/user/api/v1/padlhub/auth/viva/authorize'],
      ['PUT', '/user/api/v1/padlhub/profile/privacy'],
      ['GET', '/user/api/v1/padlhub/games'],
      ['POST', '/user/api/v1/padlhub/auth/session/refresh'],
    ] as const) {
      counters = incrementWriteCounter(counters, method, path);
    }
    expect(counters).toEqual({
      CREATE_ATTEMPTS: 1,
      JOIN_ATTEMPTS: 1,
      PAYMENT_ATTEMPTS: 1,
      PROVIDER_WRITES: 1,
      OTHER_WRITE_ATTEMPTS: 1,
      UNKNOWN_READS: 0,
    });
  });
});
