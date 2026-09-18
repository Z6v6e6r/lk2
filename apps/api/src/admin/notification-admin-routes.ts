import { createHash } from 'node:crypto';

import { normalizePhoneE164 } from '@phub/auth';
import type { AdminNotificationChannel, AdminNotificationRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

// The CUP addresses recipients either by phone or by PadlHub user id. The user id is the
// authoritative selector: it needs no phone mapping and cannot be redirected by a phone claim.
const MAX_SELECTOR_VALUES = 100;
const recipientsSchema = z.object({
  phones: z.array(z.string().min(5).max(32)).max(MAX_SELECTOR_VALUES).optional(),
  userIds: z.array(z.string().trim().min(1).max(64)).max(MAX_SELECTOR_VALUES).optional(),
});
const campaignSchema = recipientsSchema.extend({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(8_000),
  deepLink: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .refine((value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'))
    .optional(),
  channels: z
    .array(z.enum(['IN_APP', 'WEB_PUSH', 'IOS_PUSH', 'ANDROID_PUSH']))
    .min(1)
    .max(4),
});

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function normalizePhones(phones: readonly string[]): readonly string[] | undefined {
  const normalized = phones.map(normalizePhoneE164);
  if (normalized.some((phone) => !phone)) return undefined;
  return [...new Set(normalized as string[])];
}

// A user id is compared as a canonical UUID, so the same identifier in a different letter case or
// with surrounding whitespace must not become two selector values.
function normalizeUserIds(userIds: readonly string[]): readonly string[] | undefined {
  const normalized = userIds.map((userId) => userId.trim().toLowerCase());
  if (normalized.some((userId) => !USER_ID_PATTERN.test(userId))) return undefined;
  return [...new Set(normalized)];
}

interface RecipientSelector {
  readonly normalizedPhones: readonly string[];
  readonly normalizedUserIds: readonly string[];
}

type SelectorParseResult =
  | { readonly selector: RecipientSelector }
  | { readonly error: { readonly code: string; readonly message: string } };

function parseRecipientSelector(input: {
  readonly phones?: readonly string[] | undefined;
  readonly userIds?: readonly string[] | undefined;
}): SelectorParseResult {
  const phones = input.phones ?? [];
  const userIds = input.userIds ?? [];
  const requested = phones.length + userIds.length;
  if (requested === 0) {
    return {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Укажите хотя бы один номер телефона или идентификатор пользователя.',
      },
    };
  }
  if (requested > MAX_SELECTOR_VALUES) {
    return {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Укажите не более 100 получателей за один запрос.',
      },
    };
  }
  const normalizedPhones = normalizePhones(phones);
  if (!normalizedPhones) {
    return {
      error: {
        code: 'PHONE_INVALID',
        message: 'Один или несколько номеров телефонов указаны неверно.',
      },
    };
  }
  const normalizedUserIds = normalizeUserIds(userIds);
  if (!normalizedUserIds) {
    return {
      error: {
        code: 'USER_ID_INVALID',
        message: 'Один или несколько идентификаторов пользователя указаны неверно.',
      },
    };
  }
  return { selector: { normalizedPhones, normalizedUserIds } };
}

const subscriberQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().uuid().optional(),
});

function idempotencyKey(request: FastifyRequest): string {
  return request.headers['idempotency-key'] as string;
}

function campaignRequestHash(input: {
  readonly normalizedPhones: readonly string[];
  readonly normalizedUserIds: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
  readonly channels: readonly AdminNotificationChannel[];
}): string {
  const normalizedUserIds = [...input.normalizedUserIds].sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        normalizedPhones: [...input.normalizedPhones].sort(),
        title: input.title,
        body: input.body,
        deepLink: input.deepLink ?? null,
        channels: [...new Set(input.channels)].sort(),
        // Phone-only requests keep the hash they had before user-id targeting existed, so a retry of
        // an in-flight command still replays instead of failing as a conflict.
        ...(normalizedUserIds.length > 0 ? { normalizedUserIds } : {}),
      }),
    )
    .digest('hex');
}

function repositoryUnavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendApiError(
    request,
    reply,
    503,
    'ADMIN_NOTIFICATIONS_UNAVAILABLE',
    'Контур отправки уведомлений временно недоступен.',
  );
}

