import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDatabasePool, withTenantTransaction } from '@phub/database';
import { isValidIdempotencyKey } from '@phub/domain';
import {
  HOME_PROJECTION_COMPONENT_EVENT,
  homeProjectionComponentPayloadSchema,
} from '@phub/home-projection';

interface EnqueueOptions {
  readonly file: string;
  readonly tenantKey: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly apply: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function usage(): never {
  throw new Error(
    'Usage: npm run home:component:enqueue -- --file <component.json> --tenant <tenant-key> ' +
      '--event-id <uuid> --correlation-id <opaque-id> [--apply]',
  );
}

function parseArguments(args: readonly string[]): EnqueueOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (!argument?.startsWith('--')) usage();
    const value = args[index + 1];
    if (!value || value.startsWith('--')) usage();
    values.set(argument, value);
    index += 1;
  }

  const file = values.get('--file');
  const tenantKey = values.get('--tenant');
  const eventId = values.get('--event-id');
  const correlationId = values.get('--correlation-id');
  if (!file || !tenantKey || !eventId || !correlationId) usage();
  if (!TENANT_KEY_PATTERN.test(tenantKey)) throw new Error('Invalid --tenant value');
  if (!UUID_PATTERN.test(eventId)) throw new Error('--event-id must be a UUID');
  if (!isValidIdempotencyKey(correlationId)) {
    throw new Error('--correlation-id must be 16-128 safe opaque characters');
  }
  return { file, tenantKey, eventId, correlationId, apply };
}

const options = parseArguments(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const rawPayload: unknown = JSON.parse(await readFile(resolve(options.file), 'utf8'));
const payload = homeProjectionComponentPayloadSchema.parse(rawPayload);
const pool = createDatabasePool(databaseUrl);
try {
  const tenant = await pool.query<{ id: string }>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [options.tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Active tenant not found');

  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    tenantKey: options.tenantKey,
    tenantId,
    userId: payload.userId,
    component: payload.component,
    componentRevision: payload.componentRevision,
    eventId: options.eventId,
  };
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({ ...summary, outcome: 'validated' }, null, 2)}\n`);
  } else {
    const outcome = await withTenantTransaction(pool, tenantId, async (client) => {
      const user = await client.query(
        `select id from identity.users
          where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
        [tenantId, payload.userId],
      );
      if (user.rowCount === 0) throw new Error('Active PadlHub user not found');
      const inserted = await client.query(
        `insert into audit.outbox_events (
           id, tenant_id, event_type, aggregate_id, correlation_id, payload
         ) values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do nothing
         returning id`,
        [
          options.eventId,
          tenantId,
          HOME_PROJECTION_COMPONENT_EVENT,
          payload.userId,
          options.correlationId,
          JSON.stringify(payload),
        ],
      );
      if (inserted.rowCount === 0) return 'unchanged' as const;
      await client.query(
        `insert into audit.audit_log (
           tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
         ) values ($1, 'HOME_COMPONENT_ENQUEUED', 'HOME_DASHBOARD_COMPONENT', $2,
                   'SUCCESS', $3, $4::jsonb)`,
        [
          tenantId,
          payload.userId,
          options.correlationId,
          JSON.stringify({
            eventId: options.eventId,
            component: payload.component,
            componentRevision: payload.componentRevision,
          }),
        ],
      );
      return 'enqueued' as const;
    });
    process.stdout.write(`${JSON.stringify({ ...summary, outcome }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
