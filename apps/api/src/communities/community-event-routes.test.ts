import { loadConfig } from '@phub/config';
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
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: ['communities.read'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('community event recovery route', () => {
  it('passes only the JWT principal and bounded sequence query', async () => {
    const listEvents = vi.fn().mockResolvedValue({
      outcome: 'found',
      page: {
        items: [],
        afterSequence: 7,
        latestSequence: 7,
        retainedFromSequence: 1,
        hasMore: false,
      },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityEventRecoveryService: { listEvents },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/communities/${communityId}/events?afterSequence=7&limit=25`,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        viewerUserId: userId,
        communityId,
        afterSequence: 7,
        limit: 25,
      }),
    );
  });

  it('returns explicit reset headers for an expired gap', async () => {
    const listEvents = vi.fn().mockResolvedValue({
      outcome: 'gap_expired',
      latestSequence: 40,
      retainedFromSequence: 20,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityEventRecoveryService: { listEvents },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/communities/${communityId}/events?afterSequence=1`,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'COMMUNITY_EVENT_GAP_EXPIRED',
      recoveryAction: 'FULL_CANONICAL_RELOAD',
      latestSequence: 40,
      retainedFromSequence: 20,
    });
    expect(response.headers['x-community-latest-sequence']).toBe('40');
    expect(response.headers['x-community-retained-from-sequence']).toBe('20');
  });
});
