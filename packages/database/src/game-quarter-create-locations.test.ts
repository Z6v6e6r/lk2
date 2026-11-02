import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
const resolve = vi.hoisted(() => vi.fn());
vi.mock('./game-create-location-binding-repository.js', () => ({
  resolveGameCreateLocationBinding: resolve,
}));
import { createQuarterCreateRepository } from './game-quarter-create-repository.js';
const tenant = '11111111-1111-4111-8111-000000000001',
  station = '11111111-1111-4111-8111-000000000002',
  court = '11111111-1111-4111-8111-000000000003';
function setup(rows: unknown[]) {
  const query = vi.fn((sql: string) =>
      Promise.resolve({
        rows: sql.includes('from integration.game_create_location_bindings') ? rows : [],
        rowCount: rows.length,
      }),
    ),
    release = vi.fn(),
    client = { query, release },
    pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { query, release, repo: createQuarterCreateRepository(pool) };
}
beforeEach(() => resolve.mockReset());
describe('private typed quarter location list', () => {
  it('validates every candidate with full lineage and emits only public pair and labels', async () => {
    const t = setup([
      {
        station_id: station,
        court_id: court,
        station_title: 'Station',
        court_name: 'Court',
        provider_room_id: 'must-not-leak',
      },
    ]);
    resolve.mockResolvedValue({ id: 'private-binding' });
    expect(await t.repo.locations(tenant)).toEqual({
      items: [{ stationId: station, courtId: court, stationTitle: 'Station', courtName: 'Court' }],
    });
    expect(resolve).toHaveBeenCalledWith(expect.anything(), {
      tenantId: tenant,
      stationId: station,
      courtId: court,
    });
    expect(t.query).toHaveBeenCalledWith(
      expect.stringContaining('count(distinct trim(g.court_name))=1'),
      [tenant],
    );
    expect(t.release).toHaveBeenCalledOnce();
  });
  it('stale/revoked/ambiguous lineage yields no actionable pair; empty catalogue stays empty', async () => {
    const t = setup([
      { station_id: station, court_id: court, station_title: 'Station', court_name: 'Court' },
    ]);
    resolve.mockResolvedValue(null);
    expect(await t.repo.locations(tenant)).toEqual({ items: [] });
    expect(await setup([]).repo.locations(tenant)).toEqual({ items: [] });
  });
  it('rejects oversized candidate set and SQL failure, never returns a partial ready selector', async () => {
    const t = setup(Array.from({ length: 26 }, () => ({ station_id: station, court_id: court })));
    await expect(t.repo.locations(tenant)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    const failure = setup([]);
    failure.query.mockRejectedValueOnce(new Error('read failure'));
    await expect(failure.repo.locations(tenant)).rejects.toThrow();
  });
});
