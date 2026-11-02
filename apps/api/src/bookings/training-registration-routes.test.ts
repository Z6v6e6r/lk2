import { afterEach, it, expect, vi } from 'vitest';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';
const tenantId = '11111111-1111-4111-8111-111111111111',
  userId = '22222222-2222-4222-8222-222222222222',
  trainingId = '33333333-3333-4333-8333-333333333333',
  subscriptionId = '44444444-4444-4444-8444-444444444444';
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
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function token(permissions = ['games.play']) {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}
async function setup() {
  const result = {
      trainingId,
      subscriptionId,
      dateHint: '2035-04-02',
      operation: { id: '66666666-6666-4666-8666-666666666666', status: 'CONFIRMED' as const },
      registration: { status: 'UNKNOWN' as const, asOf: null },
      retryAfterSeconds: 15,
    },
    runtime = {
      execute: vi.fn(() => Promise.resolve(result)),
      read: vi.fn(() => Promise.resolve(result)),
    };
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
    logger: createLogger('training-test', 'silent'),
    trainingRegistration: runtime,
  });
  apps.push(app);
  return { app, runtime, result };
}
it('authenticated public endpoint derives actor/session and keeps current observation independent', async () => {
  const { app, runtime, result } = await setup();
  const response = await app.inject({
    method: 'POST',
    url: `/user/api/v1/fixture/trainings/${trainingId}/registrations`,
    headers: {
      authorization: `Bearer ${await token()}`,
      'idempotency-key': 'synthetic-training-key',
    },
    payload: { dateHint: '2035-04-02', subscriptionId },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(result);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(runtime.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId,
      userId,
      sessionId: '55555555-5555-4555-8555-555555555555',
    }),
    {
      trainingId,
      dateHint: '2035-04-02',
      subscriptionId,
      idempotencyKey: 'synthetic-training-key',
    },
  );
});
it('missing auth/permission/key, private fields and malformed query stop before runtime', async () => {
  const { app, runtime } = await setup();
  const base = {
    method: 'POST' as const,
    url: `/user/api/v1/fixture/trainings/${trainingId}/registrations`,
    headers: {
      authorization: `Bearer ${await token()}`,
      'idempotency-key': 'synthetic-training-key',
    },
    payload: { dateHint: '2035-04-02', subscriptionId },
  };
  for (const request of [
    { ...base, headers: {} },
    { ...base, headers: { ...base.headers, authorization: `Bearer ${await token([])}` } },
    { ...base, headers: { authorization: base.headers.authorization } },
    { ...base, payload: { ...base.payload, providerExerciseId: 'synthetic-external' } },
    { ...base, url: base.url + '?recoveryOnly=true' },
    { ...base, payload: { ...base.payload, dateHint: '2035-02-30' } },
  ])
    expect((await app.inject(request)).statusCode).toBeGreaterThanOrEqual(400);
  expect(runtime.execute).not.toHaveBeenCalled();
});
it('GET is a separate nonmutating read with same stable key and no body', async () => {
  const { app, runtime } = await setup();
  const response = await app.inject({
    url: `/user/api/v1/fixture/trainings/${trainingId}/registration-operation`,
    headers: {
      authorization: `Bearer ${await token()}`,
      'idempotency-key': 'synthetic-training-key',
    },
  });
  expect(response.statusCode).toBe(200);
  expect(runtime.read).toHaveBeenCalledTimes(1);
  expect(runtime.execute).not.toHaveBeenCalled();
});
