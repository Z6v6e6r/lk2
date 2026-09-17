import { FULL_CLIENT_PERMISSIONS, isAdminOnlyPermission } from '@phub/auth';
import { createDatabasePool, withTenantTransaction } from '@phub/database';
import type { PoolClient, QueryResultRow } from 'pg';

/**
 * One-time backfill for the closed beta: every active user of the tenant receives the full client
 * permission catalog, so a tester can exercise profile, chats, games and communities without an
 * operator editing rights account by account.
 *
 * The environment must already run with `BETA_FULL_CLIENT_ACCESS_ENABLED=true`; the switch only
 * covers token issuance, and this script is what makes the grant durable in
 * `identity.user_access_profiles`. Existing permissions and roles are preserved, `admin` is never
 * granted, and admin-only permissions are never added. Dry-run is the default.
 */

const CONFIRMATION_TOKEN = 'APPLY_USER_ACCESS';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SAMPLE_LIMIT = 5;

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface UserAccessRow extends QueryResultRow {
  readonly id: string;
  readonly roles: string[] | null;
  readonly permissions: string[] | null;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function mergedAccess(row: UserAccessRow): { roles: string[]; permissions: string[] } {
  const roles = new Set(row.roles ?? []);
  roles.add('client');
  const permissions = new Set(row.permissions ?? []);
  for (const permission of FULL_CLIENT_PERMISSIONS) permissions.add(permission);
  for (const permission of permissions) {
    if (isAdminOnlyPermission(permission)) permissions.delete(permission);
  }
  roles.delete('admin');
  return { roles: [...roles].sort(), permissions: [...permissions].sort() };
}

function alreadyFull(row: UserAccessRow): boolean {
  const current = new Set(row.permissions ?? []);
  return FULL_CLIENT_PERMISSIONS.every((permission) => current.has(permission));
}

async function activeUsers(client: PoolClient, tenantId: string): Promise<UserAccessRow[]> {
  const result = await client.query<UserAccessRow>(
    `select u.id, a.roles, a.permissions
       from identity.users u
       left join identity.user_access_profiles a
         on a.tenant_id = u.tenant_id and a.user_id = u.id
      where u.tenant_id = $1 and u.status = 'ACTIVE'
      order by u.id`,
    [tenantId],
  );
  return result.rows;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const tenantKey = argument('tenant-key');
const actorId = argument('actor-id');
const confirm = argument('confirm');

if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}
if (process.env.BETA_FULL_CLIENT_ACCESS_ENABLED !== 'true') {
  throw new Error(
    'BETA_FULL_CLIENT_ACCESS_ENABLED must be true in this environment before granting beta access',
  );
}

const pool = createDatabasePool(connectionString);
try {
  const tenant = await pool.query<TenantRow>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Tenant was not found or is inactive');

  const outcome = await withTenantTransaction(pool, tenantId, async (client) => {
    const actor = await client.query(
      `select id
         from identity.users
        where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
      [tenantId, actorId],
    );
    if (actor.rowCount !== 1) throw new Error('Actor must be an active user in the tenant');

    const users = await activeUsers(client, tenantId);
    const pending = users.filter((user) => !alreadyFull(user));
    const applied = confirm === CONFIRMATION_TOKEN;
    if (!applied) return { users, pending, changed: 0 };

    for (const user of pending) {
      const desired = mergedAccess(user);
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `user-access:${tenantId}:${user.id}`,
      ]);
      await client.query(
        `insert into identity.user_access_profiles (
           tenant_id, user_id, roles, permissions, updated_by
         ) values ($1, $2, $3::text[], $4::text[], $5)
         on conflict (tenant_id, user_id) do update set
           roles = excluded.roles,
           permissions = excluded.permissions,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [tenantId, user.id, desired.roles, desired.permissions, actorId],
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
          user.id,
          `beta-full-client-access-${Date.now()}`,
          JSON.stringify({ roles: user.roles ?? [], permissions: user.permissions ?? [] }),
          JSON.stringify(desired),
        ],
      );
    }
    return { users, pending, changed: pending.length };
  });

  const report = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    fullClientPermissions: [...FULL_CLIENT_PERMISSIONS],
    activeUsers: outcome.users.length,
    usersAlreadyFull: outcome.users.length - outcome.pending.length,
    usersToChange: outcome.pending.length,
    changed: outcome.changed,
    sampleUserIds: outcome.pending.slice(0, SAMPLE_LIMIT).map((user) => user.id),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
  }
} finally {
  await pool.end();
}
