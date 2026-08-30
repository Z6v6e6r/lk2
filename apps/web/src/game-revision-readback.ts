export type GameRevisionReadbackResult<T extends { readonly revision: number }> =
  | { readonly status: 'converged'; readonly game: T }
  | { readonly status: 'updating'; readonly game?: T }
  | { readonly status: 'unavailable'; readonly error: unknown };

export async function waitForGameRevision<T extends { readonly revision: number }>(input: {
  readonly load: () => Promise<T>;
  readonly minimumRevision: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}): Promise<GameRevisionReadbackResult<T>> {
  const now = input.now ?? Date.now;
  const delay =
    input.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const deadline = now() + Math.max(1_000, input.timeoutMs ?? 30_000);
  let delayMs = 250;
  let latest: T | undefined;
  let lastError: unknown;

  for (;;) {
    try {
      latest = await input.load();
      lastError = undefined;
      if (latest.revision >= input.minimumRevision) {
        return { status: 'converged', game: latest };
      }
    } catch (error) {
      lastError = error;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      if (latest) return { status: 'updating', game: latest };
      return { status: 'unavailable', error: lastError };
    }
    await delay(Math.min(delayMs, remainingMs));
    delayMs = Math.min(delayMs * 2, 2_000);
  }
}
