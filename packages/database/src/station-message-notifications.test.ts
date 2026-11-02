import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { stationMapping } from './station-message-notifications.js';
describe('station notification canonical mapping authority', () => {
  it.each([
    { rows: [] },
    {
      rows: [
        { id: 'a', internal_id: 'user' },
        { id: 'b', internal_id: 'user' },
      ],
    },
  ])('refuses missing/ambiguous mapping without writes', async ({ rows }) => {
    const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
    await expect(
      stationMapping(
        { query } as unknown as PoolClient,
        'tenant',
        'VIVA',
        'viva_profile',
        'player',
      ),
    ).rejects.toThrow('STATION_MAPPING_UNAVAILABLE');
    expect(query.mock.calls).toHaveLength(1);
    expect(query.mock.calls[0]![0]).not.toMatch(/insert|update/i);
  });
  it('refuses rebind of originally pinned canonical user/mapping', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ id: 'new-map', internal_id: 'new-user' }], rowCount: 1 });
    await expect(
      stationMapping(
        { query } as unknown as PoolClient,
        'tenant',
        'VIVA',
        'viva_profile',
        'player',
        { id: 'old-map', internalId: 'old-user' },
      ),
    ).rejects.toThrow('STATION_MAPPING_CHANGED');
  });
  it('does not require fabricated external_version, but requires active exact user', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'map', internal_id: 'user' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      stationMapping(
        { query } as unknown as PoolClient,
        'tenant',
        'VIVA',
        'viva_profile',
        'player',
      ),
    ).rejects.toThrow('STATION_RECIPIENT_UNAVAILABLE');
    expect(query.mock.calls[0]![0]).not.toContain('external_version');
    expect(query.mock.calls[0]![0]).toContain('for share of m');
    expect(query.mock.calls[1]![0]).toContain('for share nowait');
    expect(query.mock.calls[1]![1]).toEqual(['tenant', 'user']);
  });
  it('community identity does not require a speculative canonical community row', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ id: 'map', internal_id: 'community' }], rowCount: 1 });
    expect(
      await stationMapping(
        { query } as unknown as PoolClient,
        'tenant',
        'LK_LEGACY',
        'community',
        'private',
        { id: 'map', internalId: 'community' },
      ),
    ).toEqual({ id: 'map', internal_id: 'community' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
