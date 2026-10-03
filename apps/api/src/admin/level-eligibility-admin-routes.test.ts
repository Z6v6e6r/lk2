import { loadConfig } from '@phub/config';
import type { LevelEligibilityPolicyRepository, LevelEligibilityPolicyView } from '@phub/database';
import { createLogger } from '@phub/observability';
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
const levels = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    sportCode: 'PADEL',
    code: 'C',
    title: 'C',
    rank: 3,
    sortOrder: 3,
    aliases: ['C'],
    active: true,
    scaleVersion: 1,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    sportCode: 'PADEL',
    code: 'B',
    title: 'B',
    rank: 5,
    sortOrder: 5,
    aliases: ['B'],
    active: true,
    scaleVersion: 1,
  },
] as const;
const policy: LevelEligibilityPolicyView = {
  id: '33333333-3333-4333-8333-333333333333',
  sportCode: 'PADEL',
  activityType: 'GAME',
  mode: 'OFF',
  lowerToleranceSteps: 0,
  upperToleranceSteps: 0,
  missingActivityConstraintAction: 'ALLOW',
  legacyTextConstraintAction: 'ALLOW',
  recheckWaitlistPromotion: true,
  version: 1,
  changeComment: 'Safe initial policy',
  updatedBy: null,
  createdAt: '2026-08-16T10:00:00.000Z',
};

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

function repository() {
  const publish = vi
    .fn()
    .mockResolvedValue({ outcome: 'applied', policy: { ...policy, version: 2 }, replayed: false });
  return {
    value: {
      getState: vi.fn().mockResolvedValue({ sportCode: 'PADEL', levels, policies: [policy] }),
      getVersion: vi.fn().mockResolvedValue(policy),
      listHistory: vi.fn().mockResolvedValue([policy]),
      publish,
      getImpact: vi.fn().mockResolvedValue([]),
    } satisfies LevelEligibilityPolicyRepository,
    publish,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('level eligibility admin routes', () => {
  it('rolls back a historical false recheck as true without rewriting history', async () => {
    const repo = repository();
    const historical = { ...policy, recheckWaitlistPromotion: false };
    repo.value.getVersion.mockResolvedValue(historical);
    repo.value.listHistory.mockResolvedValue([historical]);
    const app = await buildApp({
      config,
      logger: createLogger('level-policy-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: repo.value,
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await token(['eligibility.publish', 'eligibility.read'])}`,
      'x-app-platform': 'cup-admin',
      'idempotency-key': 'level-policy-rollback-0001',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/level-eligibility/GAME/rollback',
      headers,
      payload: { targetVersion: 1, expectedVersion: 2, changeComment: 'Restore historical policy' },
    });
    expect(response.statusCode).toBe(200);
    expect(repo.publish).toHaveBeenCalledWith(
      expect.objectContaining({ recheckWaitlistPromotion: true }),
    );
    const history = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/level-eligibility/GAME/history',
      headers,
    });
    expect(history.statusCode).toBe(200);
    expect(JSON.stringify(history.json())).toContain('"recheckWaitlistPromotion":false');
    expect(historical.recheckWaitlistPromotion).toBe(false);
  });

  it('refuses to disable the mandatory waitlist promotion recheck', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('level-policy-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/admin/api/v1/local-padel/level-eligibility/GAME?sportCode=PADEL',
      headers: {
        authorization: `Bearer ${await token(['eligibility.publish'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'level-policy-no-recheck-0001',
      },
      payload: {
        expectedVersion: 1,
        mode: 'SHADOW',
        lowerToleranceSteps: 0,
        upperToleranceSteps: 0,
        missingActivityConstraintAction: 'ALLOW',
        legacyTextConstraintAction: 'ALLOW',
        recheckWaitlistPromotion: false,
        changeComment: 'Disable recheck',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(repo.publish).not.toHaveBeenCalled();
  });

  it('publishes an explicit optimistic policy command with CUP RBAC and idempotency', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('level-policy-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/admin/api/v1/local-padel/level-eligibility/GAME?sportCode=PADEL',
      headers: {
        authorization: `Bearer ${await token(['eligibility.publish'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'level-policy-publish-0001',
      },
      payload: {
        expectedVersion: 1,
        mode: 'SHADOW',
        lowerToleranceSteps: 1,
        upperToleranceSteps: 2,
        missingActivityConstraintAction: 'WARN',
        legacyTextConstraintAction: 'WARN',
        recheckWaitlistPromotion: true,
        changeComment: 'Начинаем shadow',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ policy: { version: 2 }, replayed: false });
    expect(repo.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        sportCode: 'PADEL',
        activityType: 'GAME',
        expectedVersion: 1,
        idempotencyKey: 'level-policy-publish-0001',
      }),
    );
  });

  it('keeps read and publish permissions separate', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('level-policy-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/admin/api/v1/local-padel/level-eligibility/GAME',
      headers: {
        authorization: `Bearer ${await token(['eligibility.read'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'level-policy-denied-0001',
      },
      payload: {
        expectedVersion: 1,
        mode: 'OFF',
        lowerToleranceSteps: 0,
        upperToleranceSteps: 0,
        missingActivityConstraintAction: 'ALLOW',
        legacyTextConstraintAction: 'ALLOW',
        recheckWaitlistPromotion: true,
        changeComment: 'No publish permission',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'LEVEL_ELIGIBILITY_ADMIN_PERMISSION_REQUIRED' });
    expect(repo.publish).not.toHaveBeenCalled();
  });

  it('runs preview through the canonical server rule without persisting a policy', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('level-policy-admin-test', 'silent'),
      pool: fakePool(),
      levelEligibilityPolicyRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/level-eligibility/preview',
      headers: {
        authorization: `Bearer ${await token(['eligibility.read'])}`,
        'x-app-platform': 'cup-admin',
      },
      payload: {
        sportCode: 'PADEL',
        activityType: 'GAME',
        playerLevelId: null,
        minimumLevelId: levels[0].id,
        maximumLevelId: levels[1].id,
        personalInvitation: false,
        organizerCreation: false,
        policy: {
          mode: 'BLOCK',
          lowerToleranceSteps: 0,
          upperToleranceSteps: 0,
          missingActivityConstraintAction: 'BLOCK',
          legacyTextConstraintAction: 'WARN',
          recheckWaitlistPromotion: true,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: false,
      status: 'DENIED',
      result: { reasonCode: 'PLAYER_LEVEL_REQUIRED' },
    });
    expect(repo.publish).not.toHaveBeenCalled();
  });
});
