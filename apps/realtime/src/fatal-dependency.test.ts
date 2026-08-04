import { describe, expect, it, vi } from 'vitest';

import { createFatalDependencyRestart } from './fatal-dependency.js';

describe('fatal realtime dependency restart', () => {
  it('marks readiness false and requests one non-zero graceful termination', () => {
    const processController = { pid: 42, exitCode: undefined as number | undefined, kill: vi.fn() };
    const logger = { fatal: vi.fn() };
    const markNotReady = vi.fn();
    const restart = createFatalDependencyRestart({
      logger: logger as never,
      processController,
      isShuttingDown: () => false,
      markNotReady,
    });

    restart('RabbitMQ closed');
    restart('RabbitMQ emitted a duplicate error', new Error('duplicate'));

    expect(markNotReady).toHaveBeenCalledOnce();
    expect(logger.fatal).toHaveBeenCalledOnce();
    expect(processController.exitCode).toBe(1);
    expect(processController.kill).toHaveBeenCalledOnce();
    expect(processController.kill).toHaveBeenCalledWith(42, 'SIGTERM');
  });

  it('does not request a restart during an intentional shutdown', () => {
    const processController = { pid: 42, exitCode: undefined as number | undefined, kill: vi.fn() };
    const markNotReady = vi.fn();
    const restart = createFatalDependencyRestart({
      logger: { fatal: vi.fn() } as never,
      processController,
      isShuttingDown: () => true,
      markNotReady,
    });

    restart('RabbitMQ closed');

    expect(markNotReady).not.toHaveBeenCalled();
    expect(processController.kill).not.toHaveBeenCalled();
    expect(processController.exitCode).toBeUndefined();
  });
});
