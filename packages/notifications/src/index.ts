import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const eventType = z.string().regex(/^[a-z][a-z0-9_.-]+\.v[1-9][0-9]*$/);
const positiveRevision = z.string().regex(/^[1-9][0-9]*$/);

export const BOOKING_NOTIFICATION_CANONICAL_CONTRACT = {
  rulesetVersion: 'booking.ru-ru.v3',
  template: {
    version: 2,
    locale: 'ru-RU',
    category: 'BOOKING',
    deepLink: '/bookings',
    channels: ['IN_APP', 'PUSH'],
    active: true,
  },
  rule: {
    keySuffix: 'default',
    audienceSelector: {
      type: 'EVENT_USERS',
      field: 'recipientUserIds',
    },
    channelOverride: ['IN_APP', 'PUSH'],
    active: true,
  },
  definitions: [
    {
      key: 'booking.confirmed',
      sourceEventType: 'booking.confirmed.v1',
      title: 'Запись подтверждена',
      body: '{{serviceTitle}}: {{startsAt}}, {{locationName}}',
      mandatory: true,
    },
    {
      key: 'booking.changed',
      sourceEventType: 'booking.changed.v1',
      title: 'Запись изменена',
      body: '{{serviceTitle}}: новое время {{startsAt}}, {{locationName}}',
      mandatory: true,
    },
    {
      key: 'booking.cancelled',
      sourceEventType: 'booking.cancelled.v1',
      title: 'Запись отменена',
      body: '{{serviceTitle}}: {{startsAt}}, {{locationName}}',
      mandatory: true,
    },
    {
      key: 'booking.reminder',
      sourceEventType: 'booking.reminder.due.v1',
      title: 'Напоминание о записи',
      body: '{{serviceTitle}} начнётся {{startsAt}}, {{locationName}}',
      mandatory: false,
    },
  ],
} as const;

export const GAME_NOTIFICATION_CANONICAL_CONTRACT = {
  rulesetVersion: 'game.ru-ru.v1',
  template: {
    version: 1,
    locale: 'ru-RU',
    category: 'GAME',
    deepLink: '/games/{{gameId}}',
    channels: ['IN_APP'],
    active: true,
  },
  rule: {
    keySuffix: 'default',
    channelOverride: ['IN_APP'],
    active: true,
  },
  definitions: [
    {
      key: 'game.participation.confirmed',
      sourceEventType: 'game.participation.confirmed.v1',
      title: 'Вы в игре',
      body: 'Место подтверждено. Откройте карточку игры и чат участников.',
      audienceSelector: {
        type: 'EVENT_USER',
        field: 'userId',
      },
      mandatory: true,
    },
    {
      key: 'game.cancelled',
      sourceEventType: 'game.cancelled.v1',
      title: 'Игра отменена',
      body: 'Откройте карточку игры, чтобы проверить детали.',
      audienceSelector: {
        type: 'EVENT_USERS',
        field: 'participantUserIds',
      },
      mandatory: true,
    },
    {
      key: 'game.participation.left',
      sourceEventType: 'game.participation.left.v1',
      title: 'Вы вышли из игры',
      body: 'Участие завершено. Откройте карточку игры, чтобы проверить детали.',
      audienceSelector: {
        type: 'EVENT_USER',
        field: 'userId',
      },
      mandatory: true,
    },
  ],
} as const;

export const BOOKING_NOTIFICATION_RULESET_VERSION =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.rulesetVersion;
export const BOOKING_NOTIFICATION_TEMPLATE_VERSION =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.template.version;
export const BOOKING_NOTIFICATION_LOCALE = BOOKING_NOTIFICATION_CANONICAL_CONTRACT.template.locale;
export const BOOKING_NOTIFICATION_TEMPLATE_CATEGORY =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.template.category;
export const BOOKING_NOTIFICATION_TEMPLATE_DEEP_LINK =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.template.deepLink;
export const BOOKING_NOTIFICATION_TEMPLATE_CHANNELS =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.template.channels;
export const BOOKING_NOTIFICATION_TEMPLATE_ACTIVE =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.template.active;
export const BOOKING_NOTIFICATION_RULE_KEY_SUFFIX =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.rule.keySuffix;
export const BOOKING_NOTIFICATION_AUDIENCE_SELECTOR =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.rule.audienceSelector;
export const BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE =
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT.rule.channelOverride;
export const BOOKING_NOTIFICATION_RULE_ACTIVE = BOOKING_NOTIFICATION_CANONICAL_CONTRACT.rule.active;
export const BOOKING_NOTIFICATION_DEFINITIONS = BOOKING_NOTIFICATION_CANONICAL_CONTRACT.definitions;

