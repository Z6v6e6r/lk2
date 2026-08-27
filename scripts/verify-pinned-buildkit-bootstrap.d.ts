export interface CommandResult {
  readonly status: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: { readonly code?: string };
}

export interface CommandSummary {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly errorCode: string | null;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly stderrBytes: number;
  readonly stderrSha256: string;
}

export interface ContainerState {
  readonly image: string;
  readonly status: string;
  readonly running: boolean;
  readonly restarting: boolean;
  readonly exitCode: number;
}

export interface BootstrapAttempt {
  readonly number: number;
  readonly buildxInspect: CommandSummary;
  readonly observedVersions: readonly string[];
  readonly containerInspect: CommandSummary;
  readonly containerState: ContainerState | null;
}

export interface BootstrapDiagnostic {
  readonly schemaVersion: 1;
  readonly kind: 'phub-buildkit-bootstrap-readiness';
  readonly service: 'api' | 'web';
  readonly builder: string;
  readonly expected: { readonly image: string; readonly version: string };
  readonly maxAttempts: 3;
  readonly attemptCount: number;
  readonly reason: string;
  readonly verified: boolean;
  readonly attempts: readonly BootstrapAttempt[];
  readonly pushed: false;
  readonly authorizesPublication: false;
  readonly authorizesDeploy: false;
}

export class BuildkitBootstrapError extends Error {
  readonly reason: string;
}

export function summarizeCommand(result: CommandResult): CommandSummary;
export function verifyPinnedBuildkitBootstrap(
  input: {
    readonly service: 'api' | 'web';
    readonly builder: string;
    readonly image: string;
    readonly version: string;
    readonly diagnosticPath: string;
  },
  dependencies?: {
    readonly runCommand?: (
      command: string,
      arguments_: readonly string[],
      timeoutMs: number,
    ) => CommandResult;
    readonly sleep?: (delayMs: number) => Promise<void>;
  },
): Promise<BootstrapDiagnostic>;
