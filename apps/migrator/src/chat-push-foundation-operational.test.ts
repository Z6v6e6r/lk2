import { describe, expect, it } from 'vitest';

import {
  assertFoundationPrometheusCollectionSuccess,
  assertFoundationPrometheusGaugePresent,
  assertFoundationPrometheusHeartbeat,
  assertFoundationPrometheusRules,
  assertFoundationPrometheusTargets,
  assertFoundationRabbitInventory,
} from './chat-push-foundation-operational.js';

function rabbitInventory() {
  return {
    queues: [
      {
        name: 'phub.notification-intent-projector.v1',
        durable: true,
        type: 'quorum',
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': 5,
          'x-dead-letter-exchange': 'phub.dead-letter',
        },
        messages_ready: 0,
        messages_unacknowledged: 0,
      },
      {
        name: 'phub.dead-letter.v1',
        durable: true,
        type: 'quorum',
        arguments: { 'x-queue-type': 'quorum' },
        messages_ready: 0,
        messages_unacknowledged: 0,
      },
    ],
    bindings: [
      ['', 'phub.notification-intent-projector.v1', 'phub.notification-intent-projector.v1'],
      ['', 'phub.dead-letter.v1', 'phub.dead-letter.v1'],
      ['phub.events', 'phub.notification-intent-projector.v1', 'booking.confirmed.v1'],
      ['phub.events', 'phub.notification-intent-projector.v1', 'booking.changed.v1'],
      ['phub.events', 'phub.notification-intent-projector.v1', 'booking.cancelled.v1'],
      ['phub.dead-letter', 'phub.dead-letter.v1', '#'],
    ].map(([source_name, destination_name, routing_key]) => ({
      source_name,
      destination_name,
      destination_kind: 'queue',
      routing_key,
    })),
  };
}

