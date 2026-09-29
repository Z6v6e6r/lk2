import { FULL_CLIENT_PERMISSIONS } from '@phub/auth';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  GAME_TEST_COURT_SCOPE as scope,
  GAME_TEST_COURTS_PERMISSION,
  createGameTestCourtRepository,
  isExactGameTestCourtPair,
  isRestrictedGameTestCourt,
} from './game-repository.js';

const userId = '33333333-3333-4333-8333-333333333333';
const audit = { commandType: 'game.join.v1', correlationId: 'test-court-admission' } as const;

function database(
  permissions: readonly string[] = [],
  mapped = 2,
  game = {
    station_id: scope.stationId as string,
    court_id: scope.courts[0].id as string,
    payment_mode: 'NO_PAYMENT',
  },
) {
  const query = vi.fn((sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('identity.user_access_profiles')) {
      expect(values).toEqual([scope.tenantId, userId, GAME_TEST_COURTS_PERMISSION]);
      expect(sql).toContain("usr.status = 'ACTIVE'");
      return { rows: permissions.includes(GAME_TEST_COURTS_PERMISSION) ? [{ granted: 1 }] : [] };
    }
    if (sql.includes('integration.external_entity_map'))
      return { rows: scope.courts.slice(0, mapped).map((court) => ({ internal_id: court.id })) };
    if (sql.includes('from games.games')) return { rows: [game] };
    return { rows: [] };
  });
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  } as unknown as Pool;
  return { pool, query };
}

describe('temporary beta test-court boundary', () => {
  it('checks the current grant for known-game admission and never falls through when disabled or mispaired', async () => {
    const grants = [GAME_TEST_COURTS_PERMISSION];
    const { pool, query } = database(grants);
    const repo = createGameTestCourtRepository(pool, true);
    expect(await repo.canJoin(scope.tenantId, userId, userId, audit)).toBe(true);
    grants.splice(0);
    expect(await repo.canJoin(scope.tenantId, userId, userId, audit)).toBe(false);
    expect(query.mock.calls.filter(([sql]) => sql.includes('insert into audit.audit_log'))).toEqual(
      [
        [
          expect.stringContaining('GAME_TEST_COURT_ACCESS_DENIED'),
          [scope.tenantId, userId, 'GAME_JOIN_V1', userId, audit.correlationId],
        ],
      ],
    );
    const granted = database([GAME_TEST_COURTS_PERMISSION]);
    expect(
      await createGameTestCourtRepository(granted.pool).canJoin(
        scope.tenantId,
        userId,
        userId,
        audit,
      ),
    ).toBe(false);
    const mispaired = database([GAME_TEST_COURTS_PERMISSION], 2, {
      station_id: userId,
      court_id: scope.courts[0].id,
      payment_mode: 'NO_PAYMENT',
    });
    expect(
      await createGameTestCourtRepository(mispaired.pool, true).canJoin(
        scope.tenantId,
        userId,
        userId,
        audit,
      ),
    ).toBe(false);
    const ordinary = database([], 2, {
      station_id: scope.stationId,
      court_id: userId,
      payment_mode: 'NO_PAYMENT',
    });
    expect(
      await createGameTestCourtRepository(ordinary.pool).canJoin(
        scope.tenantId,
        userId,
        userId,
        audit,
      ),
    ).toBe(true);
  });
  it('classifies only the two exact tenant/court identities, without granting a station-wide exception', () => {
    for (const court of scope.courts) {
      expect(isRestrictedGameTestCourt(scope.tenantId, court.id)).toBe(true);
      expect(isExactGameTestCourtPair(scope.tenantId, scope.stationId, court.id)).toBe(true);
      expect(isExactGameTestCourtPair(scope.tenantId, userId, court.id)).toBe(false);
      expect(isRestrictedGameTestCourt(userId, court.id)).toBe(false);
    }
    expect(isExactGameTestCourtPair(scope.tenantId, scope.stationId, userId)).toBe(false);
    expect(isRestrictedGameTestCourt(scope.tenantId, null)).toBe(false);
  });

  it('defaults to disabled even for an explicitly granted tester', async () => {
    const { pool, query } = database([GAME_TEST_COURTS_PERMISSION]);
    const repository = createGameTestCourtRepository(pool);
    expect(await repository.list(scope.tenantId, userId)).toEqual([]);
    expect(await repository.hasAccess(scope.tenantId, userId)).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(isRestrictedGameTestCourt(scope.tenantId, scope.courts[0].id)).toBe(true);
  });

  it('full beta client access does not grant test-court access', async () => {
    expect(FULL_CLIENT_PERMISSIONS).not.toContain(GAME_TEST_COURTS_PERMISSION);
    const { pool, query } = database(FULL_CLIENT_PERMISSIONS);
    const repository = createGameTestCourtRepository(pool, true);
    expect(await repository.list(scope.tenantId, userId)).toEqual([]);
    expect(await repository.hasAccess(scope.tenantId, userId)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('integration.external_entity_map'))).toBe(
      false,
    );
  });

  it('returns precisely two existing internal identities only with the explicit grant and complete mappings', async () => {
    const { pool } = database([GAME_TEST_COURTS_PERMISSION]);
    expect(await createGameTestCourtRepository(pool, true).list(scope.tenantId, userId)).toEqual(
      scope.courts.map((court) => ({ ...court, stationId: scope.stationId })),
    );
    const incomplete = database([GAME_TEST_COURTS_PERMISSION], 1);
    expect(
      await createGameTestCourtRepository(incomplete.pool, true).list(scope.tenantId, userId),
    ).toEqual([]);
  });

  it('does not accept missing healthy mappings and restricts the catalogue query to synced rows without errors', async () => {
    const { pool, query } = database([GAME_TEST_COURTS_PERMISSION], 0);
    expect(await createGameTestCourtRepository(pool, true).list(scope.tenantId, userId)).toEqual(
      [],
    );
    const mappingQuery = query.mock.calls.find(([sql]) =>
      sql.includes('integration.external_entity_map'),
    )?.[0];
    expect(mappingQuery).toContain("mapping.sync_status = 'synced'");
    expect(mappingQuery).toContain('mapping.sync_error_code is null');
  });

  it('rejects a different tenant before any query', async () => {
    const { pool, query } = database([GAME_TEST_COURTS_PERMISSION]);
    expect(await createGameTestCourtRepository(pool, true).list(userId, userId)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
