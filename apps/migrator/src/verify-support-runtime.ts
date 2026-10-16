import {
  assertSupportDatabaseConnection,
  openSupportTicketRuntimePool,
  SUPPORT_DATABASE_OWNER_ROLE,
} from '@phub/database/support-activation';
let pool;
try {
  if (!process.env.PHUB_SUPPORT_PRIMARY_TARGET || !process.env.DATABASE_URL) throw Error();
  const target = assertSupportDatabaseConnection(
    process.env.PHUB_SUPPORT_PRIMARY_TARGET,
    process.env.DATABASE_URL,
  );
  pool = await openSupportTicketRuntimePool(
    process.env.PHUB_SUPPORT_PRIMARY_TARGET,
    process.env.DATABASE_URL,
  );
  process.stdout.write(
    `${JSON.stringify({ schema: 'PHUB_SUPPORT_RUNTIME_ATTESTATION_V1', result: 'PASS', databaseName: target.databaseName, runtimeRoleName: target.runtimeRoleName, ownerRoleName: SUPPORT_DATABASE_OWNER_ROLE })}\n`,
  );
} catch {
  process.stderr.write('SUPPORT_RUNTIME_VERIFICATION_STOP\n');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
