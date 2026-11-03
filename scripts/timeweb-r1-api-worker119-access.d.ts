export function r1RuntimeAccessProbe(
  component: 'api' | 'worker',
  postgresAddresses: string[],
): string;
export function validateR1RuntimeAccess(
  capture: unknown,
  component: 'api' | 'worker',
  beforeGrants?: boolean,
): unknown;
