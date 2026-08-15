import { DatabaseRoleBoundaryError, verifyDatabaseRoleBoundary } from './database-role-boundary.js';

const runtimeConnectionStringInput = process.env.RUNTIME_DATABASE_URL;
const migratorConnectionStringInput = process.env.MIGRATOR_DATABASE_URL;
const phase = process.env.DATABASE_ROLE_BOUNDARY_PHASE;
const scope = process.env.DATABASE_ROLE_BOUNDARY_SCOPE ?? 'core';
const databaseOverride = process.env.DATABASE_ROLE_BOUNDARY_DATABASE_OVERRIDE;

function withDatabaseOverride(connectionString: string, database: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

if (phase !== 'pre' && phase !== 'post') {
  process.stderr.write('DATABASE_ROLE_BOUNDARY_PHASE_REQUIRED\n');
  process.exitCode = 64;
} else if (scope !== 'core' && scope !== 'media') {
  process.stderr.write('DATABASE_ROLE_BOUNDARY_SCOPE_INVALID\n');
  process.exitCode = 64;
} else if (
  databaseOverride !== undefined &&
  (scope !== 'media' || !/^phub_restore_[0-9]+(?:_[0-9]+)*$/.test(databaseOverride))
) {
  process.stderr.write('DATABASE_ROLE_BOUNDARY_DATABASE_OVERRIDE_INVALID\n');
  process.exitCode = 64;
} else if (!runtimeConnectionStringInput || !migratorConnectionStringInput) {
  process.stderr.write('DATABASE_ROLE_BOUNDARY_ENV_REQUIRED\n');
  process.exitCode = 64;
} else {
  try {
    const runtimeConnectionString = databaseOverride
      ? withDatabaseOverride(runtimeConnectionStringInput, databaseOverride)
      : runtimeConnectionStringInput;
    const migratorConnectionString = databaseOverride
      ? withDatabaseOverride(migratorConnectionStringInput, databaseOverride)
      : migratorConnectionStringInput;
    await verifyDatabaseRoleBoundary({
      runtimeConnectionString,
      migratorConnectionString,
      phase,
      scope,
    });
    process.stdout.write(
      `${JSON.stringify({
        result: 'PASS',
        phase,
        scope,
        databaseTargetIdentical: true,
        rolesDistinct: true,
        runtimeRestricted: true,
        migratorDdlReady: true,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof DatabaseRoleBoundaryError ? error.code : 'DATABASE_ROLE_BOUNDARY_CHECK_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
