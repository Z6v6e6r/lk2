import { DatabaseRoleBoundaryError, verifyDatabaseRoleBoundary } from './database-role-boundary.js';

const runtimeConnectionString = process.env.RUNTIME_DATABASE_URL;
const migratorConnectionString = process.env.MIGRATOR_DATABASE_URL;
const phase = process.env.DATABASE_ROLE_BOUNDARY_PHASE;

if (phase !== 'pre' && phase !== 'post') {
  process.stderr.write('DATABASE_ROLE_BOUNDARY_PHASE_REQUIRED\n');
  process.exitCode = 64;
} else if (!runtimeConnectionString || !migratorConnectionString) {
  process.stderr.write('DATABASE_ROLE_BOUNDARY_ENV_REQUIRED\n');
  process.exitCode = 64;
} else {
  try {
    await verifyDatabaseRoleBoundary({ runtimeConnectionString, migratorConnectionString, phase });
    process.stdout.write(
      `${JSON.stringify({
        result: 'PASS',
        phase,
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
