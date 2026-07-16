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
  if (deepLink && (!deepLink.startsWith('/') || deepLink.length > 2_000)) {
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
