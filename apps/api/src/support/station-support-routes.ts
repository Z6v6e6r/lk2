import type { LocationRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { createHash } from 'node:crypto';

import { sendApiError } from '../http-errors.js';
import type { StationSupportRepository } from './station-support-repository.js';
import {
  StationSupportProviderError,
  normalizeSupportPhoneDigits,
  type StationSupportProvider,
  type StationSupportProviderDialog,
  type StationSupportProviderMessage,
} from './station-support-provider.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4_000;
const MESSAGE_PAGE_LIMIT = 50;
const MAX_STATION_DIALOGS = 200;
const PHONE_UNLINKED_MESSAGE =
  'К станции можно написать только с привязанным номером телефона. Привяжите номер в профиле.';

/**
 * The provider's dialog and message identifiers stay inside this module. Clients address a dialog by
 * a stable PadlHub UUID derived from the provider id, and the server resolves it by enumerating the
 * caller's own dialogs, so an opaque external id never becomes a public identifier and a caller can
 * never address somebody else's dialog.
 */
function derivedPublicId(tenantId: string, kind: 'dialog' | 'message', providerId: string): string {
  const bytes = createHash('sha256')
    .update(`phub-station-support-v1:${tenantId}:${kind}:${providerId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function author(input: {
  readonly direction: 'INBOUND' | 'OUTBOUND' | 'SYSTEM';
  readonly authorType: string;
}): 'ME' | 'STATION' | 'SYSTEM' {
  if (input.direction === 'SYSTEM') return 'SYSTEM';
  return input.direction === 'INBOUND' && input.authorType.toUpperCase() === 'CLIENT'
    ? 'ME'
    : 'STATION';
}

interface Principal {
  readonly tenantId: string;
  readonly userId: string;
}

function principal(request: FastifyRequest): Principal | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = current.tenantId;
  const userId = current.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function viewDialog(
  tenantId: string,
  dialog: StationSupportProviderDialog,
  stationIds: ReadonlyMap<string, string>,
) {
  return {
    id: derivedPublicId(tenantId, 'dialog', dialog.dialogId),
    stationId: dialog.stationId ? (stationIds.get(dialog.stationId) ?? null) : null,
    stationName: dialog.stationName,
    status: dialog.status,
    updatedAt: dialog.updatedAt,
    lastMessage: dialog.lastMessage
      ? {
          preview: dialog.lastMessage.preview,
          author: author(dialog.lastMessage),
          createdAt: dialog.lastMessage.createdAt,
        }
      : null,
  };
}

function viewMessage(tenantId: string, message: StationSupportProviderMessage) {
  return {
    id: derivedPublicId(tenantId, 'message', message.messageId),
    body: message.text,
    author: author(message),
    createdAt: message.createdAt,
  };
}

/**
 * The provider stores this value on the message and dedupes on it for a short window. Namespacing
 * by tenant and user keeps one client's key from colliding with another's, and hashing keeps the
 * value inside the provider's length budget.
 */
export function stationSupportExternalMessageId(
  tenantId: string,
  userId: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(`phub-station-support-v1:${tenantId}:${userId}:${idempotencyKey}`)
    .digest('hex');
  return `phub:${digest.slice(0, 48)}`;
}

export interface StationSupportRoutesOptions {
  readonly enabled: boolean;
  readonly provider?: StationSupportProvider;
  readonly repository?: StationSupportRepository;
  readonly locationRepository?: Pick<LocationRepository, 'listPublished'>;
  readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  readonly commandHandlers: readonly preHandlerHookHandler[];
}

export function registerStationSupportRoutes(
  app: FastifyInstance,
  options: StationSupportRoutesOptions,
): void {
  const ready = (): boolean =>
    options.enabled &&
    Boolean(options.provider && options.repository && options.locationRepository);

  function disabled(request: FastifyRequest, reply: FastifyReply) {
    return sendApiError(
      request,
      reply,
      404,
      'SUPPORT_STATIONS_DISABLED',
      'Чаты со станциями ещё не включены для этой организации.',
    );
  }

  function conflict(request: FastifyRequest, reply: FastifyReply) {
    return sendApiError(
      request,
      reply,
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key уже использован для другой команды.',
    );
  }

  function providerUnavailable(request: FastifyRequest, reply: FastifyReply) {
    return sendApiError(
      request,
      reply,
      503,
      'SUPPORT_PROVIDER_UNAVAILABLE',
      'Сервис обращений к станциям временно недоступен. Попробуйте позже.',
    );
  }

  /**
   * One phone per request. The verified login phone is the stronger identity and outranks the
   * provider-asserted value, matching the existing legacy bridge. Exactly one number is forwarded so
   * the provider can never be asked to merge two viewers' identities into one client.
   */
  async function resolvePhone(
    request: FastifyRequest,
    reply: FastifyReply,
    current: Principal,
    repository: StationSupportRepository,
  ): Promise<string | null> {
    const identity = await repository.readViewerIdentity({
      tenantId: current.tenantId,
      userId: current.userId,
    });
    const phone =
      normalizeSupportPhoneDigits(identity.verifiedPhoneE164) ??
      normalizeSupportPhoneDigits(identity.providerPhoneE164);
    if (!phone) {
      sendApiError(request, reply, 409, 'SUPPORT_IDENTITY_NOT_LINKED', PHONE_UNLINKED_MESSAGE);
      return null;
    }
    return phone;
  }

  async function loadDialogs(
    current: Principal,
    repository: StationSupportRepository,
    provider: StationSupportProvider,
    correlationId: string,
    phoneDigits: string,
  ) {
    const listed = await provider.listDialogs({ phoneDigits, correlationId });
    // The published contract caps the list at 200, and the reverse station mapping below is capped
    // the same way, so the newest 200 dialogs are selected explicitly instead of truncated later.
    const dialogs = [...listed]
      .sort((left, right) => right.updatedTs - left.updatedTs)
      .slice(0, MAX_STATION_DIALOGS);
    const stationIds = await repository.readStationIdsByLegacyExternalIds({
      tenantId: current.tenantId,
      externalIds: dialogs.flatMap((dialog) => (dialog.stationId ? [dialog.stationId] : [])),
    });
    return { dialogs, stationIds };
  }

  app.get(
    '/user/api/v1/:tenantKey/support/stations',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const locations = await options.locationRepository!.listPublished(current.tenantId, {
        limit: 100,
      });
      return {
        items: locations
          .map((location) => ({ id: location.id, name: location.title }))
          .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU')),
      };
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/support/dialogs',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const phone = await resolvePhone(request, reply, current, options.repository!);
      if (!phone) return reply;
      try {
        const { dialogs, stationIds } = await loadDialogs(
          current,
          options.repository!,
          options.provider!,
          request.id,
          phone,
        );
        return {
          items: dialogs.map((dialog) => viewDialog(current.tenantId, dialog, stationIds)),
        };
      } catch (error) {
        if (error instanceof StationSupportProviderError)
          return providerUnavailable(request, reply);
        throw error;
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/support/dialogs/:dialogId/messages',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const dialogId = (request.params as { dialogId: string }).dialogId;
      if (!UUID_PATTERN.test(dialogId)) {
        return sendApiError(request, reply, 404, 'SUPPORT_DIALOG_NOT_FOUND', 'Диалог не найден.');
      }
      const phone = await resolvePhone(request, reply, current, options.repository!);
      if (!phone) return reply;
      try {
        const { dialogs } = await loadDialogs(
          current,
          options.repository!,
          options.provider!,
          request.id,
          phone,
        );
        const dialog = dialogs.find(
          (item) => derivedPublicId(current.tenantId, 'dialog', item.dialogId) === dialogId,
        );
        if (!dialog) {
          return sendApiError(request, reply, 404, 'SUPPORT_DIALOG_NOT_FOUND', 'Диалог не найден.');
        }
        const messages = await options.provider!.listMessages({
          dialogId: dialog.dialogId,
          limit: MESSAGE_PAGE_LIMIT,
          beforeTs: Date.now() + 1,
          correlationId: request.id,
        });
        return { items: messages.map((message) => viewMessage(current.tenantId, message)) };
      } catch (error) {
        if (error instanceof StationSupportProviderError)
          return providerUnavailable(request, reply);
        throw error;
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/support/messages',
    {
      preHandler: [...options.commandHandlers],
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const body = request.body as Record<string, unknown> | null;
      const stationId = typeof body?.stationId === 'string' ? body.stationId : null;
      const dialogId = typeof body?.dialogId === 'string' ? body.dialogId : null;
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['stationId', 'dialogId', 'text'].includes(key)) ||
        (stationId === null) === (dialogId === null) ||
        (stationId !== null && !UUID_PATTERN.test(stationId)) ||
        (dialogId !== null && !UUID_PATTERN.test(dialogId)) ||
        text.length === 0 ||
        text.length > MAX_MESSAGE_LENGTH
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'SUPPORT_MESSAGE_INVALID',
          'Укажите станцию или диалог и текст сообщения длиной до 4000 символов.',
        );
      }
      const repository = options.repository!;
      const provider = options.provider!;
      const idempotencyKey = request.headers['idempotency-key'] as string;
      const phone = await resolvePhone(request, reply, current, repository);
      if (!phone) return reply;

      let target: { dialogId: string | null; stationId: string; stationName: string };
      if (dialogId !== null) {
        const loaded = await loadDialogs(current, repository, provider, request.id, phone).catch(
          (error: unknown) => {
            if (error instanceof StationSupportProviderError) return null;
            throw error;
          },
        );
        if (!loaded) return providerUnavailable(request, reply);
        const match = loaded.dialogs.find(
          (item) => derivedPublicId(current.tenantId, 'dialog', item.dialogId) === dialogId,
        );
        if (!match) {
          return sendApiError(request, reply, 404, 'SUPPORT_DIALOG_NOT_FOUND', 'Диалог не найден.');
        }
        if (match.status.toUpperCase() === 'CLOSED') {
          return sendApiError(
            request,
            reply,
            409,
            'SUPPORT_DIALOG_CLOSED',
            'Обращение закрыто. Начните новое обращение к станции.',
          );
        }
        target = {
          dialogId: match.dialogId,
          stationId: match.stationId ?? 'UNASSIGNED',
          stationName: match.stationName,
        };
      } else {
        const legacyStationId = await repository.readLegacyStationExternalId({
          tenantId: current.tenantId,
          stationId: stationId!,
        });
        if (!legacyStationId) {
          return sendApiError(
            request,
            reply,
            409,
            'SUPPORT_STATION_NOT_BOUND',
            'Станция ещё не связана с обращениями. Выберите другую станцию.',
          );
        }
        const locations = await options.locationRepository!.listPublished(current.tenantId, {
          limit: 100,
        });
        const location = locations.find((item) => item.id === stationId);
        if (!location) {
          return sendApiError(
            request,
            reply,
            404,
            'SUPPORT_STATION_UNKNOWN',
            'Станция не найдена.',
          );
        }
        const existing = await loadDialogs(current, repository, provider, request.id, phone).catch(
          (error: unknown) => {
            if (error instanceof StationSupportProviderError) return null;
            throw error;
          },
        );
        if (!existing) return providerUnavailable(request, reply);
        const match =
          existing.dialogs.find(
            (item) => item.stationId === legacyStationId && item.status.toUpperCase() !== 'CLOSED',
          ) ?? null;
        target = {
          dialogId: match?.dialogId ?? null,
          stationId: legacyStationId,
          stationName: match?.stationName ?? location.title,
        };
      }

      // A retry of an already accepted command is answered from the provider's own record: the
      // derived external message id is stored on the message. The stored body must match, otherwise
      // the same key is being reused for a different command and must not silently drop the text.
      const providerMessageId = stationSupportExternalMessageId(
        current.tenantId,
        current.userId,
        idempotencyKey,
      );
      if (target.dialogId) {
        const replayed = await findSentMessage(
          provider,
          target.dialogId,
          providerMessageId,
          request.id,
        ).catch(() => null);
        if (replayed) {
          if (replayed.text.trim() !== text) return conflict(request, reply);
          return {
            dialogId: derivedPublicId(current.tenantId, 'dialog', target.dialogId),
            message: viewMessage(current.tenantId, replayed),
            replayed: true,
          };
        }
      }

      try {
        const sent = await provider.sendEvent({
          phoneDigits: phone,
          externalUserId: current.userId,
          externalChatId: `lk2:${current.userId}`,
          displayName: 'Игрок ПадлХАБ',
          text,
          stationId: target.stationId,
          stationName: target.stationName,
          externalMessageId: providerMessageId,
          correlationId: request.id,
        });
        // A 2xx without a parsable dialog id is still an accepted write for a new dialog, so the
        // same read-back recovery runs before the command may be reported as failed.
        const resolvedDialogId = sent.dialogId ?? target.dialogId;
        if (!resolvedDialogId) {
          const recoveredOnly = await recoverSentMessage(
            provider,
            request.id,
            phone,
            null,
            target.stationId,
            providerMessageId,
          ).catch(() => null);
          if (recoveredOnly) {
            return {
              dialogId: derivedPublicId(current.tenantId, 'dialog', recoveredOnly.dialogId),
              message: viewMessage(current.tenantId, recoveredOnly.message),
              replayed: true,
            };
          }
          return providerUnavailable(request, reply);
        }
        const message = await findSentMessage(
          provider,
          resolvedDialogId,
          providerMessageId,
          request.id,
        ).catch(() => null);
        return {
          dialogId: derivedPublicId(current.tenantId, 'dialog', resolvedDialogId),
          message: message ? viewMessage(current.tenantId, message) : null,
          replayed: false,
        };
      } catch (error) {
        if (!(error instanceof StationSupportProviderError)) throw error;
        if (error.code === 'SUPPORT_PROVIDER_REJECTED') {
          return sendApiError(
            request,
            reply,
            422,
            'SUPPORT_MESSAGE_REJECTED',
            'Станция отклонила обращение. Проверьте текст и попробуйте снова.',
          );
        }
        // Ambiguous write recovery: a timeout or 5xx may still have committed the message, so read
        // the provider back before reporting failure. The retried command is safe either way.
        const recovered = await recoverSentMessage(
          provider,
          request.id,
          phone,
          target.dialogId,
          target.stationId,
          providerMessageId,
        ).catch(() => null);
        if (recovered) {
          return {
            dialogId: derivedPublicId(current.tenantId, 'dialog', recovered.dialogId),
            message: viewMessage(current.tenantId, recovered.message),
            replayed: true,
          };
        }
        return providerUnavailable(request, reply);
      }
    },
  );
}

async function findSentMessage(
  provider: StationSupportProvider,
  dialogId: string,
  externalMessageId: string,
  correlationId: string,
): Promise<StationSupportProviderMessage | null> {
  const messages = await provider.listMessages({
    dialogId,
    limit: MESSAGE_PAGE_LIMIT,
    beforeTs: Date.now() + 1,
    correlationId,
  });
  return messages.find((message) => message.externalMessageId === externalMessageId) ?? null;
}

async function recoverSentMessage(
  provider: StationSupportProvider,
  correlationId: string,
  phoneDigits: string,
  knownDialogId: string | null,
  legacyStationId: string,
  externalMessageId: string,
): Promise<{ readonly dialogId: string; readonly message: StationSupportProviderMessage } | null> {
  const dialogs = await provider.listDialogs({ phoneDigits, correlationId });
  const candidates = knownDialogId
    ? dialogs.filter((dialog) => dialog.dialogId === knownDialogId)
    : dialogs.filter((dialog) => dialog.stationId === legacyStationId);
  for (const dialog of candidates) {
    const message = await findSentMessage(
      provider,
      dialog.dialogId,
      externalMessageId,
      correlationId,
    );
    if (message) return { dialogId: dialog.dialogId, message };
  }
  return null;
}
