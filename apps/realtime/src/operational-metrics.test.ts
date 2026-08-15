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
    const recorder = createRealtimeMetricRecorder();

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
    expect(instruments.add.mock.calls).toEqual(
      expect.arrayContaining([
        [1],
        [-1],
        [1, { reason: 'capacity' }],
        [1, { outcome: 'rejected' }],
        [1, { outcome: 'not_found' }],
        [12],
        [1, { outcome: 'fanout_failed' }],
      ]),
    );
    expect(JSON.stringify(instruments.add.mock.calls)).not.toMatch(
      /tenant|user|community|session/i,
    );
  });
});