export type BookingNotificationDefinition = (typeof BOOKING_NOTIFICATION_DEFINITIONS)[number];

export const GAME_NOTIFICATION_RULESET_VERSION =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.rulesetVersion;
export const GAME_NOTIFICATION_TEMPLATE_VERSION =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.template.version;
export const GAME_NOTIFICATION_LOCALE = GAME_NOTIFICATION_CANONICAL_CONTRACT.template.locale;
export const GAME_NOTIFICATION_TEMPLATE_CATEGORY =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.template.category;
export const GAME_NOTIFICATION_TEMPLATE_DEEP_LINK =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.template.deepLink;
export const GAME_NOTIFICATION_TEMPLATE_CHANNELS =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.template.channels;
export const GAME_NOTIFICATION_TEMPLATE_ACTIVE =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.template.active;
export const GAME_NOTIFICATION_RULE_KEY_SUFFIX =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.rule.keySuffix;
export const GAME_NOTIFICATION_RULE_CHANNEL_OVERRIDE =
  GAME_NOTIFICATION_CANONICAL_CONTRACT.rule.channelOverride;
export const GAME_NOTIFICATION_RULE_ACTIVE = GAME_NOTIFICATION_CANONICAL_CONTRACT.rule.active;
export const GAME_NOTIFICATION_DEFINITIONS = GAME_NOTIFICATION_CANONICAL_CONTRACT.definitions;
export type GameNotificationDefinition = (typeof GAME_NOTIFICATION_DEFINITIONS)[number];

/**
 * Direct-chat notification ruleset. Messaging events stay on the generic source-event schema: ADR
 * 0022 keeps their payload identifier-only (tenant, conversation, message, sequence and recipient
 * identifiers), so the projector resolves recipients from `recipientUserIds` instead of a dedicated
 * payload contract, and the rendered text never quotes message content. Direct messages are the one
 * conversation a person can be pulled back into, so the ruleset asks for both channels; the version
 * moves to `messaging.ru-ru.v2` because a provisioned template version can never change its channels.
 */
export const MESSAGING_NOTIFICATION_CANONICAL_CONTRACT = {
  rulesetVersion: 'messaging.ru-ru.v2',
  template: {
    version: 2,
    locale: 'ru-RU',
    category: 'MESSAGING',
    deepLink: '/chats/{{conversationId}}',
    channels: ['IN_APP', 'PUSH'],
    active: true,
  },
  rule: {
    keySuffix: 'default',
    channelOverride: ['IN_APP', 'PUSH'],
    active: true,
  },
  definitions: [
    {
      key: 'messaging.conversation.created',
      sourceEventType: 'messaging.conversation.created.v1',
      title: 'Новый чат',
      body: 'Откройте чат в ПадлХАБ, чтобы ответить.',
      audienceSelector: {
        type: 'EVENT_USERS',
        field: 'recipientUserIds',
      },
      mandatory: false,
    },
    {
      key: 'messaging.message.created',
      sourceEventType: 'messaging.message.created.v1',
      title: 'Новое сообщение',
      body: 'Откройте чат в ПадлХАБ, чтобы прочитать сообщение.',
      audienceSelector: {
        type: 'EVENT_USERS',
        field: 'recipientUserIds',
      },
      mandatory: false,
    },
  ],
} as const;

