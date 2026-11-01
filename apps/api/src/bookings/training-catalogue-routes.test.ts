import { afterEach, it, expect, vi } from 'vitest';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import type { VivaExerciseRecommendation } from '@phub/viva-adapter';
import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';
import { MemoryEventCatalogSnapshotStore } from './event-catalog-snapshot-store.js';
import type { EventCatalogItem } from './booking-recommendation-routes.js';
const tenantId = '11111111-1111-4111-8111-111111111111',
  userId = '22222222-2222-4222-8222-222222222222';
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'fixture-issuer',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'synthetic-access-secret-at-least32characters',
  JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least32characters',
});
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
async function token(permissions = ['games.play'], actor = userId) {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(actor)
    .setExpirationTime(new Date('2099-01-01'))
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}
const today = () => new Date(Date.now() + 10_800_000).toISOString().slice(0, 10);
function activity(id: string): VivaExerciseRecommendation {
  return {
    id,
    kind: 'TRAINING',
    title: 'Групповая тренировка уровень D',
    startsAt: `${today()}T10:00:00+03:00`,
    endsAt: `${today()}T11:00:00+03:00`,
    timezone: 'Europe/Moscow',
    station: {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Synthetic station',
      shortAddress: null,
    },
    court: null,
    category: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Групповая тренировка уровень D',
    },
    capacity: { total: 6, open: 1 },
    levelRange: null,
    host: null,
    route: `/trainings?event=${id}`,
  };
}
async function setup(enabled = true) {
  const read = vi.fn((input: { dates: readonly string[] }) =>
    Promise.resolve({
      activities: [
        activity('66666666-6666-4666-8666-666666666666'),
        activity('77777777-7777-4777-8777-777777777777'),
      ],
      completedDates: input.dates,
    }),
  );
  const store = new MemoryEventCatalogSnapshotStore<EventCatalogItem>();
  const pool = {
    query: async (text: string) => {
      await Promise.resolve();
      if (text.includes('identity.tenants')) return { rows: [{ id: tenantId }] };
      throw new Error('unexpected DB');
    },
  } as unknown as Pool;
  const app = await buildApp({
    config,
    pool,
    logger: createLogger('training-catalogue-test', 'silent'),
    ...(enabled ? { trainingCatalogueSource: { read }, eventCatalogSnapshotStore: store } : {}),
  });
  apps.push(app);
  const url = `/user/api/v1/fixture/trainings/catalog?localDates=${today()}&kinds=GROUP_TRAINING&availability=INCLUDE_FULL&limit=1`;
  return { app, read, url, store };
}
it('bootstraps and continues only the same actor snapshot, without a client provider job', async () => {
  const { app, read, url } = await setup();
  const headers = { authorization: `Bearer ${await token()}` };
  const first = await app.inject({ method: 'GET', url, headers });
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('private, no-store');
  const page = first.json<{
    nextCursor: string;
    snapshotVersion: string;
    items: unknown[];
    staleAt: string;
  }>();
  expect(page.items).toHaveLength(1);
  expect(first.body).not.toMatch(/accessToken|providerTenant|commands|handoff/);
  const cursorUrl = `/user/api/v1/fixture/trainings/catalog?cursor=${page.nextCursor}&limit=1`;
  const second = await app.inject({ method: 'GET', url: cursorUrl, headers });
  expect(second.statusCode).toBe(200);
  expect(second.json()).toMatchObject({
    snapshotVersion: page.snapshotVersion,
    staleAt: page.staleAt,
  });
  expect(read).toHaveBeenCalledTimes(1);
  const foreign = await app.inject({
    method: 'GET',
    url: cursorUrl,
    headers: {
      authorization: `Bearer ${await token(['games.play'], '88888888-8888-4888-8888-888888888888')}`,
    },
  });
  expect(foreign.statusCode).toBe(400);
  const changedLimit = await app.inject({
    method: 'GET',
    url: cursorUrl.replace('limit=1', 'limit=2'),
    headers,
  });
  expect(changedLimit.statusCode).toBe(400);
});
it('refuses unauthenticated, denied and disabled reads before source access', async () => {
  const { app, read, url } = await setup();
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${await token([])}` },
      })
    ).statusCode,
  ).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const disabled = await setup(false);
  expect(
    (
      await disabled.app.inject({
        method: 'GET',
        url: disabled.url,
        headers: { authorization: `Bearer ${await token()}` },
      })
    ).statusCode,
  ).toBe(503);
});
it.each([
  'localDates=2035-02-30',
  'localDates=2000-01-01',
  'localDates=2099-01-01',
  'limit=51',
  'unknown=1',
  'localDates=x&localDates=y',
  'cursor=not-a-uuid',
])('rejects malformed, duplicate or out-of-window query %s', async (bad) => {
  const { app, read, url } = await setup();
  const key = bad.split('=')[0]!;
  const params = new URLSearchParams(url.split('?')[1]);
  params.delete(key);
  const response = await app.inject({
    method: 'GET',
    url: url.split('?')[0] + '?' + params.toString() + '&' + bad,
    headers: { authorization: `Bearer ${await token()}` },
  });
  expect(response.statusCode).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
it('keeps partial days explicit and does not leak provider error details', async () => {
  const { app, read, url } = await setup();
  read.mockResolvedValueOnce({ activities: [], completedDates: [] });
  const headers = { authorization: `Bearer ${await token()}` };
  const partial = await app.inject({ method: 'GET', url, headers });
  expect(partial.json()).toMatchObject({
    state: 'PARTIAL',
    totalMatched: null,
    facets: null,
    sourceStatus: [{ state: 'UNAVAILABLE' }],
  });
  read.mockRejectedValueOnce(new Error('private-token-provider-details'));
  const failed = await app.inject({ method: 'GET', url, headers });
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('private-token');
});
it('does not renew source freshness when continuation extends Redis-style TTL', async () => {
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  const { app, url, read } = await setup();
  const headers = { authorization: `Bearer ${await token()}` };
  const first = (await app.inject({ method: 'GET', url, headers })).json<{
    nextCursor: string;
    staleAt: string;
  }>();
  const continuation = `/user/api/v1/fixture/trainings/catalog?cursor=${first.nextCursor}&limit=1`;
  time += 590_000;
  expect((await app.inject({ method: 'GET', url: continuation, headers })).statusCode).toBe(200);
  time += 11_000;
  expect((await app.inject({ method: 'GET', url: continuation, headers })).statusCode).toBe(410);
  expect(read).toHaveBeenCalledTimes(1);
});
