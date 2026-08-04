import { z } from 'zod';

const connectionSchema = z
  .object({
    ticket: z.string().min(32).max(4_096),
    reconnectTicket: z.string().min(32).max(4_096).optional(),
    communityId: z.string().uuid(),
    deniedCommunityId: z.string().uuid().optional(),
    slowClient: z.boolean().default(false),
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.deniedCommunityId === connection.communityId) {
      context.addIssue({
        code: 'custom',
        message: 'deniedCommunityId must differ from communityId',
        path: ['deniedCommunityId'],
      });
    }
    if (connection.slowClient && connection.reconnectTicket) {
      context.addIssue({
        code: 'custom',
        message: 'a slow-client probe cannot also be a reconnect probe',
        path: ['slowClient'],
      });
    }
  });

export const realtimeLoadFixtureSchema = z
  .object({
    connections: z.array(connectionSchema).min(1).max(20_000),
    expectedEvent: z
      .object({
        communityId: z.string().uuid(),
        eventType: z.string().min(1).max(128),
        targetType: z.enum(['POST', 'COMMENT', 'REACTION']),
        targetId: z.string().uuid(),
        targetRevision: z.number().int().positive().safe().optional(),
        minimumSequence: z.number().int().positive().safe().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, context) => {
    for (const [index, connection] of fixture.connections.entries()) {
      if (connection.communityId !== fixture.expectedEvent.communityId) {
        context.addIssue({
          code: 'custom',
          message: 'every connection must subscribe to the expected hot community',
          path: ['connections', index, 'communityId'],
        });
      }
    }
  });

export type RealtimeLoadFixture = z.infer<typeof realtimeLoadFixtureSchema>;
export type ExpectedRealtimeEvent = RealtimeLoadFixture['expectedEvent'];

function environmentBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = environment[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function environmentInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export interface RealtimeLoadPolicy {
  readonly certification: boolean;
  readonly holdMs: number;
  readonly minimumReconnects: number;
  readonly minimumReconnectRatePerSecond: number;
  readonly requireDeniedSubscription: boolean;
  readonly requireSlowClient: boolean;
}

export function resolveRealtimeLoadPolicy(input: {
  readonly loopback: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}): RealtimeLoadPolicy {
  const environment = input.environment ?? process.env;
  const certification = environmentBoolean(
    environment,
    'COMMUNITIES_REALTIME_CERTIFICATION',
    !input.loopback,
  );
  const policy = {
    certification,
    holdMs: environmentInteger(
      environment,
      'COMMUNITIES_REALTIME_HOLD_MS',
      certification ? 30 * 60_000 : 60_000,
      1_000,
      3_600_000,
    ),
    minimumReconnects: environmentInteger(
      environment,
      'COMMUNITIES_REALTIME_MIN_RECONNECTS',
      certification ? 1_000 : 0,
      0,
      20_000,
    ),
    minimumReconnectRatePerSecond: environmentInteger(
      environment,
      'COMMUNITIES_REALTIME_MIN_RECONNECT_RATE_PER_SECOND',
      certification ? 1_000 : 0,
      0,
      20_000,
    ),
    requireDeniedSubscription: environmentBoolean(
      environment,
      'COMMUNITIES_REALTIME_REQUIRE_DENIED_SUBSCRIPTION',
      certification,
    ),
    requireSlowClient: environmentBoolean(
      environment,
      'COMMUNITIES_REALTIME_REQUIRE_SLOW_CLIENT',
      certification,
    ),
  };
  if (certification && policy.holdMs < 30 * 60_000) {
    throw new Error('Certification hold must be at least 30 minutes');
  }
  if (certification && policy.minimumReconnects < 1_000) {
    throw new Error('Certification requires at least 1,000 reconnects');
  }
  if (certification && policy.minimumReconnectRatePerSecond < 1_000) {
    throw new Error('Certification reconnect rate must be at least 1,000 connections/second');
  }
  if (certification && !policy.requireDeniedSubscription) {
    throw new Error('Certification requires a denied-subscription probe');
  }
  if (certification && !policy.requireSlowClient) {
    throw new Error('Certification requires a slow-client probe');
  }
  return policy;
}

export function matchesExpectedRealtimeEvent(
  event: Record<string, unknown>,
  expected: ExpectedRealtimeEvent,
): boolean {
  return (
    event.type === 'community.event' &&
    event.communityId === expected.communityId &&
    event.eventType === expected.eventType &&
    event.targetType === expected.targetType &&
    event.targetId === expected.targetId &&
    (expected.targetRevision === undefined || event.targetRevision === expected.targetRevision) &&
    (expected.minimumSequence === undefined ||
      (typeof event.sequence === 'number' && event.sequence >= expected.minimumSequence))
  );
}

export interface RealtimeConnectionGateObservation {
  readonly expectedEventDeliveries: number;
  readonly unexpectedClose: boolean;
  readonly unauthorizedDeliveries: number;
  readonly deniedSubscriptionRequired: boolean;
  readonly deniedSubscriptionVerified: boolean;
  readonly slowClient: boolean;
  readonly slowClientCloseCode?: number;
}

export function evaluateRealtimeLoadAssertions(input: {
  readonly policy: RealtimeLoadPolicy;
  readonly observations: readonly RealtimeConnectionGateObservation[];
  readonly reconnects: number;
  readonly reconnectRatePerSecond: number;
}): readonly string[] {
  const failures: string[] = [];
  const eventMissing = input.observations.filter(
    (observation) => !observation.slowClient && observation.expectedEventDeliveries < 1,
  ).length;
  if (eventMissing > 0) failures.push(`expected_event_missing_on_connections:${eventMissing}`);
  const unexpectedCloses = input.observations.filter(
    (observation) => observation.unexpectedClose,
  ).length;
  if (unexpectedCloses > 0) failures.push(`unexpected_closes:${unexpectedCloses}`);
  const unauthorizedDeliveries = input.observations.reduce(
    (sum, observation) => sum + observation.unauthorizedDeliveries,
    0,
  );
  if (unauthorizedDeliveries > 0) {
    failures.push(`unauthorized_cross_tenant_deliveries:${unauthorizedDeliveries}`);
  }
  const deniedProbes = input.observations.filter(
    (observation) => observation.deniedSubscriptionRequired,
  );
  if (input.policy.requireDeniedSubscription && deniedProbes.length === 0) {
    failures.push('denied_subscription_probe_missing');
  }
  const deniedFailures = deniedProbes.filter(
    (observation) => !observation.deniedSubscriptionVerified,
  ).length;
  if (deniedFailures > 0) failures.push(`denied_subscription_probe_failed:${deniedFailures}`);
  const slowProbes = input.observations.filter((observation) => observation.slowClient);
  if (input.policy.requireSlowClient && slowProbes.length === 0) {
    failures.push('slow_client_probe_missing');
  }
  const slowFailures = slowProbes.filter(
    (observation) => observation.slowClientCloseCode !== 1013,
  ).length;
  if (slowFailures > 0) failures.push(`slow_client_not_shed:${slowFailures}`);
  if (input.reconnects < input.policy.minimumReconnects) {
    failures.push(`reconnect_count_below_target:${input.reconnects}`);
  }
  if (input.reconnectRatePerSecond < input.policy.minimumReconnectRatePerSecond) {
    failures.push(`reconnect_rate_below_target:${Math.round(input.reconnectRatePerSecond)}`);
  }
  return failures;
}
