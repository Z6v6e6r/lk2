import { describe, expect, it, vi } from 'vitest';

import { createGameRepository } from './game-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const operationId = 'd724f040-f5ec-4432-8c59-d016f68348fe';
const eventId = '7d04d95e-cfb9-40a1-a0a7-f8d03c5d385c';

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

  it('replays the original completed result without writing aggregate state again', async () => {
    const { pool, query } = poolWithHandler((text) => {
      if (text.includes('from games.command_idempotency')) {
        return {
          rows: [
            {
              command_type: 'game.create.v1',
              request_hash: 'a'.repeat(64),
              state: 'COMPLETED',
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
      replayed: true,
    });
    expect(query.mock.calls.some(([text]) => text.includes('insert into games.games'))).toBe(false);
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
  });
});
