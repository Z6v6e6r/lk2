import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerCoachGameSummaryRoutes } from './coach-game-summary-routes.js';

describe('retired public coach-game summary routes', () => {
  it('returns a compatible empty page pointing at the authenticated browser-assisted catalog', async () => {
    const app = Fastify({ logger: false });
    registerCoachGameSummaryRoutes(app, { publicTenantHandlers: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/coach-games?dateFrom=2026-07-28&dateTo=2026-07-29',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      deprecation: 'true',
      link: '</user/api/v1/local-padel/booking-screen-read-jobs>; rel="successor-version"',
    });
    await app.close();
  });

  it('retires the legacy avatar surface without server provider traffic', async () => {
    const app = Fastify({ logger: false });
    registerCoachGameSummaryRoutes(app, { publicTenantHandlers: [] });

    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/coach-games/99999999-9999-4999-8999-999999999999/trainer-avatar',
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers.deprecation).toBe('true');
    await app.close();
  });
});
