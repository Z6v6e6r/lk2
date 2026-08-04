import { describe, expect, it } from 'vitest';

import {
  collectLoadBudgetBreaches,
  type LoadMeasurementSummary,
} from './communities-load-budget.js';

function measurement(overrides: Partial<LoadMeasurementSummary> = {}): LoadMeasurementSummary {
  return {
    operations: 300,
    durationMs: 300,
    throughputRps: 1_000,
    p50Ms: 20,
    p95Ms: 100,
    p99Ms: 200,
    maxMs: 250,
    ...overrides,
  };
}

describe('Communities load budget reporting', () => {
  it('collects every journey breach instead of stopping at the first one', () => {
    const breaches = collectLoadBudgetBreaches([
      {
        name: 'Feed',
        result: measurement({ p95Ms: 250 }),
        p95TargetMs: 200,
        p99TargetMs: 450,
        minimumRps: 200,
      },
      {
        name: 'Recovery',
        result: measurement({ p99Ms: 500 }),
        p95TargetMs: 200,
        p99TargetMs: 450,
      },
      {
        name: 'Mixed read',
        result: measurement({ throughputRps: 700 }),
        p95TargetMs: 200,
        p99TargetMs: 450,
        minimumRps: 750,
      },
    ]);

    expect(breaches).toEqual([
      expect.objectContaining({ name: 'Feed', violations: ['p95'] }),
      expect.objectContaining({ name: 'Recovery', violations: ['p99'] }),
      expect.objectContaining({ name: 'Mixed read', violations: ['throughput'] }),
    ]);
  });

  it('returns no breaches when latency and throughput equal their limits', () => {
    expect(
      collectLoadBudgetBreaches([
        {
          name: 'Boundary',
          result: measurement({ p95Ms: 200, p99Ms: 450, throughputRps: 750 }),
          p95TargetMs: 200,
          p99TargetMs: 450,
          minimumRps: 750,
        },
      ]),
    ).toEqual([]);
  });
});
