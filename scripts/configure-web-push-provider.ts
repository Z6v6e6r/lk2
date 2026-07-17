import { createDatabasePool, queryOne, withTenantTransaction } from '@phub/database';
import type { QueryResultRow } from 'pg';

const CONFIRMATION_TOKEN = 'APPLY_WEB_PUSH_PROVIDER';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface ProviderRow extends QueryResultRow {
  readonly id: string;
  readonly status: 'ACTIVE' | 'DISABLED' | 'DEGRADED';
  readonly credential_ref: string;
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
const appId = argument('app-id') ?? 'padlhub-web';
const environment = argument('environment') ?? 'SANDBOX';
const desiredState = argument('state');
const credentialRef = argument('credential-ref') ?? 'env:WEB_PUSH_VAPID_PRIVATE_KEY';
const confirm = argument('confirm');

if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}
if (appId.length < 1 || appId.length > 300) throw new Error('--app-id must have 1-300 characters');
if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
  throw new Error('--environment must be SANDBOX or PRODUCTION');
}
if (desiredState !== 'on' && desiredState !== 'off') {
  throw new Error('--state must be on or off');
}
if (credentialRef.trim().length < 1 || credentialRef.length > 500) {
  throw new Error('--credential-ref must have 1-500 characters');
}

const desiredStatus = desiredState === 'on' ? 'ACTIVE' : 'DISABLED';
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
    return queryOne<ProviderRow>(
      client,
      `select id, status, credential_ref
         from integration.notification_provider_accounts
        where tenant_id = $1
          and channel = 'PUSH'
          and platform = 'WEB'
          and provider = 'WEB_PUSH'
          and app_id = $2
          and environment = $3`,
      [tenantId, appId, environment],
    );
  });

  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    appId,
    environment,
    currentStatus: current?.status ?? null,
    desiredStatus,
    credentialSource: credentialRef.split(':', 1)[0],
  };
  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    const providerId = await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `web-push-provider:${tenantId}:${appId}:${environment}`,
      ]);
      const actor = await client.query(
        `select 1
           from identity.users
          where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
        [tenantId, actorId],
      );
      if (actor.rowCount === 0) throw new Error('Actor is not an active user in the tenant');

      const lockedCurrent = await queryOne<ProviderRow>(
        client,
        `select id, status, credential_ref
           from integration.notification_provider_accounts
          where tenant_id = $1
            and channel = 'PUSH'
            and platform = 'WEB'
            and provider = 'WEB_PUSH'
            and app_id = $2
            and environment = $3
          for update`,
        [tenantId, appId, environment],
      );
      const provider = await queryOne<ProviderRow>(
        client,
        `insert into integration.notification_provider_accounts (
           tenant_id, channel, platform, provider, app_id, environment, credential_ref, status
         ) values ($1, 'PUSH', 'WEB', 'WEB_PUSH', $2, $3, $4, $5)
         on conflict (tenant_id, channel, platform, provider, app_id, environment) do update set
           credential_ref = excluded.credential_ref,
           status = excluded.status,
           updated_at = now()
         returning id, status, credential_ref`,
        [tenantId, appId, environment, credentialRef, desiredStatus],
      );
      if (!provider) throw new Error('WEB_PUSH_PROVIDER_WRITE_LOST');

      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, old_value, new_value
         ) values ($1, $2, 'WEB_PUSH_PROVIDER_CHANGED', 'NOTIFICATION_PROVIDER_ACCOUNT', $3,
                   'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
        [
          tenantId,
          actorId,
          provider.id,
          `web-push-provider-${Date.now()}`,
          JSON.stringify(
            lockedCurrent
              ? {
                  status: lockedCurrent.status,
                  credentialSource: lockedCurrent.credential_ref.split(':', 1)[0],
                }
              : null,
          ),
          JSON.stringify({
            status: desiredStatus,
            appId,
            environment,
            credentialSource: credentialRef.split(':', 1)[0],
          }),
        ],
      );
      return provider.id;
    });
    process.stdout.write(`${JSON.stringify({ ...preview, providerId, applied: true }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
