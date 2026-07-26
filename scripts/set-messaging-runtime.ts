import { createDatabasePool, queryOne, withTenantTransaction } from '@phub/database';
import type { QueryResultRow } from 'pg';

const CONFIRMATION_TOKEN = 'APPLY_MESSAGING_RUNTIME';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface RuntimeRow extends QueryResultRow {
  readonly http_enabled: boolean;
  readonly direct_enabled: boolean;
  readonly realtime_enabled: boolean;
  readonly contextual_enabled: boolean;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function gate(name: string): 'on' | 'off' | 'keep' {
  const value = argument(name) ?? 'keep';
  if (value !== 'on' && value !== 'off' && value !== 'keep') {
    throw new Error(`--${name} must be on, off or keep`);
  }
  return value;
}

function desired(value: 'on' | 'off' | 'keep', current: boolean): boolean {
  return value === 'keep' ? current : value === 'on';
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const tenantKey = argument('tenant-key');
const actorId = argument('actor-id');
const http = gate('http');
const direct = gate('direct');
const realtime = gate('realtime');
const contextual = gate('contextual');
const confirm = argument('confirm');
if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}
if ([http, direct, realtime, contextual].every((value) => value === 'keep')) {
  throw new Error('At least one messaging gate must be on or off');
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
    const actor = await client.query(
      `select 1
         from identity.users
        where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
      [tenantId, actorId],
    );
    if (actor.rowCount === 0) throw new Error('Actor is not an active user in the tenant');
    return queryOne<RuntimeRow>(
      client,
      `select http_enabled, direct_enabled, realtime_enabled, contextual_enabled
         from messaging.tenant_runtime_settings
        where tenant_id = $1`,
      [tenantId],
    );
  });

  const currentState = {
    httpEnabled: current?.http_enabled ?? false,
    directEnabled: current?.direct_enabled ?? false,
    realtimeEnabled: current?.realtime_enabled ?? false,
    contextualEnabled: current?.contextual_enabled ?? false,
  };
  const desiredState = {
    httpEnabled: desired(http, currentState.httpEnabled),
    directEnabled: desired(direct, currentState.directEnabled),
    realtimeEnabled: desired(realtime, currentState.realtimeEnabled),
    contextualEnabled: desired(contextual, currentState.contextualEnabled),
  };
  if (
    !desiredState.httpEnabled &&
    (desiredState.directEnabled || desiredState.realtimeEnabled || desiredState.contextualEnabled)
  ) {
    throw new Error('Direct, realtime and contextual gates require --http=on');
  }

  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    current: currentState,
    desired: desiredState,
  };
  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `messaging-runtime:${tenantId}`,
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
        `select http_enabled, direct_enabled, realtime_enabled, contextual_enabled
           from messaging.tenant_runtime_settings
          where tenant_id = $1
          for update`,
        [tenantId],
      );
      await client.query(
        `insert into messaging.tenant_runtime_settings (
           tenant_id, http_enabled, direct_enabled, realtime_enabled,
           contextual_enabled, updated_by
         ) values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id) do update set
           http_enabled = excluded.http_enabled,
           direct_enabled = excluded.direct_enabled,
           realtime_enabled = excluded.realtime_enabled,
           contextual_enabled = excluded.contextual_enabled,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [
          tenantId,
          desiredState.httpEnabled,
          desiredState.directEnabled,
          desiredState.realtimeEnabled,
          desiredState.contextualEnabled,
          actorId,
        ],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, old_value, new_value
         ) values ($1, $2, 'MESSAGING_RUNTIME_CHANGED', 'TENANT', $1,
                   'SUCCESS', $3, $4::jsonb, $5::jsonb)`,
        [
          tenantId,
          actorId,
          `messaging-runtime-${Date.now()}`,
          JSON.stringify({
            httpEnabled: lockedCurrent?.http_enabled ?? false,
            directEnabled: lockedCurrent?.direct_enabled ?? false,
            realtimeEnabled: lockedCurrent?.realtime_enabled ?? false,
            contextualEnabled: lockedCurrent?.contextual_enabled ?? false,
          }),
          JSON.stringify(desiredState),
        ],
      );
    });
    process.stdout.write(`${JSON.stringify({ ...preview, applied: true }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
