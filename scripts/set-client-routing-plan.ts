import { createHash } from 'node:crypto';

import { createDatabasePool, withTenantTransaction } from '@phub/database';
import {
  CLIENT_ROUTING_MODES,
  DIRECT_VIVA_CONTRACT_READY_OPERATIONS,
  DIRECT_VIVA_READ_OPERATIONS,
  isValidIdempotencyKey,
  type ClientRoutingMode,
  type DirectVivaReadOperation,
} from '@phub/domain';

interface Options {
  readonly tenantKey: string;
  readonly mode: ClientRoutingMode;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly reason: string;
  readonly validForSeconds: number;
  readonly directOperations: readonly DirectVivaReadOperation[];
  readonly apply: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function usage(): never {
  throw new Error(
    'Usage: npm run routing:plan:set -- --tenant <tenant-key> ' +
      '--mode <PADLHUB_ONLY|MIXED_END_USER_READS> --actor <uuid> ' +
      '--idempotency-key <opaque-id> --correlation-id <opaque-id> --reason <text> ' +
      '[--operations profile.read,...] [--valid-for-seconds 30..300] [--apply]',
  );
}

function parseArguments(args: readonly string[]): Options {
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

  const tenantKey = values.get('--tenant');
  const mode = values.get('--mode');
  const actorId = values.get('--actor');
  const idempotencyKey = values.get('--idempotency-key');
  const correlationId = values.get('--correlation-id');
  const reason = values.get('--reason')?.trim();
  const validForSeconds = Number(values.get('--valid-for-seconds') ?? '60');
  const directOperations = (values.get('--operations') ?? '')
    .split(',')
    .map((operation) => operation.trim())
    .filter(Boolean);
  if (!tenantKey || !mode || !actorId || !idempotencyKey || !correlationId || !reason) usage();
  if (!TENANT_KEY_PATTERN.test(tenantKey)) throw new Error('Invalid --tenant value');
  if (!CLIENT_ROUTING_MODES.includes(mode as ClientRoutingMode))
    throw new Error('Invalid --mode value');
  if (!UUID_PATTERN.test(actorId)) throw new Error('--actor must be a UUID');
  if (!isValidIdempotencyKey(idempotencyKey)) throw new Error('Invalid --idempotency-key value');
  if (!isValidIdempotencyKey(correlationId)) throw new Error('Invalid --correlation-id value');
  if (reason.length > 500) throw new Error('--reason is limited to 500 characters');
  if (
    directOperations.some(
      (operation) => !DIRECT_VIVA_READ_OPERATIONS.includes(operation as DirectVivaReadOperation),
    ) ||
    new Set(directOperations).size !== directOperations.length
  ) {
    throw new Error('--operations contains an unknown or duplicate operation');
  }
  if (
    directOperations.some(
      (operation) =>
        !DIRECT_VIVA_CONTRACT_READY_OPERATIONS.includes(
          operation as (typeof DIRECT_VIVA_CONTRACT_READY_OPERATIONS)[number],
        ),
    )
  ) {
    throw new Error(
      `--operations contains a read whose provider contract is not ready; enabled: ${DIRECT_VIVA_CONTRACT_READY_OPERATIONS.join(',')}`,
    );
  }
  if (mode === 'MIXED_END_USER_READS' && directOperations.length === 0) {
    throw new Error('--operations is required for MIXED_END_USER_READS');
  }
  if (mode === 'PADLHUB_ONLY' && directOperations.length > 0) {
    throw new Error('--operations must be empty for PADLHUB_ONLY');
  }
  if (!Number.isInteger(validForSeconds) || validForSeconds < 30 || validForSeconds > 300) {
    throw new Error('--valid-for-seconds must be an integer from 30 to 300');
  }
  return {
    tenantKey,
    mode: mode as ClientRoutingMode,
    actorId,
    idempotencyKey,
    correlationId,
    reason,
    validForSeconds,
    directOperations: directOperations as DirectVivaReadOperation[],
    apply,
  };
}

const options = parseArguments(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = createDatabasePool(databaseUrl);
try {
  const tenant = await pool.query<{ id: string }>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [options.tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Active tenant not found');

  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        mode: options.mode,
        validForSeconds: options.validForSeconds,
        directOperations: options.directOperations,
        reason: options.reason,
      }),
    )
    .digest('hex');
  const summary = {
    execution: options.apply ? 'apply' : 'dry-run',
    tenantKey: options.tenantKey,
    tenantId,
    mode: options.mode,
    validForSeconds: options.validForSeconds,
    directOperations: options.directOperations,
    actorId: options.actorId,
    idempotencyKey: options.idempotencyKey,
  };

  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({ ...summary, outcome: 'validated' }, null, 2)}\n`);
  } else {
    const outcome = await withTenantTransaction(pool, tenantId, async (client) => {
      const replay = await client.query<{ request_hash: string; result_revision: string }>(
        `select request_hash, result_revision::text as result_revision
           from integration.client_routing_plan_commands
          where tenant_id = $1 and idempotency_key = $2
          for update`,
        [tenantId, options.idempotencyKey],
      );
      const priorCommand = replay.rows[0];
      if (priorCommand) {
        if (priorCommand.request_hash !== requestHash) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }
        return { status: 'replayed' as const, revision: priorCommand.result_revision };
      }

      const current = await client.query<{
        mode: ClientRoutingMode;
        revision: string;
        valid_for_seconds: number;
        direct_read_operations: DirectVivaReadOperation[];
      }>(
        `select mode, revision::text as revision, valid_for_seconds, direct_read_operations
           from integration.client_routing_plans
          where tenant_id = $1
          for update`,
        [tenantId],
      );
      const oldPlan = current.rows[0] ?? {
        mode: 'PADLHUB_ONLY' as const,
        revision: '0',
        valid_for_seconds: 60,
        direct_read_operations: [],
      };
      const revision = String(BigInt(oldPlan.revision) + 1n);
      await client.query(
        `insert into integration.client_routing_plans (
           tenant_id, mode, revision, valid_for_seconds, direct_read_operations,
           changed_by, change_reason
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id) do update set
           mode = excluded.mode,
           revision = excluded.revision,
           valid_for_seconds = excluded.valid_for_seconds,
           direct_read_operations = excluded.direct_read_operations,
           changed_by = excluded.changed_by,
           change_reason = excluded.change_reason,
           updated_at = now()`,
        [
          tenantId,
          options.mode,
          revision,
          options.validForSeconds,
          options.directOperations,
          options.actorId,
          options.reason,
        ],
      );
      await client.query(
        `insert into integration.client_routing_plan_commands (
           tenant_id, idempotency_key, request_hash, requested_mode,
           requested_operations, result_revision, actor_id, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          options.idempotencyKey,
          requestHash,
          options.mode,
          options.directOperations,
          revision,
          options.actorId,
          options.correlationId,
        ],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id, result,
           reason, correlation_id, old_value, new_value
         ) values ($1, $2, 'CLIENT_ROUTING_PLAN_CHANGED', 'CLIENT_ROUTING_PLAN',
                   $1, 'SUCCESS', $3, $4, $5::jsonb, $6::jsonb)`,
        [
          tenantId,
          options.actorId,
          options.reason,
          options.correlationId,
          JSON.stringify({
            mode: oldPlan.mode,
            revision: oldPlan.revision,
            validForSeconds: oldPlan.valid_for_seconds,
            directOperations: oldPlan.direct_read_operations,
          }),
          JSON.stringify({
            mode: options.mode,
            revision,
            validForSeconds: options.validForSeconds,
            directOperations: options.directOperations,
          }),
        ],
      );
      return { status: 'changed' as const, revision };
    });
    process.stdout.write(`${JSON.stringify({ ...summary, outcome }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
