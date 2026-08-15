import { metrics } from '@opentelemetry/api';

export const REALTIME_METRIC_INSTRUMENTS = {
  consumerReady: 'phub.realtime.consumer.ready',
  consumerFailures: 'phub.realtime.consumer.failures',
  rabbitReconnects: 'phub.realtime.rabbitmq.reconnects',
  processHeartbeatUnixTime: 'phub.realtime.process.heartbeat_unixtime',
  processExpectedReplicas: 'phub.realtime.process.expected_replicas',
  quarantinedEvents: 'phub.realtime.quarantine.events',
  projectedEvents: 'phub.realtime.fanout.projected_events',
  deliveredHints: 'phub.realtime.fanout.delivered_hints',
} as const;

export interface RealtimeMetricRecorder {
  recordHeartbeat(): void;
  recordConsumerReady(ready: boolean): void;
  recordConsumerFailure(): void;
  recordRabbitReconnect(): void;
  recordQuarantinedEvent(): void;
  recordProjectedEvent(deliveredHints: number): void;
}

export function createRealtimeMetricRecorder(options: {
  readonly instanceId: string;
  readonly expectedReplicas: number;
  readonly now?: () => number;
}): RealtimeMetricRecorder {
  const meter = metrics.getMeter('@phub/realtime');
  const consumerReady = meter.createGauge(REALTIME_METRIC_INSTRUMENTS.consumerReady);
  const consumerFailures = meter.createCounter(REALTIME_METRIC_INSTRUMENTS.consumerFailures);
  const rabbitReconnects = meter.createCounter(REALTIME_METRIC_INSTRUMENTS.rabbitReconnects);
  const processHeartbeatUnixTime = meter.createGauge(
    REALTIME_METRIC_INSTRUMENTS.processHeartbeatUnixTime,
  );
  const processExpectedReplicas = meter.createGauge(
    REALTIME_METRIC_INSTRUMENTS.processExpectedReplicas,
  );
  const quarantinedEvents = meter.createCounter(REALTIME_METRIC_INSTRUMENTS.quarantinedEvents);
  const projectedEvents = meter.createCounter(REALTIME_METRIC_INSTRUMENTS.projectedEvents);
  const deliveredHints = meter.createCounter(REALTIME_METRIC_INSTRUMENTS.deliveredHints);
  const attributes = {
    'service.instance.id': options.instanceId,
  };

  return {
    recordHeartbeat() {
      processHeartbeatUnixTime.record(
        Math.floor((options.now?.() ?? Date.now()) / 1_000),
        attributes,
      );
      processExpectedReplicas.record(options.expectedReplicas, attributes);
    },
    recordConsumerReady(ready) {
      consumerReady.record(ready ? 1 : 0, attributes);
    },
    recordConsumerFailure() {
      consumerFailures.add(1, attributes);
    },
    recordRabbitReconnect() {
      rabbitReconnects.add(1, attributes);
    },
    recordQuarantinedEvent() {
      quarantinedEvents.add(1, attributes);
    },
    recordProjectedEvent(deliveredCount) {
      projectedEvents.add(1, attributes);
      if (deliveredCount > 0) deliveredHints.add(deliveredCount, attributes);
    },
  };
}
