export interface StagingRealtimeSmokeSessionOptions {
  readonly statePath: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly socketFactory?: (url: URL) => {
    addEventListener(
      type: string,
      listener: (event: { data?: unknown; code?: number }) => void,
    ): void;
    close(code?: number, reason?: string): void;
    send(value: string): void;
  };
  readonly randomUuid?: () => string;
  readonly now?: () => number;
  readonly failAfter?: 'pending-write' | 'refresh-response' | 'successor-write' | 'ticket-response';
}

export function runStagingRealtimeSmokeSession(
  options: StagingRealtimeSmokeSessionOptions,
): Promise<{ readonly status: 'passed'; readonly generation: number }>;
