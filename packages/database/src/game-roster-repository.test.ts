import { describe, expect, it, vi } from 'vitest';

import { createGameRosterRepository } from './game-roster-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const organizerId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const playerId = '47b10c0e-2d9f-4775-96dc-2941adae4968';
const participationId = '05d8cc21-9ab9-4ec2-a966-cb52ef13dd29';
const reservationId = '238df6f5-fec4-44dd-ad8c-39e98ade8366';
const waitlistEntryId = '7527d5e1-da33-464a-94c7-ace34a11e295';

function input(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    tenantId,
    actorUserId: playerId,
    gameId,
    idempotencyKey: 'games-roster-command-0001',
    requestHash: 'a'.repeat(64),
    correlationId: 'corr-games-roster-0001',
    expectedRevision: 1,
    ...overrides,
  };
}

function lockedGame(paymentMode: 'NO_PAYMENT' | 'SPLIT' = 'NO_PAYMENT') {
  return {
    id: gameId,
    revision: '1',
    lifecycle_state: 'SCHEDULED',
    starts_at: '2026-08-01T18:00:00.000Z',
    join_cutoff_at: '2026-08-01T17:30:00.000Z',
    capacity: 2,
    waitlist_enabled: true,
    payment_mode: paymentMode,
    database_now: '2026-08-01T10:00:00.000Z',
  };
}

function rosterFacts(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    active_participant_count: 1,
    active_reservation_count: 0,
    participation_id: null,
    participation_role: null,
    reservation_id: null,
    waitlist_entry_id: null,
    waitlist_position: null,
    ...overrides,
  };
}

function poolWithHandler(
  handler: (
    text: string,
    values: readonly unknown[],
  ) => { rows?: readonly unknown[]; rowCount?: number },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    const result = handler(text, values);
    return Promise.resolve({
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? result.rows?.length ?? 0,
    });
  });
  return {
    pool: {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    },
    query,
  };
}

function baseHandler(
  text: string,
  options: {
    readonly paymentMode?: 'NO_PAYMENT' | 'SPLIT';
    readonly facts?: Readonly<Record<string, unknown>>;
  } = {},
) {
  if (text.includes('from games.command_idempotency')) return { rows: [] };
  if (text.includes('from games.games') && text.includes('for update')) {
    return { rows: [lockedGame(options.paymentMode)] };
  }
  if (text.includes('active_participant_count')) {
    return { rows: [rosterFacts(options.facts)] };
  }
  if (text.includes('update games.games set revision')) return { rows: [{ revision: '2' }] };
  return { rows: [] };
}