export const MESSAGING_NOTIFICATION_RULESET_VERSION =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.rulesetVersion;
export const MESSAGING_NOTIFICATION_TEMPLATE_VERSION =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.template.version;
export const MESSAGING_NOTIFICATION_LOCALE =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.template.locale;
export const MESSAGING_NOTIFICATION_TEMPLATE_CATEGORY =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.template.category;
export const MESSAGING_NOTIFICATION_TEMPLATE_DEEP_LINK =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.template.deepLink;
export const MESSAGING_NOTIFICATION_TEMPLATE_CHANNELS =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.template.channels;
export const MESSAGING_NOTIFICATION_TEMPLATE_ACTIVE =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.template.active;
export const MESSAGING_NOTIFICATION_RULE_KEY_SUFFIX =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.rule.keySuffix;
export const MESSAGING_NOTIFICATION_RULE_CHANNEL_OVERRIDE =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.rule.channelOverride;
export const MESSAGING_NOTIFICATION_RULE_ACTIVE =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.rule.active;
export const MESSAGING_NOTIFICATION_DEFINITIONS =
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT.definitions;
export type MessagingNotificationDefinition = (typeof MESSAGING_NOTIFICATION_DEFINITIONS)[number];

/**
 * Incoming friend-request ruleset. A request is addressed to one account, so the event carries that
 * account in `recipientUserIds` and the rule resolves it from there; the rendered text names neither
 * the requester nor any profile detail, and opens the notifications feed where the request can be
 * answered. The channels include PUSH because a request is worthless if the addressed player only
 * discovers it after opening the cabinet.
 */
export const FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT = {
  rulesetVersion: 'friendship.ru-ru.v1',
  template: {
    version: 1,
    locale: 'ru-RU',
    category: 'FRIENDSHIP',
    deepLink: '/notifications',
    channels: ['IN_APP', 'PUSH'],
    active: true,
  },
  rule: {
    keySuffix: 'default',
    channelOverride: ['IN_APP', 'PUSH'],
    active: true,
  },
  definitions: [
    {
      key: 'profile.friend_request.created',
      sourceEventType: 'profile.friend_request.created.v1',
      title: 'Заявка в друзья',
      body: 'Откройте ПадлХАБ, чтобы ответить.',
      audienceSelector: {
        type: 'EVENT_USERS',
        field: 'recipientUserIds',
      },
      mandatory: false,
    },
  ],
} as const;

export const FRIENDSHIP_NOTIFICATION_RULESET_VERSION =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.rulesetVersion;
export const FRIENDSHIP_NOTIFICATION_TEMPLATE_VERSION =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.template.version;
export const FRIENDSHIP_NOTIFICATION_LOCALE =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.template.locale;
export const FRIENDSHIP_NOTIFICATION_TEMPLATE_CATEGORY =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.template.category;
export const FRIENDSHIP_NOTIFICATION_TEMPLATE_DEEP_LINK =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.template.deepLink;
export const FRIENDSHIP_NOTIFICATION_TEMPLATE_CHANNELS =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.template.channels;
export const FRIENDSHIP_NOTIFICATION_TEMPLATE_ACTIVE =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.template.active;
export const FRIENDSHIP_NOTIFICATION_RULE_KEY_SUFFIX =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.rule.keySuffix;
export const FRIENDSHIP_NOTIFICATION_RULE_CHANNEL_OVERRIDE =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.rule.channelOverride;
export const FRIENDSHIP_NOTIFICATION_RULE_ACTIVE =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.rule.active;
export const FRIENDSHIP_NOTIFICATION_DEFINITIONS =
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT.definitions;
export type FriendshipNotificationDefinition = (typeof FRIENDSHIP_NOTIFICATION_DEFINITIONS)[number];

export function bookingNotificationContractHash(contract: object): string {
  const serialized = JSON.stringify(contract);
  if (!serialized) throw new Error('BOOKING_NOTIFICATION_CONTRACT_NOT_SERIALIZABLE');
  return createHash('sha256').update(serialized).digest('hex');
}

export const BOOKING_NOTIFICATION_REQUEST_HASH = bookingNotificationContractHash(
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT,
);
export const GAME_NOTIFICATION_REQUEST_HASH = bookingNotificationContractHash(
  GAME_NOTIFICATION_CANONICAL_CONTRACT,
);
export const MESSAGING_NOTIFICATION_REQUEST_HASH = bookingNotificationContractHash(
  MESSAGING_NOTIFICATION_CANONICAL_CONTRACT,
);
export const FRIENDSHIP_NOTIFICATION_REQUEST_HASH = bookingNotificationContractHash(
  FRIENDSHIP_NOTIFICATION_CANONICAL_CONTRACT,
);

