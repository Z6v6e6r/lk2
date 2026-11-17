import { loadConfig } from '@phub/config';
import type { ProfileProviderObservationRepository } from '@phub/database/profile-provider-observation';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';
import { buildMockHomeDashboard } from '../home/home-dashboard.js';
import { MemoryProfileProviderReadJobStore } from './profile-read-job-store.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const projectionConfig = {
  ...config,
  HOME_READ_MODE: 'projection' as const,
  VIVA_MODE: 'sandbox' as const,
  PROFILE_NATIVE_READ_ENABLED: true,
};
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('select 1 as ready')) return Promise.resolve({ rows: [{ ready: 1 }] });
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error('Unexpected query: ' + text));
    },
  } as unknown as Pool;
}

async function accessToken(): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: ['profile.read'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type StoredObservation = Awaited<ReturnType<ProfileProviderObservationRepository['get']>>;

function observationRepository(observation: StoredObservation) {
  return {
    get: vi.fn().mockResolvedValue(observation),
    put: vi.fn().mockResolvedValue('accepted' as const),
  } satisfies ProfileProviderObservationRepository;
}

function summaryRepository() {
  return {
    get: vi.fn().mockResolvedValue({
      userId,
      displayName: 'Сергеев Алексей',
      avatarUrl: null,
      levelLabel: null,
      levelValue: null,
    }),
  };
}

describe('GET profile fallback with a provider observation', () => {
  it('adds a fresh provider level and balance to the local slice', async () => {
    const observations = observationRepository({
      level: { label: 'C+', value: 3.8 },
      balanceMinor: 54_000,
      currency: 'RUB',
      observedAt: new Date().toISOString(),
    });
    const app = await buildApp({
      config: projectionConfig,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: { get: () => Promise.resolve(undefined) },
      profileSummaryRepository: summaryRepository(),
      profileProviderObservationRepository: observations,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: 'Bearer ' + (await accessToken()) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('private');
    expect(response.json()).toMatchObject({
      userId,
      displayName: 'Сергеев Алексей',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
      balanceMinor: 54_000,
      currency: 'RUB',
    });
    expect(observations.get).toHaveBeenCalledWith(tenantId, userId);
  });

  it('keeps the placeholder when the rollout flag is off even for a fresh observation', async () => {
    const observations = observationRepository({
      level: { label: 'C+', value: 3.8 },
      balanceMinor: 54_000,
      currency: 'RUB',
      observedAt: new Date().toISOString(),
    });
    const app = await buildApp({
      config: { ...projectionConfig, PROFILE_NATIVE_READ_ENABLED: false },
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: { get: () => Promise.resolve(undefined) },
      profileSummaryRepository: summaryRepository(),
      profileProviderObservationRepository: observations,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: 'Bearer ' + (await accessToken()) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('balanceMinor');
    expect(response.json()).not.toHaveProperty('level');
    expect(observations.get).not.toHaveBeenCalled();
  });

  it('drops an observation outside the freshness window', async () => {
    const observations = observationRepository({
      level: { label: 'C+', value: 3.8 },
      balanceMinor: 54_000,
      currency: 'RUB',
      observedAt: new Date(Date.now() - 901_000).toISOString(),
    });
    const app = await buildApp({
      config: projectionConfig,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: { get: () => Promise.resolve(undefined) },
      profileSummaryRepository: summaryRepository(),
      profileProviderObservationRepository: observations,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: 'Bearer ' + (await accessToken()) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('balanceMinor');
    expect(response.json()).not.toHaveProperty('level');
    expect(JSON.stringify(response.json())).not.toContain('54000');
  });

  it('keeps the local slice when the observation read fails', async () => {
    const observations = {
      get: vi.fn().mockRejectedValue(new Error('database unavailable')),
      put: vi.fn().mockResolvedValue('accepted' as const),
    } satisfies ProfileProviderObservationRepository;
    const app = await buildApp({
      config: projectionConfig,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: { get: () => Promise.resolve(undefined) },
      profileSummaryRepository: summaryRepository(),
      profileProviderObservationRepository: observations,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: 'Bearer ' + (await accessToken()) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId, displayName: 'Сергеев Алексей' });
    expect(response.json()).not.toHaveProperty('balanceMinor');
  });

  it('keeps the complete projection authoritative over the observation', async () => {
    const generatedAt = new Date();
    const dashboard = buildMockHomeDashboard({
      tenantId,
      userId,
      displayName: 'Алексей',
      phoneLast4: '3190',
      roles: ['client'],
      permissions: ['profile.read'],
      now: generatedAt,
    });
    const payload = {
      ...dashboard,
      snapshot: { ...dashboard.snapshot, source: 'LOCAL_PROJECTION' as const },
    };
    const observations = observationRepository({
      level: { label: 'A', value: 6 },
      balanceMinor: 1,
      currency: 'RUB',
      observedAt: new Date().toISOString(),
    });
    const app = await buildApp({
      config: projectionConfig,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: {
        get: () =>
          Promise.resolve({
            tenantId,
            userId,
            sourceRevision: '1',
            sourceEventId: '55555555-5555-4555-8555-555555555555',
            producer: 'HOME_IMPORT',
            snapshotVersion: payload.snapshot.version,
            payload,
            payloadChecksum: 'a'.repeat(64),
            generatedAt: payload.snapshot.generatedAt,
            staleAt: payload.snapshot.staleAt,
            updatedAt: payload.snapshot.generatedAt,
          }),
      },
      profileSummaryRepository: summaryRepository(),
      profileProviderObservationRepository: observations,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: 'Bearer ' + (await accessToken()) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(payload.profile);
    expect(observations.get).not.toHaveBeenCalled();
  });

  it('serves the fallback without provider fields when no observation store is mounted', async () => {
    const app = await buildApp({
      config: projectionConfig,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: { get: () => Promise.resolve(undefined) },
      profileSummaryRepository: summaryRepository(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: 'Bearer ' + (await accessToken()) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId, displayName: 'Сергеев Алексей' });
    expect(response.json()).not.toHaveProperty('balanceMinor');
  });
});

describe('profile provider read routes wiring', () => {
  it('mounts the Android provider-read job creation through the real app', async () => {
    const jobStore = new MemoryProfileProviderReadJobStore();
    const app = await buildApp({
      config: {
        ...projectionConfig,
        PROFILE_NATIVE_READ_ENABLED: true,
        VIVA_DIRECT_READ_ENABLED: true,
      },
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      clientRoutingPlanRepository: {
        get: () =>
          Promise.resolve({
            mode: 'MIXED_END_USER_READS' as const,
            revision: '2',
            validForSeconds: 30,
            directOperations: ['profile.read' as const],
            providerTenantKey: 'provider-tenant',
            delegationReady: true,
          }),
      },
      profileProviderReadJobStore: jobStore,
      profileProviderObservationRepository: observationRepository(undefined),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { authorization: 'Bearer ' + (await accessToken()), 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json<{ jobId: string; commandId: string; expiresAt: string }>();
    expect(Object.keys(body).sort()).toEqual(['commandId', 'expiresAt', 'jobId']);
    await expect(jobStore.get(body.jobId)).resolves.toMatchObject({
      tenantId,
      userId,
      commandId: body.commandId,
    });
  });

  it('answers 403 through the real app while the rollout flag is off', async () => {
    const app = await buildApp({
      config: { ...projectionConfig, PROFILE_NATIVE_READ_ENABLED: false },
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      clientRoutingPlanRepository: {
        get: () =>
          Promise.resolve({
            mode: 'MIXED_END_USER_READS' as const,
            revision: '2',
            validForSeconds: 30,
            directOperations: ['profile.read' as const],
            providerTenantKey: 'provider-tenant',
            delegationReady: true,
          }),
      },
      profileProviderReadJobStore: new MemoryProfileProviderReadJobStore(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { authorization: 'Bearer ' + (await accessToken()), 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PROFILE_NATIVE_READ_DISABLED' });
  });

  it('never serves the observation through the other-viewer profile read', async () => {
    const observations = observationRepository({
      level: { label: 'A', value: 6 },
      balanceMinor: 54_000,
      currency: 'RUB',
      observedAt: new Date().toISOString(),
    });
    const app = await buildApp({
      config: { ...projectionConfig, VIVA_MODE: 'production' },
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: { get: () => Promise.resolve(undefined) },
      profileSummaryRepository: summaryRepository(),
      profileProviderObservationRepository: observations,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profiles/11111111-1111-4111-8111-111111111111',
      headers: { authorization: 'Bearer ' + (await accessToken()) },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain('54000');
    expect(response.json()).not.toMatchObject({ level: { label: 'A' } });
    expect(observations.get).not.toHaveBeenCalled();
  });
});