describe('game roster repository', () => {
  it('confirms a no-payment join and emits roster completion under one locked transaction', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('insert into games.participations')) {
        return { rows: [{ id: participationId }] };
      }
      if (text.includes('array_agg(user_id')) {
        return { rows: [{ user_ids: [organizerId, playerId] }] };
      }
      return baseHandler(text);
    });

    await expect(createGameRosterRepository(pool as never).join(input())).resolves.toMatchObject({
      outcome: 'applied',
      gameId,
      revision: 2,
      viewerRelation: 'PARTICIPANT',
      participationId,
      committedAt: '2026-08-01T10:00:00.000Z',
      replayed: false,
    });
    const gameLock = query.mock.calls.find(
      ([text]) => text.includes('from games.games') && text.includes('for update'),
    );
    expect(gameLock).toBeDefined();
    const outboxTypes = query.mock.calls
      .filter(([text]) => text.includes('insert into audit.outbox_events'))
      .map((call) => call[1]?.[2]);
    expect(outboxTypes).toEqual(['game.participation.confirmed.v1', 'game.roster.completed.v1']);
    expect(query.mock.calls.some(([text]) => text.includes('games.command_idempotency'))).toBe(
      true,
    );
    expect(query.mock.calls.some(([text]) => text.includes('audit.audit_log'))).toBe(true);
  });

  it('creates a capacity-holding split reservation and expiry command', async () => {
    const expiresAt = '2026-08-01T10:15:00.000Z';
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('insert into games.seat_reservations')) {
        return { rows: [{ id: reservationId, expires_at: expiresAt }] };
      }
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(createGameRosterRepository(pool as never).join(input())).resolves.toMatchObject({
      outcome: 'applied',
      revision: 2,
      viewerRelation: 'SEAT_RESERVED',
      reservationId,
      expiresAt,
    });
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          text.includes('game.reservation.expire.v1') &&
          (values?.some((value) => String(value).includes(reservationId)) ?? false),
      ),
    ).toBe(true);
    expect(
      query.mock.calls
        .filter(([text]) => text.includes('insert into audit.outbox_events'))
        .map((call) => call[1]?.[2]),
    ).toEqual(['game.participation.reserved.v1']);
  });

  it('persists a replayable capacity rejection without a roster write or outbox event', async () => {
    const { pool, query } = poolWithHandler((text) =>
      baseHandler(text, {
        facts: { active_participant_count: 2 },
      }),
    );

    await expect(createGameRosterRepository(pool as never).join(input())).resolves.toEqual({
      outcome: 'rejected',
      code: 'GAME_FULL',
      currentRevision: 1,
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into audit.outbox_events')),
    ).toBe(false);
    expect(
      query.mock.calls.some(
        ([text, values]) => text.includes("'FAILED'") && (values?.includes('GAME_FULL') ?? false),
      ),
    ).toBe(true);
  });

  it('emits explicit waitlist joined and left facts', async () => {
    const joined = poolWithHandler((text) => {
      if (text.includes('insert into games.waitlist_entries')) {
        return { rows: [{ id: waitlistEntryId, position: '1' }] };
      }
      return baseHandler(text, { facts: { active_participant_count: 2 } });
    });
    await expect(
      createGameRosterRepository(joined.pool as never).joinWaitlist(input()),
    ).resolves.toMatchObject({
      outcome: 'applied',
      viewerRelation: 'WAITLISTED',
      waitlistEntryId,
      position: 1,
    });
    expect(
      joined.query.mock.calls
        .filter(([text]) => text.includes('insert into audit.outbox_events'))
        .map((call) => call[1]?.[2]),
    ).toEqual(['game.waitlist.joined.v1']);

    const left = poolWithHandler((text) =>
      baseHandler(text, {
        facts: {
          active_participant_count: 2,
          waitlist_entry_id: waitlistEntryId,
          waitlist_position: '1',
        },
      }),
    );
    await expect(
      createGameRosterRepository(left.pool as never).leaveWaitlist(
        input({ idempotencyKey: 'games-roster-command-0002', requestHash: 'b'.repeat(64) }),
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      viewerRelation: 'NONE',
      waitlistEntryId,
      position: 1,
    });
    expect(
      left.query.mock.calls
        .filter(([text]) => text.includes('insert into audit.outbox_events'))
        .map((call) => call[1]?.[2]),
    ).toEqual(['game.waitlist.left.v1']);
  });

  it('replays the original command result and rejects cross-request key reuse', async () => {
    const stored = {
      outcome: 'applied',
      commandId: 'd39e4287-e65c-4e75-88e4-4447e4c91ddb',
      gameId,
      revision: 2,
      viewerRelation: 'PARTICIPANT',
      participationId,
      committedAt: '2026-08-01T10:00:00.000Z',
    };
    const replayPool = poolWithHandler((text) =>
      text.includes('from games.command_idempotency')
        ? {
            rows: [
              {
                id: stored.commandId,
                command_type: 'game.join.v1',
                request_hash: 'a'.repeat(64),
                state: 'COMPLETED',
                result_payload: stored,
                error_code: null,
              },
            ],
          }
        : { rows: [] },
    );
    await expect(
      createGameRosterRepository(replayPool.pool as never).join(input()),
    ).resolves.toEqual({ ...stored, replayed: true });

    const conflictPool = poolWithHandler((text) =>
      text.includes('from games.command_idempotency')
        ? {
            rows: [
              {
                id: stored.commandId,
                command_type: 'game.join.v1',
                request_hash: 'f'.repeat(64),
                state: 'COMPLETED',
                result_payload: stored,
                error_code: null,
              },
            ],
          }
        : { rows: [] },
    );
    await expect(
      createGameRosterRepository(conflictPool.pool as never).join(input()),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
  });

  it('expires a due reservation and reopens capacity through service idempotency', async () => {
    const commandId = '312b2311-8f7a-43f0-9c5f-13fef4c73884';
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.seat_reservations') && text.includes('for update')) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              expires_at: '2026-08-01T09:59:00.000Z',
            },
          ],
        };
      }
      if (text.includes('active_participant_count') && !text.includes('participation_id')) {
        return {
          rows: [{ active_participant_count: 1, active_reservation_count: 0 }],
        };
      }
      if (text.includes('array_agg(user_id')) {
        return { rows: [{ user_ids: [organizerId] }] };
      }
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(
      createGameRosterRepository(pool as never).expireReservation({
        tenantId,
        gameId,
        commandId,
        idempotencyKey: 'games-expiry-command-0001',
        requestHash: 'c'.repeat(64),
        correlationId: 'corr-games-expiry-0001',
        reservationId,
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      commandId,
      gameId,
      revision: 2,
      replayed: false,
    });
    expect(
      query.mock.calls
        .filter(([text]) => text.includes('insert into audit.outbox_events'))
        .map((call) => call[1]?.[2]),
    ).toEqual(['game.participation.expired.v1', 'game.roster.reopened.v1']);
    expect(
      query.mock.calls.some(
        ([text, values]) => text.includes("'COMPLETED'") && values?.includes(commandId),
      ),
    ).toBe(true);
  });

  it('promotes only the selected first waitlist entry into the available seat', async () => {
    const commandId = '5c495f29-c3e6-426f-a855-28301b447152';
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('active_participant_count') && !text.includes('participation_id')) {
        return {
          rows: [{ active_participant_count: 1, active_reservation_count: 0 }],
        };
      }
      if (text.includes('from games.waitlist_entries') && text.includes('min(position)')) {
        return {
          rows: [
            {
              id: waitlistEntryId,
              user_id: playerId,
              position: '1',
              state: 'ACTIVE',
            },
          ],
        };
      }
      if (text.includes('insert into games.participations')) {
        return { rows: [{ id: participationId }] };
      }
      if (text.includes('array_agg(user_id')) {
        return { rows: [{ user_ids: [organizerId, playerId] }] };
      }
      return baseHandler(text);
    });

    await expect(
      createGameRosterRepository(pool as never).promoteWaitlist({
        tenantId,
        gameId,
        commandId,
        idempotencyKey: 'games-promote-command-0001',
        requestHash: 'd'.repeat(64),
        correlationId: 'corr-games-promote-0001',
        waitlistEntryId,
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      commandId,
      gameId,
      revision: 2,
      replayed: false,
    });
    expect(
      query.mock.calls
        .filter(([text]) => text.includes('insert into audit.outbox_events'))
        .map((call) => call[1]?.[2]),
    ).toEqual([
      'game.waitlist.promoted.v1',
      'game.participation.confirmed.v1',
      'game.roster.completed.v1',
    ]);
  });

  it('loads a durable user operation only through tenant and actor ownership', async () => {
    const stored = {
      outcome: 'applied',
      commandId: 'd39e4287-e65c-4e75-88e4-4447e4c91ddb',
      gameId,
      revision: 2,
      viewerRelation: 'PARTICIPANT',
      participationId,
      committedAt: '2026-08-01T10:00:00.000Z',
    };
    const { pool, query } = poolWithHandler((text) =>
      text.includes('from games.command_idempotency')
        ? {
            rows: [
              {
                id: stored.commandId,
                command_type: 'game.join.v1',
                request_hash: 'a'.repeat(64),
                state: 'COMPLETED',
                result_payload: stored,
                error_code: null,
                aggregate_id: gameId,
                completed_at: stored.committedAt,
              },
            ],
          }
        : { rows: [] },
    );

    await expect(
      createGameRosterRepository(pool as never).getOperation({
        tenantId,
        actorUserId: playerId,
        operationId: stored.commandId,
      }),
    ).resolves.toEqual({
      commandId: stored.commandId,
      commandType: 'game.join.v1',
      gameId,
      state: 'COMPLETED',
      committedAt: stored.committedAt,
      result: { ...stored, replayed: true },
    });
    expect(
      query.mock.calls.some(
        ([text, values]) => text.includes('actor_user_id = $3') && values?.includes(playerId),
      ),
    ).toBe(true);
  });
});
