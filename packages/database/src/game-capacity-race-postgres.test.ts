/**
 * QA scenario 1 (authoritative) — concurrent joins must not exceed `games.capacity`.
 *
 * Capacity is a persisted column: `games.capacity smallint not null check (capacity between 2 and 4)`
 * (packages/database/migrations/0023_games_foundation.sql:21). It is enforced by
 * `assertCanJoinGameFacts()` (GAME_FULL) inside a transaction that first takes
 * `select ... from games.games ... for update`, so concurrent joins for the same game serialise on
 * that row lock. This test proves the outcome rather than the mechanism: N parallel joins against a
 * nearly-full game must admit exactly the free seats, reject the rest with GAME_FULL, leave the
 * roster equal to capacity, and leak no raw database error.
 *
 * This is the real-Postgres concurrency proof. It runs only when
 * GAME_CAPACITY_RACE_TEST_DATABASE_URL points at a disposable database, and SKIPS (not fails)
 * otherwise — which is the case in this QA environment (127.0.0.1:5432 closed).
 */
import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createGameRepository } from './game-repository.js';
import { createGameRosterRepository } from './game-roster-repository.js';

const connectionString = process.env.GAME_CAPACITY_RACE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describePostgres('scenario 1: concurrent joins against real PostgreSQL capacity', () => {
  const pool = new Pool({ connectionString, max: 8 });
  const games = createGameRepository(pool);
  const roster = createGameRosterRepository(pool);
  const tenantId = randomUUID();
  const organizerId = randomUUID();
  const stationId = randomUUID();
  const players = Array.from({ length: 12 }, () => randomUUID());

  function command(): {
    idempotencyKey: string;
    requestHash: string;
    correlationId: string;
  } {
    const id = randomUUID();
    return { idempotencyKey: id, requestHash: hash(id), correlationId: id };
  }

  async function createGame(capacity: number): Promise<string> {
    const startsAt = new Date(Date.now() + 86_400_000);
    const created = await games.create({
      tenantId,
      actorUserId: organizerId,
      ...command(),
      title: `Capacity race ${randomUUID()}`,
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
      timezone: 'Europe/Moscow',
      capacity,
      waitlistEnabled: false,
      joinCutoffAt: new Date(startsAt.getTime() - 1_800_000).toISOString(),
      paymentMode: 'NO_PAYMENT',
    });
    expect(created.outcome).toBe('applied');
    if (created.outcome !== 'applied') throw new Error('CAPACITY_RACE_FIXTURE_FAILED');
    return created.gameId;
  }

  async function activeParticipantCount(gameId: string): Promise<number> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from games.participations
          where tenant_id = $1 and game_id = $2 and state = 'ACTIVE' and role = 'PLAYER'`,
        [tenantId, gameId],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  beforeAll(async () => {
    await pool.query(
      'insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)',
      [tenantId, `capacity-race-${tenantId}`, 'Capacity race fixture'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        "insert into identity.users (tenant_id, id, status) select $1, id, 'ACTIVE' from unnest($2::uuid[]) id",
        [tenantId, [organizerId, ...players]],
      );
      await client.query(
        "insert into locations.profiles (tenant_id, id, slug, title, publication_status, created_by, updated_by, published_at) values ($1, $2, $3, 'Capacity race station', 'PUBLISHED', $4, $4, now())",
        [tenantId, stationId, `capacity-race-${stationId}`, organizerId],
      );
      // Level eligibility OFF so the race measures capacity only, not the level gate.
      await client.query(
        "insert into eligibility.level_policies (tenant_id, sport_code, activity_type, mode, version) values ($1, 'PADEL', 'GAME', 'OFF', 1)",
        [tenantId],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('admits exactly one of six parallel joins when one seat is free (capacity 4)', async () => {
    const gameId = await createGame(4);
    // Fill to capacity-1 sequentially so the race starts at the boundary.
    for (const playerId of players.slice(0, 3)) {
      const result = await roster.join({ tenantId, actorUserId: playerId, gameId, ...command() });
      expect(result.outcome).toBe('applied');
    }
    expect(await activeParticipantCount(gameId)).toBe(3);

    const contenders = players.slice(3, 9);
    const outcomes = await Promise.all(
      contenders.map((playerId) =>
        roster
          .join({ tenantId, actorUserId: playerId, gameId, ...command() })
          .catch((error: unknown) => ({ outcome: 'threw' as const, error })),
      ),
    );

    const applied = outcomes.filter((outcome) => outcome.outcome === 'applied');
    const rejected = outcomes.filter((outcome) => outcome.outcome === 'rejected');
    const thrown = outcomes.filter((outcome) => outcome.outcome === 'threw');

    // No raw 23505 / pool / lock error may escape as an unhandled rejection.
    expect(thrown).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const outcome of rejected) {
      if (outcome.outcome === 'rejected') expect(outcome.code).toBe('GAME_FULL');
    }
    // The durable roster never exceeds the cap.
    expect(await activeParticipantCount(gameId)).toBe(4);
  });

  it('admits exactly one of four parallel joins when one seat is free (capacity 2)', async () => {
    const gameId = await createGame(2);
    expect(
      (await roster.join({ tenantId, actorUserId: players[0]!, gameId, ...command() })).outcome,
    ).toBe('applied');
    expect(await activeParticipantCount(gameId)).toBe(1);

    const outcomes = await Promise.all(
      players
        .slice(1, 5)
        .map((playerId) =>
          roster
            .join({ tenantId, actorUserId: playerId, gameId, ...command() })
            .catch((error: unknown) => ({ outcome: 'threw' as const, error })),
        ),
    );

    expect(outcomes.filter((outcome) => outcome.outcome === 'threw')).toHaveLength(0);
    expect(outcomes.filter((outcome) => outcome.outcome === 'applied')).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.outcome === 'rejected');
    expect(rejected).toHaveLength(3);
    for (const outcome of rejected) {
      if (outcome.outcome === 'rejected') expect(outcome.code).toBe('GAME_FULL');
    }
    expect(await activeParticipantCount(gameId)).toBe(2);
  });

  it('does not admit a duplicate seat when the same player races themselves', async () => {
    const gameId = await createGame(4);
    const playerId = players[0]!;
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        roster
          .join({ tenantId, actorUserId: playerId, gameId, ...command() })
          .catch((error: unknown) => ({ outcome: 'threw' as const, error })),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.outcome === 'threw')).toHaveLength(0);
    // Exactly one durable participation for this player, whatever the concurrency shape.
    expect(await activeParticipantCount(gameId)).toBe(1);
    expect(outcomes.filter((outcome) => outcome.outcome === 'applied')).toHaveLength(1);
  });
});
