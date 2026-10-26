import { describe, expect, it, vi } from 'vitest';

import {
  readGameStartReminderTarget,
  readPreparingLegacyGameStartReminderTarget,
} from './game-reminder-repository.js';

const canonical = {
  revision: '7',
  title: 'Закрытая игра',
  starts_at: new Date('2026-11-01T18:00:00Z'),
  lifecycle_state: 'SCHEDULED',
  location_name: 'Клуб',
  legacy_source: false,
  legacy_mapping: false,
};
const isolated = {
  source_revision: '3',
  title: 'Legacy private game',
  starts_at: new Date('2026-11-01T18:00:00Z'),
  location_name: 'Legacy club',
  source_state: 'SCHEDULED',
  source_checked_at: new Date('2026-11-01T11:59:00Z'),
  status_checked_at: new Date('2026-11-01T11:59:00Z'),
  healthy: true,
  source_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status_generation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  error_code: null,
};

function clientFor(input: {
  owner?: Record<string, unknown>;
  source?: Record<string, unknown>;
  recipients?: readonly string[];
}) {
  const query = vi.fn((sql: string) => {
    if (sql.includes('from games.games game'))
      return Promise.resolve({
        rows: input.owner ? [input.owner] : [],
        rowCount: input.owner ? 1 : 0,
      });
    if (sql.includes('from notifications.legacy_game_reminder_sources source'))
      return Promise.resolve({
        rows: input.source ? [input.source] : [],
        rowCount: input.source ? 1 : 0,
      });
    if (
      sql.includes('from games.participations participant') ||
      sql.includes('from notifications.legacy_game_reminder_recipients recipient')
    ) {
      const rows = (input.recipients ?? []).map((user_id) => ({ user_id }));
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as never, query };
}

describe('game start reminder audience', () => {
  it('selects a current ACTIVE native participant without a public-discovery filter', async () => {
    const fixture = clientFor({
      owner: canonical,
      recipients: ['11111111-1111-4111-8111-111111111111'],
    });
    await expect(
      readGameStartReminderTarget(fixture.client, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gameId: '33333333-3333-4333-8333-333333333333',
        now: new Date('2026-11-01T12:00:00Z'),
        maxLegacySourceAgeMs: 600_000,
      }),
    ).resolves.toMatchObject({ state: 'READY', target: { revision: '7' } });
    expect(String(fixture.query.mock.calls[0]?.[0])).not.toContain("visibility='PUBLIC'");
    expect(String(fixture.query.mock.calls[1]?.[0])).toContain("participant.state='ACTIVE'");
  });

  it('never falls a mapped legacy game back to canonical participations', async () => {
    const fixture = clientFor({
      owner: { ...canonical, legacy_source: true, legacy_mapping: true },
    });
    await expect(
      readGameStartReminderTarget(fixture.client, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gameId: '33333333-3333-4333-8333-333333333333',
        now: new Date('2026-11-01T12:00:00Z'),
        maxLegacySourceAgeMs: 600_000,
      }),
    ).resolves.toEqual({ state: 'SOURCE_STALE' });
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });

  it('requires a healthy current generation and its exact verified recipient revision', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const fixture = clientFor({
      owner: { ...canonical, legacy_source: true, legacy_mapping: true },
      source: isolated,
      recipients: [userId],
    });
    await expect(
      readGameStartReminderTarget(fixture.client, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gameId: '33333333-3333-4333-8333-333333333333',
        now: new Date('2026-11-01T12:00:00Z'),
        maxLegacySourceAgeMs: 600_000,
        expectedRevision: '3',
        onlyRecipientUserId: userId,
      }),
    ).resolves.toMatchObject({
      state: 'READY',
      target: { revision: '3', recipientUserIds: [userId] },
    });
    const recipientSql = String(fixture.query.mock.calls[2]?.[0]);
    expect(recipientSql).toContain('legacy_game_reminder_recipients');
    expect(recipientSql).toContain('recipient.source_revision=$3::bigint');
    expect(recipientSql).not.toContain('games.participations');
  });

  it('blocks dispatch immediately while the source generation is unhealthy', async () => {
    const fixture = clientFor({
      owner: { ...canonical, legacy_source: true, legacy_mapping: true },
      source: { ...isolated, healthy: false, status_checked_at: null },
    });
    await expect(
      readGameStartReminderTarget(fixture.client, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gameId: '33333333-3333-4333-8333-333333333333',
        now: new Date('2026-11-01T12:00:00Z'),
        maxLegacySourceAgeMs: 600_000,
      }),
    ).resolves.toEqual({ state: 'SOURCE_STALE' });
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });

  it('allows only the exact preparing generation to refresh contexts while normal dispatch holds', async () => {
    const generationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const source = {
      ...isolated,
      healthy: false,
      status_checked_at: null,
      error_code: 'REFRESH_IN_PROGRESS',
    };
    const input = {
      tenantId: '22222222-2222-4222-8222-222222222222',
      gameId: '33333333-3333-4333-8333-333333333333',
      now: new Date('2026-11-01T12:00:00Z'),
      maxLegacySourceAgeMs: 600_000,
    };
    await expect(
      readGameStartReminderTarget(
        clientFor({
          owner: { ...canonical, legacy_source: true, legacy_mapping: true },
          source,
        }).client,
        input,
      ),
    ).resolves.toEqual({ state: 'SOURCE_STALE' });
    await expect(
      readPreparingLegacyGameStartReminderTarget(
        clientFor({
          owner: { ...canonical, legacy_source: true, legacy_mapping: true },
          source,
        }).client,
        { ...input, generationId },
      ),
    ).resolves.toMatchObject({ state: 'READY', target: { revision: '3' } });
    await expect(
      readPreparingLegacyGameStartReminderTarget(
        clientFor({
          owner: { ...canonical, legacy_source: true, legacy_mapping: true },
          source,
        }).client,
        { ...input, generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      ),
    ).resolves.toEqual({ state: 'SOURCE_STALE' });
  });

  it('uses isolated source state and time when stale canonical legacy fields are terminal', async () => {
    const fixture = clientFor({
      owner: {
        ...canonical,
        starts_at: new Date('2026-10-31T18:00:00Z'),
        lifecycle_state: 'CANCELLED',
        legacy_source: true,
        legacy_mapping: true,
      },
      source: isolated,
    });
    await expect(
      readGameStartReminderTarget(fixture.client, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gameId: '33333333-3333-4333-8333-333333333333',
        now: new Date('2026-11-01T12:00:00Z'),
        maxLegacySourceAgeMs: 600_000,
      }),
    ).resolves.toMatchObject({ state: 'READY', target: { startsAt: '2026-11-01T18:00:00.000Z' } });
  });

  it('never falls a former mapped mirror/source game back to native after mapping removal', async () => {
    const owner = { ...canonical, legacy_source: true, legacy_mapping: false };
    const input = {
      tenantId: '22222222-2222-4222-8222-222222222222',
      gameId: '33333333-3333-4333-8333-333333333333',
      now: new Date('2026-11-01T12:00:00Z'),
      maxLegacySourceAgeMs: 600_000,
    };
    const regular = clientFor({ owner, source: isolated, recipients: ['native-user'] });
    await expect(readGameStartReminderTarget(regular.client, input)).resolves.toEqual({
      state: 'SOURCE_STALE',
    });
    expect(regular.query).toHaveBeenCalledTimes(1);
    const preparing = clientFor({ owner, source: isolated, recipients: ['native-user'] });
    await expect(
      readPreparingLegacyGameStartReminderTarget(preparing.client, {
        ...input,
        generationId: isolated.source_generation_id,
      }),
    ).resolves.toEqual({ state: 'SOURCE_STALE' });
    expect(preparing.query).toHaveBeenCalledTimes(1);
  });

  it.each(['CANCELLED', 'MISSING', 'OUT_OF_WINDOW'] as const)(
    'terminalizes an isolated %s source before recipient lookup',
    async (sourceState) => {
      const fixture = clientFor({
        owner: { ...canonical, legacy_source: true, legacy_mapping: true },
        source: { ...isolated, source_state: sourceState },
      });
      await expect(
        readGameStartReminderTarget(fixture.client, {
          tenantId: '22222222-2222-4222-8222-222222222222',
          gameId: '33333333-3333-4333-8333-333333333333',
          now: new Date('2026-11-01T12:00:00Z'),
          maxLegacySourceAgeMs: 600_000,
        }),
      ).resolves.toEqual({ state: 'GAME_UNAVAILABLE' });
      expect(fixture.query).toHaveBeenCalledTimes(2);
    },
  );
});
