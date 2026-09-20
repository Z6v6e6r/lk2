import { loadConfig } from '@phub/config';
import type { MessagingMediaRepository, MessagingRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import type { MessagingMediaObjectStore } from './messaging-media-object-store.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  CHAT_MEDIA_ENABLED: 'true',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'phub-test',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
});

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const conversationId = '22222222-2222-4222-8222-222222222222';
const mediaId = '77777777-7777-4777-8777-777777777777';
const messageId = '33333333-3333-4333-8333-333333333333';
const sha256 = 'a'.repeat(64);
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

const asset = {
  id: mediaId,
  conversationId,
  uploaderUserId: userId,
  mediaType: 'IMAGE' as const,
  state: 'UPLOADING' as const,
  fileName: 'photo.png',
  contentType: 'image/png',
  byteSize: 1_024,
  sha256,
  revision: 1,
  readyObjectVersion: null,
  readyAt: null,
  rejectionCode: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

function mediaRepository(
  overrides: Partial<MessagingMediaRepository> = {},
): MessagingMediaRepository {
  return {
    issueUpload: vi.fn().mockResolvedValue({
      outcome: 'issued',
      replayed: false,
      intent: {
        id: mediaId,
        conversationId,
        uploaderUserId: userId,
        mediaType: 'IMAGE',
        objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
        declaredContentType: 'image/png',
        declaredByteSize: 1_024,
        declaredSha256: sha256,
        uploadExpiresAt: '2026-09-20T10:15:00.000Z',
        revision: 1,
        createdAt: '2026-09-20T10:00:00.000Z',
      },
    }),
    getFinalizeTarget: vi.fn().mockResolvedValue({
      outcome: 'inspect',
      objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
    }),
    finalizeUpload: vi.fn().mockResolvedValue({
      outcome: 'finalized',
      replayed: false,
      media: { ...asset, state: 'SCANNING' },
    }),
    getMedia: vi.fn().mockResolvedValue({ outcome: 'ok', media: asset }),
    claimScans: vi.fn().mockResolvedValue([]),
    completeScan: vi.fn().mockResolvedValue('ready'),
    rejectScan: vi.fn().mockResolvedValue('rejected'),
    releaseScan: vi.fn().mockResolvedValue(undefined),
    failScan: vi.fn().mockResolvedValue('rejected'),
    expireDue: vi.fn().mockResolvedValue([]),
    confirmExpiredObjectsAbsent: vi.fn().mockResolvedValue(true),
    claimGc: vi.fn().mockResolvedValue([]),
    completeGc: vi.fn().mockResolvedValue('deleted'),
    failGc: vi.fn().mockResolvedValue(undefined),
    deadLetterGc: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function objectStore(
  overrides: Partial<MessagingMediaObjectStore> = {},
): MessagingMediaObjectStore {
  return {
    checkReady: vi.fn().mockResolvedValue(undefined),
    createUploadGrant: vi.fn().mockResolvedValue({
      url: 'https://storage.example.test/phub-test/quarantine?X-Amz-Signature=test',
      method: 'PUT',
      requiredHeaders: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
      expiresAt: '2026-09-20T10:15:00.000Z',
    }),
    inspectCurrentVersion: vi.fn().mockResolvedValue({
      byteSize: 1_024,
      contentType: 'image/png',
      etag: '"etag"',
      versionId: 'version-1',
      checksumSha256: sha256,
    }),
    createDeliveryUrl: vi.fn().mockResolvedValue('https://storage.example.test/signed'),
    ...overrides,
  };
}

function messageRepository(overrides: Partial<MessagingRepository> = {}): MessagingRepository {
  return {
    getRuntimeSettings: vi.fn().mockResolvedValue({
      httpEnabled: true,
      directEnabled: true,
      realtimeEnabled: false,
      contextualEnabled: false,
    }),
    getMessageMediaForViewer: vi.fn().mockResolvedValue({
      outcome: 'ok',
      media: {
        mediaId,
        messageId,
        conversationId,
        mediaType: 'IMAGE',
        fileName: 'photo.png',
        contentType: 'image/png',
        byteSize: 1_024,
        objectKey: `chat-media/ready/${tenantId}/${conversationId}/${mediaId}/content`,
        objectVersion: 'ready-version-1',
        sha256,
      },
    }),
    ...overrides,
  } as unknown as MessagingRepository;
}

async function build(options: {
  readonly media?: MessagingMediaRepository;
  readonly store?: MessagingMediaObjectStore;
  readonly messages?: MessagingRepository;
}) {
  const app = await buildApp({
    config,
    logger: createLogger('messaging-media-api-test', 'silent'),
    pool: fakePool(),
    messagingRepository: options.messages ?? messageRepository(),
    messagingMediaRepository: options.media ?? mediaRepository(),
    messagingMediaObjectStore: options.store ?? objectStore(),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('messaging media API', () => {
  it('requires authorization before touching storage', async () => {
    const store = objectStore();
    const app = await build({ store });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
      payload: { fileName: 'photo.png', contentType: 'image/png', byteSize: 1_024, sha256 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(store.createUploadGrant).not.toHaveBeenCalled();
  });

  it('issues a single-use quarantine grant for an image', async () => {
    const app = await build({});
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-media-issue-0001',
      },
      payload: { fileName: 'photo.png', contentType: 'image/png', byteSize: 1_024, sha256 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      media: { id: mediaId, mediaType: 'IMAGE', state: 'UPLOADING' },
      upload: { method: 'PUT', requiredHeaders: { 'If-None-Match': '*' } },
    });
  });

  it('refuses content a browser would execute and any unrecognised image type', async () => {
    const media = mediaRepository();
    const app = await build({ media });
    for (const contentType of ['image/svg+xml', 'text/html', 'image/gif']) {
      const response = await app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'idempotency-key': 'chat-media-issue-0002',
        },
        payload: { fileName: 'payload.bin', contentType, byteSize: 1_024, sha256 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_PAYLOAD_INVALID' });
    }
    expect(media.issueUpload).not.toHaveBeenCalled();
  });

  it('refuses a path-like file name and an over-limit byte size', async () => {
    const media = mediaRepository();
    const app = await build({ media });
    const token = await accessToken();
    const traversal = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'chat-media-issue-0003' },
      payload: {
        fileName: '../../etc/passwd',
        contentType: 'application/pdf',
        byteSize: 1_024,
        sha256,
      },
    });
    const oversized = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'chat-media-issue-0004' },
      payload: {
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        byteSize: 15 * 1_024 * 1_024 + 1,
        sha256,
      },
    });

    expect(traversal.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(media.issueUpload).not.toHaveBeenCalled();
  });

  it('maps upload quota refusals to a retryable stable code', async () => {
    const app = await build({
      media: mediaRepository({
        issueUpload: vi.fn().mockResolvedValue({
          outcome: 'outstanding_upload_quota_exceeded',
          retryAfterSeconds: 42,
        }),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-media-issue-0005',
      },
      payload: { fileName: 'photo.png', contentType: 'image/png', byteSize: 1_024, sha256 },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
    expect(response.json()).toMatchObject({
      code: 'MESSAGING_MEDIA_OUTSTANDING_UPLOAD_QUOTA_EXCEEDED',
    });
  });

  it('fails finalize closed when the uploaded object is missing', async () => {
    const app = await build({
      store: objectStore({ inspectCurrentVersion: vi.fn().mockResolvedValue(undefined) }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/finalize`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-media-finalize-0001',
      },
      payload: { declaredByteSize: 1_024 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_OBJECT_MISSING' });
  });

  it('reports an object mismatch when the stored bytes differ from the declaration', async () => {
    const app = await build({
      media: mediaRepository({
        finalizeUpload: vi.fn().mockResolvedValue({ outcome: 'object_mismatch' }),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/finalize`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-media-finalize-0002',
      },
      payload: { declaredByteSize: 1_024 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_OBJECT_MISMATCH' });
  });

  it('hands a reader a short-lived redirect instead of an object key', async () => {
    const store = objectStore();
    const app = await build({ store });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://storage.example.test/signed');
    expect(store.createDeliveryUrl).toHaveBeenCalledWith({
      delivery: {
        objectKey: `chat-media/ready/${tenantId}/${conversationId}/${mediaId}/content`,
        objectVersion: 'ready-version-1',
        fileName: 'photo.png',
        contentType: 'image/png',
        inline: true,
      },
      expiresInSeconds: config.CHAT_MEDIA_READ_URL_TTL_SECONDS,
    });
    expect(JSON.stringify(response.body)).not.toContain('chat-media/ready');
  });

  it('hides a message attachment from a reader without an active membership', async () => {
    const store = objectStore();
    const app = await build({
      store,
      messages: messageRepository({
        getMessageMediaForViewer: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_NOT_FOUND' });
    expect(store.createDeliveryUrl).not.toHaveBeenCalled();
  });

  it('sends an attachment-only message through the messaging command', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      outcome: 'ok',
      replayed: false,
      message: {
        id: messageId,
        conversationId,
        sequence: 3,
        sender: { userId, displayName: 'Анна' },
        messageType: 'IMAGE',
        body: '',
        attachments: [
          {
            mediaId,
            position: 1,
            fileName: 'photo.png',
            contentType: 'image/png',
            byteSize: 1_024,
            mediaType: 'IMAGE',
          },
        ],
        createdAt: '2026-09-20T10:00:00.000Z',
      },
    });
    const app = await build({
      messages: messageRepository({ sendMessage } as unknown as Partial<MessagingRepository>),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-message-attachment-0001',
      },
      payload: { clientMessageId: 'client-message-attachment-0001', attachmentIds: [mediaId] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'ok', message: { messageType: 'IMAGE' } });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        conversationId,
        body: '',
        attachmentMediaIds: [mediaId],
      }),
    );
  });

  it('refuses a message with more than four attachments before the command runs', async () => {
    const sendMessage = vi.fn();
    const app = await build({
      messages: messageRepository({ sendMessage } as unknown as Partial<MessagingRepository>),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-message-attachment-0002',
      },
      payload: {
        clientMessageId: 'client-message-attachment-0002',
        attachmentIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          '44444444-4444-4444-8444-444444444444',
          '55555555-5555-4555-8555-555555555555',
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'MESSAGE_INVALID' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports a not-ready attachment with a stable retryable code', async () => {
    const app = await build({
      messages: messageRepository({
        sendMessage: vi
          .fn()
          .mockResolvedValue({ outcome: 'attachment_invalid', reason: 'NOT_READY' }),
      } as unknown as Partial<MessagingRepository>),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/messages`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-message-attachment-0003',
      },
      payload: {
        clientMessageId: 'client-message-attachment-0003',
        body: 'смотрите',
        attachmentIds: [mediaId],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_NOT_READY' });
  });

  it('keeps media routes closed while the chat media flag is off', async () => {
    const disabled = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    });
    const app = await buildApp({
      config: disabled,
      logger: createLogger('messaging-media-api-test', 'silent'),
      pool: fakePool(),
      messagingRepository: messageRepository(),
      messagingMediaRepository: mediaRepository(),
      messagingMediaObjectStore: objectStore(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_DISABLED' });
  });
});
