import type {
  NotificationInboxPosition,
  NotificationInboxRepository,
  NotificationPreferenceChannelRule,
  NotificationPreferenceRecord,
  NotificationPreferenceRepository,
  NotificationPreferenceUpdate,
  NotificationRuntimeSettings,
} from '@phub/database';
import {
  NOTIFICATION_PREFERENCE_DEFAULT_TIMEZONE,
  isSupportedNotificationTimeZone,
  notificationPreferenceCategoryUpdateSchema,
} from '@phub/notifications';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One configurable channel of one category, already merged with the recipient's stored row. */
interface NotificationPreferenceChannelView {
  readonly channel: string;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly available: boolean;
  readonly quietFrom?: string;
  readonly quietUntil?: string;
}

interface NotificationPreferenceCategoryView {
  readonly category: string;
  readonly channels: readonly NotificationPreferenceChannelView[];
}

function preferenceView(input: {
  readonly configurable: readonly NotificationPreferenceChannelRule[];
  readonly stored: readonly NotificationPreferenceRecord[];
  readonly runtime: NotificationRuntimeSettings;
}): { readonly categories: readonly NotificationPreferenceCategoryView[] } {
  const storedByKey = new Map(
    input.stored.map((preference) => [`${preference.category}:${preference.channel}`, preference]),
  );
  const categories = new Map<string, NotificationPreferenceChannelView[]>();
  for (const rule of input.configurable) {
    const preference = storedByKey.get(`${rule.category}:${rule.channel}`);
    const channels = categories.get(rule.category) ?? [];
    channels.push({
      channel: rule.channel,
      // An absent row is the server default: the recipient allows the channel.
      enabled: preference?.enabled ?? true,
      timezone: preference?.timezone ?? NOTIFICATION_PREFERENCE_DEFAULT_TIMEZONE,
      available:
        rule.channel === 'IN_APP' ? input.runtime.inAppEnabled : input.runtime.webPushEnabled,
      ...(preference?.quietFrom && preference.quietUntil
        ? { quietFrom: preference.quietFrom, quietUntil: preference.quietUntil }
        : {}),
    });
    categories.set(rule.category, channels);
  }
  return {
    categories: [...categories.entries()].map(([category, channels]) => ({ category, channels })),
  };
}

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const notificationRequest = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = notificationRequest.tenantId;
  const userId = notificationRequest.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function encodeCursor(position: NotificationInboxPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decodeCursor(value: string): NotificationInboxPosition | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      !UUID_PATTERN.test(record.id) ||
      typeof record.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(record.createdAt))
    ) {
      return undefined;
    }
    return { id: record.id, createdAt: record.createdAt };
  } catch {
    return undefined;
  }
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'NOTIFICATION_STORE_UNAVAILABLE',
    'Оповещения временно недоступны.',
  );
}

async function inAppEnabled(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: Pick<NotificationInboxRepository, 'getRuntimeSettings'>,
  tenantId: string,
): Promise<boolean> {
  const settings = await repository.getRuntimeSettings(tenantId);
  if (settings.inAppEnabled) return true;
  sendApiError(request, reply, 404, 'NOTIFICATIONS_DISABLED', 'Раздел оповещений не включён.');
  return false;
}

/**
 * The notification section is reachable while at least one channel is enabled for the tenant, so a
 * tenant that runs Web Push without the in-app feed can still manage its preferences.
 */