export const BOOKING_NOTIFICATION_EVENT_TYPES = [
  'booking.confirmed.v1',
  'booking.changed.v1',
  'booking.cancelled.v1',
  'booking.reminder.due.v1',
] as const;

export const GAME_NOTIFICATION_EVENT_TYPES = [
  'game.participation.confirmed.v1',
  'game.participation.left.v1',
  'game.cancelled.v1',
] as const;

export const MESSAGING_NOTIFICATION_EVENT_TYPES = [
  'messaging.conversation.created.v1',
  'messaging.message.created.v1',
] as const;

export const FRIENDSHIP_NOTIFICATION_EVENT_TYPES = ['profile.friend_request.created.v1'] as const;

export const MAX_NOTIFICATION_EVENT_RECIPIENTS = 50;

const recipientUserIdsSchema = z
  .array(uuid)
  .min(1)
  .max(MAX_NOTIFICATION_EVENT_RECIPIENTS)
  .transform((items) => [...new Set(items)]);
const bookingEventEnvelopeBase = z.object({
  id: uuid,
  aggregateId: uuid,
  tenantId: uuid,
  occurredAt: dateTime,
  correlationId: z.string().min(8).max(128),
});
const bookingEventPayloadBase = {
  bookingId: uuid,
  revision: positiveRevision,
  recipientUserIds: recipientUserIdsSchema,
  serviceTitle: z.string().trim().min(1).max(160),
  startsAt: dateTime,
  timezone: z.string().trim().min(1).max(64),
  locationName: z.string().trim().min(1).max(160),
};

function bookingEventSchema<
  TType extends (typeof BOOKING_NOTIFICATION_EVENT_TYPES)[number],
  TExtra extends z.ZodRawShape,
>(type: TType, extra: TExtra) {
  return bookingEventEnvelopeBase
    .extend({
      type: z.literal(type),
      payload: z.object({ ...bookingEventPayloadBase, ...extra }).strict(),
    })
    .strict();
}

export const bookingNotificationSourceEventSchema = z
  .discriminatedUnion('type', [
    bookingEventSchema('booking.confirmed.v1', {}),
    bookingEventSchema('booking.changed.v1', {
      changedFields: z
        .array(z.enum(['SERVICE', 'STARTS_AT', 'LOCATION', 'STATUS']))
        .min(1)
        .max(4)
        .transform((items) => [...new Set(items)]),
    }),
    bookingEventSchema('booking.cancelled.v1', {
      reasonCode: z.enum([
        'USER_REQUEST',
        'VENUE_REQUEST',
        'PAYMENT_FAILED',
        'SERVICE_UNAVAILABLE',
        'OTHER',
      ]),
    }),
    bookingEventSchema('booking.reminder.due.v1', {
      reminderKind: z.enum(['HOURS_24', 'HOURS_2']),
    }),
  ])
  .superRefine((event, context) => {
    if (event.aggregateId !== event.payload.bookingId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'aggregateId must match payload.bookingId',
      });
    }
  });

export type BookingNotificationSourceEvent = z.infer<typeof bookingNotificationSourceEventSchema>;

const gameNotificationEventPayloadBase = {
  gameId: uuid,
  aggregateRevision: positiveRevision,
  causationId: uuid,
  actorUserId: uuid.nullable(),
};
const gameParticipantUserIdsSchema = z
  .array(uuid)
  .max(4)
  .refine((items) => new Set(items).size === items.length, {
    message: 'Participant user identifiers must be unique',
  });

