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

interface RegistryBody {
  level: { source: string; status: string; sportCode?: string };
  legacyCoverage: {
    status: string;
    reason?: string;
    coveredProducts?: number;
    uncoveredProducts?: number;
    products?: Array<{
      productId: string;
      providerProductIds: string[];
      coveredBy: Array<{ subscriptionTypeId: string; policyVersion: number | null }>;
    }>;
  };
  subscriptions: { source: string; status: string; reason?: string; registry?: unknown };
  legacy: {
    source: string;
    status: string;
    authority?: string;
    products?: number;
    rules?: number;
    repo?: { sha: string; url: string; date: string };
  };
}

interface LegacyBody {
  schemaVersion: number;
  source: string;
  authority: string;
  inventory: { products: unknown[]; rules: Array<Record<string, unknown>> };
  coverage: { status: string; reason?: string; coveredProducts?: number };
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
    const body = JSON.parse(response.body) as RegistryBody;
    expect(body.level).toMatchObject({ source: 'LK2_LEVEL', status: 'OK', sportCode: 'PADEL' });
    expect(body.subscriptions).toMatchObject({
      source: 'CUP_PUBLISHED',
      status: 'OK',
      registry,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(body.legacy).toMatchObject({
      source: 'LK1_INVENTORY',
      status: 'OK',
      authority: 'INVENTORY_ONLY',
    });
    expect(typeof body.legacy.repo?.sha).toBe('string');
    expect(typeof body.legacy.repo?.url).toBe('string');
    expect(typeof body.legacy.repo?.date).toBe('string');
    expect(body.legacy.products ?? 0).toBeGreaterThan(0);
    expect(body.legacy.rules ?? 0).toBeGreaterThan(0);
    expect(body.legacyCoverage.status).toBe('OK');
    expect(body.legacyCoverage.coveredProducts).toBe(0);
    expect(body.legacyCoverage.uncoveredProducts).toBeGreaterThan(0);
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
    const unavailable = JSON.parse(response.body) as RegistryBody;
    expect(unavailable.level).toMatchObject({ status: 'OK' });
    expect(unavailable.subscriptions).toEqual({
      source: 'CUP_PUBLISHED',
      status: 'UNAVAILABLE',
      reason: 'SUBSCRIPTION_POLICY_REGISTRY_UNAVAILABLE',
    });
  });

  it('matches LK1 products to published CUP policies by provider product id', async () => {
    const item = {
      subscriptionTypeId: 'subscription_type:annual',
      code: 'ANNUAL_HUB',
      title: 'Годовой HUB',
      description: null,
      state: 'ACTIVE' as const,
      currentPolicyVersion: 3,
      publication: {
        publicationId: 'publication:annual-v3',
        policyVersion: 3,
        policyDigest: `sha256:${'a'.repeat(64)}`,
        state: 'PUBLISHED' as const,
        effectiveAt: '2026-10-01T00:00:00.000Z',
        applyTo: 'NEW_ONLY' as const,
        publishedAt: '2026-10-01T00:00:00.000Z',
        supersededAt: null,
        runtimeCompatibility: null,
      },
      rules: null,
      surfaces: ['CREATE_GAME', 'JOIN_GAME'],
      providerProductIds: ['db7a5250-7369-4f43-8ac5-9111be24bc74'],
      versions: [
        {
          policyVersion: 3,
          status: 'PUBLISHED' as const,
          modelVersion: 3 as const,
          effectiveAt: '2026-10-01T00:00:00.000Z',
          applyTo: 'NEW_ONLY' as const,
          publicationState: 'PUBLISHED' as const,
        },
      ],
      instances: { total: 0, byPolicyVersion: [] },
      lastDecision: null,
      lastQuoteDecision: null,
    };
    const matching: SubscriptionPolicyRegistryResult = {
      ...registry,
      items: [item],
    };
    const app = await buildApp({
      config,
      logger: createLogger('rules-registry-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: levelRepository(),
      subscriptionPolicyRegistryClient: { read: vi.fn().mockResolvedValue(matching) },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/rules-registry?sportCode=PADEL',
      headers: await adminHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as RegistryBody;
    expect(body.legacyCoverage.status).toBe('OK');
    expect(body.legacyCoverage.coveredProducts).toBe(1);
    const hub = body.legacyCoverage.products?.find(
      (product) => product.productId === 'lk1:hub-annual',
    );
    expect(hub?.providerProductIds).toContain('db7a5250-7369-4f43-8ac5-9111be24bc74');
    expect(hub?.coveredBy[0]).toMatchObject({
      subscriptionTypeId: 'subscription_type:annual',
      policyVersion: 3,
    });
  });

  it('serves the LK1 inventory snapshot as explicit intake evidence', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('rules-registry-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: levelRepository(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/legacy-rules-inventory',
      headers: await adminHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as LegacyBody;
    expect(body).toMatchObject({
      schemaVersion: 1,
      source: 'LK1_INVENTORY',
      authority: 'INVENTORY_ONLY',
    });
    expect(body.inventory.products.length).toBeGreaterThan(0);
    expect(body.inventory.rules.length).toBeGreaterThan(0);
    expect(body.inventory.rules[0]).toHaveProperty('ruleId');
    expect(body.inventory.rules[0]).toHaveProperty('evidence');
    expect(body.coverage).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'SUBSCRIPTIONS_UNAVAILABLE',
    });
  });

  it('adds published-policy coverage to the legacy inventory endpoint', async () => {
    const item = {
      subscriptionTypeId: 'subscription_type:annual',
      code: 'ANNUAL_HUB',
      title: 'Годовой HUB',
      description: null,
      state: 'ACTIVE' as const,
      currentPolicyVersion: 3,
      publication: {
        publicationId: 'publication:annual-v3',
        policyVersion: 3,
        policyDigest: `sha256:${'a'.repeat(64)}`,
        state: 'PUBLISHED' as const,
        effectiveAt: '2026-10-01T00:00:00.000Z',
        applyTo: 'NEW_ONLY' as const,
        publishedAt: '2026-10-01T00:00:00.000Z',
        supersededAt: null,
        runtimeCompatibility: null,
      },
      rules: null,
      surfaces: ['CREATE_GAME', 'JOIN_GAME'],
      providerProductIds: ['db7a5250-7369-4f43-8ac5-9111be24bc74'],
      versions: [],
      instances: { total: 0, byPolicyVersion: [] },
      lastDecision: null,
      lastQuoteDecision: null,
    };
    const app = await buildApp({
      config,
      logger: createLogger('rules-registry-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: levelRepository(),
      subscriptionPolicyRegistryClient: {
        read: vi.fn().mockResolvedValue({ ...registry, items: [item] }),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/legacy-rules-inventory',
      headers: await adminHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as LegacyBody;
    expect(body.coverage).toMatchObject({ status: 'OK', coveredProducts: 1 });
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
    const missing = JSON.parse(response.body) as RegistryBody;
    expect(missing.level).toEqual({
      source: 'LK2_LEVEL',
      status: 'UNAVAILABLE',
      reason: 'LEVEL_ELIGIBILITY_REPOSITORY_NOT_CONFIGURED',
    });
    expect(missing.subscriptions).toEqual({
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

    const legacyWithoutPermission = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/legacy-rules-inventory',
      headers: await adminHeaders(['eligibility.read']),
    });
    expect(legacyWithoutPermission.statusCode).toBe(403);
  });
});
