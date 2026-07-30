import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryBookingScreenReadJobStore } from './booking-screen-read-job-store.js';
import { registerBookingRecommendationRoutes } from './booking-recommendation-routes.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000001';

describe('client-assisted booking screen read routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('binds commands to the user and removes provider identifiers before ranking', async () => {
    const app = Fastify();
    apps.push(app);
    const authenticate = (request: FastifyRequest): Promise<void> => {
      request.tenantId = tenantId;
      request.padlHubClaims = {
        sub: userId,
        tenants: [tenantId],
        roles: ['client'],
        permissions: ['games.play'],
        sid: '30000000-0000-4000-8000-000000000001',
      };
      return Promise.resolve();
    };
    registerBookingRecommendationRoutes(app, {
      clientAssistedJobStore: new MemoryBookingScreenReadJobStore(),
      gameRepository: {
        listRecommendationCardProjections: vi.fn().mockResolvedValue({
          candidates: [],
          history: [],
        }),
      },
      preferencesRepository: {
        getRecommendationProfile: vi.fn().mockResolvedValue({
          playerLevel: 'C',
          preferences: {
            favoriteStationIds: [],
            preferredTimeWindows: [],
            useHistory: false,
            version: 0,
            updatedAt: null,
          },
        }),
      } as never,
      authenticatedTenantHandlers: [authenticate],
      publicTenantHandlers: [],
    });

    const started = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/booking-screen-read-jobs',
      payload: { screen: 'FOR_ME' },
    });
    expect(started.statusCode).toBe(200);
    const job = started.json<{
      readonly jobId: string;
      readonly commands: readonly {
        readonly commandId: string;
        readonly date: string;
      }[];
    }>();
    expect(job.commands).toHaveLength(7);
    const command = job.commands[0]!;

    const accepted = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/results/${command.commandId}`,
      payload: {
        payload: [
          {
            id: 'viva-exercise-secret-42',
            type: { id: 605, name: 'Групповая тренировка' },
            direction: { id: 100, name: 'Тренировки' },
            timeFrom: `${command.date}T15:00:00.000+03:00`,
            timeTo: `${command.date}T16:30:00.000+03:00`,
            studio: { id: 'viva-studio-secret-10', name: 'Терехово' },
            maxClientsCount: 8,
            freePlaces: 3,
            accessLevels: [2.5, 3],
          },
        ],
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: true, replayed: false, itemCount: 1 });

    const completed = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/complete`,
      payload: { limit: 6 },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      state: 'PARTIAL',
      completedCommands: 1,
      totalCommands: 7,
      page: {
        items: [
          {
            kind: 'TRAINING',
            activity: {
              title: 'Групповая тренировка',
              station: { name: 'Терехово' },
            },
          },
        ],
      },
    });
    expect(completed.body).not.toMatch(/viva-exercise-secret-42|viva-studio-secret-10/);
  });

  it('builds MY_BOOKINGS from a fixed list/details pair with canonical mappings', async () => {
    const app = Fastify();
    apps.push(app);
    const authenticate = (request: FastifyRequest): Promise<void> => {
      request.tenantId = tenantId;
      request.padlHubClaims = {
        sub: userId,
        tenants: [tenantId],
        roles: ['client'],
        permissions: ['games.play'],
        sid: '30000000-0000-4000-8000-000000000001',
      };
      return Promise.resolve();
    };
    const canonicalBookingId = '40000000-0000-4000-8000-000000000001';
    const canonicalGameId = '50000000-0000-4000-8000-000000000001';
    const resolveMappings = vi
      .fn<
        (input: {
          readonly tenantId: string;
          readonly bookingExternalIds: readonly string[];
          readonly exerciseAssociationIds: readonly string[];
        }) => Promise<{
          readonly bookings: readonly { readonly externalId: string; readonly bookingId: string }[];
          readonly games: readonly { readonly associationId: string; readonly gameId: string }[];
        }>
      >()
      .mockResolvedValue({
        bookings: [
          {
            externalId: 'private-viva-booking-id',
            bookingId: canonicalBookingId,
          },
        ],
        games: [
          {
            associationId: 'private-viva-exercise-id',
            gameId: canonicalGameId,
          },
        ],
      });
    const mappingRepository = { resolve: resolveMappings };
    registerBookingRecommendationRoutes(app, {
      clientAssistedJobStore: new MemoryBookingScreenReadJobStore(),
      bookingScreenMappingRepository: mappingRepository,
      authenticatedTenantHandlers: [authenticate],
      publicTenantHandlers: [],
    });

    const started = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/booking-screen-read-jobs',
      payload: { screen: 'MY_BOOKINGS' },
    });
    expect(started.statusCode).toBe(200);
    const job = started.json<{
      readonly jobId: string;
      readonly screen: string;
      readonly commands: readonly {
        readonly commandId: string;
        readonly operation: string;
        readonly detailsOperation: string;
        readonly page: number;
        readonly size: number;
      }[];
    }>();
    expect(job).toMatchObject({
      screen: 'MY_BOOKINGS',
      commands: [
        {
          operation: 'bookings.read',
          detailsOperation: 'bookings.details.read',
          page: 0,
          size: 50,
        },
      ],
    });
    const command = job.commands[0]!;
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();

    const accepted = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/results/${command.commandId}`,
      payload: {
        payload: {
          bookings: {
            content: [{ id: 'private-viva-booking-id', isCancelled: false }],
          },
          details: [
            {
              id: 'private-viva-booking-id',
              isCancelled: false,
              transactionStatus: null,
              exercise: {
                id: 'private-viva-exercise-id',
                timeFrom: startsAt,
                timeTo: new Date(Date.parse(startsAt) + 2 * 60 * 60 * 1_000).toISOString(),
                inWaitlist: false,
                direction: { id: 4588, name: 'Игры' },
                type: { id: 1613, name: 'Игра на рейтинг' },
                studio: { name: 'Терехово', address: 'Москва' },
                room: { name: 'Корт 1' },
              },
            },
          ],
        },
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: true, itemCount: 1 });

    const completed = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/complete`,
      payload: { limit: 50 },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      screen: 'MY_BOOKINGS',
      state: 'READY',
      completedCommands: 1,
      totalCommands: 1,
      bookings: {
        items: [
          {
            id: canonicalBookingId,
            kind: 'game',
            title: 'Игра на рейтинг',
            route: `/games/${canonicalGameId}`,
          },
        ],
      },
    });
    expect(completed.body).not.toMatch(/private-viva-booking-id|private-viva-exercise-id|VIVA/i);
    const mappingInput = resolveMappings.mock.calls[0]?.[0];
    expect(mappingInput?.tenantId).toBe(tenantId);
    expect(mappingInput?.bookingExternalIds).toEqual(['private-viva-booking-id']);
    expect(mappingInput?.exerciseAssociationIds).toContain('private-viva-exercise-id');
  });
});
