import { beforeEach, describe, expect, it, vi } from 'vitest';

const instruments = vi.hoisted(() => ({
  gaugeRecord: vi.fn(),
  counterAdd: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createGauge: (name: string) => ({
        record: (value: number, attributes?: Readonly<Record<string, string>>) => {
          instruments.gaugeRecord(name, value, attributes);
        },
      }),
      createCounter: (name: string) => ({
        add: (value: number, attributes?: Readonly<Record<string, string>>) => {
          instruments.counterAdd(name, value, attributes);
        },
      }),
    }),
  },
}));

import { createRealtimeMetricRecorder, REALTIME_METRIC_INSTRUMENTS } from './realtime-metrics.js';

describe('realtime metrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a content-free timestamp heartbeat with the process instance label', () => {
    const recorder = createRealtimeMetricRecorder({
      instanceId: 'realtime-replica-1',
      expectedReplicas: 2,
      now: () => 123_456,
    });

    recorder.recordHeartbeat();

    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      REALTIME_METRIC_INSTRUMENTS.processHeartbeatUnixTime,
      123,
      { 'service.instance.id': 'realtime-replica-1' },
    );
    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      REALTIME_METRIC_INSTRUMENTS.processExpectedReplicas,
      2,
      { 'service.instance.id': 'realtime-replica-1' },
    );

    recorder.recordConsumerReady(true);
    recorder.recordConsumerFailure();
    recorder.recordRabbitReconnect();
    recorder.recordQuarantinedEvent();
    recorder.recordProjectedEvent(3);

    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      REALTIME_METRIC_INSTRUMENTS.consumerReady,
      1,
      { 'service.instance.id': 'realtime-replica-1' },
    );
    for (const instrument of [
      REALTIME_METRIC_INSTRUMENTS.consumerFailures,
      REALTIME_METRIC_INSTRUMENTS.rabbitReconnects,
      REALTIME_METRIC_INSTRUMENTS.quarantinedEvents,
      REALTIME_METRIC_INSTRUMENTS.projectedEvents,
    ]) {
      expect(instruments.counterAdd).toHaveBeenCalledWith(instrument, 1, {
        'service.instance.id': 'realtime-replica-1',
      });
    }
    expect(instruments.counterAdd).toHaveBeenCalledWith(
      REALTIME_METRIC_INSTRUMENTS.deliveredHints,
      3,
      { 'service.instance.id': 'realtime-replica-1' },
    );
  });
});
