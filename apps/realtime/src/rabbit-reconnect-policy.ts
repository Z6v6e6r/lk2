export function rabbitReconnectDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(0, Math.min(Math.trunc(attempt), 6));
  return Math.min(10_000, 250 * 2 ** boundedAttempt);
}
