import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBookingScreenReadJobStore } from './booking-screen-read-job-store.js';
import { registerBookingRecommendationRoutes } from './booking-recommendation-routes.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000001';
const path = '/user/api/v1/local-padel/booking-screen-read-jobs';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(failTournament = false) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
  const app = Fastify();
  apps.push(app);
  const store = new MemoryBookingScreenReadJobStore();
  const readDate = failTournament
    ? vi.fn().mockRejectedValue(new Error('offline'))
    : vi.fn().mockResolvedValue([
        {
          id: '70000000-0000-4000-8000-000000000001',
          title: 'Test tournament',
          format: 'Американо',
          startsAt: '2026-07-19T09:00:00Z',
          endsAt: '2026-07-19T11:00:00Z',
          venue: 'Test station',
          trainerName: null,
          levelRange: null,
          organizer: null,
          capacity: { total: 16, registered: 2, open: 14, waitlist: 0 },
          status: 'REGISTRATION',
          route: '/tournaments?event=70000000-0000-4000-8000-000000000001',
        },
      ]);
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
    clientAssistedJobStore: store,
    gameRepository: {
      listRecommendationCardProjections: vi.fn().mockResolvedValue({ candidates: [], history: [] }),
    },
    preferencesRepository: {
      getRecommendationProfile: vi.fn().mockResolvedValue({
        playerLevel: null,
        preferences: {
          favoriteStationIds: [],
          preferredTimeWindows: [],
          useHistory: false,
          version: 0,
          updatedAt: null,
        },
      }),
    } as never,
    tournamentSource: { readDate },
    publicTenantHandlers: [authenticate],
    authenticatedTenantHandlers: [authenticate],
  });
  return { app, store, readDate };
}
describe('date-specific recommendation read jobs', () => {
  it('persists the last visible calendar day and issues exactly one schedule read; legacy reads keep seven days', async () => {
    const { app, store } = setup();
    const response = await app.inject({
      method: 'POST',
      url: path,
      payload: { screen: 'FOR_ME', localDate: '2026-07-31' },
    });
    expect(response.statusCode).toBe(200);
    const job = response.json<{
      jobId: string;
      commands: [{ commandId: string; operation: string; date: string }];
    }>();
    expect(job.commands).toHaveLength(1);
    expect(job.commands[0]).toMatchObject({ operation: 'schedule.read', date: '2026-07-31' });
    expect(typeof job.commands[0].commandId).toBe('string');
    expect(await store.get(job.jobId)).toMatchObject({ tenantId, userId, localDate: '2026-07-31' });
    const legacy = await app.inject({ method: 'POST', url: path, payload: { screen: 'FOR_ME' } });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json<{ commands: unknown[] }>().commands).toHaveLength(7);
  });
  it.each([
    { screen: 'FOR_ME', localDate: '2026-02-30' },
    { screen: 'FOR_ME', localDate: '2026-07-16' },
    { screen: 'FOR_ME', localDate: '2026-08-01' },
    { screen: 'FOR_ME', localDate: null },
    { screen: 'FOR_ME', localDate: ['2026-07-19'] },
    { screen: 'GROUP_TRAININGS', localDate: '2026-07-19' },
    { screen: 'MY_BOOKINGS', localDate: '2026-07-19' },
    { screen: 'FOR_ME', localDate: '2026-07-19', providerUrl: 'https://invalid.test' },
  ])('rejects invalid or out-of-scope inputs: %j', async (payload) => {
    const { app, readDate } = setup();
    const response = await app.inject({ method: 'POST', url: path, payload });
    expect(response.statusCode).toBe(400);
    expect(readDate).not.toHaveBeenCalled();
  });
  it.each([
    [false, false],
    [true, true],
    [false, true],
  ])(
    'keeps available tournaments and reports completeness (tournament failure %s, schedule complete %s)',
    async (failTournament, scheduleComplete) => {
      const { app, store, readDate } = setup(failTournament);
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { screen: 'FOR_ME', localDate: '2026-07-19' },
      });
      const job = response.json<{
        jobId: string;
        commands: [{ commandId: string; operation: string; date: string }];
      }>();
      if (scheduleComplete)
        await store.putResult(
          job.jobId,
          {
            kind: 'schedule',
            commandId: job.commands[0].commandId,
            activities: [],
            acceptedAt: new Date().toISOString(),
          },
          120,
        );
      const completed = await app.inject({
        method: 'POST',
        url: `${path}/${job.jobId}/complete`,
        payload: { limit: 14, phase: 'FULL' },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({
        state: !failTournament && scheduleComplete ? 'READY' : 'PARTIAL',
        page: { nextCursor: null },
      });
      expect(readDate).toHaveBeenCalledExactlyOnceWith('2026-07-19');
      const items = completed.json<{ page: { items: { kind: string }[] } }>().page.items;
      expect(items.map((item) => item.kind)).toEqual(failTournament ? [] : ['TOURNAMENT']);
    },
  );
});
