import { loadConfig } from '@phub/config';
import type { MessagingModerationRepository } from '@phub/database';
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
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const reportId = '33333333-3333-4333-8333-333333333333';
const caseId = '44444444-4444-4444-8444-444444444444';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(
  permissions: readonly string[],
  audience: 'admin' | 'client' = 'admin',
): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['admin'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(audience === 'admin' ? config.JWT_ADMIN_AUDIENCE : config.JWT_AUDIENCE)
    .setSubject(actorUserId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function repository(
  overrides: Partial<MessagingModerationRepository> = {},
): MessagingModerationRepository {
  return {
    submitReport: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
    listReportQueue: vi.fn().mockResolvedValue([
      {
        reportId,
        conversationId,
        messageId,
        messageSenderUserId: '66666666-6666-4666-8666-666666666666',
        messageBody: 'текст сообщения',
        messageCreatedAt: '2026-09-20T11:00:00.000Z',
        messageHiddenAt: null,
        reporterUserId: '77777777-7777-4777-8777-777777777777',
        reasonCode: 'SPAM',
        details: null,
        reportState: 'TRIAGED',
        caseId,
        caseState: 'OPEN',
        caseSeverity: 'MEDIUM',
        createdAt: '2026-09-20T12:00:00.000Z',
      },
    ]),
    decideReport: vi.fn().mockResolvedValue({
      outcome: 'decided',
      action: 'HIDE_MESSAGE',
      hidden: true,
      replayed: false,
    }),
    ...overrides,
  };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('messaging moderation admin routes', () => {
  it('requires an admin token before reading the queue', async () => {
    const listReportQueue = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({ listReportQueue }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/messaging/moderation/reports',
    });

    expect(response.statusCode).toBe(401);
    expect(listReportQueue).not.toHaveBeenCalled();
  });

  it('never accepts a client-audience token that carries the admin permission', async () => {
    const listReportQueue = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({ listReportQueue }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/messaging/moderation/reports',
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.read'], 'client')}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(listReportQueue).not.toHaveBeenCalled();
  });

  it('requires the granular read capability and the CUP client header', async () => {
    const listReportQueue = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({ listReportQueue }),
    });
    apps.push(app);

    const withoutCapability = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/messaging/moderation/reports',
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.decide'])}`,
        'x-app-platform': 'cup-admin',
      },
    });
    const withoutCupHeader = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/messaging/moderation/reports',
      headers: { authorization: `Bearer ${await token(['chat.moderation.read'])}` },
    });

    expect(withoutCapability.statusCode).toBe(403);
    expect(withoutCapability.json()).toMatchObject({
      code: 'CHAT_MODERATION_PERMISSION_REQUIRED',
    });
    expect(withoutCupHeader.statusCode).toBe(403);
    expect(withoutCupHeader.json()).toMatchObject({ code: 'ADMIN_CLIENT_REQUIRED' });
    expect(listReportQueue).not.toHaveBeenCalled();
  });

  it('lists the reported body for a moderator with chat.moderation.read', async () => {
    const listReportQueue = vi.fn().mockResolvedValue([]);
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({ listReportQueue }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/messaging/moderation/reports?limit=10',
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ items: [] });
    expect(listReportQueue).toHaveBeenCalledWith({ tenantId, limit: 10 });
  });

  it('rejects a malformed queue query without calling the repository', async () => {
    const listReportQueue = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({ listReportQueue }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/messaging/moderation/reports?limit=500',
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MODERATION_QUERY_INVALID' });
    expect(listReportQueue).not.toHaveBeenCalled();
  });

  it('decides with the JWT actor, an idempotency key and a stable reason code', async () => {
    const decideReport = vi.fn().mockResolvedValue({
      outcome: 'decided',
      action: 'HIDE_MESSAGE',
      hidden: true,
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({ decideReport }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/messaging/moderation/reports/${reportId}/decision`,
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'messaging-moderation-decision-0001',
      },
      payload: { action: 'HIDE_MESSAGE', reasonCode: 'POLICY_VIOLATION' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-idempotent-replayed']).toBe('false');
    expect(response.json()).toEqual({
      outcome: 'decided',
      action: 'HIDE_MESSAGE',
      hidden: true,
      replayed: false,
    });
    expect(decideReport).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        moderatorUserId: actorUserId,
        reportId,
        action: 'HIDE_MESSAGE',
        reasonCode: 'POLICY_VIOLATION',
        idempotencyKey: 'messaging-moderation-decision-0001',
      }),
    );
  });

  it('requires chat.moderation.decide and a schema-valid reason code', async () => {
    const decideReport = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({ decideReport }),
    });
    apps.push(app);

    const withoutCapability = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/messaging/moderation/reports/${reportId}/decision`,
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'messaging-moderation-decision-0002',
      },
      payload: { action: 'HIDE_MESSAGE', reasonCode: 'POLICY_VIOLATION' },
    });
    const invalidReason = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/messaging/moderation/reports/${reportId}/decision`,
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'messaging-moderation-decision-0003',
      },
      payload: { action: 'HIDE_MESSAGE', reasonCode: 'free text' },
    });

    expect(withoutCapability.statusCode).toBe(403);
    expect(invalidReason.statusCode).toBe(400);
    expect(invalidReason.json()).toMatchObject({ code: 'MESSAGING_MODERATION_DECISION_INVALID' });
    expect(decideReport).not.toHaveBeenCalled();
  });

  it('keeps an unknown report and a reused command key on stable codes', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
      messagingModerationRepository: repository({
        decideReport: vi
          .fn()
          .mockResolvedValueOnce({ outcome: 'not_found' })
          .mockResolvedValueOnce({ outcome: 'idempotency_conflict' }),
      }),
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await token(['chat.moderation.decide'])}`,
      'x-app-platform': 'cup-admin',
      'idempotency-key': 'messaging-moderation-decision-0004',
    };
    const payload = { action: 'DISMISS', reasonCode: 'NOT_A_VIOLATION' };

    const unknown = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/messaging/moderation/reports/${reportId}/decision`,
      headers,
      payload,
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/messaging/moderation/reports/${reportId}/decision`,
      headers,
      payload,
    });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'MESSAGING_REPORT_NOT_FOUND' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('answers 503 when the moderation repository is not wired', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-moderation-admin-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/messaging/moderation/reports',
      headers: {
        authorization: `Bearer ${await token(['chat.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MODERATION_UNAVAILABLE' });
  });
});
