import { loadConfig } from '@phub/config';
import type { PlayerLevelRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

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
const levelId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const level = {
  playerId: userId,
  sportCode: 'PADEL',
  levelId,
  code: 'C+',
  title: 'C+',
  rank: 4,
  source: 'SELF_DECLARED' as const,
  numericValue: null,
  scaleVersion: 1,
  updatedAt: '2026-08-16T18:00:00.000Z',
};

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(permissions: readonly string[] = ['profile.read']): Promise<string> {
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

function repository() {
  const setLevel = vi
    .fn()
    .mockResolvedValue({ outcome: 'applied', level, replayed: false } as const);
  return {
    value: {
      getState: vi.fn().mockResolvedValue({
        sportCode: 'PADEL',
        scaleVersion: 1,
        levels: [
          {
            id: levelId,
            sportCode: 'PADEL',
            code: 'C+',
            title: 'C+',
            rank: 4,
            sortOrder: 4,
            aliases: ['C+'],
            active: true,
            scaleVersion: 1,
          },
        ],
        currentLevel: null,
      }),
      setLevel,
    } satisfies PlayerLevelRepository,
    setLevel,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('profile level routes', () => {
  it('lists the server-owned canonical scale for the authenticated player', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('profile-level-route-test', 'silent'),
      pool: fakePool(),
      playerLevelRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile/level?sportCode=PADEL',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sportCode: 'PADEL',
      currentLevel: null,
      levels: [{ id: levelId, code: 'C+' }],
    });
  });

  it('derives the player and source instead of accepting them from the client', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('profile-level-route-test', 'silent'),
      pool: fakePool(),
      playerLevelRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/user/api/v1/local-padel/profile/level',
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'profile-level-command-0001',
      },
      payload: { sportCode: 'PADEL', levelId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ levelId, source: 'SELF_DECLARED' });
    expect(repo.setLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        playerId: userId,
        source: 'SELF_DECLARED',
        idempotencyKey: 'profile-level-command-0001',
      }),
    );
  });

  it('rejects caller-supplied actor and source fields', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('profile-level-route-test', 'silent'),
      pool: fakePool(),
      playerLevelRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/user/api/v1/local-padel/profile/level',
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'profile-level-command-0002',
      },
      payload: { sportCode: 'PADEL', levelId, playerId: userId, source: 'ONBOARDING' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'PROFILE_LEVEL_PAYLOAD_INVALID' });
    expect(repo.setLevel).not.toHaveBeenCalled();
  });

  it('publishes the established assessment without exposing its scoring operations', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('profile-level-route-test', 'silent'),
      pool: fakePool(),
      playerLevelRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile/level-assessment',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 'padel-self-assessment-v1',
      sportCode: 'PADEL',
      baseQuestionId: 'q1_1',
    });
    const payload: { readonly questions: readonly unknown[] } = response.json();
    expect(payload.questions).toHaveLength(21);
    expect(response.body).not.toContain('operation');
    expect(response.body).not.toContain('cap');
  });

  it('derives ONBOARDING level and numeric value from answers on the server', async () => {
    const repo = repository();
    repo.setLevel.mockResolvedValue({
      outcome: 'applied',
      level: { ...level, source: 'ONBOARDING', numericValue: 3.63 },
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('profile-level-route-test', 'silent'),
      pool: fakePool(),
      playerLevelRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/level-assessment',
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'profile-level-assessment-0001',
      },
      payload: {
        sportCode: 'PADEL',
        assessmentVersion: 'padel-self-assessment-v1',
        answers: {
          q1_1: ['one_two_years'],
          q3_1: ['3_4'],
          q3_2: ['yes'],
          q3_3: ['regular'],
          q3_4: ['unstable'],
          q3_5: ['4_8'],
          q3_6: ['1_3'],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      assessment: { numericScore: 3.63, levelCode: 'C+' },
      level: { source: 'ONBOARDING', numericValue: 3.63 },
    });
    expect(repo.setLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        playerId: userId,
        source: 'ONBOARDING',
        numericValue: 3.63,
        levelId,
      }),
    );
  });

  it('rejects client-computed assessment output and hidden-branch answers', async () => {
    const repo = repository();
    const app = await buildApp({
      config,
      logger: createLogger('profile-level-route-test', 'silent'),
      pool: fakePool(),
      playerLevelRepository: repo.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/level-assessment',
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'profile-level-assessment-0002',
      },
      payload: {
        sportCode: 'PADEL',
        assessmentVersion: 'padel-self-assessment-v1',
        answers: { q1_1: ['less_month'], q4_6: ['3_plus'] },
        levelCode: 'A',
        numericScore: 10,
        playerId: userId,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'LEVEL_ASSESSMENT_PAYLOAD_INVALID' });
    expect(repo.setLevel).not.toHaveBeenCalled();
  });
});
