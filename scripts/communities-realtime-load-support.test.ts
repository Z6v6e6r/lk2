import { describe, expect, it } from 'vitest';

import {
  evaluateRealtimeLoadAssertions,
  matchesExpectedRealtimeEvent,
  realtimeLoadFixtureSchema,
  resolveRealtimeLoadPolicy,
  type RealtimeConnectionGateObservation,
} from './communities-realtime-load-support.js';

const expectedEvent = {
  communityId: '11111111-1111-4111-8111-111111111111',
  eventType: 'community.post.edited.v1',
  targetType: 'POST' as const,
  targetId: '22222222-2222-4222-8222-222222222222',
  targetRevision: 4,
  minimumSequence: 10,
};

function observation(
  overrides: Partial<RealtimeConnectionGateObservation> = {},
): RealtimeConnectionGateObservation {
  return {
    expectedEventDeliveries: 1,
    unexpectedClose: false,
    unauthorizedDeliveries: 0,
    deniedSubscriptionRequired: false,
    deniedSubscriptionVerified: false,
    slowClient: false,
    ...overrides,
  };
}

describe('Communities realtime load gate support', () => {
  it('requires an exact external expected-event contract', () => {
    expect(() =>
      realtimeLoadFixtureSchema.parse({
        expectedOrigin: 'wss://staging.padlhub.test',
        connections: [
          {
            ticket: 'x'.repeat(32),
            communityId: expectedEvent.communityId,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      realtimeLoadFixtureSchema.parse({
        expectedOrigin: 'wss://staging.padlhub.test',
        connections: [
          {
            ticket: 'x'.repeat(32),
            communityId: '33333333-3333-4333-8333-333333333333',
          },
        ],
        expectedEvent,
      }),
    ).toThrow('every connection must subscribe to the expected hot community');
    expect(
      matchesExpectedRealtimeEvent(
        {
          type: 'community.event',
          communityId: expectedEvent.communityId,
          eventType: expectedEvent.eventType,
          targetType: expectedEvent.targetType,
          targetId: expectedEvent.targetId,
          targetRevision: 4,
          sequence: 10,
        },
        expectedEvent,
      ),
    ).toBe(true);
    expect(
      matchesExpectedRealtimeEvent(
        {
          type: 'community.event',
          communityId: expectedEvent.communityId,
          eventType: expectedEvent.eventType,
          targetType: expectedEvent.targetType,
          targetId: '33333333-3333-4333-8333-333333333333',
          targetRevision: 4,
          sequence: 10,
        },
        expectedEvent,
      ),
    ).toBe(false);
  });

  it('defaults external certification to a thirty-minute hold and mandatory failure probes', () => {
    expect(resolveRealtimeLoadPolicy({ loopback: false, environment: {} })).toEqual({
      certification: true,
      holdMs: 1_800_000,
      minimumReconnects: 1_000,
      minimumReconnectRatePerSecond: 1_000,
      requireDeniedSubscription: true,
      requireSlowClient: true,
    });
    expect(resolveRealtimeLoadPolicy({ loopback: true, environment: {} })).toMatchObject({
      certification: false,
      holdMs: 60_000,
      minimumReconnects: 0,
    });
    expect(() =>
      resolveRealtimeLoadPolicy({
        loopback: false,
        environment: { COMMUNITIES_REALTIME_HOLD_MS: '60000' },
      }),
    ).toThrow('Certification hold must be at least 30 minutes');
    expect(() =>
      resolveRealtimeLoadPolicy({
        loopback: false,
        environment: { COMMUNITIES_REALTIME_REQUIRE_SLOW_CLIENT: 'false' },
      }),
    ).toThrow('Certification requires a slow-client probe');
  });

  it('fails when total deliveries hide a connection with no expected event', () => {
    const policy = resolveRealtimeLoadPolicy({
      loopback: true,
      environment: { COMMUNITIES_REALTIME_HOLD_MS: '1000' },
    });
    expect(
      evaluateRealtimeLoadAssertions({
        policy,
        observations: [
          observation({ expectedEventDeliveries: 2 }),
          observation({ expectedEventDeliveries: 0 }),
        ],
        reconnects: 0,
        reconnectRatePerSecond: 0,
      }),
    ).toContain('expected_event_missing_on_connections:1');
  });

  it('fails closed when certification probes or reconnect rate are absent', () => {
    const policy = resolveRealtimeLoadPolicy({ loopback: false, environment: {} });
    expect(
      evaluateRealtimeLoadAssertions({
        policy,
        observations: [observation()],
        reconnects: 999,
        reconnectRatePerSecond: 999,
      }),
    ).toEqual(
      expect.arrayContaining([
        'denied_subscription_probe_missing',
        'slow_client_probe_missing',
        'reconnect_count_below_target:999',
        'reconnect_rate_below_target:999',
      ]),
    );
  });

  it('detects denied-subscription, slow-client and cross-tenant failures', () => {
    const policy = resolveRealtimeLoadPolicy({
      loopback: true,
      environment: {
        COMMUNITIES_REALTIME_REQUIRE_DENIED_SUBSCRIPTION: 'true',
        COMMUNITIES_REALTIME_REQUIRE_SLOW_CLIENT: 'true',
      },
    });
    expect(
      evaluateRealtimeLoadAssertions({
        policy,
        observations: [
          observation({
            deniedSubscriptionRequired: true,
            deniedSubscriptionVerified: false,
            unauthorizedDeliveries: 1,
          }),
          observation({ slowClient: true, slowClientCloseCode: 1000 }),
        ],
        reconnects: 0,
        reconnectRatePerSecond: 0,
      }),
    ).toEqual(
      expect.arrayContaining([
        'unauthorized_cross_tenant_deliveries:1',
        'denied_subscription_probe_failed:1',
        'slow_client_not_shed:1',
      ]),
    );
  });
});
