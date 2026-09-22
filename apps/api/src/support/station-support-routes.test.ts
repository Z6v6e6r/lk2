import type { LocationRepository, StationSupportRepository } from '@phub/database';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import type {
  StationSupportProvider,
  StationSupportProviderDialog,
  StationSupportProviderMessage,
} from './station-support-provider.js';
import { StationSupportProviderError } from './station-support-provider.js';
import { stationSupportExternalMessageId } from './station-support-routes.js';

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
    .setSubject(userId)
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
    text: 'Добрый день! Корт свободен в 19:00.',
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
}) {
  const app = await buildApp({
    config: overrides.config ?? baseConfig,
    logger: createLogger('station-support-api-test', 'silent'),
    pool: fakePool(),
    stationSupportProvider: overrides.provider ?? provider(),
    stationSupportRepository: overrides.repository ?? repository(),
    locationRepository: locations() as LocationRepository,
  });
  apps.push(app);
  return app;
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

async function publicDialogId(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/user/api/v1/local-padel/support/dialogs',
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  return response.json<{ items: { id: string }[] }>().items[0]!.id;
}
