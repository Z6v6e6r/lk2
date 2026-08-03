import type { Logger } from 'pino';

export type WorkerCoreCycleState = 'starting' | 'running' | 'healthy' | 'failed' | 'stalled';

export interface WorkerForwardProgressSnapshot {
  readonly ready: boolean;
  readonly state: WorkerCoreCycleState;
  readonly lastProgressAgeMs: number | null;
  readonly maxStaleMs: number;
}

export function calculateWorkerForwardProgressMaxStaleMs(options: {
  readonly pollIntervalMs: number;
  readonly confirmTimeoutMs: number;
}): number {
  return Math.max(30_000, options.pollIntervalMs * 3, options.confirmTimeoutMs * 2);
}

export class WorkerForwardProgressTracker {
  private cycleInProgress = false;
  private lastProgressAt: number | undefined;
  private lastSuccessfulCycleAt: number | undefined;
  private lastFailedCycleAt: number | undefined;

  constructor(private readonly maxStaleMs: number) {}

  markCycleStarted(now = Date.now()): void {
    this.cycleInProgress = true;
    this.lastProgressAt = now;
  }

  markProgress(now = Date.now()): void {
    this.lastProgressAt = now;
  }

  markCycleSucceeded(now = Date.now()): void {
    this.cycleInProgress = false;
    this.lastProgressAt = now;
    this.lastSuccessfulCycleAt = now;
  }

  markCycleFailed(now = Date.now()): void {
    this.cycleInProgress = false;
    this.lastProgressAt = now;
    this.lastFailedCycleAt = now;
  }

  snapshot(now = Date.now()): WorkerForwardProgressSnapshot {
    const lastProgressAgeMs =
      this.lastProgressAt === undefined ? null : Math.max(0, now - this.lastProgressAt);
    const hasSuccessfulCycle = this.lastSuccessfulCycleAt !== undefined;
    const latestCycleFailed =
      this.lastFailedCycleAt !== undefined &&
      (this.lastSuccessfulCycleAt === undefined ||
        this.lastFailedCycleAt >= this.lastSuccessfulCycleAt);
    const progressIsFresh = lastProgressAgeMs !== null && lastProgressAgeMs <= this.maxStaleMs;
    const ready = hasSuccessfulCycle && !latestCycleFailed && progressIsFresh;

    let state: WorkerCoreCycleState;
    if (latestCycleFailed) state = 'failed';
    else if (!hasSuccessfulCycle) state = 'starting';
    else if (!progressIsFresh) state = 'stalled';
    else if (this.cycleInProgress) state = 'running';
    else state = 'healthy';

    return { ready, state, lastProgressAgeMs, maxStaleMs: this.maxStaleMs };
  }
}

export type RabbitFailureReason = 'close' | 'error';

export function createRabbitFailureHandler(options: {
  readonly logger: Pick<Logger, 'error'>;
  readonly isShuttingDown: () => boolean;
  readonly markUnavailable: () => void;
  readonly terminate: (reason: RabbitFailureReason) => void | Promise<void>;
}): (reason: RabbitFailureReason, error?: Error) => void {
  let terminationRequested = false;

  return (reason, error): void => {
    options.markUnavailable();
    if (options.isShuttingDown() || terminationRequested) return;
    terminationRequested = true;
    options.logger.error(
      error ? { err: error, reason } : { reason },
      'RabbitMQ connection became unavailable; terminating worker for supervisor restart',
    );
    void Promise.resolve(options.terminate(reason)).catch((terminationError: unknown) => {
      options.logger.error(
        { err: terminationError, reason },
        'worker termination after RabbitMQ failure did not complete cleanly',
      );
    });
  };
}
