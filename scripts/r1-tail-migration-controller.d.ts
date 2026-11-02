export const R1_TAIL_ROOT: string;
export const R1_TAIL_REQUEST: string;
export function r1TailPaths(operation: unknown): Readonly<Record<string, string>>;
export function validateR1TailOperation(value: unknown, at?: number): unknown;
export function runR1TailAdapter(
  mode: string,
  bytes: Buffer,
  ops: Record<string, unknown>,
): Promise<unknown>;
