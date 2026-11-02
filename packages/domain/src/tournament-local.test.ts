import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  parseTournamentReceipt,
  parseTournamentCommand,
  tournamentOwnerOperationId,
  tournamentDigest,
} from './tournament-local.js';
const id = '11111111-1111-4111-a111-111111111111';
const command = {
  schemaVersion: 1 as const,
  action: 'JOIN' as const,
  tournamentId: id,
  date: '2026-11-01',
};
export function tournamentReceipt(operationId = id) {
  return {
    schemaVersion: 1 as const,
    tournamentId: id,
    operation: {
      operationId,
      action: 'JOIN' as const,
      outcome: 'REGISTERED' as const,
      reason: 'REGISTERED' as const,
      generation: operationId,
      committedAt: '2026-10-31T12:00:00Z',
    },
    registration: { status: 'REGISTERED' as const, asOf: '2026-10-31T12:00:01Z' },
  };
}
describe('CUP local tournament exact wire', () => {
  it('matches CUP #64 commandIdentity domains and ordering', async () => {
    const digest = (d: string, v: unknown) =>
      createHash('sha256')
        .update(d + '\0')
        .update(JSON.stringify(v))
        .digest('hex');
    const actor = digest('tournament-local-actor:v1', ['tenant', '7']);
    const key = digest('tournament-local-key:v1', ['tenant', actor, id, 'lk2-tournament:' + id]);
    const h = digest('tournament-local-operation:v1', key);
    expect(await tournamentOwnerOperationId('tenant', '7', 'lk2-tournament:' + id, id)).toBe(
      `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
    );
    expect(
      await tournamentDigest('tournament-local-request:v1', parseTournamentCommand(command)),
    ).toBe(digest('tournament-local-request:v1', command));
  });
  it('canonicalizes JSONB key order before receipt hashing', () => {
    const r = tournamentReceipt();
    expect(
      parseTournamentReceipt(
        { ...r, operation: Object.fromEntries(Object.entries(r.operation).reverse()) },
        command,
        id,
      ),
    ).toEqual(r);
  });
  it.each(['operationId', 'action', 'generation', 'reason'])(
    'rejects forged %s even for terminal receipt',
    (field) => {
      const r = tournamentReceipt();
      expect(() =>
        parseTournamentReceipt(
          { ...r, operation: { ...r.operation, [field]: 'forged' } },
          command,
          id,
        ),
      ).toThrow();
    },
  );
  it('refuses extra, missing, invalid date and caller gender', () => {
    expect(() =>
      parseTournamentReceipt({ ...tournamentReceipt(), extra: true }, command, id),
    ).toThrow();
    for (const c of [
      { ...command, date: '2026-02-30' },
      { ...command, gender: 'MALE' },
      { ...command, schemaVersion: 2 },
    ])
      expect(() => parseTournamentCommand(c)).toThrow();
  });
  it('binds LEAVE to exact old generation', () => {
    const c = { ...command, action: 'LEAVE' as const, originalJoinOperationId: id };
    const r = {
      ...tournamentReceipt(),
      operation: {
        ...tournamentReceipt().operation,
        action: 'LEAVE',
        outcome: 'LEFT',
        reason: 'LEFT',
      },
    };
    expect(parseTournamentReceipt(r, c, id).operation.generation).toBe(id);
    expect(() =>
      parseTournamentReceipt(
        r,
        { ...c, originalJoinOperationId: '22222222-2222-4222-a222-222222222222' },
        id,
      ),
    ).toThrow();
  });
});
