import { loadConfig } from '@phub/config';
import type { LevelEligibilityPolicyRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import type { SubscriptionPolicyRegistryResult } from '@phub/subscription-runtime-adapter';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

const registry: SubscriptionPolicyRegistryResult = {
  schemaVersion: 1,
  generatedAt: '2026-10-21T08:00:00.000Z',
  items: [],
  totals: { subscriptionTypes: 1, publishedPolicies: 1, draftPolicies: 0, instances: 2 },
};
const levelState = { sportCode: 'PADEL', levels: [], policies: [] };

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(permissions: readonly string[]): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['admin'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_ADMIN_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function levelRepository(): LevelEligibilityPolicyRepository {
  return {
    getState: vi.fn().mockResolvedValue(levelState),
  } as unknown as LevelEligibilityPolicyRepository;
}

function adminHeaders(permissions: readonly string[] = ['eligibility.publish']) {
  return token(permissions).then((authorization) => ({
    authorization: `Bearer ${authorization}`,
    'x-app-platform': 'cup-admin',
  }));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('rules registry admin route', () => {
  it('returns level rules and the CUP published-policy registry', async () => {
    const read = vi.fn().mockResolvedValue(registry);
    const app = await buildApp({
      config,
      logger: createLogger('rules-registry-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: levelRepository(),
      subscriptionPolicyRegistryClient: { read },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/rules-registry?sportCode=PADEL',
      headers: await adminHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.level).toMatchObject({ source: 'LK2_LEVEL', status: 'OK', sportCode: 'PADEL' });
    expect(body.subscriptions).toMatchObject({
      source: 'CUP_PUBLISHED',
      status: 'OK',
      registry,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('keeps level rules visible when CUP is unavailable and reports it explicitly', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('rules-registry-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: levelRepository(),
      subscriptionPolicyRegistryClient: {
        read: vi.fn().mockRejectedValue(new Error('CUP unavailable')),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/rules-registry',
      headers: await adminHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().level).toMatchObject({ status: 'OK' });
    expect(response.json().subscriptions).toEqual({
      source: 'CUP_PUBLISHED',
      status: 'UNAVAILABLE',
      reason: 'SUBSCRIPTION_POLICY_REGISTRY_UNAVAILABLE',
    });
  });

  it('does not present missing sources as empty data', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('rules-registry-admin-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/rules-registry',
      headers: await adminHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().level).toEqual({
      source: 'LK2_LEVEL',
      status: 'UNAVAILABLE',
      reason: 'LEVEL_ELIGIBILITY_REPOSITORY_NOT_CONFIGURED',
    });
    expect(response.json().subscriptions).toEqual({
      source: 'CUP_PUBLISHED',
      status: 'UNAVAILABLE',
      reason: 'SUBSCRIPTION_POLICY_REGISTRY_NOT_CONFIGURED',
    });
  });

  it('requires the CUP client and the strongest existing CUP permission', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('rules-registry-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: levelRepository(),
      subscriptionPolicyRegistryClient: { read: vi.fn().mockResolvedValue(registry) },
    });
    apps.push(app);

    const withoutPlatform = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/rules-registry',
      headers: { authorization: `Bearer ${await token(['eligibility.publish'])}` },
    });
    expect(withoutPlatform.statusCode).toBe(403);

    const withoutPermission = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/rules-registry',
      headers: await adminHeaders(['eligibility.read']),
    });
    expect(withoutPermission.statusCode).toBe(403);

    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/rules-registry',
      headers: { 'x-app-platform': 'cup-admin' },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
