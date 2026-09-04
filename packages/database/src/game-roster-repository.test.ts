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

function lockedGame(
  paymentMode: 'NO_PAYMENT' | 'ORGANIZER_PAYS' | 'SPLIT' | 'SUBSCRIPTION' = 'NO_PAYMENT',
) {
  return {
    id: gameId,
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
    readonly paymentMode?: 'NO_PAYMENT' | 'ORGANIZER_PAYS' | 'SPLIT' | 'SUBSCRIPTION';
    readonly facts?: Readonly<Record<string, unknown>>;
  } = {},
) {
  if (text.includes('from games.command_idempotency')) return { rows: [] };
  if (
    text.includes('from (values (1)) source(marker)') &&
    text.includes('eligibility.level_policies')
  ) {
    return {
      rows: [
        {
          mode: null,
          lower_tolerance_steps: null,
          upper_tolerance_steps: null,
          missing_activity_constraint_action: null,
          legacy_text_constraint_action: null,
          policy_version: null,
          player_level_id: null,
          player_rank: null,
          player_level_source: null,
          player_scale_version: null,
          minimum_level_id: null,
          maximum_level_id: null,
          minimum_rank: null,
          maximum_rank: null,
          constraint_scale_version: null,
          valid_invitation_id: null,
        },
      ],
    };
  }
  if (text.includes('insert into eligibility.payment_snapshots')) return { rowCount: 1 };
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

  it.each(['SPLIT', 'SUBSCRIPTION'] as const)(
    'fails closed a %s join before eligibility, payment, reservation or event writes',
    async (paymentMode) => {
      const { pool, query } = poolWithHandler((text) => baseHandler(text, { paymentMode }));

      await expect(createGameRosterRepository(pool as never).join(input())).resolves.toEqual({
        outcome: 'rejected',
        code: 'GAME_PAYMENT_REQUIRED',
        currentRevision: 1,
        replayed: false,
      });

      const forbiddenWrites = [
        'insert into eligibility.decisions',
        'insert into eligibility.payment_snapshots',
        'insert into games.seat_reservations',
        'insert into games.scheduled_commands',
        'insert into games.participations',
        'insert into audit.outbox_events',
        'update eligibility.personal_invitations',
        'update games.games set revision',
      ];
      expect(
        query.mock.calls.filter(([text]) =>
          forbiddenWrites.some((needle) => text.includes(needle)),
        ),
      ).toEqual([]);
      expect(
        query.mock.calls.some(
          ([text, values]) =>
            text.includes("'FAILED'") && (values?.includes('GAME_PAYMENT_REQUIRED') ?? false),
        ),
      ).toBe(true);
      expect(
        query.mock.calls.some(
          ([text, values]) =>
            text.includes('insert into audit.audit_log') &&
            (values?.includes('GAME_PAYMENT_REQUIRED') ?? false),
        ),
      ).toBe(true);
    },
  );

  it.each(['SPLIT', 'SUBSCRIPTION'] as const)(
    'replays a fail-closed %s join without additional writes',
    async (paymentMode) => {
      let stored = false;
      const { pool, query } = poolWithHandler((text) => {
        if (text.includes('from games.command_idempotency') && stored) {
          return {
            rows: [
              {
                id: 'd39e4287-e65c-4e75-88e4-4447e4c91ddb',
                command_type: 'game.join.v1',
                request_hash: 'a'.repeat(64),
                state: 'FAILED',
                result_payload: null,
                error_code: 'GAME_PAYMENT_REQUIRED',
              },
            ],
          };
        }
        if (text.includes('insert into games.command_idempotency')) stored = true;
        return baseHandler(text, { paymentMode });
      });
      const repository = createGameRosterRepository(pool as never);
      const forbiddenWrites = [
        'insert into eligibility.decisions',
        'insert into eligibility.payment_snapshots',
        'insert into games.seat_reservations',
        'insert into games.scheduled_commands',
        'insert into games.participations',
        'insert into audit.outbox_events',
        'update eligibility.personal_invitations',
        'update games.games set revision',
      ];

      await expect(repository.join(input())).resolves.toMatchObject({
        outcome: 'rejected',
        code: 'GAME_PAYMENT_REQUIRED',
        replayed: false,
      });
      const forbiddenWritesAfterFirstAttempt = query.mock.calls.filter(([text]) =>
        forbiddenWrites.some((needle) => text.includes(needle)),
      ).length;
      await expect(repository.join(input())).resolves.toEqual({
        outcome: 'rejected',
        code: 'GAME_PAYMENT_REQUIRED',
        replayed: true,
      });
      expect(
        query.mock.calls.filter(([text]) =>
          forbiddenWrites.some((needle) => text.includes(needle)),
        ),
      ).toHaveLength(forbiddenWritesAfterFirstAttempt);
    },
  );

  it('keeps organizer-pays joins on the existing direct participation path', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('insert into games.participations')) {
        return { rows: [{ id: participationId }] };
      }
      if (text.includes('array_agg(user_id')) {
        return { rows: [{ user_ids: [organizerId, playerId] }] };
      }
      return baseHandler(text, { paymentMode: 'ORGANIZER_PAYS' });
    });

    await expect(createGameRosterRepository(pool as never).join(input())).resolves.toMatchObject({
      outcome: 'applied',
      viewerRelation: 'PARTICIPANT',
      participationId,
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) =>
        ['insert into games.seat_reservations', 'game.reservation.expire.v1'].some((needle) =>
          text.includes(needle),
        ),
      ),
    ).toBe(false);
  });

  it('atomically confirms a reserved split seat from trusted evidence and reuses its eligibility snapshot', async () => {
    const evidenceId = '253153f0-6810-4f1d-9c3a-58be08fbd28c';
    const eligibilityDecisionId = 'd63ff37f-ed9b-45f7-a135-838ea74925e0';
    const { pool, query } = poolWithHandler((text) => {
      if (
        text.includes('from games.seat_reservations') &&
        text.includes('eligibility_decision_id')
      ) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'REQUIRES_ACTION',
              expires_at: '2026-08-01T10:15:00.000Z',
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
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(
      createGameRosterRepository(pool as never).confirmPayment({
        ...input({ expectedRevision: undefined }),
        reservationId,
        evidence: {
          provider: 'VIVA',
          operationType: 'TRANSACTION',
          operationId: 'viva-transaction-101',
          bookingId: 'viva-booking-101',
          exerciseId: 'viva-exercise-101',
          clientPhoneE164: '+79000000001',
          evidenceHash: 'e'.repeat(64),
          verifiedAt: '2026-08-01T10:05:00.000Z',
          verifiedBy: 'LEGACY_NODE_RED',
          amountMinor: 250000,
          currency: 'RUB',
        },
      }),
    ).resolves.toMatchObject({
      outcome: 'applied',
      gameId,
      revision: 2,
      viewerRelation: 'PARTICIPANT',
      participationId,
      reservationId,
      replayed: false,
    });
    expect(query.mock.calls.some(([text]) => text.includes('eligibility.level_policies'))).toBe(
      false,
    );
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          text.includes('insert into games.participations') &&
          values?.includes(eligibilityDecisionId),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          text.includes("set state = 'CONFIRMED', payment_state = 'PAID'") &&
          values?.includes(reservationId),
      ),
    ).toBe(true);
    expect(
      query.mock.calls
        .filter(([text]) => text.includes('insert into audit.outbox_events'))
        .map((call) => call[1]?.[2]),
    ).toEqual(['game.participation.confirmed.v1']);
  });

  it('records a late provider confirmation for recovery without creating participation', async () => {
    const eligibilityDecisionId = 'd63ff37f-ed9b-45f7-a135-838ea74925e0';
    const { pool, query } = poolWithHandler((text) => {
      if (
        text.includes('from games.seat_reservations') &&
        text.includes('eligibility_decision_id')
      ) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'REQUIRES_ACTION',
              expires_at: '2026-08-01T09:59:00.000Z',
              eligibility_decision_id: eligibilityDecisionId,
              payment_snapshot_exists: true,
            },
          ],
        };
      }
      if (text.includes('from games.payment_confirmation_evidence')) return { rows: [] };
      if (text.includes('insert into games.payment_confirmation_evidence')) {
        return { rows: [{ id: '253153f0-6810-4f1d-9c3a-58be08fbd28c' }] };
      }
      if (text.includes('update games.payment_confirmation_evidence')) return { rowCount: 1 };
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(
      createGameRosterRepository(pool as never).confirmPayment({
        ...input({ expectedRevision: undefined }),
        reservationId,
        evidence: {
          provider: 'VIVA',
          operationType: 'TRANSACTION',
          operationId: 'viva-transaction-late',
          bookingId: 'viva-booking-late',
          exerciseId: 'viva-exercise-late',
          clientPhoneE164: '+79000000001',
          evidenceHash: 'f'.repeat(64),
          verifiedAt: '2026-08-01T10:05:00.000Z',
          verifiedBy: 'LEGACY_NODE_RED',
        },
      }),
    ).resolves.toEqual({
      outcome: 'rejected',
      code: 'GAME_RESERVATION_EXPIRED',
      currentRevision: 1,
      replayed: false,
    });
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          text.includes("resolution = 'REJECTED'") && values?.includes('GAME_RESERVATION_EXPIRED'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
  });

  it('rejects reuse of provider evidence for another reservation', async () => {
    const eligibilityDecisionId = 'd63ff37f-ed9b-45f7-a135-838ea74925e0';
    const { pool, query } = poolWithHandler((text) => {
      if (
        text.includes('from games.seat_reservations') &&
        text.includes('eligibility_decision_id')
      ) {
        return {
          rows: [
            {
              id: reservationId,
              user_id: playerId,
              state: 'ACTIVE',
              payment_state: 'REQUIRES_ACTION',
              expires_at: '2026-08-01T10:15:00.000Z',
              eligibility_decision_id: eligibilityDecisionId,
              payment_snapshot_exists: true,
            },
          ],
        };
      }
      if (text.includes('from games.payment_confirmation_evidence')) {
        return {
          rows: [
            {
              id: '253153f0-6810-4f1d-9c3a-58be08fbd28c',
              reservation_id: 'b56f61c7-0f40-49f2-bb5d-898f46406412',
              provider: 'VIVA',
              provider_operation_type: 'TRANSACTION',
              provider_operation_id: 'viva-transaction-reused',
              evidence_hash: '1'.repeat(64),
              resolution: 'APPLIED',
              error_code: null,
              participation_id: participationId,
              aggregate_revision: '2',
              resolved_at: '2026-08-01T10:04:00.000Z',
            },
          ],
        };
      }
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(
      createGameRosterRepository(pool as never).confirmPayment({
        ...input({ expectedRevision: undefined }),
        reservationId,
        evidence: {
          provider: 'VIVA',
          operationType: 'TRANSACTION',
          operationId: 'viva-transaction-reused',
          bookingId: 'viva-booking-reused',
          exerciseId: 'viva-exercise-reused',
          clientPhoneE164: '+79000000001',
          evidenceHash: '1'.repeat(64),
          verifiedAt: '2026-08-01T10:05:00.000Z',
          verifiedBy: 'LEGACY_NODE_RED',
        },
      }),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      code: 'GAME_PAYMENT_EVIDENCE_CONFLICT',
    });
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.participations')),
    ).toBe(false);
  });

  it('fails closed a paid join before evaluating a missing canonical player level', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('eligibility.level_policies')) {
        return { rows: [eligibilityFacts()] };
      }
      if (text.includes('from games.games') && text.includes('for update')) {
        return {
          rows: [
            {
              ...lockedGame('SPLIT'),
              min_level_id: '1dfc1d4a-47cb-4b43-a735-761260a2e986',
              max_level_id: '7d7556e6-f30b-48e5-9ff2-c39bdf062ff7',
            },
          ],
        };
      }
      return baseHandler(text, { paymentMode: 'SPLIT' });
    });

    await expect(createGameRosterRepository(pool as never).join(input())).resolves.toEqual({
      outcome: 'rejected',
      code: 'GAME_PAYMENT_REQUIRED',
      currentRevision: 1,
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into eligibility.decisions')),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into games.seat_reservations')),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) => text.includes('insert into eligibility.payment_snapshots')),
    ).toBe(false);
  });

  it('accepts only a repository-validated personal invitation and consumes it after the join', async () => {
    const invitationId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('eligibility.level_policies')) {
        return { rows: [eligibilityFacts({ valid_invitation_id: invitationId })] };
      }
      if (text.includes('from games.games') && text.includes('for update')) {
        return {
          rows: [
            {
              ...lockedGame(),
              min_level_id: '1dfc1d4a-47cb-4b43-a735-761260a2e986',
              max_level_id: '7d7556e6-f30b-48e5-9ff2-c39bdf062ff7',
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
      createGameRosterRepository(pool as never).join(input({ invitationId })),
    ).resolves.toMatchObject({ outcome: 'applied', viewerRelation: 'PARTICIPANT' });
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          text.includes('update eligibility.personal_invitations') &&
          values?.includes(invitationId),
      ),
    ).toBe(true);
    const validationSql = query.mock.calls.find(([text]) =>
      text.includes('from eligibility.personal_invitations'),
    )?.[0];
    expect(validationSql).toContain("invitation_type = 'PERSONAL'");
    expect(validationSql).toContain('tenant_id = $1');
    expect(validationSql).toContain("activity_type = 'GAME'");
    expect(validationSql).toContain('activity_id = $9');
    expect(validationSql).toContain('recipient_player_id = $2');
    expect(validationSql).toContain("status = 'ACTIVE'");
    expect(validationSql).toContain('revoked_at is null');
    expect(validationSql).toContain('expires_at > now()');
    expect(validationSql).toContain('use_count < max_uses');
  });

  it('does not treat an unvalidated public or forged invitation id as a level bypass', async () => {
    const invitationId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
    const { pool } = poolWithHandler((text) => {
      if (text.includes('eligibility.level_policies')) {
        return { rows: [eligibilityFacts({ valid_invitation_id: null })] };
      }
      if (text.includes('from games.games') && text.includes('for update')) {
        return {
          rows: [
            {
              ...lockedGame(),
              min_level_id: '1dfc1d4a-47cb-4b43-a735-761260a2e986',
              max_level_id: '7d7556e6-f30b-48e5-9ff2-c39bdf062ff7',
            },
          ],
        };
      }
      return baseHandler(text);
    });

    await expect(
      createGameRosterRepository(pool as never).join(input({ invitationId })),
    ).resolves.toMatchObject({ outcome: 'rejected', code: 'PLAYER_LEVEL_REQUIRED' });
  });

  it('does not consume an invitation when the level rule is OFF and no bypass was used', async () => {
    const invitationId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('eligibility.level_policies')) {
        return {
          rows: [
            eligibilityFacts({
              mode: null,
              policy_version: null,
              valid_invitation_id: invitationId,
            }),
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
      createGameRosterRepository(pool as never).join(input({ invitationId })),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(
      query.mock.calls.some(([text]) => text.includes('update eligibility.personal_invitations')),
    ).toBe(false);
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

  it('fails closed before releasing capacity when leaving a paid game', async () => {
    const { pool, query } = poolWithHandler((text) =>
      baseHandler(text, {
        paymentMode: 'SPLIT',
        facts: {
          active_participant_count: 2,
          participation_id: participationId,
          participation_role: 'PLAYER',
        },
      }),
    );

    await expect(
      createGameRosterRepository(pool as never).leave(
        input({ idempotencyKey: 'games-paid-leave-command-0001', requestHash: 'f'.repeat(64) }),
      ),
    ).resolves.toEqual({
      outcome: 'rejected',
      code: 'GAME_PAYMENT_REQUIRED',
      currentRevision: 1,
      replayed: false,
    });

    expect(
      query.mock.calls.some(([text]) =>
        [
          'update games.participations',
          'update games.games set revision',
          'insert into audit.outbox_events',
          'insert into games.scheduled_commands',
        ].some((needle) => text.includes(needle)),
      ),
    ).toBe(false);
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
              personal_invitation_id: null,
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

  it('fails closed without touching the waitlist for a paid promotion command', async () => {
    const commandId = '6c495f29-c3e6-426f-a855-28301b447152';
    const { pool, query } = poolWithHandler((text) => baseHandler(text, { paymentMode: 'SPLIT' }));

    await expect(
      createGameRosterRepository(pool as never).promoteWaitlist({
        tenantId,
        gameId,
        commandId,
        idempotencyKey: 'games-paid-promote-command-0001',
        requestHash: 'e'.repeat(64),
        correlationId: 'corr-games-paid-promote-0001',
        waitlistEntryId,
      }),
    ).resolves.toEqual({
      outcome: 'no_op',
      commandId,
      gameId,
      revision: 1,
      replayed: false,
    });

    expect(
      query.mock.calls.some(([text]) =>
        [
          'update games.waitlist_entries',
          'insert into games.participations',
          'insert into games.seat_reservations',
        ].some((needle) => text.includes(needle)),
      ),
    ).toBe(false);
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
