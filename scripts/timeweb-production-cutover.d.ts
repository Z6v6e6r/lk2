export const ROSTER_CUTOVER_OPERATION: string;
export const ROSTER_CUTOVER_PLAN: string;
export const ROSTER_CUTOVER_RECEIPT: string;
export const ROSTER_CUTOVER_KIND: string;
export function legacyBaselineHash(baseline: unknown): string;
export function legacyEnvironment(
  baseline: unknown,
  bytes: Buffer,
  identity: unknown,
): Record<string, string>;
