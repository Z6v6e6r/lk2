import { describe, expect, it, vi } from 'vitest';

import type { LegacyGameImportSnapshot } from '@phub/database';
import type { LegacyGameSourceSnapshot } from '@phub/legacy-games-adapter';

import {
  LegacyGameRosterRepairArgumentError,
  parseRepairArguments,
  repairLegacyGameRosters,
} from './repair-legacy-game-rosters.js';

function snapshot(externalId: string): LegacyGameSourceSnapshot {
  return {
    externalId,
    externalVersion: 'a'.repeat(64),
    vivaExerciseExternalId: '11111111-1111-4111-8111-111111111111',
    title: 'Рейтинговая игра',
    kind: 'RATING',
    visibility: 'PUBLIC',
    cancelled: false,
    startsAt: '2026-07-20T15:00:00.000Z',
    endsAt: '2026-07-20T16:30:00.000Z',
    timezone: 'Europe/Moscow',
    station: {
      externalId: 'legacy-station-secret-id',
      name: 'Терехово',
      courtExternalId: 'legacy-court-secret-id',
      courtName: 'Корт №4',
    },
    capacity: 4,
    waitlistEnabled: true,
    paymentMode: 'ORGANIZER_PAYS',
    levelFrom: 'C',
    levelTo: 'B',
    organizerExternalId: 'legacy-player-organizer',
    participants: [
      {
        externalId: 'legacy-player-organizer',
        displayName: 'Анна',
        level: 'C+',
        levelValue: 3.8,
        role: 'ORGANIZER',
        paymentState: 'PAID',
        avatarSourceUrl: null,
      },
    ],
  };
}

describe('legacy game roster repair driver', () => {
  it('reads the configured window and reports the additive repair outcome', async () => {
    const readCalls: { from: string; to: string; limit: number }[] = [];
    const read = vi.fn(
      (input: { readonly from: string; readonly to: string; readonly limit: number }) => {
        readCalls.push({ from: input.from, to: input.to, limit: input.limit });
        return Promise.resolve([snapshot('legacy-game-one'), snapshot('legacy-game-two')]);
      },
    );
    const repairCalls: {
      tenantKey: string;
      snapshots: readonly LegacyGameImportSnapshot[];
      correlationId: string;
      allowLocalRemovals?: boolean;
      now?: Date;
    }[] = [];
    const rebaselineParticipants = vi.fn(
      (input: {
        readonly tenantKey: string;
        readonly snapshots: readonly LegacyGameImportSnapshot[];
        readonly correlationId: string;
        readonly allowLocalRemovals?: boolean;
        readonly now?: Date;
      }) => {
        repairCalls.push(input);
        return Promise.resolve({
          tenantId: 'd0ba848e-d2a3-4c3d-b917-43227c780373',
          rebaselined: [{ gameId: 'game-one', externalId: 'legacy-game-one' }],
          deferred: [
            {
              gameId: 'game-two',
              externalId: 'legacy-game-two',
              code: 'LEGACY_GAME_ROSTER_REPAIR_REQUIRES_LOCAL_REMOVAL' as const,
              removableParticipantCount: 1,
            },
          ],
          skipped: 3,
        });
      },
    );

    const report = await repairLegacyGameRosters({
      pool: {} as never,
      tenantKey: 'local-padel',
      source: { read },
      repository: { rebaselineParticipants },
      limit: 500,
      lookbackDays: 1,
      lookaheadDays: 42,
      allowLocalRemovals: false,
      now: new Date('2026-09-16T12:00:00.000Z'),
      correlationId: 'legacy-games-roster-repair-test',
    });

    expect(readCalls).toEqual([
      { from: '2026-09-15T12:00:00.000Z', to: '2026-10-28T12:00:00.000Z', limit: 500 },
    ]);
    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0]?.tenantKey).toBe('local-padel');
    expect(repairCalls[0]?.snapshots).toHaveLength(2);
    expect(repairCalls[0]?.correlationId).toBe('legacy-games-roster-repair-test');
    expect(repairCalls[0]?.allowLocalRemovals).toBe(false);
    expect(repairCalls[0]?.now).toEqual(new Date('2026-09-16T12:00:00.000Z'));
    expect(report).toMatchObject({
      attempted: 2,
      skipped: 3,
      allowLocalRemovals: false,
    });
    expect(report.rebaselined).toHaveLength(1);
    expect(report.deferred).toHaveLength(1);
  });

  it('parses only the exact operator arguments and refuses an unsafe window', () => {
    expect(parseRepairArguments(['--tenant-key', 'local-padel'])).toEqual({
      tenantKey: 'local-padel',
      limit: 500,
      allowLocalRemovals: false,
    });
    expect(parseRepairArguments(['--tenant-key', 'local-padel', '--limit', '307'])).toEqual({
      tenantKey: 'local-padel',
      limit: 307,
      allowLocalRemovals: false,
    });
    expect(
      parseRepairArguments(['--tenant-key', 'local-padel', '--allow-local-removals']),
    ).toMatchObject({ allowLocalRemovals: true });

    expect(() => parseRepairArguments([])).toThrow(LegacyGameRosterRepairArgumentError);
    expect(() => parseRepairArguments(['--tenant-key', 'Local Padel'])).toThrow('tenant_key');
    expect(() => parseRepairArguments(['--tenant-key', 'local-padel', '--limit', '0'])).toThrow(
      'limit',
    );
    expect(() => parseRepairArguments(['--tenant-key', 'local-padel', '--limit', '501'])).toThrow(
      'limit',
    );
    expect(() => parseRepairArguments(['--tenant-key', 'local-padel', '--force'])).toThrow('usage');
  });
});