export const gameNotificationSourceEventSchema = z
  .discriminatedUnion('type', [
    bookingEventEnvelopeBase
      .extend({
        type: z.literal('game.participation.confirmed.v1'),
        payload: z
          .object({
            ...gameNotificationEventPayloadBase,
            userId: uuid,
            participationId: uuid,
          })
          .strict(),
      })
      .strict(),
    bookingEventEnvelopeBase
      .extend({
        type: z.literal('game.participation.left.v1'),
        payload: z
          .object({
            ...gameNotificationEventPayloadBase,
            userId: uuid,
            participationId: uuid,
          })
          .strict(),
      })
      .strict(),
    bookingEventEnvelopeBase
      .extend({
        type: z.literal('game.cancelled.v1'),
        payload: z
          .object({
            ...gameNotificationEventPayloadBase,
            participantUserIds: gameParticipantUserIdsSchema,
            reasonCode: z.enum([
              'ORGANIZER_REQUEST',
              'VENUE_UNAVAILABLE',
              'WEATHER',
              'SAFETY',
              'PROVISIONING_FAILED',
              'OTHER',
            ]),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((event, context) => {
    if (event.aggregateId !== event.payload.gameId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'aggregateId must match payload.gameId',
      });
    }
  });

export type GameNotificationSourceEvent = z.infer<typeof gameNotificationSourceEventSchema>;

const genericNotificationSourceEventSchema = z
  .object({
    id: uuid,
    type: eventType,
    aggregateId: uuid,
    tenantId: uuid,
    occurredAt: dateTime,
    correlationId: z.string().min(8).max(128),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine(
    (event) =>
      !BOOKING_NOTIFICATION_EVENT_TYPES.includes(
        event.type as (typeof BOOKING_NOTIFICATION_EVENT_TYPES)[number],
      ) &&
      !GAME_NOTIFICATION_EVENT_TYPES.includes(
        event.type as (typeof GAME_NOTIFICATION_EVENT_TYPES)[number],
      ),
    { message: 'Canonical events must use their notification event contract' },
  );

export const notificationSourceEventSchema = z.union([
  bookingNotificationSourceEventSchema,
  gameNotificationSourceEventSchema,
  genericNotificationSourceEventSchema,
]);

export type NotificationSourceEvent = z.infer<typeof notificationSourceEventSchema>;

export const notificationAudienceSelectorSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('EVENT_USER'),
      field: z.enum(['userId', 'recipientUserId']),
    })
    .strict(),
  z
    .object({
      type: z.literal('EVENT_USERS'),
      field: z.enum(['recipientUserIds', 'participantUserIds']),
    })
    .strict(),
]);

export type NotificationAudienceSelector = z.infer<typeof notificationAudienceSelectorSchema>;

export function resolveNotificationRecipients(
  event: NotificationSourceEvent,
  selector: NotificationAudienceSelector,
): readonly string[] {
  const recipient = (event.payload as Readonly<Record<string, unknown>>)[selector.field];
  if (selector.type === 'EVENT_USER') {
    return typeof recipient === 'string' && uuid.safeParse(recipient).success ? [recipient] : [];
  }
  const parsed = recipientUserIdsSchema.safeParse(recipient);
  return parsed.success ? parsed.data : [];
}

const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_.]{0,127})\s*}}/g;

function valueAtPath(payload: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = payload;
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Readonly<Record<string, unknown>>)[segment];
  }
  return value;
}

function renderValue(template: string, payload: Readonly<Record<string, unknown>>): string {
  return template.replaceAll(PLACEHOLDER_PATTERN, (_match, path: string) => {
    const value = valueAtPath(payload, path);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    throw new Error(`NOTIFICATION_TEMPLATE_VALUE_MISSING:${path}`);
  });
}

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
}

export function renderNotificationTemplate(input: {
  readonly titleTemplate: string;
  readonly bodyTemplate: string;
  readonly deepLinkTemplate?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}): RenderedNotification {
  const title = renderValue(input.titleTemplate, input.payload);
  const body = renderValue(input.bodyTemplate, input.payload);
  const deepLink = input.deepLinkTemplate
    ? renderValue(input.deepLinkTemplate, input.payload)
    : undefined;

  if (title.length < 1 || title.length > 300) throw new Error('NOTIFICATION_TITLE_INVALID');
  if (body.length < 1 || body.length > 8_000) throw new Error('NOTIFICATION_BODY_INVALID');
  if (
    deepLink &&
    (!deepLink.startsWith('/') ||
      deepLink.startsWith('//') ||
      deepLink.includes('\\') ||
      deepLink.length > 2_000)
  ) {
    throw new Error('NOTIFICATION_DEEP_LINK_INVALID');
  }
  return { title, body, ...(deepLink ? { deepLink } : {}) };
}

export type NotificationPushPlatform = 'WEB' | 'IOS' | 'ANDROID';

