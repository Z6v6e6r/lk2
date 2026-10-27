import { loadConfig } from '@phub/config';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerAuthRoutes } from './auth-routes.js';
import type { PhoneSubjectLinkService } from './phone-subject-link-service.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sessionId = '108966ea-d0a3-4b95-b4fc-d0239f351e70';
const challengeId = 'a6d5cb38-9d1f-49be-b294-7bc1addb4420';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  CORS_ORIGINS: 'https://lk.example.test',
  VIVA_MODE: 'sandbox',
  AUTH_PHONE_SUBJECT_LINK_ENABLED: 'true',
});

const apps: FastifyInstance[] = [];

function createApp(service?: PhoneSubjectLinkService): FastifyInstance {
  const app = Fastify();
  apps.push(app);
  const authenticated = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization !== 'Bearer client-session') {
      await reply.status(401).send({ code: 'AUTH_REQUIRED' });
      return;
    }
    request.tenantId = tenantId;
    request.padlHubClaims = {
      sub: userId,
      sid: sessionId,
      tenants: [tenantId],
      roles: ['client'],
      permissions: ['profile.read'],
    };
  };
  registerAuthRoutes(
    app,
    {} as never,
    config,
    [authenticated],
    undefined,
    undefined,
    undefined,
    service,
  );
  return app;
}

function headers(intent: string) {
  return {
    authorization: 'Bearer client-session',
    origin: 'https://lk.example.test',
    'idempotency-key': 'subject-link-command-0001',
    'x-session-intent': intent,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('identity subject link routes', () => {
  it('requires authentication before invoking the service', async () => {
    const start = vi.fn();
    const app = createApp({ start, verify: vi.fn() } as never);
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/identity-subject-link/challenges',
      headers: {
        origin: 'https://lk.example.test',
        'idempotency-key': 'subject-link-command-0001',
        'x-session-intent': 'identity-subject-link-start',
      },
      payload: { phone: '+79990000001' },
    });
    expect(response.statusCode).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it.each([undefined, 'https://attacker.example.test'])(
    'requires the exact allowed Origin: %s',
    async (origin) => {
      const start = vi.fn();
      const app = createApp({ start, verify: vi.fn() } as never);
      const requestHeaders: Record<string, string> = {
        authorization: 'Bearer client-session',
        'idempotency-key': 'subject-link-command-0001',
        'x-session-intent': 'identity-subject-link-start',
      };
      if (origin) requestHeaders.origin = origin;
      const response = await app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/auth/identity-subject-link/challenges',
        headers: requestHeaders,
        payload: { phone: '+79990000001' },
      });
      expect(response.statusCode).toBe(403);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it('requires the exact start intent and a strict body', async () => {
    const start = vi.fn();
    const app = createApp({ start, verify: vi.fn() } as never);
    const missingIntent = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/identity-subject-link/challenges',
      headers: {
        ...headers('wrong-intent'),
      },
      payload: { phone: '+79990000001' },
    });
    expect(missingIntent.statusCode).toBe(400);
    const extraActor = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/identity-subject-link/challenges',
      headers: headers('identity-subject-link-start'),
      payload: { phone: '+79990000001', userId },
    });
    expect(extraActor.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it('derives the client actor from authenticated claims', async () => {
    const start = vi.fn<PhoneSubjectLinkService['start']>().mockResolvedValue({
      challengeId,
      expiresAt: '2026-10-26T12:05:00.000Z',
      resendAfterSeconds: 60,
    });
    const app = createApp({ start, verify: vi.fn() } as never);
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/identity-subject-link/challenges',
      headers: headers('identity-subject-link-start'),
      payload: { phone: '+79990000001' },
    });
    expect(response.statusCode).toBe(202);
    expect(typeof start.mock.calls[0]?.[0].correlationId).toBe('string');
    expect(start).toHaveBeenCalledWith({
      actor: { tenantId, tenantKey: 'local-padel', userId, sessionId, audience: 'client' },
      phone: '+79990000001',
      idempotencyKey: 'subject-link-command-0001',
      correlationId: start.mock.calls[0]?.[0].correlationId,
    });
  });

  it('requires exact verify intent and returns only the redacted outcome', async () => {
    const verify = vi
      .fn<PhoneSubjectLinkService['verify']>()
      .mockResolvedValue({ status: 'linked' });
    const app = createApp({ start: vi.fn(), verify } as never);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/identity-subject-link/challenges/${challengeId}/verify`,
      headers: headers('identity-subject-link-verify'),
      payload: { code: '1234' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'linked' });
    expect(JSON.stringify(response.json())).not.toMatch(/7999|subject|issuer|token/i);
    expect(typeof verify.mock.calls[0]?.[0].correlationId).toBe('string');
    expect(verify).toHaveBeenCalledWith({
      actor: { tenantId, tenantKey: 'local-padel', userId, sessionId, audience: 'client' },
      challengeId,
      code: '1234',
      idempotencyKey: 'subject-link-command-0001',
      correlationId: verify.mock.calls[0]?.[0].correlationId,
    });
  });

  it('fails closed when the runtime dependency is absent', async () => {
    const app = createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/identity-subject-link/challenges',
      headers: headers('identity-subject-link-start'),
      payload: { phone: '+79990000001' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'AUTH_SUBJECT_LINK_DISABLED' });
  });
});
