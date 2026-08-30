import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  createGameRepository,
  type CreateStoredGameInput,
  type CreateStoredGameResult,
} from './game-repository.js';
import { createGameRosterRepository } from './game-roster-repository.js';

const connectionString = process.env.GAME_CREATE_RECOVERY_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describePostgres('game create durable recovery on real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 8 });
  const repository = createGameRepository(pool);
  const rosterRepository = createGameRosterRepository(pool);
  const tenantId = randomUUID();
  const actorUserId = randomUUID();
  const playerUserIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
  const stationId = randomUUID();
  const draftStationId = randomUUID();
  const courtId = randomUUID();
  const foreignTenantId = randomUUID();
  const foreignActorUserId = randomUUID();
  const foreignStationId = randomUUID();
  const foreignCourtId = randomUUID();

  function input(
    label: string,
    startsAt: Date,
    overrides: Partial<CreateStoredGameInput> = {},
  ): CreateStoredGameInput {
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
      ...overrides,
    };
  }

  function rosterInput(gameId: string, actorId: string, label: string) {
    return {
      tenantId,
      actorUserId: actorId,
      gameId,
      idempotencyKey: `game-roster-${label}-${randomUUID()}`,
      requestHash: hash(`game-roster-${label}-${randomUUID()}`),
      correlationId: `game-roster-${label}-${randomUUID()}`,
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
         select $1, user_id, 'ACTIVE'
           from unnest($2::uuid[]) as users(user_id)`,
        [tenantId, [actorUserId, ...playerUserIds]],
      );
      await client.query(
        `insert into locations.profiles (
           tenant_id, id, slug, title, publication_status,
           created_by, updated_by, published_at
         ) values ($1, $2, $3, $4, 'PUBLISHED', $5, $5, now())`,
        [tenantId, stationId, `game-recovery-${stationId}`, 'Game recovery station', actorUserId],
      );
      await client.query(
        `insert into locations.profiles (
           tenant_id, id, slug, title, publication_status, created_by, updated_by
         ) values ($1, $2, $3, $4, 'DRAFT', $5, $5)`,
        [
          tenantId,
          draftStationId,
          `game-recovery-${draftStationId}`,
          'Draft game recovery station',
          actorUserId,
        ],
      );
      await client.query(
        `insert into integration.external_entity_map (
           tenant_id, external_system, entity_type, internal_id, external_id, sync_status
         ) values ($1, 'TEST', 'game_court', $2, $3, 'synced')`,
        [tenantId, courtId, `game-recovery-court-${courtId}`],
      );
    });
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, $3)`,
      [foreignTenantId, `game-recovery-foreign-${foreignTenantId}`, 'Foreign game recovery'],
    );
    await withTenantTransaction(pool, foreignTenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')`,
        [foreignTenantId, foreignActorUserId],
      );
      await client.query(
        `insert into locations.profiles (
           tenant_id, id, slug, title, publication_status,
           created_by, updated_by, published_at
         ) values ($1, $2, $3, $4, 'PUBLISHED', $5, $5, now())`,
        [
          foreignTenantId,
          foreignStationId,
          `game-recovery-${foreignStationId}`,
          'Foreign game recovery station',
          foreignActorUserId,
        ],
      );
      await client.query(
        `insert into integration.external_entity_map (
           tenant_id, external_system, entity_type, internal_id, external_id, sync_status
         ) values ($1, 'TEST', 'game_court', $2, $3, 'synced')`,
        [foreignTenantId, foreignCourtId, `game-recovery-court-${foreignCourtId}`],
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

  it.each([
    ['missing', randomUUID()],
    ['foreign', foreignStationId],
    ['unpublished', draftStationId],
  ] as const)(
    'rejects a %s station with zero durable command or side effect',
    async (label, rejectedStationId) => {
      const command = input(`station-${label}`, new Date(Date.now() + 60_000), {
        stationId: rejectedStationId,
      });

      await expect(repository.create(command)).resolves.toEqual({
        outcome: 'rejected',
        code: 'GAME_LOCATION_INVALID',
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
    },
  );

  it.each([
    ['missing', randomUUID()],
    ['foreign', foreignCourtId],
  ] as const)(
    'rejects a %s court with zero durable command or side effect',
    async (label, rejectedCourtId) => {
      const command = input(`court-${label}`, new Date(Date.now() + 60_000), {
        courtId: rejectedCourtId,
      });

      await expect(repository.create(command)).resolves.toEqual({
        outcome: 'rejected',
        code: 'GAME_LOCATION_INVALID',
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
    },
  );

  it('accepts a same-tenant published station and mapped court', async () => {
    const command = input('valid-court', new Date(Date.now() + 60_000), { courtId });

    await expect(repository.create(command)).resolves.toMatchObject({
      outcome: 'applied',
      replayed: false,
    });
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

  it('serializes two same-game projector events without deadlock or a stale card', async () => {
    const command = input('parallel-projector', new Date(Date.now() + 60_000));
    const created = await repository.create(command);
    if (created.outcome !== 'applied') throw new Error('GAME_CREATE_TEST_SETUP_FAILED');
    const eventIds = [randomUUID(), randomUUID()] as const;

    const outcomes = await Promise.race([
      Promise.all(
        eventIds.map((eventId) =>
          repository.projectCardEvent({ tenantId, eventId, gameId: created.gameId }),
        ),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GAME_PROJECTOR_PARALLEL_TIMEOUT')), 5_000),
      ),
    ]);

    expect([...outcomes].sort()).toEqual(['applied', 'stale']);
    await withTenantTransaction(pool, tenantId, async (client) => {
      const projection = await client.query<{
        aggregate_revision: string;
        projection_revision: string;
      }>(
        `select aggregate_revision, projection_revision
           from games.card_projections
          where tenant_id = $1 and game_id = $2`,
        [tenantId, created.gameId],
      );
      expect(projection.rows).toEqual([{ aggregate_revision: '1', projection_revision: '1' }]);
      const inbox = await client.query<{ processed: string }>(
        `select count(*) filter (where processed_at is not null)::text as processed
           from audit.inbox_events
          where tenant_id = $1 and event_id = any($2::uuid[])`,
        [tenantId, eventIds],
      );
      expect(inbox.rows[0]?.processed).toBe('2');
    });
  });

  it('serializes two physical last-seat joins and rejects the loser without overflow', async () => {
    const created = await repository.create(
      input('last-seat', new Date(Date.now() + 60 * 60_000), { capacity: 2 }),
    );
    if (created.outcome !== 'applied') throw new Error('GAME_CREATE_TEST_SETUP_FAILED');

    const results = await Promise.race([
      Promise.all([
        rosterRepository.join(rosterInput(created.gameId, playerUserIds[0], 'last-seat-a')),
        rosterRepository.join(rosterInput(created.gameId, playerUserIds[1], 'last-seat-b')),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GAME_LAST_SEAT_PARALLEL_TIMEOUT')), 5_000),
      ),
    ]);

    expect(results.filter((result) => result.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'rejected')).toMatchObject([
      { code: 'GAME_FULL' },
    ]);
    await withTenantTransaction(pool, tenantId, async (client) => {
      const count = await client.query<{ active: string; distinct_users: string }>(
        `select count(*)::text as active, count(distinct user_id)::text as distinct_users
           from games.participations
          where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'`,
        [tenantId, created.gameId],
      );
      expect(count.rows[0]).toEqual({ active: '2', distinct_users: '2' });
    });
  });

  it('leases one promotion to one worker and promotes one free waitlist entry exactly once', async () => {
    const created = await repository.create(
      input('waitlist-promotion', new Date(Date.now() + 60 * 60_000), { capacity: 2 }),
    );
    if (created.outcome !== 'applied') throw new Error('GAME_CREATE_TEST_SETUP_FAILED');
    const participantId = playerUserIds[0];
    const waitingId = playerUserIds[1];
    await expect(
      rosterRepository.join(rosterInput(created.gameId, participantId, 'promotion-participant')),
    ).resolves.toMatchObject({ outcome: 'applied' });
    const waiting = await rosterRepository.joinWaitlist(
      rosterInput(created.gameId, waitingId, 'promotion-waiting'),
    );
    expect(waiting).toMatchObject({ outcome: 'applied', viewerRelation: 'WAITLISTED' });
    if (waiting.outcome !== 'applied' || !waiting.waitlistEntryId) {
      throw new Error('GAME_WAITLIST_TEST_SETUP_FAILED');
    }
    await expect(
      rosterRepository.leave(rosterInput(created.gameId, participantId, 'promotion-leave')),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const [claimA, claimB] = await Promise.all([
      repository.claimScheduledCommands({
        tenantId,
        workerId: 'game-promotion-pg-a',
        limit: 1,
        commandTypes: ['game.waitlist.promote.v1'],
      }),
      repository.claimScheduledCommands({
        tenantId,
        workerId: 'game-promotion-pg-b',
        limit: 1,
        commandTypes: ['game.waitlist.promote.v1'],
      }),
    ]);
    expect([claimA.length, claimB.length].sort()).toEqual([0, 1]);
    const command = [...claimA, ...claimB][0];
    if (!command) throw new Error('GAME_PROMOTION_COMMAND_NOT_CLAIMED');
    const workerId = claimA.length === 1 ? 'game-promotion-pg-a' : 'game-promotion-pg-b';

    await expect(
      rosterRepository.promoteWaitlist({
        tenantId,
        gameId: created.gameId,
        commandId: command.id,
        idempotencyKey: `scheduled:${command.id}`,
        requestHash: hash(`promotion:${command.id}:${waiting.waitlistEntryId}`),
        correlationId: `game-promotion-${command.id}`,
        waitlistEntryId: waiting.waitlistEntryId,
      }),
    ).resolves.toMatchObject({ outcome: 'applied', replayed: false });
    await expect(
      repository.completeScheduledCommand({ tenantId, workerId, commandId: command.id }),
    ).resolves.toBe(true);
    await expect(
      rosterRepository.promoteWaitlist({
        tenantId,
        gameId: created.gameId,
        commandId: command.id,
        idempotencyKey: `scheduled:${command.id}`,
        requestHash: hash(`promotion:${command.id}:${waiting.waitlistEntryId}`),
        correlationId: `game-promotion-${command.id}`,
        waitlistEntryId: waiting.waitlistEntryId,
      }),
    ).resolves.toMatchObject({ outcome: 'applied', replayed: true });

    await withTenantTransaction(pool, tenantId, async (client) => {
      const roster = await client.query<{
        active: string;
        promoted: string;
        waiting: string;
      }>(
        `select
           count(*) filter (where p.state = 'ACTIVE')::text as active,
           count(*) filter (where p.state = 'ACTIVE' and p.user_id = $3)::text as promoted,
           (select count(*) from games.waitlist_entries w
             where w.tenant_id = $1 and w.game_id = $2 and w.state = 'ACTIVE')::text as waiting
           from games.participations p
          where p.tenant_id = $1 and p.game_id = $2`,
        [tenantId, created.gameId, waitingId],
      );
      expect(roster.rows[0]).toEqual({ active: '2', promoted: '1', waiting: '0' });
    });
  });

  it('enforces forced tenant RLS under a temporary NOSUPERUSER NOBYPASSRLS NOINHERIT role', async () => {
    const otherTenantId = randomUUID();
    const otherActorId = randomUUID();
    const otherStationId = randomUUID();
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'Game RLS other tenant')`,
      [otherTenantId, `game-rls-${otherTenantId}`],
    );
    await withTenantTransaction(pool, otherTenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')`,
        [otherTenantId, otherActorId],
      );
      await client.query(
        `insert into locations.profiles (
           tenant_id, id, slug, title, publication_status,
           created_by, updated_by, published_at
         ) values ($1, $2, $3, $4, 'PUBLISHED', $5, $5, now())`,
        [
          otherTenantId,
          otherStationId,
          `game-rls-${otherStationId}`,
          'Game RLS station',
          otherActorId,
        ],
      );
    });
    const otherRepository = createGameRepository(pool);
    const otherGame = await otherRepository.create({
      ...input('rls-other', new Date(Date.now() + 60_000)),
      tenantId: otherTenantId,
      actorUserId: otherActorId,
      stationId: otherStationId,
    });
    if (otherGame.outcome !== 'applied') throw new Error('GAME_RLS_TEST_SETUP_FAILED');

    const roleName = `game_rls_${randomUUID().replaceAll('-', '')}`;
    const admin = await pool.connect();
    try {
      await admin.query(`create role ${roleName} nosuperuser nobypassrls noinherit`);
      await admin.query(`grant usage on schema games to ${roleName}`);
      await admin.query(`grant select, update on games.games to ${roleName}`);
      const attributes = await admin.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>('select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = $1', [roleName]);
      expect(attributes.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
      });
      const forced = await admin.query<{ relforcerowsecurity: boolean }>(
        `select relforcerowsecurity
           from pg_class
          where oid = 'games.games'::regclass`,
      );
      expect(forced.rows[0]?.relforcerowsecurity).toBe(true);

      await admin.query('begin');
      await admin.query(`set local role ${roleName}`);
      await admin.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const hidden = await admin.query('select id from games.games where id = $1', [
        otherGame.gameId,
      ]);
      expect(hidden.rowCount).toBe(0);
      const deniedMutation = await admin.query(
        `update games.games set title = title where id = $1 returning id`,
        [otherGame.gameId],
      );
      expect(deniedMutation.rowCount).toBe(0);
      await admin.query('rollback');
    } finally {
      try {
        await admin.query('rollback').catch(() => undefined);
        await admin.query(`drop owned by ${roleName}`);
        await admin.query(`drop role if exists ${roleName}`);
      } finally {
        admin.release();
      }
    }
  });
});
