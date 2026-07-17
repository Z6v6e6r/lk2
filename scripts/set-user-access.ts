import { createDatabasePool, queryOne, withTenantTransaction } from '@phub/database';
import type { QueryResultRow } from 'pg';

const CONFIRMATION_TOKEN = 'APPLY_USER_ACCESS';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ACCESS_VALUE_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface AccessRow extends QueryResultRow {
  readonly roles: string[];
  readonly permissions: string[];
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function listArgument(name: string): readonly string[] {
  const values = (argument(name) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.some((value) => !ACCESS_VALUE_PATTERN.test(value))) {
    throw new Error(`--${name} must contain comma-separated access identifiers`);
  }
  return [...new Set(values)].sort();
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const tenantKey = argument('tenant-key');
const actorId = argument('actor-id');
const userId = argument('user-id');
const roles = listArgument('roles');
const permissions = listArgument('permissions');
const confirm = argument('confirm');

if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}
if (!userId || !UUID_PATTERN.test(userId)) {
  throw new Error('--user-id must be an active PadlHub user UUID in the tenant');
}

const pool = createDatabasePool(connectionString);
try {
  const tenant = await pool.query<TenantRow>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Tenant was not found or is inactive');

  const current = await withTenantTransaction(pool, tenantId, async (client) => {
    const users = await client.query(
      `select id
         from identity.users
        where tenant_id = $1 and id = any($2::uuid[]) and status = 'ACTIVE'`,
      [tenantId, [...new Set([actorId, userId])]],
    );
    if (users.rowCount !== new Set([actorId, userId]).size) {
      throw new Error('Actor and target must be active users in the tenant');
    }
    return queryOne<AccessRow>(
      client,
      `select roles, permissions
         from identity.user_access_profiles
        where tenant_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
  });

  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    userId,
    current: current ?? { roles: ['client'], permissions: ['profile.read'] },
    desired: { roles, permissions },
  };
  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `user-access:${tenantId}:${userId}`,
      ]);
      const users = await client.query(
        `select id
           from identity.users
          where tenant_id = $1 and id = any($2::uuid[]) and status = 'ACTIVE'`,
        [tenantId, [...new Set([actorId, userId])]],
      );
      if (users.rowCount !== new Set([actorId, userId]).size) {
        throw new Error('Actor and target must be active users in the tenant');
      }
      const locked = await queryOne<AccessRow>(
        client,
        `select roles, permissions
           from identity.user_access_profiles
          where tenant_id = $1 and user_id = $2
          for update`,
        [tenantId, userId],
      );
      await client.query(
        `insert into identity.user_access_profiles (
           tenant_id, user_id, roles, permissions, updated_by
         ) values ($1, $2, $3::text[], $4::text[], $5)
         on conflict (tenant_id, user_id) do update set
           roles = excluded.roles,
           permissions = excluded.permissions,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [tenantId, userId, roles, permissions, actorId],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, old_value, new_value
         ) values ($1, $2, 'USER_ACCESS_CHANGED', 'USER_ACCESS', $3,
                   'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
        [
          tenantId,
          actorId,
          userId,
          `user-access-${Date.now()}`,
          JSON.stringify(locked ?? { roles: ['client'], permissions: ['profile.read'] }),
          JSON.stringify({ roles, permissions }),
        ],
      );
    });
    process.stdout.write(`${JSON.stringify({ ...preview, applied: true }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
