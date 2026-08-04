import { metrics } from '@opentelemetry/api';

export const REALTIME_METRIC_INSTRUMENTS = {
  activeConnections: 'phub.realtime.connections.active',
  rejectedConnections: 'phub.realtime.connections.rejected',
  authenticationAttempts: 'phub.realtime.authentication.attempts',
  communitySubscriptions: 'phub.realtime.communities.subscriptions',
  communityFanoutHints: 'phub.realtime.communities.fanout.hints',
  communityFanoutRecipients: 'phub.realtime.communities.fanout.recipients',
  communityFanoutFailures: 'phub.realtime.communities.fanout.failures',
  socketBackpressureClosures: 'phub.realtime.socket.backpressure_closures',
} as const;

export type RealtimeConnectionRejectionReason = 'capacity' | 'rate_limited' | 'unauthorized';
export type RealtimeSubscriptionOutcome =
  'accepted' | 'disabled' | 'invalid' | 'limit' | 'not_found';
export type RealtimeFanoutHintOutcome = 'accepted' | 'fanout_failed' | 'invalid';

export interface RealtimeMetricRecorder {
  recordConnectionOpened(): void;
  recordConnectionClosed(): void;
  recordConnectionRejected(reason: RealtimeConnectionRejectionReason): void;
  recordAuthentication(outcome: 'accepted' | 'rejected'): void;
  recordCommunitySubscription(outcome: RealtimeSubscriptionOutcome): void;
  recordCommunityFanout(recipients: number): void;
  recordCommunityFanoutHint(outcome: RealtimeFanoutHintOutcome): void;
  recordCommunityFanoutFailure(): void;
  recordSocketBackpressureClosure(): void;
}

export function createRealtimeMetricRecorder(): RealtimeMetricRecorder {
  const meter = metrics.getMeter('@phub/realtime');
  const activeConnections = meter.createUpDownCounter(
    REALTIME_METRIC_INSTRUMENTS.activeConnections,
  );
  const rejectedConnections = meter.createCounter(REALTIME_METRIC_INSTRUMENTS.rejectedConnections);
  const authenticationAttempts = meter.createCounter(
    REALTIME_METRIC_INSTRUMENTS.authenticationAttempts,
  );
  const communitySubscriptions = meter.createCounter(
    REALTIME_METRIC_INSTRUMENTS.communitySubscriptions,
  );
  const communityFanoutHints = meter.createCounter(
    REALTIME_METRIC_INSTRUMENTS.communityFanoutHints,
  );
  const communityFanoutRecipients = meter.createCounter(
    REALTIME_METRIC_INSTRUMENTS.communityFanoutRecipients,
  );
  const communityFanoutFailures = meter.createCounter(
    REALTIME_METRIC_INSTRUMENTS.communityFanoutFailures,
  );
  const socketBackpressureClosures = meter.createCounter(
    REALTIME_METRIC_INSTRUMENTS.socketBackpressureClosures,
  );

  return {
    recordConnectionOpened() {
      activeConnections.add(1);
    },
    recordConnectionClosed() {
      activeConnections.add(-1);
    },
    recordConnectionRejected(reason) {
      rejectedConnections.add(1, { reason });
    },
    recordAuthentication(outcome) {
      authenticationAttempts.add(1, { outcome });
    },
    recordCommunitySubscription(outcome) {
      communitySubscriptions.add(1, { outcome });
    },
    recordCommunityFanout(recipients) {
      if (recipients > 0) communityFanoutRecipients.add(recipients);
    },
    recordCommunityFanoutHint(outcome) {
      communityFanoutHints.add(1, { outcome });
    },
    recordCommunityFanoutFailure() {
      communityFanoutFailures.add(1);
    },
    recordSocketBackpressureClosure() {
      socketBackpressureClosures.add(1);
    },
  };
}
