import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const eventType = z.string().regex(/^[a-z][a-z0-9_.-]+\.v[1-9][0-9]*$/);

export const notificationSourceEventSchema = z
  .object({
    id: uuid,
    type: eventType,
    aggregateId: uuid,
    tenantId: uuid,
    occurredAt: dateTime,
    correlationId: z.string().min(8).max(128),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type NotificationSourceEvent = z.infer<typeof notificationSourceEventSchema>;

export const notificationAudienceSelectorSchema = z
  .object({
    type: z.literal('EVENT_USER'),
    field: z.enum(['userId', 'recipientUserId']),
  })
  .strict();

export type NotificationAudienceSelector = z.infer<typeof notificationAudienceSelectorSchema>;

export function resolveNotificationRecipients(
  event: NotificationSourceEvent,
  selector: NotificationAudienceSelector,
): readonly string[] {
  const recipient = event.payload[selector.field];
  return typeof recipient === 'string' && uuid.safeParse(recipient).success ? [recipient] : [];
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

export type PushDeliveryResult =
  | { readonly outcome: 'accepted'; readonly externalMessageId?: string }
  | { readonly outcome: 'retryable_failure'; readonly errorCode: string }
  | {
      readonly outcome: 'terminal_failure';
      readonly errorCode: string;
      readonly invalidate: boolean;
    };

export interface NotificationPushDeliveryPort {
  readonly platform: NotificationPushPlatform;
  send(request: PushDeliveryRequest): Promise<PushDeliveryResult>;
}

const webPushKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .min(16)
  .max(256);

export const webPushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => new URL(value).protocol === 'https:', 'Web Push endpoint must use HTTPS'),
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