describe('chat/push foundation operational inventory', () => {
  it('accepts only the exact queue arguments and explicit booking bindings', () => {
    expect(assertFoundationRabbitInventory(rabbitInventory(), { requireQueues: true })).toEqual({
      queueCount: 2,
      bindingCount: 6,
    });

    const wildcard = rabbitInventory();
    wildcard.bindings.push({
      source_name: 'phub.events',
      destination_name: 'phub.notification-intent-projector.v1',
      destination_kind: 'queue',
      routing_key: '#',
    });
    expect(() => assertFoundationRabbitInventory(wildcard, { requireQueues: true })).toThrow(
      'CHAT_PUSH_FOUNDATION_RABBIT_BINDING_MISMATCH',
    );

    const wrongDeliveryLimit = rabbitInventory();
    wrongDeliveryLimit.queues[0]!.arguments['x-delivery-limit'] = 50;
    expect(() =>
      assertFoundationRabbitInventory(wrongDeliveryLimit, { requireQueues: true }),
    ).toThrow('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_ARGUMENT_MISMATCH');
  });

  it('allows both queues to be absent only before the candidate worker starts', () => {
    expect(
      assertFoundationRabbitInventory({ queues: [], bindings: [] }, { requireQueues: false }),
    ).toEqual({ queueCount: 0, bindingCount: 0 });
    expect(() =>
      assertFoundationRabbitInventory({ queues: [], bindings: [] }, { requireQueues: true }),
    ).toThrow('CHAT_PUSH_FOUNDATION_RABBIT_QUEUE_INVENTORY_MISMATCH');
  });

  it('requires healthy, freshly evaluated alert rules', () => {
    const nowMs = Date.parse('2026-08-15T12:00:00.000Z');
    const response = {
      status: 'success',
      data: {
        groups: [
          {
            rules: ['PadlHubWebPushCircuitOpen', 'PadlHubBookingReminderDelayed'].map((name) => ({
              name,
              type: 'alerting',
              query:
                name === 'PadlHubWebPushCircuitOpen'
                  ? 'sum by (environment) (increase(phub_worker_web_push_provider_outcomes_total{outcome="WEB_PUSH_CIRCUIT_OPEN"}[5m])) > 0'
                  : 'phub_worker_notifications_booking_reminder_oldest_due_age_seconds > 60',
              duration: name === 'PadlHubWebPushCircuitOpen' ? 60 : 120,
              labels: {
                severity: name === 'PadlHubWebPushCircuitOpen' ? 'p1' : 'p2',
                component: 'worker',
              },
              state: 'inactive',
              alerts: [] as Record<string, unknown>[],
              health: 'ok',
              lastError: '',
              lastEvaluation: '2026-08-15T11:59:30.000Z',
            })),
          },
        ],
      },
    };
    expect(assertFoundationPrometheusRules(response, { nowMs })).toEqual({ ruleCount: 2 });

    response.data.groups[0]!.rules[0]!.health = 'err';
    expect(() => assertFoundationPrometheusRules(response, { nowMs })).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_UNHEALTHY',
    );
    response.data.groups[0]!.rules[0]!.health = 'ok';
    response.data.groups[0]!.rules[0]!.state = 'firing';
    response.data.groups[0]!.rules[0]!.alerts = [{}];
    expect(() => assertFoundationPrometheusRules(response, { nowMs })).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_SHAPE_MISMATCH',
    );
    response.data.groups[0]!.rules[0]!.state = 'inactive';
    response.data.groups[0]!.rules[0]!.alerts = [];
    response.data.groups[0]!.rules[0]!.query = 'vector(0)';
    expect(() => assertFoundationPrometheusRules(response, { nowMs })).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_SHAPE_MISMATCH',
    );
    response.data.groups[0]!.rules[0]!.query =
      'sum by (environment) (increase(phub_worker_web_push_provider_outcomes_total{outcome="WEB_PUSH_CIRCUIT_OPEN"}[5m])) > 0';
    response.data.groups[0]!.rules[0]!.lastEvaluation = '2026-08-15T11:50:00.000Z';
    expect(() => assertFoundationPrometheusRules(response, { nowMs })).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_RULE_STALE',
    );
  });

  it('requires the exact fresh and healthy OTEL collector scrape target', () => {
    const nowMs = Date.parse('2026-08-15T12:00:00.000Z');
    const response = {
      status: 'success',
      data: {
        activeTargets: [
          {
            scrapePool: 'otel-collector',
            scrapeUrl: 'http://otel-collector:8889/metrics',
            health: 'up',
            lastError: '',
            lastScrape: '2026-08-15T11:59:45.000Z',
          },
        ],
      },
    };
    expect(assertFoundationPrometheusTargets(response, { nowMs })).toEqual({ targetCount: 1 });

    response.data.activeTargets[0]!.health = 'down';
    expect(() => assertFoundationPrometheusTargets(response, { nowMs })).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_TARGET_UNHEALTHY',
    );
    response.data.activeTargets[0]!.health = 'up';
    response.data.activeTargets[0]!.lastScrape = '2026-08-15T11:55:00.000Z';
    expect(() => assertFoundationPrometheusTargets(response, { nowMs })).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_TARGET_STALE',
    );
    response.data.activeTargets = [];
    expect(() => assertFoundationPrometheusTargets(response, { nowMs })).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_TARGET_INVENTORY_MISMATCH',
    );
  });

  it('requires a post-start heartbeat value from the exact candidate worker instance', () => {
    const nowMs = Date.parse('2026-08-15T12:00:00.000Z');
    const response = {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: {}, value: [nowMs / 1_000, String(nowMs / 1_000 - 15)] }],
      },
    };
    expect(
      assertFoundationPrometheusHeartbeat(response, {
        nowMs,
        minimumUnixTime: nowMs / 1_000 - 30,
      }),
    ).toEqual({ heartbeatUnixTime: nowMs / 1_000 - 15 });

    response.data.result[0]!.value[1] = String(nowMs / 1_000 - 300);
    expect(() =>
      assertFoundationPrometheusHeartbeat(response, {
        nowMs,
        minimumUnixTime: nowMs / 1_000 - 30,
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_PROMETHEUS_HEARTBEAT_STALE');
    response.data.result[0]!.value[1] = String(nowMs / 1_000 - 15);
    expect(() =>
      assertFoundationPrometheusHeartbeat(response, {
        nowMs,
        minimumUnixTime: nowMs / 1_000 - 10,
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_PROMETHEUS_HEARTBEAT_STALE');
    response.data.result = [];
    expect(() =>
      assertFoundationPrometheusHeartbeat(response, {
        nowMs,
        minimumUnixTime: nowMs / 1_000 - 30,
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_PROMETHEUS_SERIES_MISSING');
  });

  it('rejects fresh failed collection values and requires the booking gauge', () => {
    const response = {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: {}, value: [1_777_777_777, '1'] }],
      },
    };
    expect(() => assertFoundationPrometheusCollectionSuccess(response)).not.toThrow();
    expect(() => assertFoundationPrometheusGaugePresent(response)).not.toThrow();

    response.data.result[0]!.value[1] = '0';
    expect(() => assertFoundationPrometheusCollectionSuccess(response)).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_COLLECTION_FAILED',
    );
    response.data.result = [];
    expect(() => assertFoundationPrometheusGaugePresent(response)).toThrow(
      'CHAT_PUSH_FOUNDATION_PROMETHEUS_SERIES_MISSING',
    );
  });
});
