import { describe, expect, it, vi } from 'vitest';

import {
  calculateWorkerForwardProgressMaxStaleMs,
  createRabbitFailureHandler,
  WorkerForwardProgressTracker,
} from './worker-runtime-health.js';

describe('worker forward progress readiness', () => {
  it('stays unready until a complete cycle succeeds and fails closed after failure or stall', () => {
    const tracker = new WorkerForwardProgressTracker(30_000);

    expect(tracker.snapshot(1_000)).toMatchObject({ ready: false, state: 'starting' });

    tracker.markCycleStarted(2_000);
    expect(tracker.snapshot(2_001)).toMatchObject({ ready: false, state: 'starting' });

    tracker.markCycleSucceeded(3_000);
    expect(tracker.snapshot(3_001)).toMatchObject({ ready: true, state: 'healthy' });

    tracker.markCycleStarted(4_000);
    expect(tracker.snapshot(4_001)).toMatchObject({ ready: true, state: 'running' });

    tracker.markCycleFailed(5_000);
    expect(tracker.snapshot(5_001)).toMatchObject({ ready: false, state: 'failed' });

    tracker.markCycleStarted(6_000);
    tracker.markCycleSucceeded(7_000);
    expect(tracker.snapshot(37_001)).toMatchObject({ ready: false, state: 'stalled' });
  });

  it('derives a bounded threshold from the existing poll and confirm settings', () => {
    expect(
      calculateWorkerForwardProgressMaxStaleMs({
        pollIntervalMs: 1_000,
        confirmTimeoutMs: 10_000,
      }),
    ).toBe(30_000);
    expect(
      calculateWorkerForwardProgressMaxStaleMs({
        pollIntervalMs: 60_000,
        confirmTimeoutMs: 10_000,
      }),
    ).toBe(180_000);
  });
});

describe('RabbitMQ terminal failure handling', () => {
  it('marks Rabbit unavailable and requests exactly one supervisor restart', async () => {
    const logger = { error: vi.fn() };
    const markUnavailable = vi.fn();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const handleFailure = createRabbitFailureHandler({
      logger: logger as never,
      isShuttingDown: () => false,
      markUnavailable,
      terminate,
    });

    handleFailure('error', new Error('socket lost'));
    handleFailure('close');
    await Promise.resolve();

    expect(markUnavailable).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('error');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'error' }),
      expect.stringContaining('supervisor restart'),
    );
  });

  it('does not recursively terminate during an intentional shutdown', () => {
    const terminate = vi.fn();
    const handleFailure = createRabbitFailureHandler({
      logger: { error: vi.fn() } as never,
      isShuttingDown: () => true,
      markUnavailable: vi.fn(),
      terminate,
    });

    handleFailure('close');

    expect(terminate).not.toHaveBeenCalled();
  });
});
