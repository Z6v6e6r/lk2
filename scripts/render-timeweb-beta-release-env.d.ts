export interface ExpectedPublicationIdentity {
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: string;
}

export function renderReleaseEnvironment(
  manifest: unknown,
  expected: ExpectedPublicationIdentity,
): string;
