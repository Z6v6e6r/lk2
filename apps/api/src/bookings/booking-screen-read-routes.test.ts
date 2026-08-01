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
    const avatarSources = new Map<string, string>();
    const registerAvatarSource = vi.fn((activityId: string, sourceUrl: string) => {
      avatarSources.set(activityId, sourceUrl);
    });
    const avatarMediaRead = vi.fn().mockResolvedValue({
      body: Buffer.from('webp-host'),
      etag: '"client-assisted-host"',
    });
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
            recommendFriends: true,
            recommendationDisplay: 'CARDS',
            version: 0,
            updatedAt: null,
          },
        }),
      } as never,
      tournamentSource: {
        readDate: vi.fn().mockResolvedValue([
          {
            id: '70000000-0000-4000-8000-000000000001',
            title: 'Турнир из ЦУП',
            format: 'Американо',
            startsAt: '2099-07-29T17:00:00.000Z',
            endsAt: '2099-07-29T19:00:00.000Z',
            venue: 'Терехово',
            trainerName: 'Илья Соколов',
            levelRange: null,
            organizer: {
              displayName: 'Илья Соколов',
              avatarUrl: null,
            },
            capacity: {
              total: 16,
              registered: 12,
              open: 4,
              waitlist: 0,
            },
            status: 'REGISTRATION',
            route: '/tournaments?event=70000000-0000-4000-8000-000000000001',
          },
        ]),
      },
      exerciseSource: {
        readDate: vi.fn().mockResolvedValue([]),
        registerAvatarSource,
        readAvatarSource: (activityId: string) => avatarSources.get(activityId),
      },
      avatarMedia: {
        read: avatarMediaRead,
      },
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
    const command = job.commands[1]!;

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
            room: { id: 'viva-room-secret-3', name: 'Корт №3' },
            maxClientsCount: 8,
            freePlaces: 3,
            accessLevels: [2.5, 3],
            trainers: [
              {
                id: 'viva-trainer-secret-7',
                displayName: 'Мария Орлова',
                photo: 'https://media.example/private-trainer-photo',
              },
            ],
          },
          {
            id: 'viva-tournament-secret-99',
            type: { id: 839, name: 'Турнир' },
            direction: { id: 2617, name: 'Турниры' },
            timeFrom: `${command.date}T17:00:00.000+03:00`,
            timeTo: `${command.date}T19:00:00.000+03:00`,
            studio: { id: 'viva-studio-secret-10', name: 'Терехово' },
            maxClientsCount: 16,
            freePlaces: 4,
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
              court: { name: 'Корт №3' },
              category: { name: 'Групповая тренировка' },
              host: {
                displayName: 'Мария Орлова',
              },
            },
          },
          {
            kind: 'TOURNAMENT',
            activity: {
              id: '70000000-0000-4000-8000-000000000001',
              title: 'Турнир из ЦУП',
            },
          },
        ],
      },
    });
    const completedBody = completed.json<{
      readonly page: {
        readonly items: readonly {
          readonly kind: string;
          readonly activity?: {
            readonly id: string;
            readonly host?: { readonly avatarUrl?: string | null };
          };
        }[];
      };
    }>();
    const trainingActivity = completedBody.page.items.find(
      (item) => item.kind === 'TRAINING',
    )?.activity;
    expect(trainingActivity?.host?.avatarUrl).toBe(
      `/public/api/v1/local-padel/booking-activities/${trainingActivity?.id}/host-avatar`,
    );
    expect(registerAvatarSource).toHaveBeenCalledWith(
      trainingActivity?.id,
      'https://media.example/private-trainer-photo',
    );
    expect(completed.body).not.toMatch(
      /viva-exercise-secret-42|viva-tournament-secret-99|viva-studio-secret-10|viva-room-secret-3|viva-trainer-secret-7|media\.example/,
    );

    const avatar = await app.inject({
      method: 'GET',
      url: `/public/api/v1/local-padel/booking-activities/${trainingActivity?.id}/host-avatar`,
    });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers['content-type']).toBe('image/webp');
    expect(avatar.body).toBe('webp-host');
    expect(avatarMediaRead).toHaveBeenCalledWith({
      cacheKey: `booking-activity:${trainingActivity?.id}`,
      sourceUrl: 'https://media.example/private-trainer-photo',
    });
  });

  it('builds GROUP_TRAININGS with the current cabinet types without personalization filters', async () => {
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
      authenticatedTenantHandlers: [authenticate],
      publicTenantHandlers: [],
    });

    const started = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/booking-screen-read-jobs',
      payload: { screen: 'GROUP_TRAININGS' },
    });
    expect(started.statusCode).toBe(200);
    const job = started.json<{
      readonly jobId: string;
      readonly screen: string;
      readonly commands: readonly { readonly commandId: string; readonly date: string }[];
    }>();
    expect(job.screen).toBe('GROUP_TRAININGS');
    expect(job.commands).toHaveLength(7);
    const command = job.commands[0]!;
    const sourceItems = [
      {
        id: 'private-group-d',
        type: { id: 605, name: 'Падел групповая тренировка' },
        direction: { id: 1, name: 'Групповая тренировка уровень D' },
        timeFrom: `${command.date}T12:00:00.000+03:00`,
        timeTo: `${command.date}T13:00:00.000+03:00`,
        studio: { id: 'private-studio', name: 'Терехово' },
        room: { id: 'private-court-1', name: 'Корт №1' },
        maxClientsCount: 6,
        freePlaces: 0,
      },
      {
        id: 'private-coach-c',
        type: { id: 605, name: 'Падел групповая тренировка' },
        direction: { id: 2, name: 'Игра+Тренер. Уровень C' },
        timeFrom: `${command.date}T14:00:00.000+03:00`,
        timeTo: `${command.date}T15:00:00.000+03:00`,
        studio: { id: 'private-studio', name: 'Терехово' },
        room: { id: 'private-court-2', name: 'Корт №2' },
        maxClientsCount: 4,
        freePlaces: 2,
      },
      {
        id: 'private-split-d-plus',
        type: { id: 605, name: 'Падел групповая тренировка' },
        direction: { id: 3, name: 'Сплит D+' },
        timeFrom: `${command.date}T16:00:00.000+03:00`,
        timeTo: `${command.date}T17:00:00.000+03:00`,
        studio: { id: 'private-studio', name: 'Терехово' },
        room: { id: 'private-court-3', name: 'Корт №3' },
        maxClientsCount: 4,
        freePlaces: 1,
      },
      {
        id: 'private-trial',
        type: { id: 605, name: 'Падел групповая тренировка' },
        direction: { id: 4, name: 'Первая пробная тренировка' },
        timeFrom: `${command.date}T18:00:00.000+03:00`,
        timeTo: `${command.date}T19:00:00.000+03:00`,
        studio: { id: 'private-studio', name: 'Терехово' },
        room: { id: 'private-court-4', name: 'Корт №4' },
        maxClientsCount: 4,
        freePlaces: 1,
      },
    ];

    const accepted = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/results/${command.commandId}`,
      payload: { payload: sourceItems },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ itemCount: 4 });

    const completed = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/complete`,
      payload: { limit: 500 },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      screen: 'GROUP_TRAININGS',
      state: 'PARTIAL',
      completedCommands: 1,
      totalCommands: 7,
      trainings: {
        items: [
          {
            title: 'Групповая тренировка уровень D',
            category: { name: 'Групповая тренировка уровень D' },
            capacity: { open: 0 },
          },
          {
            title: 'Игра+Тренер. Уровень C',
            category: { name: 'Игра+Тренер. Уровень C' },
          },
          {
            title: 'Сплит D+',
            category: { name: 'Сплит D+' },
          },
        ],
      },
    });
    expect(completed.body).not.toMatch(
      /private-group-d|private-coach-c|private-split-d-plus|private-trial|private-studio|private-court/,
    );
    expect(completed.body).not.toContain('Первая пробная тренировка');
  });

  it('reads two tournament days for the initial Home slice and the full range after expansion', async () => {
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
    const readTournamentDate = vi
      .fn<(date: string) => Promise<readonly never[]>>()
      .mockResolvedValue([]);
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
          playerLevel: 'D',
          preferences: {
            favoriteStationIds: [],
            preferredTimeWindows: [],
            useHistory: false,
            recommendFriends: true,
            recommendationDisplay: 'CARDS',
            version: 0,
            updatedAt: null,
          },
        }),
      } as never,
      tournamentSource: { readDate: readTournamentDate },
      authenticatedTenantHandlers: [authenticate],
      publicTenantHandlers: [],
    });

    const started = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/booking-screen-read-jobs',
      payload: { screen: 'FOR_ME' },
    });
    const job = started.json<{
      readonly jobId: string;
      readonly commands: readonly { readonly commandId: string; readonly date: string }[];
    }>();
    expect(job.commands).toHaveLength(7);

    for (const command of job.commands.slice(0, 3)) {
      const accepted = await app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/results/${command.commandId}`,
        payload: { payload: { content: [] } },
      });
      expect(accepted.statusCode).toBe(202);
    }
    const initialCompletion = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/complete`,
      payload: { limit: 6, phase: 'HOME_INITIAL' },
    });
    expect(initialCompletion.statusCode).toBe(200);
    expect(initialCompletion.json()).toMatchObject({
      state: 'PARTIAL',
      completedCommands: 3,
      totalCommands: 7,
    });
    expect(readTournamentDate).not.toHaveBeenCalled();

    const tournamentCompletion = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/complete`,
      payload: { limit: 6, phase: 'HOME_TOURNAMENTS' },
    });
    expect(tournamentCompletion.statusCode).toBe(200);
    expect(readTournamentDate.mock.calls.map(([date]) => date)).toEqual(
      job.commands.slice(0, 2).map((command) => command.date),
    );

    for (const command of job.commands.slice(3)) {
      const accepted = await app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/results/${command.commandId}`,
        payload: { payload: { content: [] } },
      });
      expect(accepted.statusCode).toBe(202);
    }
    const expandedCompletion = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/booking-screen-read-jobs/${job.jobId}/complete`,
      payload: { limit: 6, phase: 'FULL' },
    });
    expect(expandedCompletion.statusCode).toBe(200);
    expect(expandedCompletion.json()).toMatchObject({
      state: 'READY',
      completedCommands: 7,
      totalCommands: 7,
    });
    expect(readTournamentDate.mock.calls.slice(2).map(([date]) => date)).toEqual(
      job.commands.map((command) => command.date),
    );
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