export function registerAdminNotificationRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: AdminNotificationRepository;
    readonly webPushGloballyEnabled: boolean;
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/admin/api/v1/:tenantKey/notifications/capabilities',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const tenantId = request.tenantId;
      if (!tenantId || !options.repository) return repositoryUnavailable(request, reply);
      const capabilities = await options.repository.getCapabilities({
        tenantId,
        webPushAppId: options.webPushAppId,
        webPushEnvironment: options.webPushEnvironment,
      });
      const webPushEnabled =
        options.webPushGloballyEnabled &&
        capabilities.webPushTenantEnabled &&
        capabilities.webPushProviderConfigured;
      return {
        channels: [
          {
            channel: 'WEB_PUSH',
            enabled: webPushEnabled,
            reason: webPushEnabled
              ? undefined
              : !options.webPushGloballyEnabled
                ? 'GLOBAL_RUNTIME_DISABLED'
                : !capabilities.webPushTenantEnabled
                  ? 'TENANT_RUNTIME_DISABLED'
                  : 'PROVIDER_NOT_CONFIGURED',
          },
          {
            channel: 'ANDROID_PUSH',
            enabled: false,
            reason: 'FCM_ADAPTER_NOT_IMPLEMENTED',
            tenantEnabled: capabilities.androidPushTenantEnabled,
          },
          {
            channel: 'IOS_PUSH',
            enabled: false,
            reason: 'APNS_ADAPTER_NOT_IMPLEMENTED',
            tenantEnabled: capabilities.iosPushTenantEnabled,
          },
          {
            channel: 'IN_APP',
            enabled: capabilities.inAppTenantEnabled,
            reason: capabilities.inAppTenantEnabled ? undefined : 'TENANT_RUNTIME_DISABLED',
          },
        ],
      };
    },
  );

  app.get(
    '/admin/api/v1/:tenantKey/notifications/web-push-subscribers',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!options.repository || !request.tenantId) return repositoryUnavailable(request, reply);
      const parsed = subscriberQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Укажите курсор в виде UUID и размер страницы от 1 до 50.',
        );
      }
      return options.repository.listWebPushSubscribers({
        tenantId: request.tenantId,
        webPushAppId: options.webPushAppId,
        webPushEnvironment: options.webPushEnvironment,
        limit: parsed.data.limit ?? 20,
        ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
      });
    },
  );

  app.post(
    '/admin/api/v1/:tenantKey/notifications/recipients/resolve',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!options.repository || !request.tenantId) return repositoryUnavailable(request, reply);
      const parsed = recipientsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Укажите от 1 до 100 номеров телефонов или идентификаторов пользователей.',
        );
      }
      const parsedSelector = parseRecipientSelector(parsed.data);
      if ('error' in parsedSelector) {
        return sendApiError(
          request,
          reply,
          400,
          parsedSelector.error.code,
          parsedSelector.error.message,
        );
      }
      return options.repository.resolveRecipients({
        tenantId: request.tenantId,
        ...parsedSelector.selector,
        webPushGloballyEnabled: options.webPushGloballyEnabled,
        webPushAppId: options.webPushAppId,
        webPushEnvironment: options.webPushEnvironment,
      });
    },
  );

  app.post(
    '/admin/api/v1/:tenantKey/notifications/campaigns',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const actorUserId = request.padlHubClaims?.sub;
      if (!options.repository || !request.tenantId || !actorUserId) {
        return repositoryUnavailable(request, reply);
      }
      const parsed = campaignSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'INVALID_REQUEST',
          'Проверьте получателей, текст и каналы отправки.',
        );
      }
      const parsedSelector = parseRecipientSelector(parsed.data);
      if ('error' in parsedSelector) {
        return sendApiError(
          request,
          reply,
          400,
          parsedSelector.error.code,
          parsedSelector.error.message,
        );
      }
      const { normalizedPhones, normalizedUserIds } = parsedSelector.selector;
      const channels = [...new Set(parsed.data.channels)];
      const unsupportedChannel = channels.find(
        (channel) => channel === 'IOS_PUSH' || channel === 'ANDROID_PUSH',
      );
      if (unsupportedChannel) {
        return sendApiError(
          request,
          reply,
          409,
          'NOTIFICATION_CHANNEL_UNAVAILABLE',
          unsupportedChannel === 'IOS_PUSH'
            ? 'Отправка через APNs ещё не подключена.'
            : 'Отправка через FCM ещё не подключена.',
        );
      }
      const supportedChannels = channels as readonly ('IN_APP' | 'WEB_PUSH')[];
      const result = await options.repository.createCampaign({
        tenantId: request.tenantId,
        actorUserId,
        normalizedPhones,
        normalizedUserIds,
        title: parsed.data.title,
        body: parsed.data.body,
        ...(parsed.data.deepLink ? { deepLink: parsed.data.deepLink } : {}),
        requestedChannels: supportedChannels,
        requestHash: campaignRequestHash({
          normalizedPhones,
          normalizedUserIds,
          title: parsed.data.title,
          body: parsed.data.body,
          ...(parsed.data.deepLink ? { deepLink: parsed.data.deepLink } : {}),
          channels,
        }),
        idempotencyKey: idempotencyKey(request),
        correlationId: request.id,
        webPushGloballyEnabled: options.webPushGloballyEnabled,
        webPushAppId: options.webPushAppId,
        webPushEnvironment: options.webPushEnvironment,
      });

      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_CONFLICT',
          'Этот ключ операции уже использован с другими данными.',
        );
      }
      if (result.outcome === 'channel_unavailable') {
        return sendApiError(
          request,
          reply,
          409,
          'NOTIFICATION_CHANNEL_UNAVAILABLE',
          result.channel === 'IN_APP'
            ? 'Центр уведомлений отключён для организации.'
            : 'Web Push не настроен или отключён.',
        );
      }
      if (result.outcome === 'recipients_not_found') {
        return sendApiError(
          request,
          reply,
          422,
          'NOTIFICATION_RECIPIENTS_NOT_FOUND',
          'Активные получатели по указанным номерам телефонов и идентификаторам не найдены.',
        );
      }
      return reply.status(202).send(result);
    },
  );
}