export interface PushDeliveryRequest {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly providerAccountId: string;
  readonly platform: NotificationPushPlatform;
  readonly endpoint: string;
  readonly notification: {
    readonly id: string;
    readonly title: string;
    readonly preview: string;
    readonly deepLink?: string;
  };
  /**
   * RFC 8030 scheduling hints. They change how the push service treats the message, not the visible
   * payload, so a time-critical notification keeps the same wire shape as an informational one.
   */
  readonly urgency?: 'very-low' | 'low' | 'normal' | 'high';
  readonly ttlSeconds?: number;
  readonly providerIdempotencyKey: string;
}

export type NotificationProviderDeliveryResult =
  | { readonly outcome: 'accepted'; readonly externalMessageId?: string }
  | { readonly outcome: 'retryable_failure'; readonly errorCode: string }
  | {
      readonly outcome: 'terminal_failure';
      readonly errorCode: string;
      readonly invalidate: boolean;
      readonly suspendPolicy?: boolean;
    };

export type PushDeliveryResult = NotificationProviderDeliveryResult;

export interface NotificationPushDeliveryPort {
  readonly platform: NotificationPushPlatform;
  send(request: PushDeliveryRequest): Promise<PushDeliveryResult>;
}

/**
 * Messenger delivery is deliberately separate from mobile/browser push. External target IDs are
 * resolved from encrypted integration storage by the worker and never become public user IDs.
 */
export interface MessengerDeliveryRequest {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly providerAccountId: string;
  readonly connector: 'MAX';
  readonly target: {
    readonly kind: 'USER' | 'CHAT';
    readonly externalId: string;
  };
  readonly notification: {
    readonly id: string;
    readonly text: string;
    readonly deepLink?: string;
  };
  readonly providerIdempotencyKey: string;
}

export interface NotificationMessengerDeliveryPort {
  readonly connector: 'MAX';
  send(request: MessengerDeliveryRequest): Promise<NotificationProviderDeliveryResult>;
}

const webPushKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .min(16)
  .max(256);

export const MAX_WEB_PUSH_ENDPOINT_LENGTH = 2_048;

export function canonicalWebPushEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      (url.port.length > 0 && url.port !== '443') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url.href.length <= MAX_WEB_PUSH_ENDPOINT_LENGTH ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function webPushEndpointOrigin(endpoint: string): string | undefined {
  const canonical = canonicalWebPushEndpoint(endpoint);
  return canonical === undefined ? undefined : new URL(canonical).origin;
}

export function isWebPushEndpointOriginAllowed(
  endpoint: string,
  allowedOrigins: readonly string[],
): boolean {
  const origin = webPushEndpointOrigin(endpoint);
  return origin !== undefined && allowedOrigins.includes(origin);
}

/**
 * Which push service backs a subscription. The origin already names the browser family: Chrome and every
 * Chromium browser use FCM, while Safari and every browser on iOS use Apple. Deriving the value from the
 * stored endpoint keeps the platform visible to operators without retaining anything new about a device
 * and without a schema change.
 */
export type WebPushEndpointPlatform = 'CHROME' | 'SAFARI' | 'OTHER';

export function webPushEndpointPlatform(endpoint: string): WebPushEndpointPlatform | undefined {
  const origin = webPushEndpointOrigin(endpoint);
  if (origin === undefined) return undefined;
  if (origin === 'https://fcm.googleapis.com') return 'CHROME';
  if (origin === 'https://web.push.apple.com') return 'SAFARI';
  return 'OTHER';
}

/**
 * The endpoint address inside the stored subscription payload. Registration encrypts
 * `canonicalWebPushSubscription`, which is a JSON envelope holding the address and its keys, so a reader
 * that expects a bare URL sees nothing at all — exactly the mistake that made every live endpoint look
 * unreadable. A bare address is still accepted so the helper stays total for an older or future shape,
 * and an unreadable payload is reported as absent instead of throwing.
 */
