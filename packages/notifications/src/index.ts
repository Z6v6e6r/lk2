import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const eventType = z.string().regex(/^[a-z][a-z0-9_.-]+\.v[1-9][0-9]*$/);
const positiveRevision = z.string().regex(/^[1-9][0-9]*$/);

export const GAME_ELIGIBILITY_NOTIFICATION_EVENT_TYPES = [
  'game.waitlist.promotion.denied.v1',
] as const;

export const GAME_ELIGIBILITY_NOTIFICATION_CANONICAL_CONTRACT = {
  rulesetVersion: 'game-eligibility.ru-ru.v1',
  template: {
    version: 1,
    locale: 'ru-RU',
    category: 'GAME',
    deepLink: '/games/{{aggregateId}}',
    channels: ['IN_APP', 'PUSH'],
    active: true,
  },
  rule: {
    keySuffix: 'default',
    audienceSelector: {
      type: 'EVENT_USER',
      field: 'userId',
    },
    channelOverride: ['IN_APP', 'PUSH'],
    active: true,
  },
  definitions: [
    {
      key: 'game.waitlist.promotion-denied',
      sourceEventType: 'game.waitlist.promotion.denied.v1',
      title: 'Место в игре не подтверждено',
      body: 'Ваш уровень больше не соответствует условиям игры.',
      mandatory: true,
    },
  ],
} as const;

export const GAME_ELIGIBILITY_NOTIFICATION_RULESET_VERSION =
  GAME_ELIGIBILITY_NOTIFICATION_CANONICAL_CONTRACT.rulesetVersion;
export const GAME_ELIGIBILITY_NOTIFICATION_REQUEST_HASH = bookingNotificationContractHash(
  GAME_ELIGIBILITY_NOTIFICATION_CANONICAL_CONTRACT,
);

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

export function bookingNotificationContractHash(contract: object): string {
  const serialized = JSON.stringify(contract);
  if (!serialized) throw new Error('BOOKING_NOTIFICATION_CONTRACT_NOT_SERIALIZABLE');
  return createHash('sha256').update(serialized).digest('hex');
}

export const BOOKING_NOTIFICATION_REQUEST_HASH = bookingNotificationContractHash(
  BOOKING_NOTIFICATION_CANONICAL_CONTRACT,
);

export const BOOKING_NOTIFICATION_EVENT_TYPES = [
  'booking.confirmed.v1',
  'booking.changed.v1',
  'booking.cancelled.v1',
  'booking.reminder.due.v1',
] as const;

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

export const gameEligibilityNotificationSourceEventSchema = bookingEventEnvelopeBase
  .extend({
    type: z.literal('game.waitlist.promotion.denied.v1'),
    payload: z
      .object({
        gameId: uuid,
        aggregateRevision: positiveRevision,
        causationId: uuid,
        actorUserId: uuid.nullable(),
        userId: uuid,
        waitlistEntryId: uuid,
        decisionId: uuid,
        reasonCode: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict()
  .refine((event) => event.aggregateId === event.payload.gameId, {
    path: ['aggregateId'],
    message: 'aggregateId must match payload.gameId',
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
      !GAME_ELIGIBILITY_NOTIFICATION_EVENT_TYPES.includes(
        event.type as (typeof GAME_ELIGIBILITY_NOTIFICATION_EVENT_TYPES)[number],
      ),
    { message: 'Canonical events must use their notification event contract' },
  );

export const notificationSourceEventSchema = z.union([
  bookingNotificationSourceEventSchema,
  gameEligibilityNotificationSourceEventSchema,
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
      field: z.literal('recipientUserIds'),
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
