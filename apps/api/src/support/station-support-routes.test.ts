import type { LocationRepository } from '@phub/database';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import sharp from 'sharp';

import { buildApp } from '../app.js';
import type {
  StationSupportProvider,
  StationSupportProviderDialog,
  StationSupportProviderMessage,
} from './station-support-provider.js';
import { StationSupportProviderError } from './station-support-provider.js';
import type { StationSupportRepository } from './station-support-repository.js';
import { stationSupportExternalMessageId } from './station-support-routes.js';
import {
  stationSupportAttachmentId,
  stationSupportMediaObjectKey,
  type StationSupportMediaStore,
} from './station-support-media.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-9a6b-4f2d-8d3c-1f0f5c3b9a11';
const stationId = '9b993668-ff54-4cce-8dfd-cad84c4a06fa';
const legacyStationId = 'Yasenevo';
const dialogId = 'dialog-1';
const idempotencyKey = 'station-message-000001';
const providerMessageId = stationSupportExternalMessageId(tenantId, userId, idempotencyKey);

const baseConfig = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  SUPPORT_STATIONS_ENABLED: 'true',
  SUPPORT_LEGACY_BASE_URL: 'https://support.padlhub.test/lk/support',
});

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
  subject: string = userId,
): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(baseConfig.JWT_ISSUER)
    .setAudience(baseConfig.JWT_AUDIENCE)
    .setSubject(subject)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(baseConfig.JWT_ACCESS_SECRET));
}

function providerDialog(
  overrides: Partial<StationSupportProviderDialog> = {},
): StationSupportProviderDialog {
  return {
    dialogId,
    stationId: legacyStationId,
    stationName: 'Ясенево',
    status: 'OPEN',
    updatedAt: '2026-09-22T10:00:00.000Z',
    updatedTs: 1_758_532_800_000,
    lastMessage: {
      preview: 'Когда свободен корт?',
      direction: 'INBOUND',
      authorType: 'CLIENT',
      createdAt: '2026-09-22T10:00:00.000Z',
      createdTs: 1_758_532_800_000,
    },
    ...overrides,
  };
}

function providerMessage(
  overrides: Partial<StationSupportProviderMessage> = {},
): StationSupportProviderMessage {
  return {
    messageId: 'message-1',
    dialogId,
    direction: 'OUTBOUND',
    authorType: 'ADMIN',
    senderName: 'Поддержка ПадлХАБ',
    text: 'Добрый день! Корт свободен в 19:00.',
    attachments: [],
    createdAt: '2026-09-22T10:05:00.000Z',
    createdTs: 1_758_532_800_001,
    externalMessageId: null,
    ...overrides,
  };
}

function provider(overrides: Partial<StationSupportProvider> = {}): StationSupportProvider {
  return {
    listDialogs: vi.fn().mockResolvedValue([providerDialog()]),
    listMessages: vi.fn().mockResolvedValue([providerMessage()]),
    sendEvent: vi.fn().mockResolvedValue({ dialogId }),
    ...overrides,
  };
}

function repository(overrides: Partial<StationSupportRepository> = {}): StationSupportRepository {
  return {
    readViewerIdentity: vi
      .fn()
      .mockResolvedValue({ providerPhoneE164: '+79990000001', verifiedPhoneE164: '+79990000001' }),
    readLegacyStationExternalId: vi.fn().mockResolvedValue(legacyStationId),
    readStationIdsByLegacyExternalIds: vi
      .fn()
      .mockResolvedValue(new Map([[legacyStationId, stationId]])),
    ...overrides,
  };
}