async function notificationRuntime(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: Pick<NotificationInboxRepository, 'getRuntimeSettings'>,
  tenantId: string,
): Promise<NotificationRuntimeSettings | undefined> {
  const settings = await repository.getRuntimeSettings(tenantId);
  if (settings.inAppEnabled || settings.webPushEnabled) return settings;
  sendApiError(request, reply, 404, 'NOTIFICATIONS_DISABLED', 'Раздел оповещений не включён.');
  return undefined;
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: NotificationInboxRepository;
    readonly preferenceRepository?: NotificationPreferenceRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/notifications',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (!(await inAppEnabled(request, reply, options.repository, current.tenantId))) return;

      const query = request.query as Record<string, unknown>;
      const limitValue = query.limit === undefined ? 20 : Number(query.limit);
      const unreadOnlyValue = query.unreadOnly === undefined ? 'false' : query.unreadOnly;
      if (
        !Number.isInteger(limitValue) ||
        limitValue < 1 ||
        limitValue > 100 ||
        (unreadOnlyValue !== 'true' && unreadOnlyValue !== 'false') ||
        (query.cursor !== undefined && typeof query.cursor !== 'string')
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'NOTIFICATION_QUERY_INVALID',
          'Некорректные параметры списка оповещений.',
        );
      }
      const before = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : undefined;
      if (query.cursor !== undefined && !before) {
        return sendApiError(
          request,
          reply,
          400,
          'NOTIFICATION_CURSOR_INVALID',
          'Курсор оповещений недействителен.',
        );
      }

      const page = await options.repository.listInbox({
        tenantId: current.tenantId,
        userId: current.userId,
        limit: limitValue,
        unreadOnly: unreadOnlyValue === 'true',
        ...(before ? { before } : {}),
      });
      return {
        items: page.items,
        unreadCount: page.unreadCount,
        ...(page.next ? { nextCursor: encodeCursor(page.next) } : {}),
      };
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/notifications/read-cursor',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (!(await inAppEnabled(request, reply, options.repository, current.tenantId))) return;

      const body = request.body as Record<string, unknown> | null;
      const throughId = body?.throughId;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof throughId !== 'string' ||
        !UUID_PATTERN.test(throughId)
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'NOTIFICATION_READ_CURSOR_INVALID',
          'Не указано оповещение, до которого нужно отметить прочтение.',
        );
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        return sendApiError(
          request,
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Для этой операции требуется корректный Idempotency-Key.',
        );
      }

      const result = await options.repository.markReadThrough({
        tenantId: current.tenantId,
        userId: current.userId,
        throughItemId: throughId,
        idempotencyKey,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found') {
        return sendApiError(
          request,
          reply,
          404,
          'NOTIFICATION_NOT_FOUND',
          'Оповещение не найдено.',
        );
      }
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      return result;
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/notifications/preferences',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const preferenceRepository = options.preferenceRepository;
      if (!options.repository || !preferenceRepository) return unavailable(request, reply);
      const runtime = await notificationRuntime(
        request,
        reply,
        options.repository,
        current.tenantId,
      );
      if (!runtime) return;

      const [configurable, stored] = await Promise.all([
        preferenceRepository.listConfigurableChannels(current.tenantId),
        preferenceRepository.listPreferences({
          tenantId: current.tenantId,
          userId: current.userId,
        }),
      ]);
      return preferenceView({ configurable, stored, runtime });
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/notifications/preferences',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const preferenceRepository = options.preferenceRepository;
      if (!options.repository || !preferenceRepository) return unavailable(request, reply);
      const runtime = await notificationRuntime(
        request,
        reply,
        options.repository,
        current.tenantId,
      );
      if (!runtime) return;

      const body = request.body as Record<string, unknown> | null;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !Array.isArray(body.categories) ||
        body.categories.length === 0 ||
        body.categories.length > 8
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'NOTIFICATION_PREFERENCE_INVALID',
          'Передайте список категорий с настройками каналов.',
        );
      }

      const configurable = await preferenceRepository.listConfigurableChannels(current.tenantId);
      const allowed = new Set(configurable.map((rule) => `${rule.category}:${rule.channel}`));
      const entries: NotificationPreferenceUpdate[] = [];
      const seen = new Set<string>();
      for (const candidate of body.categories) {
        const parsed = notificationPreferenceCategoryUpdateSchema.safeParse(candidate);
        if (!parsed.success) {
          return sendApiError(
            request,
            reply,
            400,
            'NOTIFICATION_PREFERENCE_INVALID',
            'Некорректная категория или канал оповещений.',
          );
        }
        for (const channel of parsed.data.channels) {
          const key = `${parsed.data.category}:${channel.channel}`;
          if (seen.has(key)) {
            return sendApiError(
              request,
              reply,
              400,
              'NOTIFICATION_PREFERENCE_INVALID',
              'Канал указан в категории дважды.',
            );
          }
          seen.add(key);
          if (!allowed.has(key)) {
            return sendApiError(
              request,
              reply,
              400,
              'NOTIFICATION_PREFERENCE_NOT_CONFIGURABLE',
              'Этот канал оповещений недоступен для организации.',
            );
          }
          const quietFrom = channel.quietFrom ?? null;
          const quietUntil = channel.quietUntil ?? null;
          if ((quietFrom === null) !== (quietUntil === null)) {
            return sendApiError(
              request,
              reply,
              400,
              'NOTIFICATION_PREFERENCE_INVALID',
              'Тихие часы требуют и начала, и конца интервала.',
            );
          }
          const timezone = channel.timezone?.trim() || NOTIFICATION_PREFERENCE_DEFAULT_TIMEZONE;
          if (!isSupportedNotificationTimeZone(timezone)) {
            return sendApiError(
              request,
              reply,
              400,
              'NOTIFICATION_PREFERENCE_INVALID',
              'Неизвестный часовой пояс для тихих часов.',
            );
          }
          entries.push({
            category: parsed.data.category,
            channel: channel.channel,
            enabled: channel.enabled,
            quietFrom,
            quietUntil,
            timezone,
          });
        }
      }

      const stored = await preferenceRepository.replacePreferences({
        tenantId: current.tenantId,
        userId: current.userId,
        entries,
        correlationId: request.id,
      });
      return preferenceView({ configurable, stored, runtime });
    },
  );
}
