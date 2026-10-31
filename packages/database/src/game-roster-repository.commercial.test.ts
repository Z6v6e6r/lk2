import { createHash } from 'node:crypto';
import { parseManagedJoinReceipt, type ManagedJoinBinding } from '@phub/domain';
import managedFixture from '../../subscription-runtime-adapter/src/fixtures/managed-join-v2.json';
import { describe, expect, it, vi } from 'vitest';

import {
  createGameRosterRepository,
  type BeginPaidJoinInput,
  type ConfirmGamePaymentInput,
  type PaidJoinAttemptView,
} from './game-roster-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const playerId = '47b10c0e-2d9f-4775-96dc-2941adae4968';
const otherPlayerId = '0eb92dd6-06d4-4a4d-a4f9-1bb08a9d4f14';
const operationId = 'd39e4287-e65c-4e75-88e4-4447e4c91ddb';
const subscriptionInstanceId = '6a20ae72-25f0-4c2a-9cad-8b7f2a51a56e';
const reservationId = '238df6f5-fec4-44dd-ad8c-39e98ade8366';
const participationId = '05d8cc21-9ab9-4ec2-a966-cb52ef13dd29';
const eligibilityDecisionId = 'd63ff37f-ed9b-45f7-a135-838ea74925e0';
const evidenceId = '253153f0-6810-4f1d-9c3a-58be08fbd28c';
const committedAt = '2026-08-01T10:00:00.000Z';
const reservationExpiresAt = '2026-08-01T10:15:00.000Z';

type QueryOutcome = { rows?: readonly unknown[]; rowCount?: number };

/** JSONB preserves values, not JavaScript object insertion order. */
function jsonbRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_key, row: unknown) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => b.localeCompare(a)))
      : row,
  );
}

function poolWithHandler(handler: (text: string, values: readonly unknown[]) => QueryOutcome) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    const result = handler(text, values);
    return Promise.resolve({
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? result.rows?.length ?? 0,
    });
  });
  const connect = vi.fn().mockResolvedValue({ query, release: vi.fn() });
  return { pool: { connect }, query, connect };
}

function paidJoinInput(
  overrides: { readonly expectedRevision?: number; readonly reservationTtlSeconds?: number } = {},
): BeginPaidJoinInput {
  return {
    tenantId,
    actorUserId: playerId,
    gameId,
    idempotencyKey: 'games-paid-join-command-0001',
    requestHash: 'a'.repeat(64),
    correlationId: 'corr-games-paid-join-0001',
    expectedRevision: overrides.expectedRevision ?? 1,
    operationId,
    subscriptionInstanceId,
    price: {
      amountMinor: 250000,
      currency: 'RUB',
      basePriceMinor: 500000,
      freeMinutes: 30,
      paidMinutes: 60,
      evaluatedAt: '2026-08-01T09:55:00.000Z',
      expiresAt: '2026-08-01T10:10:00.000Z',
    },
    reservationTtlSeconds: overrides.reservationTtlSeconds ?? 900,
  };
}

function confirmPaymentInput(
  options: { readonly operationId?: string; readonly evidenceHash?: string } = {},
): ConfirmGamePaymentInput {
  return {
    tenantId,
    actorUserId: playerId,
    gameId,
    idempotencyKey: 'games-payment-confirm-command-0001',
    requestHash: 'c'.repeat(64),
    correlationId: 'corr-games-payment-confirm-0001',
    reservationId,
    evidence: {
      provider: 'VIVA',
      operationType: 'TRANSACTION',
      operationId: options.operationId ?? 'viva-transaction-201',
      bookingId: 'viva-booking-201',
      exerciseId: 'viva-exercise-201',
      clientPhoneE164: '+79000000001',
      evidenceHash: options.evidenceHash ?? 'e'.repeat(64),
      verifiedAt: '2026-08-01T10:05:00.000Z',
      verifiedBy: 'LEGACY_NODE_RED',
      amountMinor: 250000,
      currency: 'RUB',
    },
  };
}

function lockedGame(
  paymentMode: 'NO_PAYMENT' | 'ORGANIZER_PAYS' | 'SPLIT' | 'SUBSCRIPTION' = 'SPLIT',
) {
  return {
    id: gameId,
    station_id: 'e25798e0-1d6b-4c56-8ea2-8524d6f9e1d7',
    court_id: null,
    revision: '1',
    lifecycle_state: 'SCHEDULED',
    starts_at: '2026-08-01T18:00:00.000Z',
    join_cutoff_at: '2026-08-01T17:30:00.000Z',
    capacity: 2,
    waitlist_enabled: true,
    payment_mode: paymentMode,
    sport_code: 'PADEL',
    min_level_id: null,
    max_level_id: null,
    level_from: null,
    level_to: null,
    database_now: committedAt,
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

function eligibilityFacts(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    mode: 'BLOCK',
    lower_tolerance_steps: 0,
    upper_tolerance_steps: 0,
    missing_activity_constraint_action: 'BLOCK',
    legacy_text_constraint_action: 'WARN',
    policy_version: '3',
    player_level_id: null,
    player_rank: null,
    player_level_source: null,
    player_scale_version: null,
    minimum_level_id: '1dfc1d4a-47cb-4b43-a735-761260a2e986',
    maximum_level_id: '7d7556e6-f30b-48e5-9ff2-c39bdf062ff7',
    minimum_rank: 3,
    maximum_rank: 5,
    constraint_scale_version: 1,
    valid_invitation_id: null,
    ...overrides,
  };
}

function commandRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: operationId,
    command_type: 'game.join.paid.v1',
    request_hash: 'a'.repeat(64),
    state: 'IN_PROGRESS',
    result_payload: null,
    error_code: null,
    aggregate_id: gameId,
    ...overrides,
  };
}

function appliedAttemptPayload(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    outcome: 'applied',
    commandId: operationId,
    gameId,
    revision: 2,
    viewerRelation: 'PARTICIPANT',
    participationId,
    reservationId,
    committedAt: '2026-08-01T10:05:00.000Z',
    ...overrides,
  };
}

function baseHandler(
  text: string,
  options: {
    readonly replayRow?: Readonly<Record<string, unknown>>;
    readonly paymentMode?: 'NO_PAYMENT' | 'ORGANIZER_PAYS' | 'SPLIT' | 'SUBSCRIPTION';
    readonly facts?: Readonly<Record<string, unknown>>;
    readonly eligibility?: Readonly<Record<string, unknown>>;
  } = {},
): QueryOutcome {
  if (text.includes('from games.command_idempotency')) {
    return { rows: options.replayRow ? [options.replayRow] : [] };
  }
  if (text.includes('eligibility.level_policies')) {
    return { rows: [options.eligibility ?? eligibilityFacts()] };
  }
  if (text.includes('from games.games') && text.includes('for update')) {
    return { rows: [lockedGame(options.paymentMode ?? 'SPLIT')] };
  }
  if (text.includes('active_participant_count')) {
    return { rows: [rosterFacts(options.facts)] };
  }
  if (text.includes('insert into eligibility.decisions')) return { rowCount: 1 };
  if (text.includes('insert into games.seat_reservations')) {
    return {
      rows: [
        {
          id: reservationId,
          state: 'ACTIVE',
          payment_state: 'PROCESSING',
          expires_at: reservationExpiresAt,
        },
      ],
    };
  }
  if (text.includes('insert into eligibility.payment_snapshots')) return { rowCount: 1 };
  if (text.includes('update games.games set revision')) return { rows: [{ revision: '2' }] };
  return { rows: [] };
}

