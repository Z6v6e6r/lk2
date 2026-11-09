import { loadConfig, type AppConfig } from '@phub/config';
import type {
  ProfileProviderObservation,
  ProfileProviderObservationRepository,
  StoredClientRoutingPlan,
} from '@phub/database';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerProfileProviderReadRoutes } from './profile-provider-read-routes.js';
import {
  MemoryProfileProviderReadJobStore,
  PROFILE_PROVIDER_READ_JOB_TTL_SECONDS,
  type ProfileProviderReadJob,
} from './profile-read-job-store.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const otherTenantId = '96afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const otherUserId = '59d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const jobId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const commandId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const levelFieldId = 'eabfe27b-3f72-4496-9185-1a2ec6e6465e';

const baseConfig = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const enabledConfig: AppConfig = {
  ...baseConfig,
  PROFILE_NATIVE_READ_ENABLED: true,
  VIVA_DIRECT_READ_ENABLED: true,
};
const directPlan: StoredClientRoutingPlan = {
  mode: 'MIXED_END_USER_READS',
  revision: '2',
  validForSeconds: 30,
  directOperations: ['profile.read'],
  providerTenantKey: 'provider-tenant',
  delegationReady: true,
};
const planWithoutProviderKey: StoredClientRoutingPlan = {
  mode: 'MIXED_END_USER_READS',
  revision: '2',
  validForSeconds: 30,
  directOperations: ['profile.read'],
  delegationReady: true,
};

function providerPayload(deposit: unknown = 54_000) {
  return {
    id: '1f6d8c19-0d6b-4a57-9f0e-2a1b3c4d5e6f',
    firstName: 'Алексей',
    middleName: null,
    lastName: 'Сергеев',
    phone: '+79990001122',
    photo: 'https://cdn.viva.test/avatar.webp',
    deposit,
    customFields: [{ id: levelFieldId, value: ['3.8'] }],
  };
}

function job(overrides: Partial<ProfileProviderReadJob> = {}): ProfileProviderReadJob {
  const createdAt = Date.now();
  return {
    jobId,
    tenantId,
    userId,
    commandId,
    operation: 'profile.read',
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + PROFILE_PROVIDER_READ_JOB_TTL_SECONDS * 1_000).toISOString(),
    ...overrides,
  };
}

function observationRepository() {
  const rows = new Map<string, ProfileProviderObservation>();
  const put = vi.fn<ProfileProviderObservationRepository['put']>(
    ({ tenantId: tenant, userId: user, observation }) => {
      const key = tenant + ':' + user;
      const existing = rows.get(key);
      if (existing && Date.parse(existing.observedAt) >= Date.parse(observation.observedAt)) {
        return Promise.resolve('ignored');
      }
      rows.set(key, observation);
      return Promise.resolve('accepted');
    },
  );
  const get = vi.fn<ProfileProviderObservationRepository['get']>((tenant, user) =>
    Promise.resolve(rows.get(tenant + ':' + user)),
  );
  return { repository: { put, get }, put, get, rows };
}

interface HarnessOptions {
  readonly config?: AppConfig;
  readonly plan?: StoredClientRoutingPlan | undefined;
  readonly includeJobStore?: boolean;
  readonly includeObservationRepository?: boolean;
  readonly includeRoutingPlan?: boolean;
  readonly jobPrincipal?: { tenantId: string; userId: string };
}

const apps: FastifyInstance[] = [];

function startHarness(options: HarnessOptions = {}) {
  const app = Fastify();
  apps.push(app);
  const jobStore = new MemoryProfileProviderReadJobStore();
  const observations = observationRepository();
  const plan = 'plan' in options ? options.plan : directPlan;
  const principal = options.jobPrincipal ?? { tenantId, userId };
  const authenticate = (request: FastifyRequest): Promise<void> => {
    request.tenantId = principal.tenantId;
    request.padlHubClaims = {
      sub: principal.userId,
      tenants: [principal.tenantId],
      roles: ['client'],
      permissions: ['profile.read'],
      sid: '55555555-5555-4555-8555-555555555555',
    };
    return Promise.resolve();
  };
  registerProfileProviderReadRoutes(app, {
    config: options.config ?? enabledConfig,
    ...(options.includeJobStore === false ? {} : { jobStore }),
    ...(options.includeObservationRepository === false
      ? {}
      : { observationRepository: observations.repository }),
    ...(options.includeRoutingPlan === false
      ? {}
      : {
          clientRoutingPlanRepository: {
            get: () => Promise.resolve(plan as StoredClientRoutingPlan),
          },
        }),
    authenticatedTenantHandlers: [authenticate],
  });
  return { app, jobStore, observations };
}

async function seedJob(
  jobStore: MemoryProfileProviderReadJobStore,
  overrides: Partial<ProfileProviderReadJob> = {},
) {
  const seeded = job(overrides);
  await jobStore.create(seeded, PROFILE_PROVIDER_READ_JOB_TTL_SECONDS);
  return seeded;
}

