import { createDatabasePool, queryOne, withTenantTransaction } from '@phub/database';
import type { QueryResultRow } from 'pg';

const CONFIRMATION_TOKEN = 'APPLY_NOTIFICATION_RUNTIME';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface RuntimeRow extends QueryResultRow {
  readonly in_app_enabled: boolean;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const tenantKey = argument('tenant-key');
const actorId = argument('actor-id');
const inApp = argument('in-app');
const confirm = argument('confirm');
if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}
if (inApp !== 'on' && inApp !== 'off') throw new Error('--in-app must be on or off');

const desired = inApp === 'on';
const pool = createDatabasePool(connectionString);
try {
  const tenant = await pool.query<TenantRow>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Tenant was not found or is inactive');

  const current = await withTenantTransaction(pool, tenantId, async (client) => {
    const actor = await client.query(
      `select 1
         from identity.users
        where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
      [tenantId, actorId],
    );
    if (actor.rowCount === 0) throw new Error('Actor is not an active user in the tenant');
    return queryOne<RuntimeRow>(
      client,
      `select in_app_enabled
         from notifications.tenant_runtime_settings
        where tenant_id = $1`,
      [tenantId],
    );
  });
  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    currentInAppEnabled: current?.in_app_enabled ?? false,
    desiredInAppEnabled: desired,
  };
  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `notification-runtime:${tenantId}`,
      ]);
      const actor = await client.query(
        `select 1
           from identity.users
          where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
        [tenantId, actorId],
      );
      if (actor.rowCount === 0) throw new Error('Actor is not an active user in the tenant');

      const lockedCurrent = await queryOne<RuntimeRow>(
        client,
        `select in_app_enabled
           from notifications.tenant_runtime_settings
          where tenant_id = $1
          for update`,
        [tenantId],
      );

      await client.query(
        `insert into notifications.tenant_runtime_settings (
           tenant_id, in_app_enabled, updated_by
         ) values ($1, $2, $3)
         on conflict (tenant_id) do update set
           in_app_enabled = excluded.in_app_enabled,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [tenantId, desired, actorId],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, old_value, new_value
         ) values ($1, $2, 'NOTIFICATION_RUNTIME_CHANGED', 'TENANT', $1,
                   'SUCCESS', $3, $4::jsonb, $5::jsonb)`,
        [
          tenantId,
          actorId,
          `notification-runtime-${Date.now()}`,
          JSON.stringify({ inAppEnabled: lockedCurrent?.in_app_enabled ?? false }),
          JSON.stringify({ inAppEnabled: desired }),
        ],
      );
    });
    process.stdout.write(`${JSON.stringify({ ...preview, applied: true }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
