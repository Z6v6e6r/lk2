import { describe, expect, it, vi } from 'vitest';
import type { SubmitGameResultInput } from '@phub/games';
import { createGameResultRepository } from './game-result-repository.js';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
] as const;
const input = {
  tenantId: '55555555-5555-4555-8555-555555555555',
  actorUserId: ids[1],
  gameId: '66666666-6666-4666-8666-666666666666',
  submissionId: '77777777-7777-4777-8777-777777777777',
  idempotencyKey: 'synthetic-score-attempt',
  requestHash: 'a'.repeat(64),
  correlationId: 'synthetic-result-clock',
};
const result: SubmitGameResultInput = {
  sets: [
    {
      setNumber: 1,
      teamAUserIds: [ids[0], ids[1]],
      teamBUserIds: [ids[2], ids[3]],
      teamA: 6,
      teamB: 4,
    },
  ],
};
const deadline = '2026-11-16T03:00:00.000Z';
function harness(now: string, state = 'PENDING_CONFIRMATION') {
  const ledger = new Map<string, Record<string, unknown>>();
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    await Promise.resolve();
    calls.push({ sql, values });
    if (sql.includes('from games.command_idempotency'))
      return {
        rows: ledger.has(String(values[2])) ? [ledger.get(String(values[2]))] : [],
        rowCount: 0,
      };
    if (sql.includes('from games.games'))
      return {
        rows: [
          {
            revision: 7,
            lifecycle_state: 'FINISHED',
            result_state: state,
            ends_at: '2026-11-15T15:00:00.000Z',
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('select clock_timestamp()'))
      return { rows: [{ database_now: now }], rowCount: 1 };
    if (sql.includes('from games.participations'))
      return { rows: ids.map((user_id) => ({ user_id })), rowCount: 4 };
    if (sql.includes('from games.result_submissions') && !sql.includes('max(revision)'))
      return {
        rows: [
          {
            id: input.submissionId,
            revision: 1,
            submitted_by_user_id: ids[0],
            submitted_at: '2026-11-16T02:00:00.000Z',
            state,
            confirmation_quorum: 1,
            score_payload: result,
            roster_snapshot: { participantUserIds: ids },
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('max(revision)')) return { rows: [{ revision: 1 }], rowCount: 1 };
    if (sql.includes('update games.games')) return { rows: [{ revision: 8 }], rowCount: 1 };
    if (sql.includes('count(*)::integer')) return { rows: [{ count: 1 }], rowCount: 1 };
    if (sql.includes('insert into games.command_idempotency') && sql.includes("'COMPLETED'")) {
      ledger.set(String(values[4]), {
        command_type: values[5],
        request_hash: values[6],
        state: 'COMPLETED',
        result_payload: JSON.parse(String(values[8])),
        error_code: null,
      });
    }
    return { rows: [], rowCount: 1 };
  });
  const repository = createGameResultRepository({
    connect: () => Promise.resolve({ query, release: vi.fn() }),
  } as never);
  return { repository, calls };
}
describe('game result command deadline and recovery', () => {
  it('accepts first entry immediately before expiry and rejects it exactly at expiry', async () => {
    const before = harness('2026-11-16T02:59:59.999Z', 'AWAITING_SUBMISSION');
    expect(await before.repository.submit({ ...input, result })).toMatchObject({
      outcome: 'applied',
    });
    const at = harness(deadline, 'AWAITING_SUBMISSION');
    expect(await at.repository.submit({ ...input, result })).toMatchObject({
      outcome: 'rejected',
      code: 'GAME_RESULT_NOT_AVAILABLE',
    });
    expect(at.calls.some((c) => c.sql.includes('insert into games.result_submissions'))).toBe(
      false,
    );
  });
  it.each(['confirm', 'dispute'] as const)(
    'enforces original deadline for %s after authorization',
    async (command) => {
      const h = harness(deadline);
      const response =
        command === 'confirm'
          ? await h.repository.confirm(input)
          : await h.repository.dispute({ ...input, dispute: { reasonCode: 'SCORE_INCORRECT' } });
      expect(response).toMatchObject({ outcome: 'rejected', code: 'GAME_RESULT_NOT_AVAILABLE' });
      expect(
        h.calls.some((c) => c.sql.includes('insert into games.result_submission_reviews')),
      ).toBe(false);
      const lock = h.calls.findIndex(
        (c) => c.sql.includes('from games.games') && c.sql.includes('for update'),
      );
      expect(h.calls.findIndex((c) => c.sql.includes('select clock_timestamp()'))).toBeGreaterThan(
        lock,
      );
    },
  );
  it('does not extend corrected entry after a dispute', async () => {
    const h = harness(deadline, 'DISPUTED');
    expect(await h.repository.submit({ ...input, result })).toMatchObject({
      outcome: 'rejected',
      code: 'GAME_RESULT_NOT_AVAILABLE',
    });
    expect(h.calls.some((c) => c.sql.includes("set state = 'SUPERSEDED'"))).toBe(false);
  });
  it('auto-confirms at game end +12h even when submitted only an hour earlier and replays once', async () => {
    const h = harness(deadline);
    const command = {
      tenantId: input.tenantId,
      gameId: input.gameId,
      submissionId: input.submissionId,
      confirmationWindowHours: 12,
      correlationId: input.correlationId,
    };
    expect(await h.repository.autoConfirm(command)).toMatchObject({
      outcome: 'applied',
      resultState: 'CONFIRMED',
      replayed: false,
    });
    expect(await h.repository.autoConfirm(command)).toMatchObject({
      outcome: 'applied',
      resultState: 'CONFIRMED',
      replayed: true,
    });
    expect(h.calls.filter((c) => c.sql.includes('insert into games.results ('))).toHaveLength(1);
    expect(h.calls.filter((c) => c.sql.includes('insert into audit.outbox_events'))).toHaveLength(
      1,
    );
    expect(
      h.calls.find((c) => c.sql.includes('insert into games.command_idempotency'))?.values[4],
    ).toContain('auto-confirm:end-window:');
  });
  it('never automatically confirms an active dispute', async () => {
    const h = harness(deadline, 'DISPUTED');
    expect(
      await h.repository.autoConfirm({
        tenantId: input.tenantId,
        gameId: input.gameId,
        submissionId: input.submissionId,
        confirmationWindowHours: 12,
        correlationId: input.correlationId,
      }),
    ).toMatchObject({ outcome: 'rejected' });
    expect(h.calls.some((c) => c.sql.includes('insert into games.results ('))).toBe(false);
  });
});