function bearer() {
  return { authorization: 'Bearer synthetic-token' };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST profile/provider-read-jobs', () => {
  it('issues one short-lived android job when the flag and the stored plan allow it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T06:00:00.000Z'));
    try {
      const { app, jobStore } = startHarness();
      const response = await app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/profile/provider-read-jobs',
        headers: { ...bearer(), 'x-app-platform': 'android' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const body = response.json<{ jobId: string; commandId: string; expiresAt: string }>();
      expect(Object.keys(body).sort()).toEqual(['commandId', 'expiresAt', 'jobId']);
      expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.commandId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(body.expiresAt) - Date.now()).toBe(
        PROFILE_PROVIDER_READ_JOB_TTL_SECONDS * 1_000,
      );
      const stored = await jobStore.get(body.jobId);
      expect(stored).toMatchObject({
        tenantId,
        userId,
        commandId: body.commandId,
        operation: 'profile.read',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 403 PROFILE_NATIVE_READ_DISABLED while the rollout flag is off', async () => {
    const { app } = startHarness({
      config: { ...enabledConfig, PROFILE_NATIVE_READ_ENABLED: false },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { ...bearer(), 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({ code: 'PROFILE_NATIVE_READ_DISABLED' });
  });

  it.each([undefined, 'ios', 'web', 'cup-admin', 'internal'])(
    'answers 403 PROFILE_NATIVE_READ_DISABLED off the android platform (header=%s)',
    async (platform) => {
      const { app } = startHarness();
      const response = await app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/profile/provider-read-jobs',
        headers: {
          ...bearer(),
          ...(platform === undefined ? {} : { 'x-app-platform': platform }),
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'PROFILE_NATIVE_READ_DISABLED' });
    },
  );

  it.each([
    ['no stored plan', undefined],
    ['padlhub-only plan', { ...directPlan, mode: 'PADLHUB_ONLY' as const, directOperations: [] }],
    ['plan without profile.read', { ...directPlan, directOperations: ['bookings.read' as const] }],
    ['plan without provider tenant key', planWithoutProviderKey],
  ])('answers 403 DIRECT_VIVA_DISABLED for %s', async (_label, plan) => {
    const { app } = startHarness({ plan });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { ...bearer(), 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'DIRECT_VIVA_DISABLED' });
  });

  it('answers 403 DIRECT_VIVA_DISABLED when the routing plan repository is not mounted', async () => {
    const { app } = startHarness({ includeRoutingPlan: false });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { ...bearer(), 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'DIRECT_VIVA_DISABLED' });
  });

  it('answers 403 DIRECT_VIVA_DISABLED when direct reads are globally disabled', async () => {
    const { app } = startHarness({ config: { ...enabledConfig, VIVA_DIRECT_READ_ENABLED: false } });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { ...bearer(), 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'DIRECT_VIVA_DISABLED' });
  });

  it('answers 400 when the create request carries fields it does not support', async () => {
    const { app } = startHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { screen: 'PROFILE' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_JOB_INVALID' });
  });

  it('answers 503 when the job store is not mounted', async () => {
    const { app } = startHarness({ includeJobStore: false });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/provider-read-jobs',
      headers: { ...bearer(), 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_STORE_UNAVAILABLE' });
  });
});

function resultsUrl(id = jobId, command = commandId) {
  return '/user/api/v1/local-padel/profile/provider-read-jobs/' + id + '/results/' + command;
}

function completeUrl(id = jobId) {
  return '/user/api/v1/local-padel/profile/provider-read-jobs/' + id + '/complete';
}

