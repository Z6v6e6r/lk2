import { describe, expect, it } from 'vitest';

import {
  MAX_NOTIFICATION_EVENT_RECIPIENTS,
  bookingNotificationSourceEventSchema,
  canonicalWebPushEndpoint,
  canonicalWebPushSubscription,
  createNotificationEndpointCipher,
  isWebPushEndpointOriginAllowed,
  gameEligibilityNotificationSourceEventSchema,
  notificationAudienceSelectorSchema,
  notificationSourceEventSchema,
  renderNotificationTemplate,
  resolveNotificationRecipients,
  webPushSubscriptionSchema,
  type NotificationMessengerDeliveryPort,
} from './index.js';

const legacyRecipientUserId = '44444444-4444-4444-8444-444444444444';
const event = notificationSourceEventSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'game.starting-soon.v1',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  tenantId: '33333333-3333-4333-8333-333333333333',
  occurredAt: '2026-07-16T12:00:00.000Z',
  correlationId: 'notification-test-123',
  payload: {
    recipientUserId: legacyRecipientUserId,
    game: { title: 'Игра на Селигерской' },
    startsAt: '19:00',
  },
});

describe('Web Push endpoint protection', () => {
  it('validates and canonicalizes the browser subscription shape', () => {
    const subscription = webPushSubscriptionSchema.parse({
      endpoint: 'https://PUSH.EXAMPLE.TEST:443/subscriptions/abc',
      expirationTime: null,
      keys: {
        p256dh: 'B'.repeat(65),
        auth: 'a'.repeat(22),
      },
    });
    expect(canonicalWebPushSubscription(subscription)).toBe(
      `{"endpoint":"https://push.example.test/subscriptions/abc","expirationTime":null,"keys":{"p256dh":"${'B'.repeat(
        65,
      )}","auth":"${'a'.repeat(22)}"}}`,
    );
    expect(subscription.endpoint).toBe('https://push.example.test/subscriptions/abc');
    expect(canonicalWebPushEndpoint('https://push.example.test:443/subscriptions/abc')).toBe(
      subscription.endpoint,
    );
  });

  it('matches only exact trusted endpoint origins', () => {
    const allowedOrigins = ['https://fcm.googleapis.com', 'https://push.example.test'];

    expect(
      isWebPushEndpointOriginAllowed(
        'https://fcm.googleapis.com/fcm/send/opaque-capability',
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isWebPushEndpointOriginAllowed(
        'https://push.example.test:443/subscriptions/abc',
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isWebPushEndpointOriginAllowed(
        'https://fcm.googleapis.com.evil.test/fcm/send/abc',
        allowedOrigins,
      ),
    ).toBe(false);
    expect(isWebPushEndpointOriginAllowed('https://127.0.0.1/internal', allowedOrigins)).toBe(
      false,
    );
    expect(
      isWebPushEndpointOriginAllowed(
        'https://user:secret@push.example.test/subscriptions/abc',
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      isWebPushEndpointOriginAllowed(
        'https://push.example.test/subscriptions/abc#internal',
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      isWebPushEndpointOriginAllowed(
        'https://push.example.test:8443/subscriptions/abc',
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it('rejects an endpoint whose canonical URL expands beyond the storage limit', () => {
    const expandedEndpoint = `https://push.example.test/${'é'.repeat(900)}`;
    expect(expandedEndpoint.length).toBeLessThan(2_048);
    expect(canonicalWebPushEndpoint(expandedEndpoint)).toBeUndefined();
    expect(
      webPushSubscriptionSchema.safeParse({
        endpoint: expandedEndpoint,
        expirationTime: null,
        keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) },
      }).success,
    ).toBe(false);
  });

  it('encrypts endpoint material with key IDs and rejects tampering', () => {
    const cipher = createNotificationEndpointCipher({
      serializedKeys: JSON.stringify({
        previous: Buffer.alloc(32, 1).toString('base64'),
        current: Buffer.alloc(32, 2).toString('base64'),
      }),
      activeKeyId: 'current',
    });
    const encrypted = cipher.encrypt('subscription-secret');
    expect(encrypted.keyId).toBe('current');
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('subscription-secret');
    expect(cipher.decrypt(encrypted.ciphertext, encrypted.keyId)).toBe('subscription-secret');

    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[15] = (tampered[15] ?? 0) ^ 1;
    expect(() => cipher.decrypt(tampered, encrypted.keyId)).toThrow();
  });
});

describe('notification domain contracts', () => {
  it('validates the waitlist promotion denial notification contract', () => {
    const gameId = '22222222-2222-4222-8222-222222222222';
    const parsed = gameEligibilityNotificationSourceEventSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'game.waitlist.promotion.denied.v1',
      aggregateId: gameId,
      tenantId: '33333333-3333-4333-8333-333333333333',
      occurredAt: '2026-08-24T12:00:00.000Z',
      correlationId: 'eligibility-notification-test',
      payload: {
        gameId,
        aggregateRevision: '4',
        causationId: '44444444-4444-4444-8444-444444444444',
        actorUserId: null,
        userId: '55555555-5555-4555-8555-555555555555',
        waitlistEntryId: '66666666-6666-4666-8666-666666666666',
        decisionId: '77777777-7777-4777-8777-777777777777',
        reasonCode: 'LEVEL_TOO_LOW',
      },
    });

    expect(resolveNotificationRecipients(parsed, { type: 'EVENT_USER', field: 'userId' })).toEqual([
      parsed.payload.userId,
    ]);
    expect(() =>
      notificationSourceEventSchema.parse({
        ...parsed,
        aggregateId: '88888888-8888-4888-8888-888888888888',
      }),
    ).toThrow();
  });

  it('keeps MAX messenger delivery outside the push platform contract', async () => {
    const port: NotificationMessengerDeliveryPort = {
      connector: 'MAX',
      send: (request) =>
        Promise.resolve({
          outcome: 'terminal_failure',
          errorCode: request.connector === 'MAX' ? 'MAX_RUNTIME_DISABLED' : 'CONNECTOR_INVALID',
          invalidate: false,
        }),
    };

    await expect(
      port.send({
        tenantId: '11111111-1111-4111-8111-111111111111',
        deliveryId: '22222222-2222-4222-8222-222222222222',
        providerAccountId: '33333333-3333-4333-8333-333333333333',
        connector: 'MAX',
        target: { kind: 'USER', externalId: 'opaque-max-user-id' },
        notification: { id: '44444444-4444-4444-8444-444444444444', text: 'safe preview' },
        providerIdempotencyKey: 'max-delivery-contract-test-0001',
      }),
    ).resolves.toEqual({
      outcome: 'terminal_failure',
      errorCode: 'MAX_RUNTIME_DISABLED',
      invalidate: false,
    });
    expect(port).not.toHaveProperty('platform');
  });

  it('resolves only a PadlHub UUID selected by the active rule', () => {
    const selector = notificationAudienceSelectorSchema.parse({
      type: 'EVENT_USER',
      field: 'recipientUserId',
    });
    expect(resolveNotificationRecipients(event, selector)).toEqual([
      '44444444-4444-4444-8444-444444444444',
    ]);
    expect(resolveNotificationRecipients({ ...event, payload: {} }, selector)).toEqual([]);
  });

  it('resolves bounded multi-recipient audiences and keeps EVENT_USER compatible', () => {
    const selector = notificationAudienceSelectorSchema.parse({
      type: 'EVENT_USERS',
      field: 'recipientUserIds',
    });
    const secondUserId = '55555555-5555-4555-8555-555555555555';
    expect(
      resolveNotificationRecipients(
        {
          ...event,
          payload: {
            recipientUserIds: [legacyRecipientUserId, secondUserId, secondUserId],
          },
        },
        selector,
      ),
    ).toEqual([legacyRecipientUserId, secondUserId]);
    expect(
      resolveNotificationRecipients(
        {
          ...event,
          payload: {
            recipientUserIds: Array.from(
              { length: MAX_NOTIFICATION_EVENT_RECIPIENTS + 1 },
              (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            ),
          },
        },
        selector,
      ),
    ).toEqual([]);
  });

  it('validates canonical booking notification events and normalizes recipients', () => {
    const bookingId = '66666666-6666-4666-8666-666666666666';
    const userId = '77777777-7777-4777-8777-777777777777';
    const parsed = bookingNotificationSourceEventSchema.parse({
      id: '88888888-8888-4888-8888-888888888888',
      type: 'booking.cancelled.v1',
      aggregateId: bookingId,
      tenantId: event.tenantId,
      occurredAt: event.occurredAt,
      correlationId: 'booking-notification-test',
      payload: {
        bookingId,
        revision: '3',
        recipientUserIds: [userId, userId],
        serviceTitle: 'Тренировка по паделу',
        startsAt: '2026-08-05T16:00:00+03:00',
        timezone: 'Europe/Moscow',
        locationName: 'ПаделхАБ Селигерская',
        reasonCode: 'VENUE_REQUEST',
      },
    });
    expect(parsed.payload.recipientUserIds).toEqual([userId]);

    expect(() =>
      notificationSourceEventSchema.parse({
        ...parsed,
        aggregateId: '99999999-9999-4999-8999-999999999999',
      }),
    ).toThrow();
    expect(() =>
      notificationSourceEventSchema.parse({
        ...parsed,
        payload: { ...parsed.payload, revision: '0' },
      }),
    ).toThrow();
  });

  it('renders a bounded snapshot and requires an internal deep link', () => {
    expect(
      renderNotificationTemplate({
        titleTemplate: '{{ game.title }}',
        bodyTemplate: 'Начало в {{startsAt}}',
        deepLinkTemplate: '/games/{{aggregateId}}',
        payload: { ...event.payload, aggregateId: event.aggregateId },
      }),
    ).toEqual({
      title: 'Игра на Селигерской',
      body: 'Начало в 19:00',
      deepLink: '/games/22222222-2222-4222-8222-222222222222',
    });

    expect(() =>
      renderNotificationTemplate({
        titleTemplate: 'Игра',
        bodyTemplate: '{{missing}}',
        deepLinkTemplate: 'https://example.test/redirect',
        payload: {},
      }),
    ).toThrow('NOTIFICATION_TEMPLATE_VALUE_MISSING');
    expect(() =>
      renderNotificationTemplate({
        titleTemplate: 'Игра',
        bodyTemplate: 'Открыть',
        deepLinkTemplate: '//evil.example.test',
        payload: {},
      }),
    ).toThrow('NOTIFICATION_DEEP_LINK_INVALID');
    expect(() =>
      renderNotificationTemplate({
        titleTemplate: 'Игра',
        bodyTemplate: 'Открыть',
        deepLinkTemplate: '/\\evil.example.test',
        payload: {},
      }),
    ).toThrow('NOTIFICATION_DEEP_LINK_INVALID');
  });
});
