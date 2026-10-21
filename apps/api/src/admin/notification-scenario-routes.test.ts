import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://synthetic@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const definition = {
  name: 'За два часа',
  trigger: 'BOOKING_STARTS',
  delayMinutes: -120,
  ttlMinutes: 120,
  title: 'Скоро тренировка',
  body: '{{serviceTitle}}',
  channels: ['IN_APP'],
  quietHours: 'DEFER',
  dailyLimit: 1,
  goal: 'NONE',
  goalWindowMinutes: 1440,
  active: false,
};
async function headers(
  input: { audience?: string; permissions?: string[]; tenants?: string[]; platform?: string } = {},
) {
  return {
    authorization: `Bearer ${await new SignJWT({
      tenants: input.tenants ?? [tenantId],
      roles: ['admin'],
      permissions: input.permissions ?? ['notifications.manage'],
      sid: '55555555-5555-4555-8555-555555555555',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.JWT_ISSUER)
      .setAudience(input.audience ?? 'phub-admin')
      .setSubject(userId)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET))}`,
    'x-app-platform': input.platform ?? 'cup-admin',
    'idempotency-key': 'scenario-synthetic-command-0001',
  };
}
async function fixture(available = true) {
  const repository = {
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue({
      id: userId,
      version: 1,
      definition,
      updatedAt: new Date().toISOString(),
    }),
    runs: vi.fn().mockResolvedValue([]),
  };
  const app = await buildApp({
    config,
    logger: createLogger('scenario-test', 'silent'),
    pool: { query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }) } as unknown as Pool,
    ...(available ? { notificationScenarioRepository: repository } : {}),
  });
  apps.push(app);
  return { app, repository };
}
const root = '/admin/api/v1/local-padel/notifications/scenarios';
describe('notification scenario admin boundary', () => {
  it.each([
    { input: { audience: 'phub-api' }, status: 401 },
    { input: { permissions: [] }, status: 403 },
    { input: { platform: 'web' }, status: 403 },
    { input: { tenants: ['11111111-1111-4111-8111-111111111111'] }, status: 403 },
  ])('denies wrong audience/permission/platform/tenant $input', async ({ input, status }) => {
    const { app, repository } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: root,
      headers: await headers(input),
      payload: { expectedVersion: 0, definition },
    });
    expect(result.statusCode).toBe(status);
    expect(repository.save).not.toHaveBeenCalled();
  });
  it('requires idempotency for a valid save', async () => {
    const { app, repository } = await fixture();
    const withoutKey: Record<string, string> = await headers();
    delete withoutKey['idempotency-key'];
    const result = await app.inject({
      method: 'POST',
      url: root,
      headers: withoutKey,
      payload: { expectedVersion: 0, definition },
    });
    expect(result.statusCode).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
  });
  it.each([
    { mandatory: true },
    { channels: ['SMS'] },
    { trigger: 'SUBSCRIPTION_ENDS' },
    { body: '{{phone}}' },
  ])('rejects unsupported settings %j', async (patch) => {
    const { app, repository } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: root,
      headers: await headers(),
      payload: { expectedVersion: 0, definition: { ...definition, ...patch } },
    });
    expect(result.statusCode).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
  });
  it('uses verified tenant/actor and propagates version/idempotency', async () => {
    const { app, repository } = await fixture();
    const result = await app.inject({
      method: 'POST',
      url: root,
      headers: await headers(),
      payload: { expectedVersion: 0, definition },
    });
    expect(result.statusCode).toBe(200);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        idempotencyKey: 'scenario-synthetic-command-0001',
        expectedVersion: 0,
      }),
    );
  });
  it('returns a stable conflict without exposing internal errors', async () => {
    const { app, repository } = await fixture();
    repository.save.mockRejectedValue(new Error('SCENARIO_VERSION_CONFLICT'));
    const result = await app.inject({
      method: 'PUT',
      url: `${root}/${userId}`,
      headers: await headers(),
      payload: { expectedVersion: 1, definition },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json<{ code: string }>().code).toBe('SCENARIO_VERSION_CONFLICT');
  });
  it('fails closed when the optional repository/schema is unavailable', async () => {
    const { app } = await fixture(false);
    const result = await app.inject({ method: 'GET', url: root, headers: await headers() });
    expect(result.statusCode).toBe(503);
  });
});
