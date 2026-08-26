import { describe, expect, it, vi } from 'vitest';

import { createGameRepository } from './game-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const operationId = 'd724f040-f5ec-4432-8c59-d016f68348fe';
const eventId = '7d04d95e-cfb9-40a1-a0a7-f8d03c5d385c';
const levelCId = 'af1dd32c-fb29-4b8f-9de5-eae140157a91';
const levelBId = '22228914-c9c2-49c8-8214-ffb2f42d240c';

const gameRow = {
  id: gameId,
  tenant_id: tenantId,
  revision: '1',
  organizer_user_id: actorUserId,
  title: 'Игра в Сколково',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  lifecycle_state: 'PROVISIONING',
  station_id: 'bd35543d-c565-443a-bd3d-eea68eb2fbe6',
  court_id: null,
  booking_id: null,
  starts_at: '2026-07-20T16:00:00.000Z',
  ends_at: '2026-07-20T17:30:00.000Z',
  timezone: 'Europe/Moscow',
  capacity: 4,
  waitlist_enabled: true,
  join_cutoff_at: '2026-07-20T15:30:00.000Z',
  payment_mode: 'SPLIT',
  level_from: 'C',
  level_to: 'B',
  result_state: 'NOT_AVAILABLE',
  card_projection_revision: null,
  created_at: '2026-07-17T12:00:00.000Z',
  updated_at: '2026-07-17T12:00:00.000Z',
} as const;

function createInput() {
  return {
    tenantId,
    actorUserId,
    idempotencyKey: 'create-game-key-0001',
    requestHash: 'a'.repeat(64),
    correlationId: 'corr-games-create-0001',
    title: 'Игра в Сколково',
    kind: 'FRIENDLY' as const,
    visibility: 'PUBLIC' as const,
    stationId: gameRow.station_id,
    startsAt: gameRow.starts_at,
    endsAt: gameRow.ends_at,
    timezone: gameRow.timezone,
    capacity: 4,
    waitlistEnabled: true,
    joinCutoffAt: gameRow.join_cutoff_at,
    paymentMode: 'SPLIT' as const,
    levelFrom: 'C' as const,
    levelTo: 'B' as const,
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
  const release = vi.fn();
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release }) },
    query,
    release,
  };
}

