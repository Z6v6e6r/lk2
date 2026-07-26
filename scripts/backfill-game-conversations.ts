import { createHash, randomUUID } from 'node:crypto';

import {
  createContextualMessagingRepository,
  createDatabasePool,
  withTenantTransaction,
} from '@phub/database';
import type { QueryResultRow } from 'pg';

const CONFIRMATION_TOKEN = 'BACKFILL_GAME_CONVERSATIONS';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface TenantRow extends QueryResultRow {
  readonly id: string;
}

interface GameRow extends QueryResultRow {
  readonly id: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function boundedLimit(value: string | undefined): number {
  const parsed = Number(value ?? '50');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('--limit must be an integer from 1 to 500');
  }
  return parsed;
}

function deterministicEventId(tenantId: string, gameId: string): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`messaging-game-backfill-v1:${tenantId}:${gameId}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const tenantKey = argument('tenant-key');
const actorId = argument('actor-id');
const limit = boundedLimit(argument('limit'));
const confirm = argument('confirm');
if (!tenantKey || !TENANT_KEY_PATTERN.test(tenantKey)) {
  throw new Error('--tenant-key must be a valid PadlHub tenant key');
}
if (!actorId || !UUID_PATTERN.test(actorId)) {
  throw new Error('--actor-id must be an active PadlHub user UUID in the tenant');
}

const pool = createDatabasePool(connectionString);
try {
  const tenant = await pool.query<TenantRow>(
    'select id from identity.tenants where tenant_key = $1 and active = true',
    [tenantKey],
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('Tenant was not found or is inactive');

  const candidates = await withTenantTransaction(pool, tenantId, async (client) => {
    const actor = await client.query(
      `select 1
         from identity.users
        where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
      [tenantId, actorId],
    );
    if (actor.rowCount === 0) throw new Error('Actor is not an active user in the tenant');
    return client.query<GameRow>(
      `select game.id
         from games.games game
         left join messaging.conversations conversation
           on conversation.tenant_id = game.tenant_id
          and conversation.kind = 'GAME'
          and conversation.context_id = game.id
        where game.tenant_id = $1
          and game.lifecycle_state in ('SCHEDULED', 'IN_PROGRESS', 'FINISHED')
          and conversation.id is null
        order by game.starts_at desc, game.id
        limit $2`,
      [tenantId, limit],
    );
  });

  const preview = {
    mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run',
    tenantKey,
    tenantId,
    actorId,
    limit,
    candidateCount: candidates.rows.length,
  };
  if (confirm !== CONFIRMATION_TOKEN) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stdout.write(`Re-run with --confirm=${CONFIRMATION_TOKEN} to apply.\n`);
    process.exitCode = 0;
  } else {
    const repository = createContextualMessagingRepository(pool);
    const counts = { projected: 0, replayed: 0, notReady: 0 };
    for (const game of candidates.rows) {
      const result = await repository.projectGameConversation({
        tenantId,
        eventId: deterministicEventId(tenantId, game.id),
        gameId: game.id,
        correlationId: `game-conversation-backfill-${randomUUID()}`,
      });
      if (result === 'dependency_missing') {
        throw new Error('GAME_CONVERSATION_BACKFILL_DEPENDENCY_MISSING');
      }
      if (result === 'projected') counts.projected += 1;
      if (result === 'replayed') counts.replayed += 1;
      if (result === 'not_ready') counts.notReady += 1;
    }
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into audit.audit_log (
           tenant_id, actor_id, action, resource_type, resource_id,
           result, correlation_id, new_value
         ) values ($1, $2, 'GAME_CONVERSATION_BACKFILL', 'TENANT', $1,
                   'SUCCESS', $3, $4::jsonb)`,
        [
          tenantId,
          actorId,
          `game-conversation-backfill-${randomUUID()}`,
          JSON.stringify({ limit, candidateCount: candidates.rows.length, ...counts }),
        ],
      );
    });
    process.stdout.write(`${JSON.stringify({ ...preview, applied: true, ...counts }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
