import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerTournamentSummaryRoutes } from './tournament-summary-routes.js';

describe('public tournament summary routes', () => {
  it('returns only bounded summary DTOs for a date range', async () => {
    const app = Fastify({ logger: false });
    const sourceUrl = 'https://media.example/private-organizer-photo';
    const readDate = vi.fn().mockResolvedValue([
      {
        id: '99999999-9999-4999-8999-999999999999',
        title: 'Воскресный Мексикано',
        format: 'Мексикано',
        startsAt: '2026-07-26T16:00:00.000Z',
        endsAt: '2026-07-26T18:00:00.000Z',
        venue: 'Селигерская',
        trainerName: 'Кирилл Твердохлеб',
        levelRange: { from: 'D+', to: 'C' },
        organizer: { displayName: 'Кирилл Твердохлеб', avatarUrl: null },
        capacity: { total: 16, registered: 12, open: 4, waitlist: 0 },
        status: 'REGISTRATION',
        route: '/tournaments?event=99999999-9999-4999-8999-999999999999',
      },
    ]);
    const readAvatarSource = vi.fn().mockReturnValue(sourceUrl);
    const avatarMedia = {
      read: vi.fn().mockResolvedValue({
        body: Buffer.from('webp-organizer'),
        etag: '"organizer-etag"',
      }),
    };
    registerTournamentSummaryRoutes(app, {
      source: { readDate, readAvatarSource },
      avatarMedia,
      publicTenantHandlers: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/tournaments?dateFrom=2026-07-26&dateTo=2026-07-27',
    });

    expect(response.statusCode).toBe(200);
    expect(readDate).toHaveBeenCalledOnce();
    const payload = response.json<{
      items: readonly {
        title: string;
        organizer: { avatarUrl: string } | null;
      }[];
    }>();
    expect(payload.items[0]?.title).toBe('Воскресный Мексикано');
    expect(payload.items[0]?.organizer?.avatarUrl).toBe(
      '/public/api/v1/local-padel/tournaments/99999999-9999-4999-8999-999999999999/organizer-avatar',
    );
    expect(response.body).not.toMatch(/phone|participants|trainerAvatarUrl|media\.example/);

    const avatarResponse = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/tournaments/99999999-9999-4999-8999-999999999999/organizer-avatar',
    });
    expect(avatarResponse.statusCode).toBe(200);
    expect(avatarResponse.headers['content-type']).toBe('image/webp');
    expect(avatarResponse.headers.etag).toBe('"organizer-etag"');
    expect(avatarResponse.body).toBe('webp-organizer');
    expect(avatarMedia.read).toHaveBeenCalledWith({
      cacheKey: 'tournament:99999999-9999-4999-8999-999999999999',
      sourceUrl,
    });
    await app.close();
  });

  it('rejects unbounded schedule ranges before contacting the source', async () => {
    const app = Fastify({ logger: false });
    const readDate = vi.fn();
    registerTournamentSummaryRoutes(app, {
      source: { readDate },
      publicTenantHandlers: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/tournaments?dateFrom=2026-07-01&dateTo=2026-08-01',
    });

    expect(response.statusCode).toBe(400);
    expect(readDate).not.toHaveBeenCalled();
    await app.close();
  });
});
