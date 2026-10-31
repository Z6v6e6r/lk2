import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createGameCreateLocationBindingRepository,
  createLocationDigest,
  resolveGameCreateLocationBinding,
} from './game-create-location-binding-repository.js';
const tenantId = randomUUID(),
  courtId = randomUUID(),
  stationId = randomUUID(),
  mappingId = randomUUID();
const mappings = [
  { id: mappingId, entity_type: 'game_court', internal_id: courtId, external_id: 'room' },
];
const lineageDigest = createLocationDigest(['CREATE_LOCATION_LINEAGE_V1', mappings, []]);
const candidate = {
  courtId,
  stationId,
  courtMappingId: mappingId,
  studioId: 'studio',
  roomId: 'room',
  lineageDigest,
  evidenceDigest: 'a'.repeat(64),
  verifiedAt: new Date().toISOString(),
};
function fixture(
  options: {
    absent?: boolean;
    old?: Record<string, unknown>;
    lineageChanged?: boolean;
    auditFailure?: boolean;
    binding?: Record<string, unknown>;
  } = {},
) {
  const query = vi.fn((sql: string) =>
    Promise.resolve().then(() => {
      if (sql.includes('to_regclass'))
        return {
          rows: [{ relation: options.absent ? null : 'integration.game_create_location_bindings' }],
          rowCount: 1,
        };
      if (sql.includes('jsonb_agg'))
        return {
          rows: [{ mappings: options.lineageChanged ? [] : mappings, games: [] }],
          rowCount: 1,
        };
      if (sql.includes('for update'))
        return { rows: options.old ? [options.old] : [], rowCount: options.old ? 1 : 0 };
      if (sql.includes('select binding.*'))
        return {
          rows: options.binding ? [options.binding] : [],
          rowCount: options.binding ? 1 : 0,
        };
      if (
        sql.includes('select 1 from locations.profiles') ||
        sql.includes('select 1 from integration.identity_provider_bindings')
      )
        return { rows: [{}], rowCount: 1 };
      if (sql.includes('insert into integration.game_create_location_bindings'))
        return {
          rows: [
            {
              id: randomUUID(),
              court_id: courtId,
              station_id: stationId,
              revision: '1',
              state: 'ACTIVE',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('insert into audit.audit_log') && options.auditFailure)
        throw new Error('synthetic-audit-failure');
      return { rows: [], rowCount: 0 };
    }),
  );
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  return { query, client, repository: createGameCreateLocationBindingRepository(pool) };
}
describe('CREATE binding repository transaction boundaries', () => {
  it('old schema returns unavailable without DDL', async () => {
    const f = fixture({ absent: true });
    expect(await f.repository.snapshot(tenantId)).toBeNull();
    expect(f.query.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(
      /create |alter |insert |update /i,
    );
  });
  it('CAS conflict and lineage drift produce no audit/outbox/business writes', async () => {
    for (const options of [{ old: { revision: '2' } }, { lineageChanged: true }]) {
      const f = fixture(options);
      expect(
        await f.repository.publish({
          tenantId,
          candidate,
          expectedRevision: null,
          commandId: randomUUID(),
        }),
      ).toBe('CONFLICT');
      expect(f.query.mock.calls.some((c) => c[0].includes('insert into'))).toBe(false);
    }
  });
  it('exact command replay precedes source refresh; changed bytes conflict', async () => {
    const commandId = randomUUID();
    const hash = createLocationDigest(['CREATE_LOCATION_PUBLISH_V1', tenantId, candidate, null]);
    const f = fixture({
      old: { last_command_id: commandId, last_command_hash: hash, revision: '1' },
    });
    expect(
      await f.repository.publish({ tenantId, candidate, expectedRevision: null, commandId }),
    ).toBe('REPLAYED');
    expect(
      await f.repository.publish({
        tenantId,
        candidate: { ...candidate, roomId: 'different' },
        expectedRevision: null,
        commandId,
      }),
    ).toBe('CONFLICT');
    expect(
      f.query.mock.calls.some((c) => c[0].includes('jsonb_agg') || c[0].includes('insert into')),
    ).toBe(false);
  });
  it('audit failure rolls back binding and outbox transaction', async () => {
    const f = fixture({ auditFailure: true });
    await expect(
      f.repository.publish({
        tenantId,
        candidate,
        expectedRevision: null,
        commandId: randomUUID(),
      }),
    ).rejects.toThrow('synthetic-audit-failure');
    expect(f.query).toHaveBeenCalledWith('rollback');
    expect(f.query).not.toHaveBeenCalledWith('commit');
  });
  it('reader locks active binding, station, provenance and tenant binding, then rejects changed lineage', async () => {
    const f = fixture({ binding: { lineage_digest: 'b'.repeat(64) } });
    expect(
      await resolveGameCreateLocationBinding(f.client, { tenantId, courtId, stationId }),
    ).toBeNull();
    const sql = f.query.mock.calls.find((c) => c[0].includes('select binding.*'))![0];
    expect(sql).toContain('for share of binding,station,mapping,identity_binding');
    expect(sql).toContain('binding.expires_at>clock_timestamp()');
    expect(sql).toContain("binding.state='ACTIVE'");
  });
});
