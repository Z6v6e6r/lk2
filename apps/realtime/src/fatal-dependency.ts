import type { Logger } from 'pino';

interface ProcessController {
  readonly pid: number;
  exitCode: string | number | null | undefined;
  kill(pid: number, signal: NodeJS.Signals): boolean;
}

export function createFatalDependencyRestart(options: {
  readonly logger: Pick<Logger, 'fatal'>;
  readonly processController: ProcessController;
  readonly isShuttingDown: () => boolean;
  readonly markNotReady: () => void;
}): (message: string, error?: unknown) => void {
  let requested = false;
  return (message, error) => {
    if (requested || options.isShuttingDown()) return;
    requested = true;
    options.markNotReady();
    options.logger.fatal({ ...(error === undefined ? {} : { error }) }, message);
    options.processController.exitCode = 1;
    options.processController.kill(options.processController.pid, 'SIGTERM');
  };
}
