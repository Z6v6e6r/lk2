import { loadConfig } from '@phub/config';
import type { MessagingModerationRepository, MessagingRepository } from '@phub/database';
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
const conversationId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const reportId = '44444444-4444-4444-8444-444444444444';
const caseId = '55555555-5555-4555-8555-555555555555';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function accessToken(
  permissions: readonly string[] = ['chat.direct.create'],
): Promise<string> {
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

/** Only the gate call is needed; the report repository never asks for runtime settings. */
function messageRepository(): MessagingRepository {
  const partial = {
    getRuntimeSettings: vi.fn().mockResolvedValue({
      httpEnabled: true,
      directEnabled: true,
      realtimeEnabled: false,
      contextualEnabled: false,
    }),
  };
  return partial as unknown as MessagingRepository;
}

function repository(
  overrides: Partial<MessagingModerationRepository> = {},
): MessagingModerationRepository {
  return {
    submitReport: vi.fn().mockResolvedValue({
      outcome: 'submitted',
      report: {
        id: reportId,
        conversationId,
        messageId,
        reporterUserId: userId,
        reasonCode: 'SPAM',
        details: null,
        state: 'TRIAGED',
        caseId,
        createdAt: '2026-09-20T12:00:00.000Z',
      },
      caseId,
      replayed: false,
    }),
    listReportQueue: vi.fn().mockResolvedValue([]),
    decideReport: vi.fn().mockResolvedValue({
      outcome: 'decided',
      action: 'DISMISS',
      hidden: false,
      replayed: false,
    }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('messaging report User API', () => {
  it('requires an authenticated member before touching moderation state', async () => {
    const submitReport = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-report-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: messageRepository(),
      messagingModerationRepository: repository({ submitReport }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers: { 'idempotency-key': 'messaging-report-command-0001' },
      payload: { reasonCode: 'SPAM' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('rejects a reason code outside the allow-list before calling the repository', async () => {
    const submitReport = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('messaging-report-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: messageRepository(),
      messagingModerationRepository: repository({ submitReport }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'messaging-report-command-0002',
      },
      payload: { reasonCode: 'HARASSMENT' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_REPORT_PAYLOAD_INVALID' });
    expect(submitReport).not.toHaveBeenCalled();
  });

  it('submits a report and answers 201 with the report and case identifiers only', async () => {
    const submitReport = vi.fn().mockResolvedValue({
      outcome: 'submitted',
      report: {
        id: reportId,
        conversationId,
        messageId,
        reporterUserId: userId,
        reasonCode: 'ABUSE',
        details: 'оскорбления',
        state: 'TRIAGED',
        caseId,
        createdAt: '2026-09-20T12:00:00.000Z',
      },
      caseId,
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('messaging-report-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: messageRepository(),
      messagingModerationRepository: repository({ submitReport }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'messaging-report-command-0003',
      },
      payload: { reasonCode: 'ABUSE', details: 'оскорбления' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      outcome: 'submitted',
      reportId,
      caseId,
      replayed: false,
    });
    expect(submitReport).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        reporterUserId: userId,
        conversationId,
        messageId,
        reasonCode: 'ABUSE',
        details: 'оскорбления',
        idempotencyKey: 'messaging-report-command-0003',
      }),
    );
    expect(response.body).not.toContain('оскорбления');
  });

  it('replays an identical retry with 200 and X-Idempotent-Replayed', async () => {
    const submitReport = vi.fn().mockResolvedValue({
      outcome: 'submitted',
      report: {
        id: reportId,
        conversationId,
        messageId,
        reporterUserId: userId,
        reasonCode: 'SPAM',
        details: null,
        state: 'TRIAGED',
        caseId,
        createdAt: '2026-09-20T12:00:00.000Z',
      },
      caseId,
      replayed: true,
    });
    const app = await buildApp({
      config,
      logger: createLogger('messaging-report-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: messageRepository(),
      messagingModerationRepository: repository({ submitReport }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'messaging-report-command-0004',
      },
      payload: { reasonCode: 'SPAM' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-idempotent-replayed']).toBe('true');
    expect(response.json()).toMatchObject({ replayed: true, reportId, caseId });
  });

  it('keeps self-report, duplicate and unknown targets on stable non-leaking codes', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-report-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: messageRepository(),
      messagingModerationRepository: repository({
        submitReport: vi
          .fn()
          .mockResolvedValueOnce({ outcome: 'self_report' })
          .mockResolvedValueOnce({ outcome: 'duplicate' })
          .mockResolvedValueOnce({ outcome: 'not_found' })
          .mockResolvedValueOnce({ outcome: 'idempotency_conflict' }),
      }),
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': 'messaging-report-command-0005',
    };

    const self = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers,
      payload: { reasonCode: 'SPAM' },
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers,
      payload: { reasonCode: 'SPAM' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers,
      payload: { reasonCode: 'SPAM' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers,
      payload: { reasonCode: 'SPAM' },
    });

    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ code: 'MESSAGING_REPORT_SELF_TARGET' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'MESSAGING_REPORT_DUPLICATE' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('answers 503 while the moderation contour is not wired', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('messaging-report-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: messageRepository(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages/${messageId}/report`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'messaging-report-command-0006',
      },
      payload: { reasonCode: 'SPAM' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MODERATION_UNAVAILABLE' });
  });
});
