import type { Pool } from 'pg';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AuthServiceError } from '../auth/auth-service.js';
import {
  createGameCreateScheduleRead,
  gameCreateScheduleOwner,
  registerGameCreateScheduleRoutes,
} from './game-create-schedule-routes.js';

const actor = {
  tenantKey: 'local-padel',
  tenantId: 'f3973ef6-ff03-4912-b9ab-a05bddbcc9aa',
  userId: 'test-user',
  sessionId: 'test-session',
  correlationId: 'test-correlation',
  signal: new AbortController().signal,
};
const station = '9f361e6e-8c9a-4655-8b32-15ded007571d';
const providerStation = '3656cbaa-6426-490f-a44f-915404cbdd2b';
const providerRoom = 'a6c94564-a2bf-4d1b-b13c-b41b0796fb30';
const token = 'synthetic.actor.bearer.token';
const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const query = { stationId: station, day, durationMinutes: '60' } as const;

function setup(aliases = [providerStation]) {
  const pool = {
    connect: () =>
      Promise.resolve({
        query: vi.fn((sql: string) =>
          Promise.resolve({
            rows: sql.includes('integration.external_entity_map')
              ? aliases.map((external_id) => ({ external_id }))
              : [],
          }),
        ),
        release: vi.fn(),
      }),
  } as unknown as Pool;
  const issueVivaAccessToken = vi.fn().mockResolvedValue({
    accessToken: token,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      slots: [
        {
          id: 'a'.repeat(64),
          roomId: providerRoom,
          courtName: 'Корт №1',
          startsAt: day + 'T18:00:00+03:00',
          endsAt: day + 'T19:00:00+03:00',
        },
      ],
    }),
  );
  const read = createGameCreateScheduleRead({
    baseUrl: 'https://padlhub.su',
    pool,
    auth: { issueVivaAccessToken },
    fetchImpl,
  });
  return { read, fetchImpl, issueVivaAccessToken };
}

describe('LK1-owned game creation schedule', () => {
  it('uses the verified actor and station mapping and drops the external room identifier', async () => {
    const { read, fetchImpl, issueVivaAccessToken } = setup();
    const result = await read(actor, query);
    expect(issueVivaAccessToken).toHaveBeenCalledWith(actor);
    const [url, request] = fetchImpl.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : null).toBe(
      'https://padlhub.su/lk/integrations/v1/game-create-schedule?' +
        new URLSearchParams({ ...query, stationId: providerStation }).toString(),
    );
    expect(request?.headers).toEqual({
      Authorization: 'Bearer ' + token,
      'X-Correlation-ID': actor.correlationId,
    });
    expect(request?.redirect).toEqual('error');
    expect(result.slots?.[0]?.courtKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(providerRoom);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('stops before any actor token or external read when station aliases disagree', async () => {
    const { read, fetchImpl, issueVivaAccessToken } = setup([providerStation, station]);
    await expect(read(actor, query)).rejects.toThrow('GAME_CREATE_SCHEDULE_STATION_UNAVAILABLE');
    expect(issueVivaAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a discounted quote that equals the regular rate', async () => {
    const { read, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        wholeCourtMinor: 400000,
        shareMinor: 100000,
        currency: 'RUB',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 25_000).toISOString(),
        residency: { status: 'APPLIED', amountMinor: 100000 },
      }),
    );
    await expect(read(actor, { ...query, slotId: 'a'.repeat(64) })).rejects.toThrow(
      'GAME_CREATE_SCHEDULE_UNAVAILABLE',
    );
  });

  it('allows the fixed local owner only for a local preview', () => {
    expect(gameCreateScheduleOwner('http://127.0.0.1:24811', true)).toBe('http://127.0.0.1:24811');
    expect(gameCreateScheduleOwner('http://127.0.0.1:24811', false)).toBeUndefined();
    expect(gameCreateScheduleOwner('https://padlhub.su.example.test/', false)).toBeUndefined();
  });

  it('keeps the OAuth reauthentication result and does not contact LK1 with a missing token', async () => {
    const { read, fetchImpl, issueVivaAccessToken } = setup();
    issueVivaAccessToken.mockRejectedValueOnce(new AuthServiceError('VIVA_REAUTH_REQUIRED'));
    await expect(read(actor, query)).rejects.toMatchObject({
      code: 'VIVA_REAUTH_REQUIRED',
      status: 401,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves the read through the authenticated application route and rejects other methods', async () => {
    const { read, fetchImpl } = setup();
    const app = Fastify();
    registerGameCreateScheduleRoutes(app, {
      read,
      handlers: [
        (request) => {
          Object.defineProperties(request, {
            tenantId: { value: actor.tenantId },
            padlHubClaims: { value: { sub: actor.userId, sid: actor.sessionId } },
          });
          return Promise.resolve();
        },
      ],
    });
    const url =
      '/user/api/v1/local-padel/games/create-schedule?' + new URLSearchParams(query).toString();
    try {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toContain('Корт №1');
      expect(response.body).not.toContain(providerRoom);
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