describe('game repository', () => {
  it('creates canonical state, command result, audit and two outbox facts atomically', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from eligibility.canonical_levels')) {
        return {
          rows: [
            { id: levelCId, code: 'C', rank: 3, scale_version: 1 },
            { id: levelBId, code: 'B', rank: 5, scale_version: 1 },
          ],
        };
      }
      if (text.includes('insert into games.games')) return { rows: [gameRow] };
      return { rows: [] };
    });

    const result = await createGameRepository(pool as never).create(createInput());

    expect(result).toMatchObject({
      outcome: 'applied',
      gameId,
      revision: 1,
      replayed: false,
    });
    expect(query).toHaveBeenCalledWith('begin');
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
    expect(query.mock.calls.some(([text]) => text.includes('for update'))).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('games.participations'))).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('games.operations'))).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('games.scheduled_commands'))).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('games.command_idempotency'))).toBe(
      true,
    );
    expect(query.mock.calls.some(([text]) => text.includes('audit.audit_log'))).toBe(true);
    expect(query.mock.calls.some(([text]) => text.includes('player_sport_levels'))).toBe(false);

    const gameInsert = query.mock.calls.find(([text]) => text.includes('insert into games.games'));
    expect(gameInsert?.[0]).toContain('min_level_id, max_level_id');
    expect(gameInsert?.[1]?.slice(-5)).toEqual(['C', 'B', levelCId, levelBId, 'PROVISIONING']);
    const auditInsert = query.mock.calls.find(([text]) => text.includes('audit.audit_log'));
    expect(JSON.parse(String(auditInsert?.[1]?.[4]))).toMatchObject({
      participationEligibility: {
        ruleCode: 'LEVEL_RANGE',
        outcome: 'BYPASS',
        reasonCode: 'ORGANIZER_CREATION_BYPASS',
      },
    });

    const outboxCalls = query.mock.calls.filter(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outboxCalls).toHaveLength(2);
    expect(outboxCalls.map((call) => call[1]?.[2])).toEqual([
      'game.created.v1',
      'game.provisioning.requested.v1',
    ]);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('schedules a no-payment game without a provider provisioning command', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from eligibility.canonical_levels')) {
        return {
          rows: [
            { id: levelCId, code: 'C', rank: 3, scale_version: 1 },
            { id: levelBId, code: 'B', rank: 5, scale_version: 1 },
          ],
        };
      }
      if (text.includes('insert into games.games')) {
        return {
          rows: [{ ...gameRow, lifecycle_state: 'SCHEDULED', payment_mode: 'NO_PAYMENT' }],
        };
      }
      return { rows: [] };
    });

    await expect(
      createGameRepository(pool as never).create({ ...createInput(), paymentMode: 'NO_PAYMENT' }),
    ).resolves.toMatchObject({ outcome: 'applied', gameId, revision: 1 });

    const scheduled = query.mock.calls.find(([text]) => text.includes("'game.lifecycle.start.v1'"));
    expect(scheduled?.[0]).toContain("'game.lifecycle.finish.v1'");
    expect(query.mock.calls.some(([text]) => text.includes("'game.provisioning.advance.v1'"))).toBe(
      false,
    );
    const operation = query.mock.calls.find(([text]) =>
      text.includes('insert into games.operations'),
    );
    expect(operation?.[1]).toContain('SUCCEEDED');
    const idempotency = query.mock.calls.find(([text]) =>
      text.includes('insert into games.command_idempotency'),
    );
    expect(idempotency?.[1]?.[1]).toBe(operation?.[1]?.[1]);
    expect(
      query.mock.calls
        .filter(([text]) => text.includes('insert into audit.outbox_events'))
        .map((call) => call[1]?.[2]),
    ).toEqual(['game.created.v1', 'game.scheduled.v1', 'game.published.v1']);
  });

  it('cancels only the organizer-owned no-payment game and emits one durable event', async () => {
    const scheduledGame = {
      ...gameRow,
      lifecycle_state: 'SCHEDULED',
      payment_mode: 'NO_PAYMENT',
    } as const;
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.games') && text.includes('for update')) {
        return { rows: [scheduledGame] };
      }
      if (text.includes('update games.games') && text.includes("lifecycle_state = 'CANCELLED'")) {
        return { rows: [{ revision: '2' }] };
      }
      if (text.includes('select user_id from games.participations')) {
        return { rows: [{ user_id: actorUserId }] };
      }
      return { rows: [] };
    });

    await expect(
      createGameRepository(pool as never).cancel({
        tenantId,
        actorUserId,
        gameId,
        idempotencyKey: 'cancel-game-key-0001',
        requestHash: 'c'.repeat(64),
        correlationId: 'cancel-game-correlation-0001',
        reasonCode: 'ORGANIZER_REQUEST',
      }),
    ).resolves.toMatchObject({ outcome: 'applied', gameId, revision: 2, replayed: false });

    const outbox = query.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]?.[2]).toBe('game.cancelled.v1');
    expect(JSON.parse(String(outbox?.[1]?.[5]))).toMatchObject({
      participantUserIds: [actorUserId],
      reasonCode: 'ORGANIZER_REQUEST',
    });
  });

  it('rejects cancellation by a non-organizer before changing the aggregate', async () => {
    const { pool, query } = poolWithHandler((text) =>
      text.includes('from games.games') && text.includes('for update')
        ? {
            rows: [
              {
                ...gameRow,
                lifecycle_state: 'SCHEDULED',
                payment_mode: 'NO_PAYMENT',
                organizer_user_id: '11111111-1111-4111-8111-111111111111',
              },
            ],
          }
        : { rows: [] },
    );

    await expect(
      createGameRepository(pool as never).cancel({
        tenantId,
        actorUserId,
        gameId,
        idempotencyKey: 'cancel-game-key-0002',
        requestHash: 'd'.repeat(64),
        correlationId: 'cancel-game-correlation-0002',
        reasonCode: 'ORGANIZER_REQUEST',
      }),
    ).resolves.toEqual({
      outcome: 'rejected',
      code: 'GAME_NOT_CANCELLABLE',
      currentRevision: 1,
      replayed: false,
    });
    expect(query.mock.calls.some(([text]) => text.includes('update games.games'))).toBe(false);
  });

  it('rejects an unmapped or reversed canonical range before creating aggregate state', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from eligibility.canonical_levels')) {
        return {
          rows: [
            { id: levelCId, code: 'C', rank: 3, scale_version: 1 },
            { id: levelBId, code: 'B', rank: 5, scale_version: 1 },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      createGameRepository(pool as never).create({
        ...createInput(),
        levelFrom: 'B',
        levelTo: 'C',
      }),
    ).rejects.toThrow('GAME_CREATE_LEVEL_RANGE_INVALID');
    expect(query.mock.calls.some(([text]) => text.includes('insert into games.games'))).toBe(false);
    expect(query).toHaveBeenCalledWith('rollback');
  });

  it('replays a legacy completed result using the durable command timestamp', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency')) {
        return {
          rows: [
            {
              command_type: 'game.create.v1',
              request_hash: 'a'.repeat(64),
              state: 'COMPLETED',
              completed_at: '2026-07-17T12:00:00.000Z',
              result_payload: {
                outcome: 'applied',
                gameId,
                operationId,
                revision: 1,
              },
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(createGameRepository(pool as never).create(createInput())).resolves.toEqual({
      outcome: 'applied',
      gameId,
      operationId,
      revision: 1,
      committedAt: '2026-07-17T12:00:00.000Z',
      replayed: true,
    });
    expect(query.mock.calls.some(([text]) => text.includes('insert into games.games'))).toBe(false);
  });

  it('reads an actor-owned create operation by the returned durable operation id', async () => {
    const { pool } = poolWithHandler((text, values) => {
      if (text.includes("command_type in ('game.create.v1', 'game.cancel.v1')")) {
        expect(values).toEqual([tenantId, operationId, actorUserId]);
        return {
          rows: [
            {
              command_type: 'game.create.v1',
              request_hash: 'a'.repeat(64),
              state: 'COMPLETED',
              completed_at: '2026-07-17T12:00:00.000Z',
              result_payload: {
                outcome: 'applied',
                gameId,
                operationId,
                revision: 1,
              },
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      createGameRepository(pool as never).getManagementOperation({
        tenantId,
        actorUserId,
        operationId,
      }),
    ).resolves.toEqual({
      commandType: 'game.create.v1',
      result: {
        outcome: 'applied',
        gameId,
        operationId,
        revision: 1,
        committedAt: '2026-07-17T12:00:00.000Z',
        replayed: true,
      },
    });
  });

  it('rejects idempotency key reuse with another request hash', async () => {
    const { pool } = poolWithHandler((text) =>
      text.includes('from games.command_idempotency')
        ? {
            rows: [
              {
                command_type: 'game.create.v1',
                request_hash: 'b'.repeat(64),
                state: 'COMPLETED',
                result_payload: {},
              },
            ],
          }
        : { rows: [] },
    );

    await expect(createGameRepository(pool as never).create(createInput())).resolves.toEqual({
      outcome: 'idempotency_conflict',
    });
  });

  it('uses monotonic keyset order for public projections', async () => {
    const { pool, query } = poolWithHandler(() => ({ rows: [] }));
    const repository = createGameRepository(pool as never);

    await repository.listPublicCardProjections({
      tenantId,
      limit: 20,
      after: { startsAt: '2026-07-20T16:00:00.000Z', gameId },
    });

    const listCall = query.mock.calls.find(([text]) =>
      text.includes('from games.card_projections'),
    );
    expect(listCall?.[0]).toContain('(starts_at, game_id) >');
    expect(listCall?.[0]).toContain("visibility = 'PUBLIC'");
    expect(listCall?.[0]).toContain('starts_at > now()');
    expect(listCall?.[1]).toEqual([tenantId, '2026-07-20T16:00:00.000Z', gameId, 21]);
  });

  it('selects viewer cards from the same projection snapshot with direction-aware keysets', async () => {
    const { pool, query } = poolWithHandler(() => ({ rows: [] }));
    await createGameRepository(pool as never).listViewerCardProjections({
      tenantId,
      viewerUserId: actorUserId,
      scope: 'HISTORY',
      limit: 20,
      after: { startsAt: gameRow.starts_at, gameId },
    });

    const call = query.mock.calls.find(([text]) =>
      text.includes("base_payload ->> 'organizerUserId'"),
    );
    expect(call?.[0]).toContain("lifecycle_state in ('FINISHED', 'CANCELLED')");
    expect(call?.[0]).toContain("reservation ->> 'expiresAt'");
    expect(call?.[0]).toContain('::timestamptz > now()');
    expect(call?.[0]).toContain('(starts_at, game_id) <');
    expect(call?.[0]).toContain('order by starts_at desc, game_id desc');
    expect(call?.[1]).toEqual([tenantId, actorUserId, gameRow.starts_at, gameId, 21]);
  });

  it('atomically projects the current locked aggregate and marks the event inbox', async () => {
    const scheduled = {
      ...gameRow,
      revision: '2',
      lifecycle_state: 'SCHEDULED',
      station_name: 'Падел Сколково',
      station_short_address: 'Новая, 1',
    };
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('insert into audit.inbox_events')) return { rows: [{ event_id: eventId }] };
      if (text.includes('from games.games g')) return { rows: [scheduled] };
      if (text.includes('from games.participations p')) {
        return {
          rows: [
            {
              user_id: actorUserId,
              display_name: 'Алексей',
              photo_url: null,
              level_label: 'C+',
              level_value: '3.43844',
              role: 'ORGANIZER',
              payment_state: 'NOT_REQUIRED',
            },
          ],
        };
      }
      if (text.includes('insert into games.card_projections')) return { rowCount: 1 };
      return { rows: [] };
    });

    await expect(
      createGameRepository(pool as never).projectCardEvent({ tenantId, eventId, gameId }),
    ).resolves.toBe('applied');
    const projectionCall = query.mock.calls.find(([text]) =>
      text.includes('insert into games.card_projections'),
    );
    expect(JSON.parse(String(projectionCall?.[1]?.[7]))).toMatchObject({
      participants: [{ userId: actorUserId, level: 'C+', levelValue: 3.43844 }],
    });
    const projectionWrite = query.mock.calls.find(([text]) =>
      text.includes('insert into games.card_projections'),
    );
    const snapshot = JSON.parse(String(projectionWrite?.[1]?.[7])) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      id: gameId,
      revision: 2,
      lifecycleState: 'SCHEDULED',
      station: { name: 'Падел Сколково' },
      participants: [{ userId: actorUserId, displayName: 'Алексей' }],
    });
    expect(
      query.mock.calls.some(([text]) =>
        text.includes('update audit.inbox_events set processed_at'),
      ),
    ).toBe(true);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('deduplicates a repeated projector event before loading aggregate state', async () => {
    const { pool, query } = poolWithHandler((text) =>
      text.includes('insert into audit.inbox_events') ? { rowCount: 0 } : { rows: [] },
    );
    await expect(
      createGameRepository(pool as never).projectCardEvent({ tenantId, eventId, gameId }),
    ).resolves.toBe('duplicate');
    expect(query.mock.calls.some(([text]) => text.includes('from games.games g'))).toBe(false);
  });

  it('claims due commands with row locking and bounded attempts', async () => {
    const commandId = '0ef0247c-cae5-4e38-b4bf-1caf19e66746';
    const { pool, query } = poolWithHandler((text) =>
      text.includes('with due as')
        ? {
            rows: [
              {
                id: commandId,
                game_id: gameId,
                command_type: 'game.lifecycle.start.v1',
                expected_revision: '2',
                payload: {},
                attempts: 1,
              },
            ],
          }
        : { rows: [] },
    );

    await expect(
      createGameRepository(pool as never).claimScheduledCommands({
        tenantId,
        workerId: 'worker-games-1',
        limit: 10,
        commandTypes: ['game.lifecycle.start.v1', 'game.lifecycle.finish.v1'],
      }),
    ).resolves.toEqual([
      {
        id: commandId,
        gameId,
        commandType: 'game.lifecycle.start.v1',
        expectedRevision: 2,
        payload: {},
        attempts: 1,
      },
    ]);
    const claimCall = query.mock.calls.find(([text]) => text.includes('with due as'));
    expect(claimCall?.[0]).toContain('for update skip locked');
    expect(claimCall?.[0]).toContain('attempts < 20');
    expect(claimCall?.[0]).toContain('command_type = any($4::text[])');
    expect(claimCall?.[1]?.[3]).toEqual(['game.lifecycle.start.v1', 'game.lifecycle.finish.v1']);
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          text.includes("last_error_code = 'GAME_COMMAND_CLAIM_EXPIRED'") &&
          text.includes("interval '60 seconds'") &&
          values?.[1] instanceof Array &&
          values[1].includes('game.lifecycle.start.v1'),
      ),
    ).toBe(true);
  });

  it('applies a claimed lifecycle command, audit and outbox event atomically', async () => {
    const commandId = '0ef0247c-cae5-4e38-b4bf-1caf19e66746';
    const occurredAt = new Date('2026-07-20T16:00:01.000Z');
    const scheduled = {
      id: gameId,
      revision: '5',
      lifecycle_state: 'SCHEDULED',
      starts_at: '2026-07-20T16:00:00.000Z',
      ends_at: '2026-07-20T17:30:00.000Z',
    };
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.scheduled_commands') && text.includes("state = 'PROCESSING'")) {
        return {
          rows: [
            {
              id: commandId,
              game_id: gameId,
              command_type: 'game.lifecycle.start.v1',
              due_at: scheduled.starts_at,
              expected_revision: scheduled.revision,
            },
          ],
        };
      }
      if (text.includes('from games.games') && text.includes('for update')) {
        return { rows: [scheduled] };
      }
      if (text.includes('update games.games') && text.includes('returning revision')) {
        return { rows: [{ revision: '6' }] };
      }
      if (text.includes('from games.participations')) {
        return { rows: [{ user_id: actorUserId }] };
      }
      if (
        text.includes('update games.scheduled_commands') &&
        text.includes("state = 'COMPLETED'")
      ) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    });

    await expect(
      createGameRepository(pool as never).executeLifecycleCommand({
        tenantId,
        workerId: 'games-process-manager-test',
        commandId,
        correlationId: `games-process-manager-${commandId}`,
        occurredAt,
      }),
    ).resolves.toMatchObject({
      outcome: 'applied',
      gameId,
      lifecycleState: 'IN_PROGRESS',
      revision: 6,
    });

    const aggregateUpdate = query.mock.calls.find(
      ([text]) => text.includes('update games.games') && text.includes('returning revision'),
    );
    expect(aggregateUpdate?.[0]).toContain("when $4 = 'FINISHED'");
    expect(aggregateUpdate?.[1]?.[3]).toBe('IN_PROGRESS');
    const outbox = query.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]?.[2]).toBe('game.started.v1');
    expect(outbox?.[1]?.[5]).toContain(`"causationId":"${commandId}"`);
    const audit = query.mock.calls.find(([text]) => text.includes('insert into audit.audit_log'));
    expect(audit?.[1]?.[1]).toBe('GAME_LIFECYCLE_STARTED');
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('refreshes a stale lifecycle command from canonical revision and schedule', async () => {
    const commandId = '0ef0247c-cae5-4e38-b4bf-1caf19e66746';
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.scheduled_commands') && text.includes("state = 'PROCESSING'")) {
        return {
          rows: [
            {
              id: commandId,
              game_id: gameId,
              command_type: 'game.lifecycle.start.v1',
              due_at: '2026-07-20T15:00:00.000Z',
              expected_revision: '4',
            },
          ],
        };
      }
      if (text.includes('from games.games') && text.includes('for update')) {
        return {
          rows: [
            {
              id: gameId,
              revision: '5',
              lifecycle_state: 'SCHEDULED',
              starts_at: '2026-07-20T16:00:00.000Z',
              ends_at: '2026-07-20T17:30:00.000Z',
            },
          ],
        };
      }
      if (
        text.includes('update games.scheduled_commands') &&
        text.includes("last_error_code = 'GAME_COMMAND_RESCHEDULED'")
      ) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    });

    await expect(
      createGameRepository(pool as never).executeLifecycleCommand({
        tenantId,
        workerId: 'games-process-manager-test',
        commandId,
        correlationId: `games-process-manager-${commandId}`,
        occurredAt: new Date('2026-07-20T15:30:00.000Z'),
      }),
    ).resolves.toEqual({
      outcome: 'rescheduled',
      gameId,
      dueAt: '2026-07-20T16:00:00.000Z',
      expectedRevision: 5,
    });
    expect(query.mock.calls.some(([text]) => text.includes('update games.games'))).toBe(false);
    const reschedule = query.mock.calls.find(
      ([text]) =>
        text.includes('update games.scheduled_commands') &&
        text.includes("last_error_code = 'GAME_COMMAND_RESCHEDULED'"),
    );
    expect(reschedule?.[0]).toContain('expected_revision = $6::bigint');
    expect(reschedule?.[0]).toContain("'expectedRevision', $6::bigint::text");
    expect(query).toHaveBeenCalledWith('commit');
  });
});
