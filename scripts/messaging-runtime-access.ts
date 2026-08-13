import type { PoolClient } from 'pg';

export async function assertCommsOperatorAccess(
  client: Pick<PoolClient, 'query'>,
  tenantId: string,
  actorId: string,
): Promise<void> {
  const authorized = await client.query(
    `select 1
       from identity.users actor
       join identity.user_access_profiles access
         on access.tenant_id = actor.tenant_id and access.user_id = actor.id
      where actor.tenant_id = $1
        and actor.id = $2
        and actor.status = 'ACTIVE'
        and 'admin' = any(access.roles)
        and 'notifications.manage' = any(access.permissions)`,
    [tenantId, actorId],
  );
  if (authorized.rowCount !== 1) throw new Error('ADMIN_PERMISSION_REQUIRED');
}
