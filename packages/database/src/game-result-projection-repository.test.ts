import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createGameResultProjectionRepository } from './game-result-projection-repository.js';

const IDS = {
  tenant: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  game: '6fe9dc1f-87b5-4efd-83a2-5cf9d8070b76',
  result: '8ef58c73-f94c-4e04-97e8-f6057afc0ec1',
  event: '705e97fd-2a14-4274-8e4a-f4e1a1248f24',
  players: [
    'f75b4e2a-9c98-4b26-85b6-ae58e0edca24',
    'a9c106f7-0db8-4e27-b1e0-298829f94730',
    '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70',
    'c68f263e-4a54-4472-9254-103e3b332538',
  ],
} as const;

describe('confirmed game result projections', () => {
  it('writes four analytical facts and four history rows for one set', async () => {
    const queries: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn((sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('insert into audit.inbox_events')) {
          return Promise.resolve({ rowCount: 1, rows: [{}] });
        }
        if (sql.includes('from games.results r')) {
          return Promise.resolve({
            rowCount: 4,
            rows: IDS.players.map((userId, index) => ({
              tenant_id: IDS.tenant,
              game_id: IDS.game,
              result_id: IDS.result,
              result_revision: 1,
              kind: 'RATING',
              title: 'Игра',
              starts_at: '2026-07-22T08:00:00.000Z',
              ends_at: '2026-07-22T09:30:00.000Z',
              venue_name: 'Селигерская',
              set_number: 1,
              team_a_score: 6,
              team_b_score: 4,
              user_id: userId,
              team: index < 2 ? 'A' : 'B',
              slot: (index % 2) + 1,
            })),
          });
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      }),
      release,
    } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    await expect(
      createGameResultProjectionRepository(pool).projectConfirmedResultEvent({
        tenantId: IDS.tenant,
        eventId: IDS.event,
        resultId: IDS.result,
      }),
    ).resolves.toBe('applied');

    expect(
      queries.filter(({ sql }) => sql.includes('insert into games.player_set_facts')),
    ).toHaveLength(4);
    expect(
      queries.filter(({ sql }) => sql.includes('insert into booking.activity_history_projection')),
    ).toHaveLength(4);
    expect(queries.some(({ sql }) => sql === 'commit')).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases an incomplete inbox claim so the same event can be redelivered', async () => {
    const queries: string[] = [];
    let dependencyVisible = false;
    const client = {
      query: vi.fn((sql: string) => {
        queries.push(sql);
        if (sql.includes('insert into audit.inbox_events')) {
          return Promise.resolve({ rowCount: 1, rows: [{}] });
        }
        if (sql.includes('from games.results r') && dependencyVisible) {
          return Promise.resolve({
            rowCount: 4,
            rows: IDS.players.map((userId, index) => ({
              tenant_id: IDS.tenant,
              game_id: IDS.game,
              result_id: IDS.result,
              result_revision: 1,
              kind: 'RATING',
              title: 'Игра',
              starts_at: '2026-07-22T08:00:00.000Z',
              ends_at: '2026-07-22T09:30:00.000Z',
              venue_name: 'Селигерская',
              set_number: 1,
              team_a_score: 6,
              team_b_score: 4,
              user_id: userId,
              team: index < 2 ? 'A' : 'B',
              slot: (index % 2) + 1,
            })),
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;

    await expect(
      createGameResultProjectionRepository(pool).projectConfirmedResultEvent({
        tenantId: IDS.tenant,
        eventId: IDS.event,
        resultId: IDS.result,
      }),
    ).resolves.toBe('result_not_found');

    dependencyVisible = true;
    await expect(
      createGameResultProjectionRepository(pool).projectConfirmedResultEvent({
        tenantId: IDS.tenant,
        eventId: IDS.event,
        resultId: IDS.result,
      }),
    ).resolves.toBe('applied');

    expect(queries.filter((sql) => sql.includes('delete from audit.inbox_events'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('set processed_at = now()'))).toHaveLength(1);
    expect(queries.filter((sql) => sql === 'commit')).toHaveLength(2);
    expect(
      queries.filter((sql) => sql.includes('insert into games.player_set_facts')),
    ).toHaveLength(4);
  });
});
