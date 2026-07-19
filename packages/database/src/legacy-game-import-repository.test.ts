import { describe, expect, it, vi } from 'vitest';

import {
  createLegacyGameImportRepository,
  type LegacyGameImportSnapshot,
} from './legacy-game-import-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';

const snapshot: LegacyGameImportSnapshot = {
  externalId: 'legacy-game-secret-id',
  externalVersion: 'a'.repeat(64),
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
      role: 'ORGANIZER',
      paymentState: 'PAID',
    },
    {
      externalId: 'legacy-player-two',
      displayName: 'Борис',
      level: 'B',
      role: 'PLAYER',
      paymentState: 'PAID',
    },
  ],
};

function fakePool(
  handler: (text: string, values: readonly unknown[]) => { rows?: readonly unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) =>
    Promise.resolve({ rows: handler(text, values).rows ?? [], rowCount: 0 }),
  );
  const clientQuery = vi.fn((text: string, values: readonly unknown[] = []) =>
    Promise.resolve({
      rows: handler(text, values).rows ?? [],
      rowCount: handler(text, values).rows?.length ?? 0,
    }),
  );
  const release = vi.fn();
  const pool = {
    query,
    connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
  };
  return { pool: pool as never, query, clientQuery, release };
}

describe('legacy game import repository', () => {
  it('creates a local aggregate, PadlHub mappings, audit and outbox in one transaction', async () => {
    const { pool, clientQuery } = fakePool((text) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-import-test-1',
      now: new Date('2026-07-18T10:00:00.000Z'),
    });

    expect(result).toMatchObject({ tenantId, skipped: 0 });
    expect(result.imported).toHaveLength(1);
    expect(clientQuery).toHaveBeenCalledWith('begin');
    expect(clientQuery).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into identity.users')),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into locations.profiles')),
    ).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text.includes('insert into games.games'))).toBe(
      true,
    );
    expect(
      clientQuery.mock.calls.filter(([text]) => text.includes('insert into games.participations')),
    ).toHaveLength(2);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into audit.outbox_events')),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([text]) => text.includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith('commit');

    const outbox = clientQuery.mock.calls.find(([text]) =>
      text.includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]?.[2]).toBe('game.scheduled.v1');
    expect(JSON.stringify(outbox?.[1])).not.toContain(snapshot.externalId);
    expect(JSON.stringify(outbox?.[1])).not.toContain(snapshot.station.externalId);
    expect(JSON.stringify(outbox?.[1])).not.toContain(snapshot.organizerExternalId);
  });

  it('skips an already mapped game without overwriting local roster changes', async () => {
    const { pool, clientQuery } = fakePool((text, values) => {
      if (text.includes('from identity.tenants')) return { rows: [{ id: tenantId }] };
      if (text.includes('from integration.external_entity_map') && values[2] === 'game') {
        return { rows: [{ internal_id: '6418f90b-0fa6-4c04-a3da-57707e2f0ae2' }] };
      }
      return { rows: [] };
    });

    const result = await createLegacyGameImportRepository(pool).importSnapshots({
      tenantKey: 'local-padel',
      snapshots: [snapshot],
      correlationId: 'legacy-import-test-2',
    });
    expect(result.imported).toEqual([]);
    expect(result.existing).toHaveLength(1);
    expect(result.existing[0]?.gameId).toBe('6418f90b-0fa6-4c04-a3da-57707e2f0ae2');
    expect(result.skipped).toBe(1);
    expect(clientQuery.mock.calls.some(([text]) => text.includes('insert into games.games'))).toBe(
      false,
    );
  });
});