export function storedWebPushEndpoint(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{')) return trimmed.length > 0 ? trimmed : undefined;
  try {
    const parsed = JSON.parse(trimmed) as { readonly endpoint?: unknown };
    return typeof parsed.endpoint === 'string' && parsed.endpoint.length > 0
      ? parsed.endpoint
      : undefined;
  } catch {
    return undefined;
  }
}

export const webPushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(MAX_WEB_PUSH_ENDPOINT_LENGTH)
      .refine(
        (value) => canonicalWebPushEndpoint(value) !== undefined,
        'Web Push endpoint must be a credential-free HTTPS URL without a fragment',
      )
      .transform((value) => canonicalWebPushEndpoint(value) as string),
    expirationTime: z.number().int().nonnegative().nullable().optional(),
    keys: z
      .object({
        p256dh: webPushKey.min(40),
        auth: webPushKey,
      })
      .strict(),
  })
  .strict();

export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>;

export function canonicalWebPushSubscription(subscription: WebPushSubscription): string {
  return JSON.stringify({
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  });
}

/**
 * A display or click receipt is reported by the service worker, which has no session and often runs while
 * the page is closed. The push therefore carries a token that authorises exactly one thing: recording a
 * receipt for the one delivery it was sent for. The key is derived from the endpoint keyring, which both
 * the API and the Worker already hold, so no new secret and no new configuration key appear anywhere.
 */
export const NOTIFICATION_RECEIPT_TOKEN_DOMAIN = 'phub:notification-receipt:v1';

export function notificationReceiptSecret(input: {
  readonly serializedKeys: string;
  readonly activeKeyId: string;
}): string {
  const keys = parseEndpointKeyring(input.serializedKeys);
  const key = keys.get(input.activeKeyId);
  if (!key) throw new Error('NOTIFICATION_ENDPOINT_ACTIVE_KEY_MISSING');
  return createHmac('sha256', key).update(NOTIFICATION_RECEIPT_TOKEN_DOMAIN).digest('base64url');
}

