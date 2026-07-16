import { describe, expect, it } from 'vitest';

import {
  notificationAudienceSelectorSchema,
  notificationSourceEventSchema,
  renderNotificationTemplate,
  resolveNotificationRecipients,
} from './index.js';

const event = notificationSourceEventSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'game.starting-soon.v1',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  tenantId: '33333333-3333-4333-8333-333333333333',
  occurredAt: '2026-07-16T12:00:00.000Z',
  correlationId: 'notification-test-123',
  payload: {
    recipientUserId: '44444444-4444-4444-8444-444444444444',
    game: { title: 'Игра на Селигерской' },
    startsAt: '19:00',
  },
});

describe('notification domain contracts', () => {
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
  });
});
