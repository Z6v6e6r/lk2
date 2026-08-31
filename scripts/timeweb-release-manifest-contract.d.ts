export interface ExpectedTimewebPublication {
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: number;
}

export function validateCanonicalManifest(
  manifest: unknown,
  options?: {
    readonly expectedPublication?: ExpectedTimewebPublication;
    readonly expectedBaseLockPath?: string;
  },
): string;
