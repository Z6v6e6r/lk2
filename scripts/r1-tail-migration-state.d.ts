import type { R1TailCatalogs } from './r1-tail-migration-profile.js';
export const R1_TAIL_SAFE_ROLES_SQL: string;
export const R1_TAIL_STATE_SQL: string;
export function r1TailSourceCatalogs(expectedSha256: string): R1TailCatalogs;
export function validateR1TailState(
  operation: Record<string, unknown>,
  value: unknown,
  phase: string,
  count: number,
  catalogs?: R1TailCatalogs,
): unknown;
