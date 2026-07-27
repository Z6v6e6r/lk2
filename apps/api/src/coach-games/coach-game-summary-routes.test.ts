import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerCoachGameSummaryRoutes } from './coach-game-summary-routes.js';

describe('public coach-game summary routes', () => {
  it('returns bounded summaries without provider identifiers', async () => {
    const app = Fastify({ logger: false });
    const sourceUrl = 'https://media.example/private-trainer-photo';
    const readDate = vi.fn().mockResolvedValue([
      {
        id: '99999999-9999-4999-8999-999999999999',
        title: 'Игра с тренером · C',
        startsAt: '2026-07-28T05:00:00.000Z',
        endsAt: '2026-07-28T06:00:00.000Z',
        stationName: 'Селигерская',
        courtName: 'Корт №2',
        level: 'C',
        trainer: { displayName: 'Кирилл Боев', avatarUrl: null },
        capacity: { total: 3, occupied: 1, open: 2 },
        status: 'JOINABLE',
      },
    ]);
    const readAvatarSource = vi.fn().mockReturnValue(sourceUrl);
    const avatarMedia = {
      read: vi.fn().mockResolvedValue({
        body: Buffer.from('webp-trainer'),
        etag: '"trainer-etag"',
      }),
    };
    registerCoachGameSummaryRoutes(app, {
      source: { readDate, readAvatarSource },
      avatarMedia,
      publicTenantHandlers: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/coach-games?dateFrom=2026-07-28&dateTo=2026-07-29',
    });

    expect(response.statusCode).toBe(200);
    expect(readDate).toHaveBeenCalledOnce();
    const payload = response.json<{
      items: readonly {
        title: string;
        trainer: { avatarUrl: string } | null;
      }[];
    }>();
    expect(payload.items[0]?.title).toBe('Игра с тренером · C');
    expect(payload.items[0]?.trainer?.avatarUrl).toBe(
      '/public/api/v1/local-padel/coach-games/99999999-9999-4999-8999-999999999999/trainer-avatar',
    );
    expect(response.body).not.toMatch(/provider|external|media\.example/);

    const avatarResponse = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/coach-games/99999999-9999-4999-8999-999999999999/trainer-avatar',
    });
    expect(avatarResponse.statusCode).toBe(200);
    expect(avatarResponse.headers['content-type']).toBe('image/webp');
    expect(avatarResponse.headers.etag).toBe('"trainer-etag"');
    expect(avatarResponse.body).toBe('webp-trainer');
    expect(avatarMedia.read).toHaveBeenCalledWith({
      cacheKey: 'coach-game:99999999-9999-4999-8999-999999999999',
      sourceUrl,
    });
    await app.close();
  });

  it('rejects date ranges larger than fifteen days before reading Viva', async () => {
    const app = Fastify({ logger: false });
    const readDate = vi.fn();
    registerCoachGameSummaryRoutes(app, {
      source: { readDate },
      publicTenantHandlers: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/coach-games?dateFrom=2026-07-01&dateTo=2026-08-01',
    });

    expect(response.statusCode).toBe(400);
    expect(readDate).not.toHaveBeenCalled();
    await app.close();
  });
});
