import { describe, expect, it, vi } from 'vitest';

import { createLegacyGameReconciliationRepository } from './legacy-game-reconciliation-repository.js';
import type { LegacyGameImportSnapshot } from './legacy-game-import-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const snapshot: LegacyGameImportSnapshot = {
  externalId: 'legacy-game-secret-id',
  externalVersion: 'a'.repeat(64),
  vivaExerciseExternalId: '11111111-1111-4111-8111-111111111111',
  title: 'Открытая игра',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  cancelled: false,
  startsAt: '2026-07-20T15:00:00.000Z',
  endsAt: '2026-07-20T16:30:00.000Z',
  timezone: 'Europe/Moscow',
  station: {
    externalId: 'legacy-station-secret-id',
    name: 'Терехово',
    courtExternalId: null,
    courtName: null,
  },
  capacity: 4,
  waitlistEnabled: true,
  paymentMode: 'ORGANIZER_PAYS',
  levelFrom: null,
  levelTo: null,
  organizerExternalId: 'legacy-player-organizer',
  participants: [
    {
      externalId: 'legacy-player-organizer',
      displayName: 'Анна',
      level: 'C',
      levelValue: 3.44,
      role: 'ORGANIZER',
      paymentState: 'PAID',
    },
    {
      externalId: 'legacy-player-two',
      displayName: 'Борис',
      level: 'D+',
      levelValue: 2.87,
      role: 'PLAYER',
      paymentState: 'PAID',
    },
  ],
};

function fakePool(rows: readonly unknown[]) {
  const query = vi.fn((text: string) => {
    if (text.includes('from identity.tenants'))
      return Promise.resolve({ rows: [{ id: tenantId }] });
    throw new Error(`Unexpected pool query: ${text}`);
  });
  const clientQuery = vi.fn((text: string) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes('from integration.external_entity_map legacy')) {
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    throw new Error(`Unexpected client query: ${text}`);
  });
  return {
    pool: { query, connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }) },
    clientQuery,
  };
}

describe('legacy game reconciliation repository', () => {
  it('reports a matching canonical game without returning source identifiers', async () => {
    const { pool } = fakePool([
      {
        external_id: snapshot.externalId,
        game_id: gameId,
        capacity: 4,
        starts_at: snapshot.startsAt,
        ends_at: snapshot.endsAt,
        lifecycle_state: 'SCHEDULED',
        active_participant_count: 2,
        viva_exercise_external_ids: [snapshot.vivaExerciseExternalId],
      },
    ]);

    await expect(
      createLegacyGameReconciliationRepository(pool as never).reconcileSnapshots({
        tenantKey: 'local-padel',
        snapshots: [snapshot],
        now: new Date('2026-07-18T10:00:00.000Z'),
      }),
    ).resolves.toEqual({
      tenantId,
      compared: 1,
      matched: 1,
      missing: 0,
      discrepancies: [],
    });
  });

  it('reports a missing association as a safe discrepancy without the source game ID', async () => {
    const { pool } = fakePool([]);
    const report = await createLegacyGameReconciliationRepository(pool as never).reconcileSnapshots(
      {
        tenantKey: 'local-padel',
        snapshots: [snapshot],
      },
    );

    expect(report).toEqual({
      tenantId,
      compared: 1,
      matched: 0,
      missing: 1,
      discrepancies: [{ reasons: ['CANONICAL_GAME_MISSING'] }],
    });
    expect(JSON.stringify(report)).not.toContain(snapshot.externalId);
    expect(JSON.stringify(report)).not.toContain(snapshot.vivaExerciseExternalId ?? '');
  });
});