function receiptTokenSignature(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

export function createNotificationReceiptToken(input: {
  readonly secret: string;
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly expiresAt: Date;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: input.tenantId,
      d: input.deliveryId,
      e: Math.floor(input.expiresAt.getTime() / 1000),
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${receiptTokenSignature(input.secret, payload).toString('base64url')}`;
}

/**
 * Returns the delivery a token authorises, or nothing. The tenant comes from the signed payload, so the
 * capability fully describes what it may do and the client needs no tenant key of its own. Every failure
 * — malformed token, expired, tampered signature — is the same answer, so a probe cannot tell them apart.
 */
export function verifyNotificationReceiptToken(input: {
  readonly secret: string;
  readonly token: string;
  readonly now?: Date;
}): { readonly tenantId: string; readonly deliveryId: string } | undefined {
  const [payload, signature] = input.token.split('.');
  if (!payload || !signature) return undefined;
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return undefined;
  }
  const expected = receiptTokenSignature(input.secret, payload);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  let parsed: { readonly t?: unknown; readonly d?: unknown; readonly e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    return undefined;
  }
  if (typeof parsed.t !== 'string' || typeof parsed.d !== 'string' || typeof parsed.e !== 'number')
    return undefined;
  const now = (input.now ?? new Date()).getTime() / 1000;
  if (!Number.isFinite(parsed.e) || parsed.e <= now) return undefined;
  return { tenantId: parsed.t, deliveryId: parsed.d };
}

export interface NotificationEndpointCipher {
  readonly activeKeyId: string;
  encrypt(plaintext: string): { readonly ciphertext: Buffer; readonly keyId: string };
  decrypt(ciphertext: Buffer, keyId: string): string;
}

function parseEndpointKeyring(serializedKeys: string): ReadonlyMap<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedKeys) as unknown;
  } catch {
    throw new Error('NOTIFICATION_ENDPOINT_KEYRING_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NOTIFICATION_ENDPOINT_KEYRING_INVALID');
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof value !== 'string') {
      throw new Error('NOTIFICATION_ENDPOINT_KEYRING_INVALID');
    }
    const key = Buffer.from(value, 'base64');
    if (
      key.length !== 32 ||
      key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')
    ) {
      throw new Error('NOTIFICATION_ENDPOINT_KEY_INVALID');
    }
    keys.set(keyId, key);
  }
  if (keys.size === 0) throw new Error('NOTIFICATION_ENDPOINT_KEYRING_EMPTY');
  return keys;
}

/**
 * User-owned notification preferences. A preference is stored per tenant, user, category and
 * channel (`notifications.user_preferences`); an absent row means the server default and therefore
 * "enabled". Only IN_APP and PUSH are user-configurable today — EMAIL, SMS and CONNECTOR have no
 * product surface — and a mandatory rule still bypasses the preference, so these settings can never
 * silence a server-owned message such as a confirmed booking.
 */
export const USER_NOTIFICATION_PREFERENCE_CHANNELS = ['IN_APP', 'PUSH'] as const;

export type UserNotificationPreferenceChannel =
  (typeof USER_NOTIFICATION_PREFERENCE_CHANNELS)[number];

export function isUserNotificationPreferenceChannel(
  value: unknown,
): value is UserNotificationPreferenceChannel {
  return (
    typeof value === 'string' &&
    (USER_NOTIFICATION_PREFERENCE_CHANNELS as readonly string[]).includes(value)
  );
}

const quietTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

export const notificationPreferenceChannelUpdateSchema = z.object({
  channel: z.enum(USER_NOTIFICATION_PREFERENCE_CHANNELS),
  enabled: z.boolean(),
  quietFrom: quietTime.nullish(),
  quietUntil: quietTime.nullish(),
  timezone: z.string().min(1).max(64).nullish(),
});

export const notificationPreferenceCategoryUpdateSchema = z.object({
  category: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  channels: z.array(notificationPreferenceChannelUpdateSchema).min(1).max(2),
});

export const NOTIFICATION_PREFERENCE_DEFAULT_TIMEZONE = 'Europe/Moscow';

const MINUTES_PER_DAY = 24 * 60;

export function isSupportedNotificationTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64 || /\s/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function localMinutesOfDay(now: Date, timezone: string): number | undefined {
  if (!isSupportedNotificationTimeZone(timezone)) return undefined;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  // `hour12: false` can render midnight as 24 in some ICU versions.
  return ((hour % 24) * 60 + minute) % MINUTES_PER_DAY;
}

function minutesOfDay(value: string): number | undefined {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether the recipient's local clock sits inside their quiet window. `quietFrom === quietUntil`
 * means "no quiet hours" rather than an all-day silence, and a window that crosses midnight
 * (`23:00`–`07:00`) is honoured as one interval. An unreadable window is never quiet: a bad row must
 * not silently swallow a notification.
 */
export function quietHoursActive(input: {
  readonly now: Date;
  readonly quietFrom: string;
  readonly quietUntil: string;
  readonly timezone: string;
}): boolean {
  const from = minutesOfDay(input.quietFrom);
  const until = minutesOfDay(input.quietUntil);
  const current = localMinutesOfDay(input.now, input.timezone);
  if (from === undefined || until === undefined || current === undefined) return false;
  if (from === until) return false;
  if (from < until) return current >= from && current < until;
  return current >= from || current < until;
}

export function createNotificationEndpointCipher(input: {
  readonly serializedKeys: string;
  readonly activeKeyId: string;
}): NotificationEndpointCipher {
  const keys = parseEndpointKeyring(input.serializedKeys);
  if (!keys.has(input.activeKeyId)) throw new Error('NOTIFICATION_ENDPOINT_ACTIVE_KEY_MISSING');

  return {
    activeKeyId: input.activeKeyId,
    encrypt(plaintext) {
      const key = keys.get(input.activeKeyId);
      if (!key) throw new Error('NOTIFICATION_ENDPOINT_ACTIVE_KEY_MISSING');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`notification-endpoint:${input.activeKeyId}`, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: Buffer.concat([Buffer.from([1]), nonce, encrypted, tag]),
        keyId: input.activeKeyId,
      };
    },
    decrypt(ciphertext, keyId) {
      const key = keys.get(keyId);
      if (!key) throw new Error('NOTIFICATION_ENDPOINT_KEY_NOT_FOUND');
      if (ciphertext.length < 30 || ciphertext[0] !== 1) {
        throw new Error('NOTIFICATION_ENDPOINT_CIPHERTEXT_INVALID');
      }
      const nonce = ciphertext.subarray(1, 13);
      const tag = ciphertext.subarray(ciphertext.length - 16);
      const encrypted = ciphertext.subarray(13, ciphertext.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`notification-endpoint:${keyId}`, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    },
  };
}