function writtenStatements(query: ReturnType<typeof poolWithHandler>['query']): readonly string[] {
  return query.mock.calls
    .map(([text]) => text)
    .filter((text) => /^(insert|update|delete)\b/i.test(text));
}

describe('game roster commercial paid join', () => {
  it('reserves a paid seat with a durable IN_PROGRESS attempt, snapshot and reserved fact in one transaction', async () => {
    const { pool, query, connect } = poolWithHandler((text) => baseHandler(text));

    const result = await createGameRosterRepository(pool as never).beginPaidJoin(paidJoinInput());
    expect(result).toMatchObject({
      outcome: 'reserved',
      operationId,
      reservationId,
      expiresAt: reservationExpiresAt,
      revision: 2,
    });
    if (result.outcome !== 'reserved') throw new Error('expected a reserved paid join');
    const decisionId = result.eligibilityDecisionId;
    expect(decisionId).toMatch(/^[0-9a-f-]{36}$/);

    expect(connect).toHaveBeenCalledTimes(1);
    const transactionStatements = query.mock.calls
      .map(([text]) => text)
      .filter((text) => text === 'begin' || text === 'commit');
    expect(transactionStatements).toEqual(['begin', 'commit']);

    const reservationInsert = query.mock.calls.find(
      ([text, values]) =>
        text.includes('insert into games.seat_reservations') &&
        text.includes("'PROCESSING'") &&
        values?.includes(decisionId) === true &&
        values?.includes(900) === true,
    );
    expect(reservationInsert).toBeDefined();
    expect(reservationInsert?.[1]).toEqual([tenantId, gameId, playerId, 900, decisionId]);
    expect(reservationInsert?.[0]).toContain("'ACTIVE'");
    expect(reservationInsert?.[0]).toContain('on conflict do nothing');

    const snapshotInsert = query.mock.calls.find(([text]) =>
      text.includes('insert into eligibility.payment_snapshots'),
    );
    expect(snapshotInsert).toBeDefined();
    expect(snapshotInsert?.[1]?.slice(0, 5)).toEqual([
      tenantId,
      operationId,
      decisionId,
      playerId,
      gameId,
    ]);
    const snapshot = JSON.parse(String(snapshotInsert?.[1]?.[5])) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      operationId,
      decisionId,
      paymentMode: 'SPLIT',
      subscriptionInstanceId,
      correlationId: 'corr-games-paid-join-0001',
    });
    expect(snapshot.price).toMatchObject({ amountMinor: 250000, currency: 'RUB' });

    const attemptInsert = query.mock.calls.find(([text]) =>
      text.includes('insert into games.command_idempotency'),
    );
    expect(attemptInsert?.[0]).toContain("'IN_PROGRESS'");
    expect(attemptInsert?.[1]).toEqual([
      tenantId,
      operationId,
      playerId,
      `user:${playerId}`,
      'games-paid-join-command-0001',
      'game.join.paid.v1',
      'a'.repeat(64),
      gameId,
    ]);

    const statements = query.mock.calls.map(([text]) => text);
    const reservationIndex = statements.findIndex((text) =>
      text.includes('insert into games.seat_reservations'),
    );
    const attemptIndex = statements.indexOf(attemptInsert?.[0] ?? '');
    const revisionIndex = statements.findIndex((text) =>
      text.includes('update games.games set revision'),
    );
    expect(reservationIndex).toBeGreaterThan(-1);
    expect(attemptIndex).toBeGreaterThan(reservationIndex);
    expect(revisionIndex).toBeGreaterThan(attemptIndex);

    const reservedEvent = query.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(reservedEvent?.[1]?.[2]).toBe('game.participation.reserved.v1');
    expect(reservedEvent?.[1]?.[5]).toContain(`"reservationId":"${reservationId}"`);
    expect(reservedEvent?.[1]?.[5]).toContain(`"expiresAt":"${reservationExpiresAt}"`);
    expect(reservedEvent?.[1]?.[5]).toContain(`"userId":"${playerId}"`);

    expect(writtenStatements(query).some((text) => text.includes('games.participations'))).toBe(
      false,
    );
  });

  it('replays an in-progress attempt by idempotency key and writes nothing again', async () => {
    const { pool, query } = poolWithHandler((text) =>
      baseHandler(text, { replayRow: commandRow() }),
    );

    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin(paidJoinInput()),
    ).resolves.toEqual({ outcome: 'replayed', operationId, state: 'IN_PROGRESS' });
    expect(writtenStatements(query)).toEqual([]);
    expect(
      query.mock.calls.some(
        ([text]) => text.includes('from games.games') && text.includes('for update'),
      ),
    ).toBe(false);
  });

  it('replays a completed attempt with the trusted finalization result', async () => {
    const { pool, query } = poolWithHandler((text) =>
      baseHandler(text, {
        replayRow: commandRow({
          state: 'COMPLETED',
          result_payload: appliedAttemptPayload(),
        }),
      }),
    );

    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin(paidJoinInput()),
    ).resolves.toEqual({
      outcome: 'replayed',
      operationId,
      state: 'COMPLETED',
      result: {
        commandId: operationId,
        gameId,
        revision: 2,
        viewerRelation: 'PARTICIPANT',
        participationId,
        reservationId,
        committedAt: '2026-08-01T10:05:00.000Z',
      },
    });
    expect(writtenStatements(query)).toEqual([]);
  });

  it.each([
    ['a different request hash', { request_hash: 'b'.repeat(64) }],
    ['a different command type', { command_type: 'game.join.v1' }],
  ] as const)(
    'fails a key reused with %s as an idempotency conflict',
    async (_label, overrides) => {
      const { pool, query } = poolWithHandler((text) =>
        baseHandler(text, { replayRow: commandRow(overrides) }),
      );

      await expect(
        createGameRosterRepository(pool as never).beginPaidJoin(paidJoinInput()),
      ).resolves.toEqual({ outcome: 'idempotency_conflict' });
      expect(writtenStatements(query)).toEqual([]);
    },
  );

  it.each(['NO_PAYMENT', 'ORGANIZER_PAYS'] as const)(
    'rejects a %s game as a payment mode mismatch before any commercial write',
    async (paymentMode) => {
      const { pool, query } = poolWithHandler((text) => baseHandler(text, { paymentMode }));

      await expect(
        createGameRosterRepository(pool as never).beginPaidJoin(paidJoinInput()),
      ).resolves.toEqual({
        outcome: 'rejected',
        code: 'GAME_PAYMENT_MODE_MISMATCH',
        currentRevision: 1,
      });
      expect(writtenStatements(query)).toEqual([]);
    },
  );

  it('rejects a stale expected revision without opening an attempt', async () => {
    const { pool, query } = poolWithHandler((text) => baseHandler(text));

    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin(
        paidJoinInput({ expectedRevision: 7 }),
      ),
    ).resolves.toEqual({
      outcome: 'rejected',
      code: 'GAME_REVISION_CONFLICT',
      currentRevision: 1,
    });
    expect(writtenStatements(query)).toEqual([]);
  });

  it.each([
    ['full', { active_participant_count: 2, active_reservation_count: 0 }, 'GAME_FULL'],
    [
      'already reserved',
      { active_participant_count: 1, reservation_id: reservationId },
      'GAME_ALREADY_RESERVED',
    ],
    [
      'already joined',
      {
        active_participant_count: 1,
        participation_id: participationId,
        participation_role: 'PLAYER',
      },
      'GAME_ALREADY_JOINED',
    ],
  ] as const)('rejects a %s game before reserving another seat', async (_label, facts, code) => {
    const { pool, query } = poolWithHandler((text) => baseHandler(text, { facts }));

    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin(paidJoinInput()),
    ).resolves.toEqual({ outcome: 'rejected', code, currentRevision: 1 });
    expect(
      writtenStatements(query).some((text) =>
        [
          'insert into games.seat_reservations',
          'insert into eligibility.payment_snapshots',
          'insert into games.command_idempotency',
        ].some((needle) => text.includes(needle)),
      ),
    ).toBe(false);
  });

  it('denies a level-ineligible paid join before any reservation write', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.games') && text.includes('for update')) {
        return {
          rows: [
            {
              ...lockedGame('SUBSCRIPTION'),
              min_level_id: '1dfc1d4a-47cb-4b43-a735-761260a2e986',
              max_level_id: '7d7556e6-f30b-48e5-9ff2-c39bdf062ff7',
            },
          ],
        };
      }
      return baseHandler(text, { paymentMode: 'SUBSCRIPTION' });
    });

    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin(paidJoinInput()),
    ).resolves.toMatchObject({ outcome: 'rejected', code: 'PLAYER_LEVEL_REQUIRED' });
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.seat_reservations')),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into eligibility.payment_snapshots')),
    ).toBe(false);
    // Parity with the free join: the refusal is durable (FAILED command row + audit) so it is
    // observable and a repeat with the same key replays the refusal, but nothing is reserved.
    expect(
      query.mock.calls.some(
        ([text]) =>
          text.includes('insert into games.command_idempotency') && text.includes("'FAILED'"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([text]) => text.includes('insert into audit.audit_log') && text.includes("'REJECTED'"),
      ),
    ).toBe(true);
  });

  it('finalizes the durable attempt from trusted confirmation evidence inside the same transaction', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (
        text.includes('from games.seat_reservations') &&
        text.includes('payment_snapshot_exists')
      ) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
              eligibility_decision_id: eligibilityDecisionId,
              payment_snapshot_exists: true,
            },
          ],
        };
      }
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      if (text.includes('insert into games.payment_confirmation_evidence')) {
        return { rows: [{ id: evidenceId }] };
      }
      if (text.includes('insert into games.participations')) {
        return { rows: [{ id: participationId }] };
      }
      if (text.includes('update games.seat_reservations')) return { rowCount: 1 };
      if (text.includes('update games.payment_confirmation_evidence')) return { rowCount: 1 };
      if (text.includes('from eligibility.payment_snapshots')) {
        return { rows: [{ operation_id: operationId }] };
      }
      if (text.includes('update games.command_idempotency')) return { rowCount: 1 };
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(
      createGameRosterRepository(pool as never).confirmPayment(
        confirmPaymentInput({ operationId: 'viva-transaction-201' }),
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      viewerRelation: 'PARTICIPANT',
      participationId,
      reservationId,
    });

    const snapshotLookup = query.mock.calls.find(([text]) =>
      text.includes('select snapshot.operation_id'),
    );
    expect(snapshotLookup?.[0]).toContain('snapshot.decision_id = $2');
    expect(snapshotLookup?.[0]).toContain("snapshot.activity_type = 'GAME'");
    expect(snapshotLookup?.[0]).toContain('snapshot.operation_id');
    expect(snapshotLookup?.[1]).toEqual([tenantId, eligibilityDecisionId, playerId, gameId]);

    const attemptFinalization = query.mock.calls.find(([text]) =>
      text.includes("set state = 'COMPLETED', result_payload = $4::jsonb"),
    );
    expect(attemptFinalization).toBeDefined();
    expect(attemptFinalization?.[1]?.[0]).toBe(tenantId);
    expect(attemptFinalization?.[1]?.[1]).toBe(operationId);
    expect(attemptFinalization?.[1]?.[2]).toBe(playerId);
    const resultPayload = JSON.parse(String(attemptFinalization?.[1]?.[3])) as Record<
      string,
      unknown
    >;
    expect(resultPayload).toMatchObject({
      outcome: 'applied',
      commandId: operationId,
      gameId,
      revision: 2,
      viewerRelation: 'PARTICIPANT',
      participationId,
      reservationId,
    });
    expect(attemptFinalization?.[0]).toContain("command_type = $6 and state = 'IN_PROGRESS'");

    const statements = query.mock.calls.map(([text]) => text);
    expect(
      statements.findIndex((text) => text.includes('update games.payment_confirmation_evidence')),
    ).toBeLessThan(statements.indexOf(attemptFinalization?.[0] ?? ''));
  });

  it('leaves a legacy trusted confirmation untouched when no local attempt snapshot exists', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (
        text.includes('from games.seat_reservations') &&
        text.includes('payment_snapshot_exists')
      ) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
              eligibility_decision_id: eligibilityDecisionId,
              payment_snapshot_exists: true,
            },
          ],
        };
      }
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      if (text.includes('insert into games.payment_confirmation_evidence')) {
        return { rows: [{ id: evidenceId }] };
      }
      if (text.includes('insert into games.participations')) {
        return { rows: [{ id: participationId }] };
      }
      if (text.includes('update games.seat_reservations')) return { rowCount: 1 };
      if (text.includes('update games.payment_confirmation_evidence')) return { rowCount: 1 };
      if (text.includes('from eligibility.payment_snapshots')) return { rows: [] };
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(
      createGameRosterRepository(pool as never).confirmPayment(
        confirmPaymentInput({
          operationId: 'viva-transaction-legacy-1',
          evidenceHash: 'f'.repeat(64),
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied', viewerRelation: 'PARTICIPANT' });
    expect(
      query.mock.calls.some(([text]) =>
        text.includes("set state = 'COMPLETED', result_payload = $4::jsonb"),
      ),
    ).toBe(false);
  });

  it('reads an in-progress attempt without mutating anything', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency')) return { rows: [commandRow()] };
      if (text.includes('from eligibility.payment_snapshots snapshot')) {
        return {
          rows: [
            {
              id: reservationId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
            },
          ],
        };
      }
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      createGameRosterRepository(pool as never).getPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
      }),
    ).resolves.toEqual({
      requestHash: 'a'.repeat(64),
      commandId: operationId,
      gameId,
      state: 'IN_PROGRESS',
      result: null,
      errorCode: null,
      reservation: {
        id: reservationId,
        state: 'ACTIVE',
        paymentState: 'PROCESSING',
        expiresAt: reservationExpiresAt,
      },
      receipt: null,
    });
    expect(writtenStatements(query)).toEqual([]);
  });

  it('reads a confirmed attempt with its reservation and trusted receipt', async () => {
    const context: PaidJoinAttemptView = {
      requestHash: 'a'.repeat(64),
      commandId: operationId,
      gameId,
      state: 'COMPLETED',
      result: {
        commandId: operationId,
        gameId,
        revision: 2,
        viewerRelation: 'PARTICIPANT',
        participationId,
        reservationId,
        committedAt,
      },
      errorCode: null,
      reservation: {
        id: reservationId,
        state: 'CONFIRMED',
        paymentState: 'PAID',
        expiresAt: reservationExpiresAt,
      },
      receipt: { provider: 'VIVA', status: 'CONFIRMED', confirmedAt: committedAt },
    };
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency')) {
        return {
          rows: [
            commandRow({
              state: 'COMPLETED',
              result_payload: appliedAttemptPayload({ committedAt }),
            }),
          ],
        };
      }
      if (text.includes('from eligibility.payment_snapshots snapshot')) {
        return {
          rows: [
            {
              id: reservationId,
              state: 'CONFIRMED',
              payment_state: 'PAID',
              expires_at: reservationExpiresAt,
            },
          ],
        };
      }
      if (text.includes('from games.payment_confirmation_evidence')) {
        return { rows: [{ provider: 'VIVA', resolved_at: committedAt }] };
      }
      return { rows: [] };
    });

    await expect(
      createGameRosterRepository(pool as never).getPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
      }),
    ).resolves.toEqual(context);
    expect(writtenStatements(query)).toEqual([]);
    expect(
      query.mock.calls.some(
        ([text]) =>
          text.includes('from games.payment_confirmation_evidence') &&
          text.includes("resolution = 'APPLIED'"),
      ),
    ).toBe(true);
  });

  it('returns null for an attempt that belongs to another actor', async () => {
    const { pool, query } = poolWithHandler(() => ({ rows: [] }));

    await expect(
      createGameRosterRepository(pool as never).getPaidJoinAttempt({
        tenantId,
        actorUserId: otherPlayerId,
        operationId,
      }),
    ).resolves.toBeNull();
    expect(writtenStatements(query)).toEqual([]);
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('from eligibility.payment_snapshots snapshot'),
      ),
    ).toBe(false);
  });

  it('fails an in-progress attempt, cancels its seat and never inserts a replacement attempt row', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('for update of reservation')) {
        return { rows: [{ id: reservationId, state: 'ACTIVE' }] };
      }
      if (text.includes('from games.command_idempotency')) {
        return { rows: [commandRow()] };
      }
      if (text.includes('update games.seat_reservations')) return { rowCount: 1 };
      if (text.includes('update games.command_idempotency')) return { rowCount: 1 };
      return { rows: [] };
    });

    await expect(
      createGameRosterRepository(pool as never).failPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
        gameId,
        code: 'GAME_PAYMENT_MODE_MISMATCH',
        correlationId: 'corr-games-paid-join-fail-0001',
      }),
    ).resolves.toEqual({
      operationId,
      state: 'FAILED',
      reservationState: 'CANCELLED',
      transitioned: true,
    });

    const reservationCancel = query.mock.calls.find(([text]) =>
      text.includes('update games.seat_reservations'),
    );
    expect(reservationCancel?.[0]).toContain("state = 'CANCELLED', payment_state = 'FAILED'");
    expect(reservationCancel?.[0]).toContain("and state = 'ACTIVE'");
    expect(reservationCancel?.[1]).toEqual([tenantId, gameId, reservationId]);

    const attemptFail = query.mock.calls.find(([text]) =>
      text.includes('update games.command_idempotency'),
    );
    expect(attemptFail?.[0]).toContain("state = 'FAILED', error_code = $4");
    expect(attemptFail?.[0]).toContain("state = 'IN_PROGRESS'");
    expect(attemptFail?.[1]).toEqual([
      tenantId,
      operationId,
      playerId,
      'GAME_PAYMENT_MODE_MISMATCH',
    ]);

    const statements = query.mock.calls.map(([text]) => text);
    expect(statements.findIndex((text) => text.includes('for update of reservation'))).toBeLessThan(
      statements.findIndex((text) => text.includes('update games.command_idempotency')),
    );
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          text.includes('insert into audit.audit_log') &&
          values?.includes('GAME_PAYMENT_MODE_MISMATCH') === true,
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.command_idempotency')),
    ).toBe(false);
  });

  it('keeps a definitive failure idempotent when the attempt is already terminal', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('for update of reservation')) {
        return { rows: [{ id: reservationId, state: 'CANCELLED' }] };
      }
      if (text.includes('from games.command_idempotency')) {
        return {
          rows: [
            commandRow({
              state: 'FAILED',
              error_code: 'GAME_PAYMENT_MODE_MISMATCH',
              completed_at: committedAt,
            }),
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      createGameRosterRepository(pool as never).failPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
        gameId,
        code: 'GAME_PAYMENT_MODE_MISMATCH',
        correlationId: 'corr-games-paid-join-fail-0002',
      }),
    ).resolves.toEqual({
      operationId,
      state: 'FAILED',
      reservationState: 'CANCELLED',
      transitioned: false,
    });
    expect(writtenStatements(query)).toEqual([]);
  });

  it('never cancels a reservation when a trusted confirmation already completed the attempt', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('for update of reservation')) {
        return { rows: [{ id: reservationId, state: 'ACTIVE' }] };
      }
      if (text.includes('from games.command_idempotency')) {
        return {
          rows: [
            commandRow({
              state: 'COMPLETED',
              result_payload: appliedAttemptPayload(),
              completed_at: committedAt,
            }),
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      createGameRosterRepository(pool as never).failPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
        gameId,
        code: 'GAME_PAYMENT_MODE_MISMATCH',
        correlationId: 'corr-games-paid-join-fail-0003',
      }),
    ).resolves.toEqual({
      operationId,
      state: 'COMPLETED',
      reservationState: 'ACTIVE',
      transitioned: false,
    });
    expect(writtenStatements(query)).toEqual([]);
  });

  it('returns a not-found failure result without writing anything', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('for update of reservation')) return { rows: [] };
      if (text.includes('from games.command_idempotency')) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      createGameRosterRepository(pool as never).failPaidJoinAttempt({
        tenantId,
        actorUserId: otherPlayerId,
        operationId,
        gameId,
        code: 'GAME_PAYMENT_MODE_MISMATCH',
        correlationId: 'corr-games-paid-join-fail-0004',
      }),
    ).resolves.toEqual({
      operationId,
      state: null,
      reservationState: null,
      transitioned: false,
    });
    expect(writtenStatements(query)).toEqual([]);
  });

  it('reconciles a trusted receipt when the unresolved paid attempt outlived the reservation ttl', async () => {
    // Earlier than the fixture's database_now (2026-08-01T10:00:00Z): expired by owner-clock.
    const expiredAt = '2026-08-01T09:50:00.000Z';
    const { pool } = poolWithHandler((text) => {
      if (
        text.includes('from games.seat_reservations') &&
        text.includes('payment_snapshot_exists')
      ) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: expiredAt,
              eligibility_decision_id: eligibilityDecisionId,
              payment_snapshot_exists: true,
            },
          ],
        };
      }
      if (
        text.includes('from eligibility.payment_snapshots snapshot') &&
        text.includes("command.state = 'IN_PROGRESS'")
      ) {
        return { rows: [{ id: operationId }] };
      }
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      if (text.includes('insert into games.payment_confirmation_evidence')) {
        return { rows: [{ id: evidenceId }] };
      }
      if (text.includes('insert into games.participations')) {
        return { rows: [{ id: participationId }] };
      }
      if (text.includes('update games.seat_reservations')) return { rowCount: 1 };
      if (text.includes('update games.payment_confirmation_evidence')) return { rowCount: 1 };
      if (text.includes('from eligibility.payment_snapshots')) {
        return { rows: [{ operation_id: operationId }] };
      }
      if (text.includes('update games.command_idempotency')) return { rowCount: 1 };
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    // The paid attempt kept the seat ACTIVE after TTL by design; the trusted receipt must finalize
    // the original operation instead of being rejected as an expired reservation.
    await expect(
      createGameRosterRepository(pool as never).confirmPayment(
        confirmPaymentInput({ operationId: 'viva-transaction-expired-1' }),
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      viewerRelation: 'PARTICIPANT',
      reservationId,
    });
  });

  it('still rejects an expired reservation that has no unresolved paid attempt', async () => {
    // Earlier than the fixture's database_now (2026-08-01T10:00:00Z): expired by owner-clock.
    const expiredAt = '2026-08-01T09:50:00.000Z';
    const { pool } = poolWithHandler((text) => {
      if (
        text.includes('from games.seat_reservations') &&
        text.includes('payment_snapshot_exists')
      ) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: expiredAt,
              eligibility_decision_id: eligibilityDecisionId,
              payment_snapshot_exists: true,
            },
          ],
        };
      }
      if (
        text.includes('from eligibility.payment_snapshots snapshot') &&
        text.includes("command.state = 'IN_PROGRESS'")
      ) {
        return { rows: [] };
      }
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      if (text.includes('insert into games.payment_confirmation_evidence')) {
        return { rows: [{ id: evidenceId }] };
      }
      if (text.includes('update games.payment_confirmation_evidence')) return { rowCount: 1 };
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(
      createGameRosterRepository(pool as never).confirmPayment(
        confirmPaymentInput({ operationId: 'viva-transaction-expired-2' }),
      ),
    ).resolves.toMatchObject({ outcome: 'rejected', code: 'GAME_RESERVATION_EXPIRED' });
  });

  it('rejects an invalid reservation ttl before opening a transaction', async () => {
    const { pool, connect } = poolWithHandler((text) => baseHandler(text));

    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin(
        paidJoinInput({ reservationTtlSeconds: 0 }),
      ),
    ).rejects.toThrow('GAME_PAID_JOIN_TTL_INVALID');
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('immutable paid JOIN confirmation binding', () => {
  const binding = {
    providerClientId: 'client-1',
    providerMappingId: tenantId,
    providerClientSubscriptionId: subscriptionInstanceId,
    providerExerciseId: 'exercise-1',
    targetMappingId: gameId,
    targetVersion: '2',
    startsAt: '2026-08-01T18:00:00.000Z',
    durationMinutes: 90,
    capacity: 4,
    admissible: true,
    requestSha256: `sha256:${'a'.repeat(64)}`,
    idempotencyKeySha256: `sha256:${'b'.repeat(64)}`,
  };
  const input = (): ConfirmGamePaymentInput => {
    const base = confirmPaymentInput();
    return {
      ...base,
      paidJoinBinding: binding,
      evidence: {
        ...base.evidence,
        operationType: 'SUBSCRIPTION_BOOKING',
        operationId,
        exerciseId: binding.providerExerciseId,
      },
    };
  };
  function database(
    snapshotBinding: unknown = binding,
    options: {
      phone?: string;
      state?: string;
      completion?: number;
      bindingSnapshot?: unknown;
    } = {},
  ) {
    return poolWithHandler((text) => {
      if (text.includes('payment_snapshot_exists'))
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
              eligibility_decision_id: eligibilityDecisionId,
              payment_snapshot_exists: true,
              paid_snapshot: {
                operation_id: operationId,
                provider_binding: snapshotBinding,
                binding_snapshot: options.bindingSnapshot,
              },
            },
          ],
        };
      if (text.includes('select state from games.command_idempotency'))
        return { rows: [{ state: options.state ?? 'IN_PROGRESS' }] };
      if (text.includes('from profile.user_summaries'))
        return { rows: [{ phone_e164: options.phone ?? '+79000000002' }] };
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      if (text.includes('insert into games.payment_confirmation_evidence'))
        return { rows: [{ id: evidenceId }] };
      if (text.includes('insert into games.participations'))
        return { rows: [{ id: participationId }] };
      if (text.includes('select snapshot.operation_id'))
        return { rows: [{ operation_id: operationId }] };
      if (text.includes('update games.command_idempotency'))
        return { rowCount: options.completion ?? 1 };
      if (
        text.includes('update games.seat_reservations') ||
        text.includes('update games.payment_confirmation_evidence') ||
        text.includes('update eligibility.payment_snapshots')
      )
        return { rowCount: 1 };
      return baseHandler(text, { paymentMode: 'SUBSCRIPTION' });
    });
  }
  it.each([
    ['legacy', {}, 'applied'],
    [
      'bound',
      { policyRef: { policyVersion: 3, policyDigest: `sha256:${'a'.repeat(64)}` } },
      'rejected',
    ],
    ['corrupt', { policyRef: null }, 'invalid'],
    ['missing', undefined, 'missing'],
  ] as const)(
    'rechecks %s snapshot before replaying a successful confirmation',
    async (_, snapshot, expected) => {
      const confirmation = input();
      const { pool, query } = poolWithHandler((text) => {
        if (text.includes('select snapshot.snapshot as binding_snapshot'))
          return { rows: snapshot === undefined ? [] : [{ binding_snapshot: snapshot }] };
        return baseHandler(text, {
          replayRow: commandRow({
            command_type: 'game.payment.confirm.v1',
            request_hash: confirmation.requestHash,
            state: 'COMPLETED',
            result_payload: appliedAttemptPayload(),
          }),
        });
      });
      const result = createGameRosterRepository(pool as never).confirmPayment(confirmation);
      if (expected === 'invalid')
        await expect(result).rejects.toThrow('GAME_PAID_JOIN_BINDING_REFS_INVALID');
      else if (expected === 'missing')
        await expect(result).rejects.toThrow('GAME_PAYMENT_SNAPSHOT_MISSING');
      else await expect(result).resolves.toMatchObject({ outcome: expected, replayed: true });
      expect(writtenStatements(query)).toEqual([]);
      const read = query.mock.calls.find(([text]) =>
        text.includes('select snapshot.snapshot as binding_snapshot'),
      );
      expect(read?.[1]).toEqual([tenantId, gameId, reservationId, playerId]);
    },
  );

  function managedInput() {
    const receipt = parseManagedJoinReceipt({
      ...managedFixture.confirmed.receipt,
      ...Object.fromEntries(
        [
          'providerClientId',
          'providerClientSubscriptionId',
          'providerExerciseId',
          'providerMappingId',
          'targetMappingId',
          'targetVersion',
          'requestSha256',
          'idempotencyKeySha256',
        ].map((key) => [key, binding[key as keyof typeof binding]]),
      ),
      tenantId,
      userId: playerId,
      gameId,
      reservationId,
      operationId,
    });
    const evidenceHash = createHash('sha256')
      .update(JSON.stringify(Object.entries(receipt).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex');
    const confirmation: ConfirmGamePaymentInput = {
      ...input(),
      requestHash: evidenceHash,
      managedJoinReceipt: receipt,
      evidence: {
        ...input().evidence,
        bookingId: receipt.bookingId,
        verifiedAt: receipt.verifiedAt,
        evidenceHash,
      },
    };
    const managedJoin: ManagedJoinBinding = {
      contractVersion: 2,
      requestFingerprint: 'a'.repeat(64),
      entitlement: managedFixture.admission.request
        .entitlement as ManagedJoinBinding['entitlement'],
    };
    const snapshot = {
      operationId,
      decisionId: eligibilityDecisionId,
      decision: { decisionId: eligibilityDecisionId, status: 'ALLOWED' },
      providerBinding: binding,
      managedJoin,
      policyRef: receipt.entitlement.policyRef,
      price: { amountMinor: 0, currency: 'RUB', freeMinutes: 90, paidMinutes: 0 },
    };
    return { confirmation, snapshot, receipt };
  }
  it('settles managed FREE with full minted usage receipt atomically in the original snapshot', async () => {
    const { confirmation, snapshot, receipt } = managedInput();
    const { pool, query } = database(binding, { bindingSnapshot: snapshot });
    expect(
      await createGameRosterRepository(pool as never).confirmPayment(confirmation),
    ).toMatchObject({ outcome: 'applied' });
    const write = query.mock.calls.find(([sql]) =>
      sql.includes('update eligibility.payment_snapshots'),
    );
    expect(write?.[1]).toEqual([
      tenantId,
      operationId,
      playerId,
      eligibilityDecisionId,
      JSON.stringify(receipt),
      gameId,
    ]);
    expect(query.mock.calls.some(([sql]) => sql === 'commit')).toBe(true);
  });
  it.each([
    'subscription',
    'policy',
    'usage',
    'instance',
    'provider',
    'actor',
    'v1',
    'malformed',
  ] as const)('denies %s mismatch on already applied managed confirmation', async (change) => {
    const { confirmation, snapshot, receipt } = managedInput();
    const stored = {
      ...receipt,
      entitlement: {
        ...receipt.entitlement,
        policyRef: { ...receipt.entitlement.policyRef },
        usageRef: { ...receipt.entitlement.usageRef },
      },
    };
    if (change === 'subscription') stored.providerClientSubscriptionId = 'foreign-subscription';
    if (change === 'policy') stored.entitlement.policyRef.policyVersion += 1;
    if (change === 'usage') stored.entitlement.usageRef.reservationUnits += 1;
    if (change === 'instance') stored.entitlement.subscriptionInstanceId = 'subscription:foreign';
    if (change === 'provider') stored.providerExerciseId = 'exercise:foreign';
    if (change === 'actor') stored.userId = otherPlayerId;
    const row = {
      ...snapshot,
      managedJoinReceipt: stored,
      ...(change === 'malformed' ? { managedJoin: null } : {}),
    };
    const supplied = change === 'v1' ? input() : confirmation;
    const { pool, query } = poolWithHandler((text) =>
      text.includes('select snapshot.snapshot as binding_snapshot')
        ? { rows: [{ binding_snapshot: row }] }
        : baseHandler(text, {
            replayRow: commandRow({
              command_type: 'game.payment.confirm.v1',
              request_hash: supplied.requestHash,
              state: 'COMPLETED',
              result_payload: appliedAttemptPayload(),
            }),
          }),
    );
    const result = createGameRosterRepository(pool as never).confirmPayment(supplied);
    if (change === 'malformed') await expect(result).rejects.toThrow();
    else
      await expect(result).resolves.toMatchObject({
        outcome: 'rejected',
        code: 'GAME_PAYMENT_EVIDENCE_CONFLICT',
      });
    expect(writtenStatements(query)).toEqual([]);
  });
  it('replays exact managed evidence even when JSONB reorders nested fields, with zero writes', async () => {
    const { confirmation, snapshot, receipt } = managedInput();
    const stored = {
      ...receipt,
      entitlement: {
        usageRef: {
          reservationUnits: receipt.entitlement.usageRef.reservationUnits,
          usageRef: receipt.entitlement.usageRef.usageRef,
        },
        policyRef: {
          policyDigest: receipt.entitlement.policyRef.policyDigest,
          policyVersion: receipt.entitlement.policyRef.policyVersion,
        },
        subscriptionInstanceId: receipt.entitlement.subscriptionInstanceId,
      },
    };
    const { pool, query } = poolWithHandler((text) =>
      text.includes('select snapshot.snapshot as binding_snapshot')
        ? { rows: [{ binding_snapshot: { ...snapshot, managedJoinReceipt: stored } }] }
        : baseHandler(text, {
            replayRow: commandRow({
              command_type: 'game.payment.confirm.v1',
              request_hash: confirmation.requestHash,
              state: 'COMPLETED',
              result_payload: appliedAttemptPayload(),
            }),
          }),
    );
    expect(
      await createGameRosterRepository(pool as never).confirmPayment(confirmation),
    ).toMatchObject({ outcome: 'applied', replayed: true });
    expect(writtenStatements(query)).toEqual([]);
  });
  it('denies bound v1 callbacks and malformed refs before evidence or roster mutation', async () => {
    const { snapshot } = managedInput();
    for (const changed of [
      snapshot,
      { ...snapshot, policyRef: { ...snapshot.policyRef, policyVersion: 99 } },
    ]) {
      const { pool, query } = database(binding, { bindingSnapshot: changed });
      const promise = createGameRosterRepository(pool as never).confirmPayment(input());
      if (changed === snapshot)
        await expect(promise).resolves.toMatchObject({
          outcome: 'rejected',
          code: 'GAME_PAYMENT_EVIDENCE_CONFLICT',
        });
      else await expect(promise).rejects.toThrow();
      expect(writtenStatements(query)).toEqual([]);
    }
  });

  it('derives phone inside the transaction and atomically completes the original paid attempt', async () => {
    const { pool, query } = database();
    await expect(
      createGameRosterRepository(pool as never).confirmPayment(input()),
    ).resolves.toMatchObject({ outcome: 'applied' });
    const evidence = query.mock.calls.find(([text]) =>
      text.includes('insert into games.payment_confirmation_evidence'),
    );
    expect(evidence?.[1]).toContain('+79000000002');
    expect(evidence?.[1]).not.toContain(input().evidence.clientPhoneE164);
    expect(
      query.mock.calls.some(
        ([text]) => text.includes('from profile.user_summaries') && text.includes('for share'),
      ),
    ).toBe(true);
  });
  it.each(Object.keys(binding))(
    'refuses changed snapshot %s before storing evidence',
    async (key) => {
      const { pool, query } = database({ ...binding, [key]: 'wrong' });
      await expect(
        createGameRosterRepository(pool as never).confirmPayment(input()),
      ).resolves.toMatchObject({ outcome: 'rejected', code: 'GAME_PAYMENT_EVIDENCE_CONFLICT' });
      expect(
        query.mock.calls.some(([text]) =>
          text.includes('insert into games.payment_confirmation_evidence'),
        ),
      ).toBe(false);
    },
  );
  it('rejects a missing exercise and failed original attempt', async () => {
    for (const changes of ['missing-exercise', 'failed-attempt']) {
      const { pool, query } = database(binding, {
        state: changes === 'failed-attempt' ? 'FAILED' : 'IN_PROGRESS',
      });
      const command = input();
      if (changes === 'missing-exercise')
        delete (command.evidence as { exerciseId?: string }).exerciseId;
      await expect(
        createGameRosterRepository(pool as never).confirmPayment(command),
      ).resolves.toMatchObject({ outcome: 'rejected' });
      expect(
        query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
      ).toBe(false);
    }
  });
  it('allows the same reconciliation key after a missing phone projection is repaired', async () => {
    const missing = database(binding, { phone: '' });
    await expect(
      createGameRosterRepository(missing.pool as never).confirmPayment(input()),
    ).rejects.toThrow('GAME_PAYMENT_ACTOR_PHONE_UNAVAILABLE');
    expect(
      missing.query.mock.calls.some(([text]) =>
        text.includes('insert into games.command_idempotency'),
      ),
    ).toBe(false);
    expect(missing.query.mock.calls.some(([text]) => text === 'rollback')).toBe(true);
    const repaired = database();
    await expect(
      createGameRosterRepository(repaired.pool as never).confirmPayment(input()),
    ).resolves.toMatchObject({ outcome: 'applied' });
  });
  it('refuses legacy confirmation of a bound reservation without changing the original attempt', async () => {
    const { pool, query } = database(binding, {
      bindingSnapshot: {
        policyRef: { policyVersion: 3, policyDigest: `sha256:${'a'.repeat(64)}` },
      },
    });
    await expect(
      createGameRosterRepository(pool as never).confirmPayment(input()),
    ).resolves.toMatchObject({ outcome: 'rejected', code: 'GAME_PAYMENT_EVIDENCE_CONFLICT' });
    expect(
      query.mock.calls.some(([text]) =>
        /^\s*(?:insert\s+into|update\s+|delete\s+from)/i.test(text),
      ),
    ).toBe(false);
  });
  it('rolls back legacy confirmation when stored binding is malformed', async () => {
    const { pool, query } = database(binding, { bindingSnapshot: { policyRef: null } });
    await expect(createGameRosterRepository(pool as never).confirmPayment(input())).rejects.toThrow(
      'GAME_PAID_JOIN_BINDING_REFS_INVALID',
    );
    expect(query.mock.calls.some(([text]) => text === 'rollback')).toBe(true);
    expect(
      query.mock.calls.some(([text]) => /(?:insert into|update games|delete from)/i.test(text)),
    ).toBe(false);
  });
  it('rolls back if completion of the original command is lost', async () => {
    const { pool, query } = database(binding, { completion: 0 });
    await expect(createGameRosterRepository(pool as never).confirmPayment(input())).rejects.toThrow(
      'GAME_PAID_JOIN_COMPLETION_CONFLICT',
    );
    expect(query.mock.calls.some(([text]) => text === 'rollback')).toBe(true);
    expect(query.mock.calls.some(([text]) => text === 'commit')).toBe(false);
  });
});

