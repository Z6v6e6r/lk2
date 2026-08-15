import { MediaRuntimeRoleProbeError, verifyMediaRuntimeRole } from './media-runtime-role-probe.js';

const runtimeConnectionString = process.env.RUNTIME_DATABASE_URL;
const databaseOverride = process.env.MEDIA_RUNTIME_DATABASE_OVERRIDE;
const tenantKey = process.env.MEDIA_RUNTIME_TENANT_KEY;

function withDatabaseOverride(connectionString: string, database: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

if (databaseOverride !== undefined && !/^phub_restore_[0-9]+(?:_[0-9]+)*$/.test(databaseOverride)) {
  process.stderr.write('MEDIA_RUNTIME_DATABASE_OVERRIDE_INVALID\n');
  process.exitCode = 64;
} else if (!runtimeConnectionString) {
  process.stderr.write('MEDIA_RUNTIME_DATABASE_URL_REQUIRED\n');
  process.exitCode = 64;
} else if (!tenantKey || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenantKey)) {
  process.stderr.write('MEDIA_RUNTIME_TENANT_KEY_REQUIRED\n');
  process.exitCode = 64;
} else {
  try {
    await verifyMediaRuntimeRole({
      connectionString: databaseOverride
        ? withDatabaseOverride(runtimeConnectionString, databaseOverride)
        : runtimeConnectionString,
      tenantKey,
    });
    process.stdout.write(
      `${JSON.stringify({
        result: 'PASS',
        tenantDml: true,
        crossTenantReadHidden: true,
        crossTenantWriteRejected: true,
        tenantKeyBound: true,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof MediaRuntimeRoleProbeError ? error.code : 'MEDIA_RUNTIME_ROLE_PROBE_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