function locations(): Pick<LocationRepository, 'listPublished'> {
  return {
    listPublished: vi.fn().mockResolvedValue([
      {
        id: stationId,
        title: 'Ясенево',
        slug: 'yasenevo',
        city: 'Москва',
      },
    ]),
  };
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function build(overrides: {
  readonly provider?: StationSupportProvider;
  readonly repository?: StationSupportRepository;
  readonly config?: typeof baseConfig;
  readonly mediaStore?: StationSupportMediaStore;
  readonly mediaAllowedHosts?: readonly string[];
}) {
  const app = await buildApp({
    config: overrides.config ?? baseConfig,
    logger: createLogger('station-support-api-test', 'silent'),
    pool: fakePool(),
    stationSupportProvider: overrides.provider ?? provider(),
    stationSupportRepository: overrides.repository ?? repository(),
    locationRepository: locations() as LocationRepository,
    ...(overrides.mediaStore ? { stationSupportMediaStore: overrides.mediaStore } : {}),
    ...(overrides.mediaAllowedHosts
      ? { stationSupportMediaAllowedHosts: overrides.mediaAllowedHosts }
      : {}),
  });
  apps.push(app);
  return app;
}

/** The bucket is faked: the tests own the bytes and never touch object storage. */
function mediaStore(stored: Map<string, { body: Buffer; fileName: string | null }> = new Map()): {
  readonly store: StationSupportMediaStore;
  readonly stored: Map<string, { body: Buffer; fileName: string | null }>;
} {
  const store: StationSupportMediaStore = {
    putWebp: vi.fn((input: Parameters<StationSupportMediaStore['putWebp']>[0]) => {
      stored.set(input.objectKey, { body: input.body, fileName: input.fileName });
      return Promise.resolve();
    }),
    stat: vi.fn((objectKey: string) => {
      const entry = stored.get(objectKey);
      return Promise.resolve(
        entry ? { byteSize: entry.body.byteLength, fileName: entry.fileName } : undefined,
      );
    }),
    read: vi.fn((objectKey: string) => {
      const entry = stored.get(objectKey);
      return entry
        ? Promise.resolve(entry.body)
        : Promise.reject(new Error('STATION_SUPPORT_MEDIA_NOT_FOUND'));
    }),
    createDeliveryUrl: vi.fn(
      (input: Parameters<StationSupportMediaStore['createDeliveryUrl']>[0]) =>
        Promise.resolve(`https://media.test/${input.objectKey}?sig=1`),
    ),
  };
  return { store, stored };
}

async function jpegBytes(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: '#8766eb' } })
    .jpeg()
    .toBuffer();
}

async function uploadPicture(
  app: Awaited<ReturnType<typeof buildApp>>,
  fileName = 'корт.png',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/user/api/v1/local-padel/support/attachments',
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': 'station-attachment-000001',
    },
    payload: {
      fileName,
      contentType: 'image/jpeg',
      data: (await jpegBytes()).toString('base64'),
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ id: string }>().id;
}