describe('paid join policy/usage binding refs (B2)', () => {
  const bindingRefs = {
    policyRef: { policyVersion: 3, policyDigest: `sha256:${'a'.repeat(64)}` },
    decisionId: '11111111-1111-4111-8111-111111111111',
    usageRef: { usageRef: 'usage:abc-1', reservationUnits: 1 },
  };
  const attemptInput = { tenantId, actorUserId: playerId, operationId };

  it('persists binding refs inside the existing payment snapshot jsonb', async () => {
    const { pool, query } = poolWithHandler((text) => baseHandler(text));

    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin({
        ...paidJoinInput(),
        bindingRefs,
      }),
    ).resolves.toMatchObject({ outcome: 'reserved' });

    const snapshotInsert = query.mock.calls.find(([text]) =>
      text.includes('insert into eligibility.payment_snapshots'),
    );
    const snapshot = JSON.parse(String(snapshotInsert?.[1]?.[5])) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      policyRef: bindingRefs.policyRef,
      usageRef: bindingRefs.usageRef,
      decisionId: bindingRefs.decisionId,
    });
  });

  it('reads binding refs back from the payment snapshot', async () => {
    const { pool } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency')) return { rows: [commandRow()] };
      if (text.includes('from eligibility.payment_snapshots snapshot')) {
        return {
          rows: [
            {
              id: reservationId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
              binding_snapshot: bindingRefs,
            },
          ],
        };
      }
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      return { rows: [] };
    });

    const view = await createGameRosterRepository(pool as never).getPaidJoinAttempt(attemptInput);
    expect(view?.bindingRefs).toEqual(bindingRefs);
  });

  it('keeps a legacy attempt readable without binding refs', async () => {
    const { pool } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency')) return { rows: [commandRow()] };
      if (text.includes('from eligibility.payment_snapshots snapshot')) {
        return {
          rows: [
            {
              id: reservationId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const view = await createGameRosterRepository(pool as never).getPaidJoinAttempt(attemptInput);
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('bindingRefs');
  });
  const invalidSnapshots: readonly [string, unknown][] = [
    ['null snapshot', null],
    ['array snapshot', []],
    ['null policy', { policyRef: null }],
    ['orphan usage', { usageRef: bindingRefs.usageRef }],
    ['orphan decision', { decisionId: bindingRefs.decisionId }],
    ['bad digest', { policyRef: { policyVersion: 3, policyDigest: 'invalid' } }],
    ['extra policy key', { policyRef: { ...bindingRefs.policyRef, ignored: true } }],
    ['bad version', { policyRef: { ...bindingRefs.policyRef, policyVersion: 0 } }],
    ['null usage', { ...bindingRefs, usageRef: null }],
    ['empty usage', { ...bindingRefs, usageRef: { usageRef: '' } }],
    [
      'invalid usage units',
      { ...bindingRefs, usageRef: { ...bindingRefs.usageRef, reservationUnits: 0 } },
    ],
    ['extra usage key', { ...bindingRefs, usageRef: { ...bindingRefs.usageRef, ignored: true } }],
    ['null decision', { ...bindingRefs, decisionId: null }],
    ['bad decision', { ...bindingRefs, decisionId: 'not-a-uuid' }],
  ];
  it.each(invalidSnapshots)(
    'does not downgrade %s to an unbound attempt',
    async (_name, snapshot) => {
      const { pool, query } = poolWithHandler((text) => {
        if (text.includes('from games.command_idempotency')) return { rows: [commandRow()] };
        if (text.includes('from eligibility.payment_snapshots snapshot'))
          return {
            rows: [
              {
                id: reservationId,
                state: 'ACTIVE',
                payment_state: 'PROCESSING',
                expires_at: reservationExpiresAt,
                binding_snapshot: snapshot,
              },
            ],
          };
        return { rows: [] };
      });
      await expect(
        createGameRosterRepository(pool as never).getPaidJoinAttempt(attemptInput),
      ).rejects.toThrow('GAME_PAID_JOIN_BINDING_REFS_INVALID');
      expect(
        query.mock.calls.some(([text]) =>
          /^\s*(?:insert\s+into|update\s+|delete\s+from)/i.test(text),
        ),
      ).toBe(false);
    },
  );

  it('rejects invalid binding on the write boundary before acquiring a connection', async () => {
    const { pool, connect } = poolWithHandler((text) => baseHandler(text));
    await expect(
      createGameRosterRepository(pool as never).beginPaidJoin({
        ...paidJoinInput(),
        bindingRefs: { policyRef: { policyVersion: 3, policyDigest: 'invalid' } },
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_REF_INVALID' });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('managed JOIN durable preflight snapshot', () => {
  function boundInput(): BeginPaidJoinInput {
    const managedJoin: ManagedJoinBinding = {
      contractVersion: 2,
      requestFingerprint: 'f'.repeat(64),
      entitlement: managedFixture.admission.request
        .entitlement as ManagedJoinBinding['entitlement'],
    };
    const receipt = managedFixture.confirmed.receipt;
    return {
      ...paidJoinInput(),
      managedJoin,
      requestHash: createHash('sha256')
        .update('game.join.managed.v2\0' + JSON.stringify(managedJoin))
        .digest('hex'),
      bindingRefs: { policyRef: receipt.entitlement.policyRef },
      price: { ...paidJoinInput().price, amountMinor: 0, freeMinutes: 90, paidMinutes: 0 },
      providerBinding: {
        providerClientId: receipt.providerClientId,
        providerClientSubscriptionId: receipt.providerClientSubscriptionId,
        providerMappingId: receipt.providerMappingId,
        providerExerciseId: receipt.providerExerciseId,
        targetMappingId: receipt.targetMappingId,
        targetVersion: receipt.targetVersion,
        requestSha256: receipt.requestSha256,
        idempotencyKeySha256: receipt.idempotencyKeySha256,
        startsAt: '2026-08-01T18:00:00.000Z',
        durationMinutes: 90,
        capacity: 2,
        admissible: true,
      },
    };
  }
  it('pins authoritative expectation before admission and never invents usage or decision UUID', async () => {
    const input = boundInput();
    const b = input.providerBinding!;
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from integration.external_entity_map'))
        return {
          rows: [
            {
              id: b.targetMappingId,
              external_id: b.providerExerciseId,
              external_version: b.targetVersion,
            },
          ],
        };
      if (text.includes('from games.games') && text.includes('for update'))
        return { rows: [{ ...lockedGame('SUBSCRIPTION'), ends_at: '2026-08-01T19:30:00.000Z' }] };
      return baseHandler(text);
    });
    expect(await createGameRosterRepository(pool as never).beginPaidJoin(input)).toMatchObject({
      outcome: 'reserved',
    });
    const stored = query.mock.calls.find(([sql]) =>
      sql.includes('insert into eligibility.payment_snapshots'),
    )?.[1]?.[5];
    const snapshot = JSON.parse(String(stored)) as Record<string, unknown>;
    expect(snapshot.managedJoin).toEqual(input.managedJoin);
    expect(snapshot.policyRef).toEqual(input.bindingRefs?.policyRef);
    expect(snapshot).not.toHaveProperty('usageRef');
    expect(snapshot.managedJoin).not.toHaveProperty('decisionId');
    expect(snapshot.decisionId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(snapshot.decision).toEqual({ decisionId: snapshot.decisionId, status: 'ALLOWED' });
    const persisted = jsonbRoundTrip(snapshot);
    const reader = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency'))
        return { rows: [commandRow({ request_hash: input.requestHash })] };
      if (text.includes('from eligibility.payment_snapshots snapshot'))
        return {
          rows: [
            {
              id: reservationId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
              binding_snapshot: persisted,
              provider_binding: jsonbRoundTrip(input.providerBinding),
            },
          ],
        };
      return { rows: [] };
    });
    const repository = createGameRosterRepository(reader.pool as never);
    expect(
      await repository.getPaidJoinAttempt({ tenantId, actorUserId: playerId, operationId }),
    ).toMatchObject({
      managedJoin: input.managedJoin,
      requestHash: input.requestHash,
      bindingRefs: input.bindingRefs,
    });
    expect(await repository.beginPaidJoin(input)).toMatchObject({ outcome: 'replayed' });
    expect(writtenStatements(reader.query)).toEqual([]);
  });
  it.each(['paid', 'hash', 'policy', 'binding'] as const)(
    'rejects invalid %s managed input before a transaction',
    async (change) => {
      const input = boundInput();
      const { pool, connect } = poolWithHandler((text) => baseHandler(text));
      const changed = {
        ...input,
        ...(change === 'paid' ? { price: { ...input.price, amountMinor: 1 } } : {}),
        ...(change === 'hash' ? { requestHash: 'e'.repeat(64) } : {}),
        ...(change === 'policy'
          ? {
              bindingRefs: {
                policyRef: {
                  policyVersion: 99,
                  policyDigest: input.bindingRefs!.policyRef.policyDigest,
                },
              },
            }
          : {}),
        ...(change === 'binding' ? { managedJoin: null } : {}),
      };
      await expect(
        createGameRosterRepository(pool as never).beginPaidJoin(changed as BeginPaidJoinInput),
      ).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it.each([
    'missing-id',
    'missing-decision',
    'malformed-id',
    'mismatched-id',
    'status',
    'managed-decision',
    'usage',
  ] as const)('rejects %s in a persisted managed snapshot', async (change) => {
    const input = boundInput();
    const snapshot: Record<string, unknown> = {
      managedJoin: input.managedJoin,
      ...input.bindingRefs,
      decisionId: eligibilityDecisionId,
      decision: { decisionId: eligibilityDecisionId, status: 'ALLOWED' },
      providerBinding: input.providerBinding,
      operationId,
      price: input.price,
    };
    if (change === 'missing-id') delete snapshot.decisionId;
    if (change === 'missing-decision') delete snapshot.decision;
    if (change === 'malformed-id') {
      snapshot.decisionId = 'not-a-uuid';
      snapshot.decision = { decisionId: 'not-a-uuid', status: 'ALLOWED' };
    }
    if (change === 'mismatched-id') snapshot.decisionId = otherPlayerId;
    if (change === 'status')
      snapshot.decision = { decisionId: eligibilityDecisionId, status: 'DENIED' };
    if (change === 'managed-decision')
      snapshot.managedJoin = { ...input.managedJoin, decisionId: eligibilityDecisionId };
    if (change === 'usage') snapshot.usageRef = { usageRef: 'invented:usage', reservationUnits: 1 };
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency'))
        return { rows: [commandRow({ request_hash: input.requestHash })] };
      if (text.includes('from eligibility.payment_snapshots snapshot'))
        return {
          rows: [
            {
              id: reservationId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
              binding_snapshot: jsonbRoundTrip(snapshot),
              provider_binding: input.providerBinding,
            },
          ],
        };
      return { rows: [] };
    });
    await expect(
      createGameRosterRepository(pool as never).getPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
      }),
    ).rejects.toThrow();
    expect(writtenStatements(query)).toEqual([]);
  });
  it('reads exact pinned expectation and hash with no current policy or provider lookup', async () => {
    const input = boundInput();
    const snapshot = {
      managedJoin: input.managedJoin,
      ...input.bindingRefs,
      providerBinding: input.providerBinding,
      operationId,
      price: input.price,
    };
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency'))
        return { rows: [commandRow({ request_hash: input.requestHash })] };
      if (text.includes('from eligibility.payment_snapshots snapshot'))
        return {
          rows: [
            {
              id: reservationId,
              state: 'ACTIVE',
              payment_state: 'PROCESSING',
              expires_at: reservationExpiresAt,
              binding_snapshot: snapshot,
              provider_binding: input.providerBinding,
            },
          ],
        };
      return { rows: [] };
    });
    expect(
      await createGameRosterRepository(pool as never).getPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
      }),
    ).toMatchObject({ managedJoin: input.managedJoin, requestHash: input.requestHash });
    expect(writtenStatements(query)).toEqual([]);
  });
  it('retains the original expectation on a durable eligibility refusal before any seat exists', async () => {
    const input = boundInput();
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency'))
        return {
          rows: [
            commandRow({
              state: 'FAILED',
              error_code: 'PLAYER_LEVEL_REQUIRED',
              request_hash: input.requestHash,
              result_payload: { managedJoin: input.managedJoin, ...input.bindingRefs },
            }),
          ],
        };
      return { rows: [] };
    });
    expect(
      await createGameRosterRepository(pool as never).getPaidJoinAttempt({
        tenantId,
        actorUserId: playerId,
        operationId,
      }),
    ).toMatchObject({ managedJoin: input.managedJoin, state: 'FAILED' });
    expect(writtenStatements(query)).toEqual([]);
  });
});
