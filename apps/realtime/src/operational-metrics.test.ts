import { describe, expect, it, vi } from 'vitest';

const instruments = vi.hoisted(() => ({
  add: vi.fn(),
  createCounter: vi.fn(),
  createUpDownCounter: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: instruments.createCounter.mockReturnValue({ add: instruments.add }),
      createUpDownCounter: instruments.createUpDownCounter.mockReturnValue({
        add: instruments.add,
      }),
    }),
  },
}));

import {
  createRealtimeMetricRecorder,
  REALTIME_METRIC_INSTRUMENTS,
} from './operational-metrics.js';

describe('realtime operational metrics', () => {
  it('uses bounded attributes and never accepts tenant, user or community identifiers', () => {
    const recorder = createRealtimeMetricRecorder({ instanceId: 'realtime-replica-a' });

    recorder.recordConnectionOpened();
    recorder.recordConnectionClosed();
    recorder.recordConnectionRejected('capacity');
    recorder.recordAuthentication('rejected');
    recorder.recordCommunitySubscription('not_found');
    recorder.recordCommunityFanout(12);
    recorder.recordCommunityFanoutHint('fanout_failed');
    recorder.recordCommunityFanoutFailure();
    recorder.recordSocketBackpressureClosure();

    expect(instruments.createUpDownCounter).toHaveBeenCalledWith(
      REALTIME_METRIC_INSTRUMENTS.activeConnections,
    );
    const instanceAttributes = { 'service.instance.id': 'realtime-replica-a' };
    expect(instruments.add.mock.calls).toEqual(
      expect.arrayContaining([
        [1, instanceAttributes],
        [-1, instanceAttributes],
        [1, { ...instanceAttributes, reason: 'capacity' }],
        [1, { ...instanceAttributes, outcome: 'rejected' }],
        [1, { ...instanceAttributes, outcome: 'not_found' }],
        [12, instanceAttributes],
        [1, { ...instanceAttributes, outcome: 'fanout_failed' }],
      ]),
    );
    expect(JSON.stringify(instruments.add.mock.calls)).not.toMatch(
      /tenant|user|community|session/i,
    );
  });
});
