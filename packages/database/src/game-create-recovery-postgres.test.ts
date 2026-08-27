import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  createGameRepository,
  type CreateStoredGameInput,
  type CreateStoredGameResult,
} from './game-repository.js';

const connectionString = process.env.GAME_CREATE_RECOVERY_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describePostgres('game create durable recovery on real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 8 });
  const repository = createGameRepository(pool);
  const tenantId = randomUUID();
  const actorUserId = randomUUID();
  const stationId = randomUUID();

  function input(label: string, startsAt: Date): CreateStoredGameInput {
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    return {
      tenantId,
      actorUserId,
      idempotencyKey: `game-create-recovery-${label}-${randomUUID()}`,
      requestHash: hash(`game-create-recovery-${label}`),
      correlationId: `game-create-recovery-${label}-${randomUUID()}`,
      title: `Recovery ${label} ${randomUUID()}`,
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timezone: 'Europe/Moscow',
      capacity: 4,
      waitlistEnabled: true,
      joinCutoffAt: new Date(startsAt.getTime() - 30 * 60_000).toISOString(),
      paymentMode: 'NO_PAYMENT',
    };
  }

  async function sideEffectCounts(command: CreateStoredGameInput) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{
        games: string;
        participations: string;
        operations: string;
        lifecycle_commands: string;
        idempotency_commands: string;
        audit_events: string;
        outbox_events: string;
      }>(
        `select
           (select count(*) from games.games
             where tenant_id = $1 and organizer_user_id = $2 and title = $3)::text as games,
           (select count(*) from games.participations p
             join games.games g on g.tenant_id = p.tenant_id and g.id = p.game_id
            where g.tenant_id = $1 and g.organizer_user_id = $2 and g.title = $3)::text
             as participations,
           (select count(*) from games.operations o
             join games.games g on g.tenant_id = o.tenant_id and g.id = o.game_id
            where g.tenant_id = $1 and g.organizer_user_id = $2 and g.title = $3)::text
             as operations,
           (select count(*) from games.scheduled_commands c
             join games.games g on g.tenant_id = c.tenant_id and g.id = c.game_id
            where g.tenant_id = $1 and g.organizer_user_id = $2 and g.title = $3
              and c.command_type in ('game.lifecycle.start.v1', 'game.lifecycle.finish.v1'))::text
             as lifecycle_commands,
           (select count(*) from games.command_idempotency
            where tenant_id = $1 and principal_key = $4 and idempotency_key = $5)::text
             as idempotency_commands,
           (select count(*) from audit.audit_log
            where tenant_id = $1 and correlation_id = $6 and action = 'GAME_CREATED')::text
             as audit_events,
           (select count(*) from audit.outbox_events
            where tenant_id = $1 and correlation_id = $6
              and event_type in ('game.created.v1', 'game.scheduled.v1', 'game.published.v1'))::text
             as outbox_events`,
        [
          tenantId,
          actorUserId,
          command.title,
          `user:${actorUserId}`,
          command.idempotencyKey,
          command.correlationId,
        ],
      );
      return result.rows[0];
    });
  }

  async function waitUntilPast(startsAt: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ past: boolean }>(
        'select clock_timestamp() >= $1::timestamptz as past',
        [startsAt],
      );
      if (result.rows[0]?.past) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('GAME_CREATE_RECOVERY_CLOCK_TIMEOUT');
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, $3)`,
      [tenantId, `game-recovery-${tenantId}`, 'Game recovery integration'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         values ($1, $2, 'ACTIVE')`,
        [tenantId, actorUserId],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('serializes concurrent same-key creates into one game and one replay', async () => {
    const command = input('concurrent', new Date(Date.now() + 60_000));
    const results = await Promise.all([repository.create(command), repository.create(command)]);

    expect(results.filter((result) => result.outcome === 'applied')).toHaveLength(2);
    const applied = results as Extract<CreateStoredGameResult, { outcome: 'applied' }>[];
    expect(new Set(applied.map((result) => result.gameId)).size).toBe(1);
    expect(applied.map((result) => result.replayed).sort()).toEqual([false, true]);
    await expect(sideEffectCounts(command)).resolves.toEqual({
      games: '1',
      participations: '1',
      operations: '1',
      lifecycle_commands: '2',
      idempotency_commands: '1',
      audit_events: '1',
      outbox_events: '3',
    });
  });

  it('replays a committed create after startsAt passes and conflicts before admission', async () => {
    const command = input('delayed', new Date(Date.now() + 2_000));
    const original = await repository.create(command);
    expect(original).toMatchObject({ outcome: 'applied', replayed: false });

    await waitUntilPast(command.startsAt);
    await expect(repository.create(command)).resolves.toMatchObject({
      outcome: 'applied',
      gameId: original.outcome === 'applied' ? original.gameId : undefined,
      replayed: true,
    });
    await expect(
      repository.create({
        ...command,
        title: `${command.title} changed`,
        requestHash: hash('changed'),
      }),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
    await expect(sideEffectCounts(command)).resolves.toEqual({
      games: '1',
      participations: '1',
      operations: '1',
      lifecycle_commands: '2',
      idempotency_commands: '1',
      audit_events: '1',
      outbox_events: '3',
    });
  });

  it('rejects a new past-start key without any durable command or side effect', async () => {
    const command = input('past-rejected', new Date(Date.now() - 60_000));

    await expect(repository.create(command)).resolves.toEqual({
      outcome: 'rejected',
      code: 'GAME_START_TIME_PASSED',
    });
    await expect(sideEffectCounts(command)).resolves.toEqual({
      games: '0',
      participations: '0',
      operations: '0',
      lifecycle_commands: '0',
      idempotency_commands: '0',
      audit_events: '0',
      outbox_events: '0',
    });
  });
});