describe('station support routes', () => {
  it('rejects an unauthenticated request before consulting the provider', async () => {
    const listDialogs = vi.fn();
    const app = await build({ provider: provider({ listDialogs }) });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/dialogs',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(listDialogs).not.toHaveBeenCalled();
  });

  it('keeps the whole station surface closed while the flag is off', async () => {
    const disabledConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    });
    const listDialogs = vi.fn();
    const app = await build({
      config: disabledConfig,
      provider: provider({ listDialogs }),
    });
    const dialogs = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/dialogs',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(dialogs.statusCode).toBe(404);
    expect(dialogs.json()).toMatchObject({ code: 'SUPPORT_STATIONS_DISABLED' });
    const stations = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/stations',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(stations.statusCode).toBe(404);
    expect(stations.json()).toMatchObject({ code: 'SUPPORT_STATIONS_DISABLED' });
    expect(listDialogs).not.toHaveBeenCalled();
  });

  it('requires the chat permission and an idempotency key for a station message', async () => {
    const sendEvent = vi.fn();
    const app = await build({ provider: provider({ sendEvent }) });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken(['profile.read'])}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'CHAT_PERMISSION_REQUIRED' });

    const missingKey = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: { authorization: `Bearer ${await accessToken()}` },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('lists station dialogs with derived public ids and no provider identifiers', async () => {
    const app = await build({});
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/dialogs',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: {
        id: string;
        stationId: string | null;
        stationName: string;
        lastMessage: { preview: string; author: string } | null;
      }[];
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      stationId,
      stationName: 'Ясенево',
      lastMessage: { preview: 'Когда свободен корт?', author: 'ME' },
    });
    expect(body.items[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(body)).not.toContain(dialogId);
  });

  it('maps an unassigned provider station to a null PadlHub station', async () => {
    const app = await build({
      provider: provider({
        listDialogs: vi
          .fn()
          .mockResolvedValue([
            providerDialog({ stationId: 'UNASSIGNED', stationName: 'Без станции' }),
          ]),
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/dialogs',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { stationId: string | null }[] }>().items[0]?.stationId).toBe(
      null,
    );
  });

  it('fails closed when the viewer has no linked phone', async () => {
    const listDialogs = vi.fn();
    const app = await build({
      repository: repository({
        readViewerIdentity: vi
          .fn()
          .mockResolvedValue({ providerPhoneE164: null, verifiedPhoneE164: null }),
      }),
      provider: provider({ listDialogs }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/dialogs',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'SUPPORT_IDENTITY_NOT_LINKED' });
    expect(listDialogs).not.toHaveBeenCalled();
  });

  it('refuses a dialog the caller does not own and reports an unavailable provider as 503', async () => {
    const app = await build({});
    const unknown = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/dialogs/${stationId}/messages`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'SUPPORT_DIALOG_NOT_FOUND' });

    const failing = await build({
      provider: provider({
        listMessages: vi
          .fn()
          .mockRejectedValue(new StationSupportProviderError('SUPPORT_PROVIDER_UNAVAILABLE')),
      }),
    });
    const list = await failing.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/dialogs/${await publicDialogId(app)}/messages`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(list.statusCode).toBe(503);
    expect(list.json()).toMatchObject({ code: 'SUPPORT_PROVIDER_UNAVAILABLE' });
  });

  it('sends a station message idempotently and returns the stored message', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ dialogId });
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        providerMessage({
          direction: 'INBOUND',
          authorType: 'CLIENT',
          text: 'Здравствуйте',
          externalMessageId: providerMessageId,
        }),
      ]);
    const app = await build({ provider: provider({ sendEvent, listMessages }) });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: '  Здравствуйте  ' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      dialogId: string;
      replayed: boolean;
      message: { body: string; author: string };
    }>();
    expect(body.replayed).toBe(false);
    expect(body.message).toMatchObject({ body: 'Здравствуйте', author: 'ME' });
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneDigits: '79990000001',
        stationId: legacyStationId,
        stationName: 'Ясенево',
        text: 'Здравствуйте',
        externalMessageId: providerMessageId,
        externalUserId: userId,
      }),
    );
  });

  it('replays an already accepted command without calling the provider again', async () => {
    const sendEvent = vi.fn();
    const app = await build({
      provider: provider({
        sendEvent,
        listMessages: vi.fn().mockResolvedValue([
          providerMessage({
            direction: 'INBOUND',
            authorType: 'CLIENT',
            text: 'Здравствуйте',
            externalMessageId: providerMessageId,
          }),
        ]),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('recovers an ambiguous write by reading the provider before reporting failure', async () => {
    const sendEvent = vi
      .fn()
      .mockRejectedValue(new StationSupportProviderError('SUPPORT_PROVIDER_TIMEOUT'));
    const listMessages = vi.fn().mockResolvedValue([
      providerMessage({
        direction: 'INBOUND',
        authorType: 'CLIENT',
        text: 'Здравствуйте',
        externalMessageId: providerMessageId,
      }),
    ]);
    const recovered = await build({ provider: provider({ sendEvent, listMessages }) });
    const response = await recovered.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ replayed: boolean }>().replayed).toBe(true);

    const lost = await build({
      provider: provider({
        sendEvent,
        listMessages: vi.fn().mockResolvedValue([]),
      }),
    });
    const failed = await lost.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'SUPPORT_PROVIDER_UNAVAILABLE' });
  });

  it('validates the message target and text', async () => {
    const sendEvent = vi.fn();
    const app = await build({ provider: provider({ sendEvent }) });
    const authorization = `Bearer ${await accessToken()}`;
    const both = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: { authorization, 'idempotency-key': idempotencyKey },
      payload: { stationId, dialogId: stationId, text: 'Здравствуйте' },
    });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toMatchObject({ code: 'SUPPORT_MESSAGE_INVALID' });

    const empty = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: { authorization, 'idempotency-key': idempotencyKey },
      payload: { stationId, text: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: { authorization, 'idempotency-key': idempotencyKey },
      payload: { stationId, text: 'я'.repeat(4_001) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('refuses a station that has no legacy binding', async () => {
    const sendEvent = vi.fn();
    const app = await build({
      repository: repository({ readLegacyStationExternalId: vi.fn().mockResolvedValue(null) }),
      provider: provider({ sendEvent }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'SUPPORT_STATION_NOT_BOUND' });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('prefers the verified login phone over the provider-asserted phone', async () => {
    const listDialogs = vi.fn().mockResolvedValue([providerDialog()]);
    const sendEvent = vi.fn().mockResolvedValue({ dialogId });
    const app = await build({
      repository: repository({
        readViewerIdentity: vi.fn().mockResolvedValue({
          providerPhoneE164: '+79990000001',
          verifiedPhoneE164: '+79990000002',
        }),
      }),
      provider: provider({ listDialogs, sendEvent }),
    });
    const authorization = `Bearer ${await accessToken()}`;
    await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/dialogs',
      headers: { authorization },
    });
    expect(listDialogs).toHaveBeenCalledWith(
      expect.objectContaining({ phoneDigits: '79990000002' }),
    );
    await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: { authorization, 'idempotency-key': idempotencyKey },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ phoneDigits: '79990000002' }));
    expect(sendEvent.mock.calls[0]?.[0]).not.toHaveProperty('additionalPhoneDigits');
  });

  it('refuses to write into a closed dialog', async () => {
    const sendEvent = vi.fn();
    const app = await build({
      provider: provider({
        listDialogs: vi.fn().mockResolvedValue([providerDialog({ status: 'CLOSED' })]),
        sendEvent,
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { dialogId: await publicDialogId(app), text: 'Здравствуйте' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'SUPPORT_DIALOG_CLOSED' });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('rejects the same idempotency key used for a different command', async () => {
    const sendEvent = vi.fn();
    const app = await build({
      provider: provider({
        sendEvent,
        listMessages: vi.fn().mockResolvedValue([
          providerMessage({
            direction: 'INBOUND',
            authorType: 'CLIENT',
            text: 'Другой текст',
            externalMessageId: providerMessageId,
          }),
        ]),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('maps a refused command to an explicit rejection instead of an outage', async () => {
    const app = await build({
      provider: provider({
        sendEvent: vi
          .fn()
          .mockRejectedValue(new StationSupportProviderError('SUPPORT_PROVIDER_REJECTED')),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'SUPPORT_MESSAGE_REJECTED' });
  });

  it('recovers a new-dialog write that answered without a dialog id', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ dialogId: null });
    const listMessages = vi.fn().mockResolvedValue([
      providerMessage({
        direction: 'INBOUND',
        authorType: 'CLIENT',
        text: 'Здравствуйте',
        externalMessageId: providerMessageId,
      }),
    ]);
    const app = await build({ provider: provider({ sendEvent, listMessages }) });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Здравствуйте' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ replayed: boolean; message: { body: string } }>();
    expect(body.replayed).toBe(true);
    expect(body.message.body).toBe('Здравствуйте');
  });

  it('bounds the dialog list to the published contract maximum', async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      providerDialog({ dialogId: `dialog-${index}`, updatedTs: index }),
    );
    const app = await build({
      provider: provider({ listDialogs: vi.fn().mockResolvedValue(many) }),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/dialogs',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: { id: string }[] }>().items;
    expect(items).toHaveLength(200);
    expect(new Set(items.map((item) => item.id)).size).toBe(200);
  });
});

describe('station support pictures', () => {
  const pngDataUrl = (): string =>
    `data:image/png;base64,${Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ).toString('base64')}`;

  it('stores an operator picture as a WebP object instead of exposing the provider value', async () => {
    const { store, stored } = mediaStore();
    const app = await build({
      mediaStore: store,
      provider: provider({
        listMessages: vi.fn().mockResolvedValue([
          providerMessage({
            text: '',
            senderName: 'ПадлХАБ • Супервайзер',
            attachments: [
              {
                type: 'IMAGE',
                url: pngDataUrl(),
                name: 'мяч.png',
                mimeType: 'image/png',
                size: 70,
              },
            ],
          }),
        ]),
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/dialogs/${await publicDialogId(app)}/messages`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: {
        authorName: string | null;
        attachments: { id: string; fileName: string; contentType: string; url: string }[];
      }[];
    }>();
    const message = body.items[0]!;
    expect(message.authorName).toBe('ПадлХАБ • Супервайзер');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      fileName: 'мяч.png',
      contentType: 'image/webp',
    });
    expect(message.attachments[0]?.url).toBe(
      `/user/api/v1/local-padel/support/attachments/${message.attachments[0]?.id}/content`,
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('iVBORw0KGgo');
    expect(stored.size).toBe(1);
    const [objectKey] = [...stored.keys()];
    expect(objectKey).toMatch(
      new RegExp(`^station-support/${tenantId}/${userId}/[0-9a-f]{64}\\.webp$`),
    );
    expect(stored.get(objectKey!)?.body.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('keeps a message readable when the provider links a picture the deployment does not allow', async () => {
    const { store, stored } = mediaStore();
    const app = await build({
      mediaStore: store,
      mediaAllowedHosts: ['support.padlhub.test'],
      provider: provider({
        listMessages: vi.fn().mockResolvedValue([
          providerMessage({
            text: 'Смотрите',
            attachments: [
              {
                type: 'IMAGE',
                url: 'http://support.padlhub.test/photo.png',
                name: 'photo.png',
                mimeType: 'image/png',
                size: 10,
              },
            ],
          }),
        ]),
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/dialogs/${await publicDialogId(app)}/messages`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ items: { body: string; attachments: unknown[] }[] }>().items[0],
    ).toMatchObject({
      body: 'Смотрите',
      attachments: [],
    });
    expect(stored.size).toBe(0);
  });

  it('serves a stored picture only to the caller whose key holds it', async () => {
    const { store } = mediaStore();
    const app = await build({ mediaStore: store });
    const attachmentId = await uploadPicture(app);
    const delivered = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(delivered.statusCode).toBe(302);
    expect(delivered.headers.location).toContain(`station-support/${tenantId}/${userId}/`);

    const unknown = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/attachments/${stationSupportAttachmentId('a'.repeat(64))}/content`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'SUPPORT_ATTACHMENT_NOT_FOUND' });

    const malformed = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/support/attachments/not-an-id/content',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(malformed.statusCode).toBe(404);
  });

  it('refuses an upload that is not a decodable JPEG, PNG or WebP', async () => {
    const { store } = mediaStore();
    const app = await build({ mediaStore: store });
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': 'station-attachment-000002',
    };
    const notAnImage = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/attachments',
      headers,
      payload: {
        fileName: 'заметка.png',
        contentType: 'image/png',
        data: Buffer.from('not really an image').toString('base64'),
      },
    });
    expect(notAnImage.statusCode).toBe(422);
    expect(notAnImage.json()).toMatchObject({ code: 'SUPPORT_ATTACHMENT_REJECTED' });

    const refusedType = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/attachments',
      headers,
      payload: {
        fileName: 'договор.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('pdf').toString('base64'),
      },
    });
    expect(refusedType.statusCode).toBe(400);
    expect(refusedType.json()).toMatchObject({ code: 'SUPPORT_ATTACHMENT_INVALID' });

    const undeclaredKey = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/attachments',
      headers,
      payload: {
        fileName: 'корт.png',
        contentType: 'image/png',
        data: Buffer.from('abc').toString('base64'),
        stationId,
      },
    });
    expect(undeclaredKey.statusCode).toBe(400);
  });

  it('forwards a viewer picture to the CUP ingest as inline WebP and refuses an unknown id', async () => {
    const { store } = mediaStore();
    const sendEvent = vi.fn().mockResolvedValue({ dialogId });
    const app = await build({
      mediaStore: store,
      provider: provider({
        sendEvent,
        // The first read is the replay probe before the write; the second reads the stored message.
        listMessages: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            providerMessage({
              direction: 'INBOUND',
              authorType: 'CLIENT',
              text: 'Фото: корт.png',
              externalMessageId: providerMessageId,
              attachments: [
                {
                  type: 'IMAGE',
                  url: 'data:image/webp;base64,AAAA',
                  name: 'корт.png',
                  mimeType: 'image/webp',
                  size: 4,
                },
              ],
            }),
          ]),
      }),
    });
    const attachmentId = await uploadPicture(app, 'корт.png');
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: '', attachmentIds: [attachmentId] },
    });
    expect(response.statusCode).toBe(200);
    const sent = sendEvent.mock.calls[0]?.[0] as {
      text: string;
      attachments?: {
        type: string;
        url: string;
        name?: string;
        mimeType?: string;
        size?: number;
      }[];
    };
    expect(sent.text).toBe('Фото: корт.png');
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0]).toMatchObject({
      type: 'IMAGE',
      name: 'корт.png',
      mimeType: 'image/webp',
    });
    expect(sent.attachments?.[0]?.url.startsWith('data:image/webp;base64,')).toBe(true);
    expect(
      response.json<{ message: { attachments: { id: string }[] } }>().message.attachments[0]?.id,
    ).toBe(attachmentId);

    const unknownId = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'station-message-000002',
      },
      payload: {
        stationId,
        text: 'Здравствуйте',
        attachmentIds: [stationSupportAttachmentId('b'.repeat(64))],
      },
    });
    expect(unknownId.statusCode).toBe(409);
    expect(unknownId.json()).toMatchObject({ code: 'SUPPORT_ATTACHMENT_NOT_FOUND' });
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });

  it('treats a replay with a different picture set as a reused key', async () => {
    const { store, stored } = mediaStore();
    const objectKey = stationSupportMediaObjectKey(tenantId, userId, 'c'.repeat(64));
    stored.set(objectKey, { body: Buffer.from('webp-bytes'), fileName: 'корт.png' });
    const sendEvent = vi.fn();
    const app = await build({
      mediaStore: store,
      provider: provider({
        sendEvent,
        listMessages: vi.fn().mockResolvedValue([
          providerMessage({
            direction: 'INBOUND',
            authorType: 'CLIENT',
            text: 'Фото: другое.png',
            externalMessageId: providerMessageId,
            attachments: [
              {
                type: 'IMAGE',
                url: 'data:image/webp;base64,AAAA',
                name: 'другое.png',
                mimeType: 'image/webp',
                size: 4,
              },
            ],
          }),
        ]),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        stationId,
        text: 'Фото: корт.png',
        attachmentIds: [stationSupportAttachmentId('c'.repeat(64))],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('never serves one viewer the picture stored for another viewer', async () => {
    const { store } = mediaStore();
    const app = await build({ mediaStore: store });
    const attachmentId = await uploadPicture(app);

    const owner = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(owner.statusCode).toBe(302);

    const other = '11111111-1111-4111-8111-111111111111';
    const foreign = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${await accessToken(undefined, other)}` },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'SUPPORT_ATTACHMENT_NOT_FOUND' });
  });

  it('refuses the same picture twice and an aggregate above one inline payload', async () => {
    const { store } = mediaStore();
    const app = await build({ mediaStore: store });
    const attachmentId = await uploadPicture(app);

    const duplicated = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { stationId, text: 'Две одинаковые', attachmentIds: [attachmentId, attachmentId] },
    });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json()).toMatchObject({ code: 'SUPPORT_MESSAGE_INVALID' });

    const heavy = mediaStore();
    const heavyApp = await build({ mediaStore: heavy.store });
    // Two pictures whose forwarded base64 cannot fit one inline payload together.
    const firstHash = 'd'.repeat(64);
    const secondHash = 'e'.repeat(64);
    heavy.stored.set(stationSupportMediaObjectKey(tenantId, userId, firstHash), {
      body: Buffer.alloc(1_600_000, 1),
      fileName: 'первое.webp',
    });
    heavy.stored.set(stationSupportMediaObjectKey(tenantId, userId, secondHash), {
      body: Buffer.alloc(1_600_000, 2),
      fileName: 'второе.webp',
    });
    const tooHeavy = await heavyApp.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        stationId,
        text: '',
        attachmentIds: [
          stationSupportAttachmentId(firstHash),
          stationSupportAttachmentId(secondHash),
        ],
      },
    });
    expect(tooHeavy.statusCode).toBe(400);
    expect(tooHeavy.json()).toMatchObject({ code: 'SUPPORT_ATTACHMENT_TOO_LARGE' });
  });

  it('detects a reused key that carries different bytes under the same name and size', async () => {
    const { store, stored } = mediaStore();
    const sha256 = 'f'.repeat(64);
    const objectKey = stationSupportMediaObjectKey(tenantId, userId, sha256);
    stored.set(objectKey, { body: Buffer.from('current-picture'), fileName: 'корт.png' });
    const sendEvent = vi.fn();
    const app = await build({
      mediaStore: store,
      provider: provider({
        sendEvent,
        listMessages: vi.fn().mockResolvedValue([
          providerMessage({
            direction: 'INBOUND',
            authorType: 'CLIENT',
            text: 'Фото: корт.png',
            externalMessageId: providerMessageId,
            // The provider stored a *different* picture, so the sigil list alone cannot tell them
            // apart: only the exact content can.
            attachments: [
              {
                type: 'IMAGE',
                url: `data:image/webp;base64,${Buffer.from('other-picture!!!').toString('base64')}`,
                name: 'корт.png',
                mimeType: 'image/webp',
                size: 15,
              },
            ],
          }),
        ]),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        stationId,
        text: 'Фото: корт.png',
        attachmentIds: [stationSupportAttachmentId(sha256)],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('replays a delivered picture when the provider re-hosted it instead of echoing it', async () => {
    const { store, stored } = mediaStore();
    const sha256 = 'a'.repeat(63) + 'b';
    stored.set(stationSupportMediaObjectKey(tenantId, userId, sha256), {
      body: Buffer.from('stored-picture'),
      fileName: 'корт.png',
    });
    const sendEvent = vi.fn();
    const app = await build({
      mediaStore: store,
      provider: provider({
        sendEvent,
        listMessages: vi.fn().mockResolvedValue([
          providerMessage({
            direction: 'INBOUND',
            authorType: 'CLIENT',
            text: 'Фото: корт.png',
            externalMessageId: providerMessageId,
            attachments: [
              {
                type: 'IMAGE',
                url: 'https://cdn.example/photo.webp',
                name: 'корт.png',
                mimeType: 'image/webp',
                size: 14,
              },
            ],
          }),
        ]),
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/messages',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        stationId,
        text: 'Фото: корт.png',
        attachmentIds: [stationSupportAttachmentId(sha256)],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('keeps the surface text-only when the deployment has no media bucket', async () => {
    const app = await build({});
    const upload = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/support/attachments',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'station-attachment-000003',
      },
      payload: { fileName: 'корт.png', contentType: 'image/png', data: 'AAAA' },
    });
    expect(upload.statusCode).toBe(503);
    expect(upload.json()).toMatchObject({ code: 'SUPPORT_ATTACHMENTS_UNAVAILABLE' });

    const messages = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/support/dialogs/${await publicDialogId(app)}/messages`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json<{ items: { attachments: unknown[] }[] }>().items[0]?.attachments).toEqual(
      [],
    );
  });
});

async function publicDialogId(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/user/api/v1/local-padel/support/dialogs',
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  return response.json<{ items: { id: string }[] }>().items[0]!.id;
}
