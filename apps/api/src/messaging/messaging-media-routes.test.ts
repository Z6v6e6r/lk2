import { loadConfig } from '@phub/config';
import type { MessagingMediaRepository, MessagingRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';
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
  subject = userId,
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
    .setSubject(subject)
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
      conversationId,
      declaredContentType: 'image/png',
      declaredByteSize: 1_024,
      declaredSha256: sha256,
    }),
    finalizeUpload: vi.fn().mockResolvedValue({
      outcome: 'finalized',
      replayed: false,
      media: { ...asset, state: 'SCANNING' },
    }),
    recordSourceUpload: vi.fn().mockResolvedValue(undefined),
    getMedia: vi.fn().mockResolvedValue({ outcome: 'ok', media: asset }),
    claimScans: vi.fn().mockResolvedValue([]),
    completeScan: vi.fn().mockResolvedValue('ready'),
    rejectScan: vi.fn().mockResolvedValue('rejected'),
    releaseScan: vi.fn().mockResolvedValue(undefined),
    failScan: vi.fn().mockResolvedValue('rejected'),
    expireDue: vi.fn().mockResolvedValue([]),
    scheduleExpiredSourceVersion: vi.fn().mockResolvedValue(undefined),
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
    putSourceObject: vi.fn().mockResolvedValue({
      byteSize: 1_024,
      contentType: 'image/png',
      etag: '"etag"',
      versionId: 'version-1',
      checksumSha256: sha256,
    }),
    readDelivery: vi.fn().mockResolvedValue(Buffer.from('ready-image')),
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
    const createUploadGrant = vi.fn().mockResolvedValue({
      url: 'https://storage.example.test/signed',
      method: 'PUT',
      requiredHeaders: {},
      expiresAt: '2026-09-20T10:15:00.000Z',
    });
    const store = objectStore({ createUploadGrant });
    const app = await build({ store });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
      payload: { fileName: 'photo.png', contentType: 'image/png', byteSize: 1_024, sha256 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(createUploadGrant).not.toHaveBeenCalled();
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

  it('gives Android a PadlHub relay descriptor without creating or exposing an S3 grant', async () => {
    const createUploadGrant = vi.fn();
    const app = await build({ store: objectStore({ createUploadGrant }) });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/uploads`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'android',
        'idempotency-key': 'chat-media-issue-android-0001',
      },
      payload: { fileName: 'photo.png', contentType: 'image/png', byteSize: 1_024, sha256 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      upload: {
        method: 'PUT',
        url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
        requiredHeaders: { 'Content-Type': 'application/octet-stream' },
      },
    });
    expect(response.body).not.toContain('storage.example.test');
    expect(response.body).not.toContain('chat-media/quarantine');
    expect(createUploadGrant).not.toHaveBeenCalled();
  });

  it('relays declared Android upload bytes to the server-owned quarantine key', async () => {
    const body = Buffer.from('android-upload');
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const putSourceObject = vi.fn().mockResolvedValue({});
    const inspectCurrentVersion = vi.fn().mockResolvedValue({
      byteSize: body.byteLength,
      contentType: 'image/png',
      etag: '"relay-etag"',
      versionId: 'relay-version-1',
      checksumSha256: bodySha256,
    });
    const app = await build({
      media: mediaRepository({
        getFinalizeTarget: vi.fn().mockResolvedValue({
          outcome: 'inspect',
          objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
          conversationId,
          declaredContentType: 'image/png',
          declaredByteSize: body.byteLength,
          declaredSha256: bodySha256,
        }),
      }),
      store: objectStore({ putSourceObject, inspectCurrentVersion }),
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'android',
        'idempotency-key': 'chat-media-relay-0001',
        'content-type': 'application/octet-stream',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ uploaded: true });
    expect(putSourceObject).toHaveBeenCalledWith({
      objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
      contentType: 'image/png',
      body,
      sha256: bodySha256,
      mediaId,
    });
  });

  it('requires authentication before relaying Android upload bytes', async () => {
    const putSourceObject = vi.fn();
    const getFinalizeTarget = vi.fn();
    const app = await build({
      media: mediaRepository({ getFinalizeTarget }),
      store: objectStore({ putSourceObject }),
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
      headers: {
        'x-app-platform': 'android',
        'idempotency-key': 'chat-media-relay-unauthorized',
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('unauthorized'),
    });

    expect(response.statusCode).toBe(401);
    expect(getFinalizeTarget).not.toHaveBeenCalled();
    expect(putSourceObject).not.toHaveBeenCalled();
  });

  it('stops excess Android relay attempts at onRequest before object storage', async () => {
    const body = Buffer.alloc(1_024, 7);
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const putSourceObject = vi.fn().mockResolvedValue(undefined);
    const inspectCurrentVersion = vi.fn().mockResolvedValue({
      byteSize: body.byteLength,
      contentType: 'image/png',
      etag: 'relay-etag',
      versionId: 'relay-version-1',
      checksumSha256: bodySha256,
    });
    const app = await build({
      media: mediaRepository({
        getFinalizeTarget: vi.fn().mockResolvedValue({
          outcome: 'inspect',
          objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
          conversationId,
          declaredContentType: 'image/png',
          declaredByteSize: body.byteLength,
          declaredSha256: bodySha256,
        }),
      }),
      store: objectStore({ putSourceObject, inspectCurrentVersion }),
    });
    const request = {
      method: 'PUT' as const,
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'android',
        'idempotency-key': 'chat-media-relay-rate-limit',
        'content-type': 'application/octet-stream',
      },
      payload: body,
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await app.inject(request)).statusCode).toBe(201);
    }
    const limited = await app.inject({
      ...request,
      // A rotated JWT for the same account must remain in the principal's limiter bucket.
      headers: { ...request.headers, authorization: `Bearer ${await accessToken(['games.play'])}` },
    });

    expect(limited.statusCode).toBe(429);
    expect(putSourceObject).toHaveBeenCalledTimes(4);
  });

  it('does not touch storage when a formerly valid uploader lost conversation access', async () => {
    const putSourceObject = vi.fn();
    const app = await build({
      media: mediaRepository({
        // The repository performs the same-transaction OPEN/active-member check before returning
        // a target, so this is the route-level representation of a revoked member or closed chat.
        getFinalizeTarget: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
      }),
      store: objectStore({ putSourceObject }),
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'android',
        'idempotency-key': 'chat-media-relay-revoked',
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('revoked'),
    });

    expect(response.statusCode).toBe(404);
    expect(putSourceObject).not.toHaveBeenCalled();
  });

  it('rejects non-Android, mismatched, expired and foreign-conversation relay uploads before storage', async () => {
    const body = Buffer.from('android-upload');
    const putSourceObject = vi.fn();
    const getFinalizeTarget = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'inspect',
        objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
        conversationId,
        declaredContentType: 'image/png',
        declaredByteSize: body.byteLength,
        declaredSha256: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({ outcome: 'upload_expired' })
      .mockResolvedValueOnce({
        outcome: 'inspect',
        objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
        conversationId: '33333333-3333-4333-8333-333333333333',
        declaredContentType: 'image/png',
        declaredByteSize: body.byteLength,
        declaredSha256: createHash('sha256').update(body).digest('hex'),
      })
      .mockResolvedValueOnce({ outcome: 'not_found' });
    const app = await build({
      media: mediaRepository({ getFinalizeTarget }),
      store: objectStore({ putSourceObject }),
    });
    const base = {
      method: 'PUT' as const,
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-media-relay-0002',
        'content-type': 'application/octet-stream',
      },
      payload: body,
    };
    const browser = await app.inject(base);
    const mismatch = await app.inject({
      ...base,
      headers: { ...base.headers, 'x-app-platform': 'android' },
    });
    const expired = await app.inject({
      ...base,
      headers: { ...base.headers, 'x-app-platform': 'android' },
    });
    const foreign = await app.inject({
      ...base,
      headers: { ...base.headers, 'x-app-platform': 'android' },
    });
    const foreignUploader = await app.inject({
      ...base,
      headers: {
        ...base.headers,
        authorization: `Bearer ${await accessToken(
          ['games.play'],
          '99999999-9999-4999-8999-999999999999',
        )}`,
        'x-app-platform': 'android',
      },
    });

    expect(browser.statusCode).toBe(400);
    expect(mismatch.statusCode).toBe(422);
    expect(expired.statusCode).toBe(409);
    expect(foreign.statusCode).toBe(404);
    expect(foreignUploader.statusCode).toBe(404);
    expect(putSourceObject).not.toHaveBeenCalled();
  });

  it('reconciles a failed immutable relay write by inspecting the exact stored version', async () => {
    const body = Buffer.from('android-upload');
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const putSourceObject = vi.fn().mockRejectedValue(new Error('timeout'));
    const inspectCurrentVersion = vi.fn().mockResolvedValue({
      byteSize: body.byteLength,
      contentType: 'image/png',
      etag: '"relay-etag"',
      versionId: 'relay-version-1',
      checksumSha256: bodySha256,
    });
    const app = await build({
      media: mediaRepository({
        getFinalizeTarget: vi.fn().mockResolvedValue({
          outcome: 'inspect',
          objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
          conversationId,
          declaredContentType: 'image/png',
          declaredByteSize: body.byteLength,
          declaredSha256: bodySha256,
        }),
      }),
      store: objectStore({ putSourceObject, inspectCurrentVersion }),
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/bytes`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'android',
        'idempotency-key': 'chat-media-relay-0003',
        'content-type': 'application/octet-stream',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-idempotent-replayed']).toBe('true');
    expect(putSourceObject).toHaveBeenCalledTimes(1);
    expect(inspectCurrentVersion).toHaveBeenCalledTimes(1);
  });

  it('refuses content a browser would execute and any unrecognised image type', async () => {
    const issueUpload = vi.fn().mockResolvedValue({ outcome: 'not_found' });
    const media = mediaRepository({ issueUpload });
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
    expect(issueUpload).not.toHaveBeenCalled();
  });

  it('refuses a path-like file name and an over-limit byte size', async () => {
    const issueUpload = vi.fn().mockResolvedValue({ outcome: 'not_found' });
    const media = mediaRepository({ issueUpload });
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
    expect(issueUpload).not.toHaveBeenCalled();
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

  it('does not finalize after access is revoked between inspection and the final transaction', async () => {
    const finalizeUpload = vi.fn().mockResolvedValue({ outcome: 'not_found' });
    const app = await build({ media: mediaRepository({ finalizeUpload }) });
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/finalize`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'chat-media-finalize-revoked',
      },
      payload: { declaredByteSize: 1_024 },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_NOT_FOUND' });
    expect(finalizeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId, mediaId, actorUserId: userId }),
    );
  });

  it('hands a reader a short-lived redirect instead of an object key', async () => {
    const createDeliveryUrl = vi.fn().mockResolvedValue('https://storage.example.test/signed');
    const store = objectStore({ createDeliveryUrl });
    const app = await build({ store });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://storage.example.test/signed');
    expect(createDeliveryUrl).toHaveBeenCalledWith({
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

  it('relays authorized Android media bytes without a storage redirect', async () => {
    const readDelivery = vi.fn().mockResolvedValue(Buffer.from('ready-image'));
    const createDeliveryUrl = vi.fn();
    const app = await build({ store: objectStore({ readDelivery, createDeliveryUrl }) });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}`, 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ready-image');
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(readDelivery).toHaveBeenCalledWith({
      delivery: {
        objectKey: `chat-media/ready/${tenantId}/${conversationId}/${mediaId}/content`,
        objectVersion: 'ready-version-1',
        fileName: 'photo.png',
        contentType: 'image/png',
        inline: true,
      },
      maxBytes: 1_024,
    });
    expect(createDeliveryUrl).not.toHaveBeenCalled();
  });

  it('shares the early Android read limit across rotated tokens before storage', async () => {
    const readDelivery = vi.fn().mockResolvedValue(Buffer.from('ready-image'));
    const app = await build({ store: objectStore({ readDelivery }) });
    const token = await accessToken();
    const rotated = await accessToken(['chat.direct.create', 'notification.read']);
    expect(rotated).not.toBe(token);
    const request = {
      method: 'GET' as const,
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${token}`, 'x-app-platform': 'android' },
    };
    for (let i = 0; i < 60; i++) expect((await app.inject(request)).statusCode).toBe(200);
    const limited = await app.inject({
      ...request,
      headers: { ...request.headers, authorization: `Bearer ${rotated}` },
    });
    expect(limited.statusCode).toBe(429);
    expect(readDelivery).toHaveBeenCalledTimes(60);
  });

  it('rejects excess concurrent Android reads before allocating another storage buffer', async () => {
    const complete: ((body: Buffer) => void)[] = [];
    const readDelivery = vi.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          complete.push(resolve);
        }),
    );
    const app = await build({ store: objectStore({ readDelivery }) });
    const token = await accessToken();
    const request = {
      method: 'GET' as const,
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${token}`, 'x-app-platform': 'android' },
    };
    const inFlight = Array.from({ length: 4 }, () =>
      app.inject(request).then((response) => response),
    );
    await vi.waitFor(() => expect(readDelivery).toHaveBeenCalledTimes(4));
    expect((await app.inject(request)).statusCode).toBe(429);
    expect(readDelivery).toHaveBeenCalledTimes(4);
    for (const resolve of complete) resolve(Buffer.from('ready-image'));
    expect((await Promise.all(inFlight)).every((response) => response.statusCode === 200)).toBe(
      true,
    );
    readDelivery.mockImplementation(() => Promise.resolve(Buffer.from('ready-image')));
    expect((await app.inject(request)).statusCode).toBe(200);
  });

  it('hides a message attachment from a reader without an active membership', async () => {
    const createDeliveryUrl = vi.fn().mockResolvedValue('https://storage.example.test/signed');
    const readDelivery = vi.fn();
    const store = objectStore({ createDeliveryUrl, readDelivery });
    const app = await build({
      store,
      messages: messageRepository({
        getMessageMediaForViewer: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/conversations/${conversationId}/media/${mediaId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}`, 'x-app-platform': 'android' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MESSAGING_MEDIA_NOT_FOUND' });
    expect(createDeliveryUrl).not.toHaveBeenCalled();
    expect(readDelivery).not.toHaveBeenCalled();
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
      messages: messageRepository({ sendMessage }),
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
      messages: messageRepository({ sendMessage }),
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
      }),
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