describe('POST profile/provider-read-jobs/:jobId/results/:commandId', () => {
  it('accepts a valid relayed provider payload and stores only the observation', async () => {
    const { app, jobStore, observations } = startHarness();
    await seedJob(jobStore);

    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json<{ accepted: boolean; replayed: boolean; observedAt: string }>();
    expect(body.accepted).toBe(true);
    expect(body.replayed).toBe(false);
    expect(Number.isFinite(Date.parse(body.observedAt))).toBe(true);
    expect(observations.put).toHaveBeenCalledTimes(1);
    expect(observations.put.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      userId,
      observation: {
        level: { label: 'C+', value: 3.8, assessmentRequired: false },
        balanceMinor: 54_000,
        currency: 'RUB',
      },
    });
    const storedObservation = JSON.stringify(observations.rows.get(tenantId + ':' + userId));
    expect(storedObservation).not.toContain('1f6d8c19-0d6b-4a57-9f0e-2a1b3c4d5e6f');
    expect(storedObservation).not.toContain('79990001122');
    expect(storedObservation).not.toContain('cdn.viva.test');
  });

  it('replays the accepted command without rewriting the observation', async () => {
    const { app, jobStore, observations } = startHarness();
    await seedJob(jobStore);

    const first = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });
    const second = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      accepted: true,
      replayed: true,
      observedAt: first.json<{ observedAt: string }>().observedAt,
    });
    expect(observations.put).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown job', '2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', commandId],
    ['unknown command', jobId, '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'],
  ])('answers 404 for an %s', async (_label, id, command) => {
    const { app, jobStore } = startHarness();
    await seedJob(jobStore);

    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(id, command),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_JOB_NOT_FOUND' });
  });

  it('answers 404 for a job owned by another principal', async () => {
    const { app, jobStore } = startHarness();
    await seedJob(jobStore, { tenantId: otherTenantId, userId: otherUserId });

    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_JOB_NOT_FOUND' });
  });

  it('answers 410 for an expired job', async () => {
    const { app, jobStore } = startHarness();
    await seedJob(jobStore, {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_JOB_EXPIRED' });
  });

  it.each([
    ['payload is not an object', { payload: 'provider bytes' }],
    ['body has extra fields', { payload: providerPayload(), extra: 1 }],
    ['payload key is missing', { result: providerPayload() }],
    ['provider payload is invalid', { payload: { id: 'not-a-uuid' } }],
  ])('answers 400 when the %s', async (_label, payload) => {
    const { app, jobStore, observations } = startHarness();
    await seedJob(jobStore);

    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_RESULT_INVALID' });
    expect(observations.put).not.toHaveBeenCalled();
  });

  it('rejects a relayed payload above the 64 KiB body limit', async () => {
    const { app, jobStore } = startHarness();
    await seedJob(jobStore);
    const oversized = providerPayload(1);
    oversized.customFields = [{ id: levelFieldId, value: ['x'.repeat(70_000)] }];

    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: oversized },
    });

    expect(response.statusCode).toBe(413);
  });

  it('answers 503 when the observation store is not mounted', async () => {
    const { app, jobStore } = startHarness({ includeObservationRepository: false });
    await seedJob(jobStore);

    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_STORE_UNAVAILABLE' });
  });
});

describe('POST profile/provider-read-jobs/:jobId/complete', () => {
  async function acceptResult(app: FastifyInstance, jobStore: MemoryProfileProviderReadJobStore) {
    await seedJob(jobStore);
    const response = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ observedAt: string }>();
  }

  it('answers 409 until a result has been accepted', async () => {
    const { app, jobStore } = startHarness();
    await seedJob(jobStore);

    const response = await app.inject({
      method: 'POST',
      url: completeUrl(),
      headers: bearer(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_INCOMPLETE' });
  });

  it('reports the refreshed state and consumes the job exactly once', async () => {
    const { app, jobStore } = startHarness();
    const accepted = await acceptResult(app, jobStore);

    const response = await app.inject({
      method: 'POST',
      url: completeUrl(),
      headers: bearer(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({ state: 'refreshed', observedAt: accepted.observedAt });

    const repeated = await app.inject({
      method: 'POST',
      url: completeUrl(),
      headers: bearer(),
    });
    expect(repeated.statusCode).toBe(404);
    expect(repeated.json()).toMatchObject({ code: 'PROFILE_READ_JOB_NOT_FOUND' });

    const lateResult = await app.inject({
      method: 'POST',
      url: resultsUrl(),
      headers: { ...bearer(), 'x-app-platform': 'android' },
      payload: { payload: providerPayload() },
    });
    expect(lateResult.statusCode).toBe(404);
    expect(lateResult.json()).toMatchObject({ code: 'PROFILE_READ_JOB_NOT_FOUND' });
  });

  it('answers 410 for an expired job', async () => {
    const { app, jobStore } = startHarness();
    await seedJob(jobStore, { expiresAt: new Date(Date.now() - 1_000).toISOString() });

    const response = await app.inject({ method: 'POST', url: completeUrl(), headers: bearer() });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_JOB_EXPIRED' });
  });

  it('answers 400 for a completion body it does not understand', async () => {
    const { app, jobStore } = startHarness();
    await seedJob(jobStore);

    const response = await app.inject({
      method: 'POST',
      url: completeUrl(),
      headers: bearer(),
      payload: { limit: 20 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'PROFILE_READ_JOB_INVALID' });
  });

  it('answers 404 for an unknown job and 503 without a store', async () => {
    const unknown = startHarness();
    const unknownResponse = await unknown.app.inject({
      method: 'POST',
      url: completeUrl('2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'),
      headers: bearer(),
    });
    expect(unknownResponse.statusCode).toBe(404);

    const noStore = startHarness({ includeJobStore: false });
    const noStoreResponse = await noStore.app.inject({
      method: 'POST',
      url: completeUrl(),
      headers: bearer(),
    });
    expect(noStoreResponse.statusCode).toBe(503);
    expect(noStoreResponse.json()).toMatchObject({ code: 'PROFILE_READ_STORE_UNAVAILABLE' });
  });
});
