export const MIGRATION_ROLE_PROBE_SOURCE: string;
export function validateMigrationRoleReadback(
  value: unknown,
  kind: string,
  target: { systemIdentifier: string; databaseName: string },
  runtimeRole?: string,
): unknown;
