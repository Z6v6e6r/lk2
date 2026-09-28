import type { Pool, PoolClient } from 'pg';

import { withTenantTransaction } from './connection.js';

export const GAME_TEST_COURTS_PERMISSION = 'games.test-courts';

// Existing PadlHub identities verified by read-only beta mapping/projection reads on 2026-09-28.
// This temporary two-court pilot has no provider IDs and creates no alternative identity.
// Owner: Games/LK2. Review after the booking pilot; retain deny rules until its games are retired.
export const GAME_TEST_COURT_SCOPE = {
  tenantId: 'd0ba848e-d2a3-4c3d-b917-43227c780373',
  stationId: '43363625-864a-4248-bcde-539bfd623170',
  courts: [
    { id: '68ab0b98-1a66-486b-b6a6-18486407d6a4', title: 'Корт №1 тест панорамик' },
    { id: '7bd207e1-8d09-46bc-9be1-dc21b3063ca6', title: 'Корт №2 тест панорамик' },
  ],
} as const;

/** Classification only: never grants access, and remains active when the pilot is disabled. */
export function isRestrictedGameTestCourt(tenantId: string, courtId?: string | null): boolean {
  return (
    tenantId === GAME_TEST_COURT_SCOPE.tenantId &&
    GAME_TEST_COURT_SCOPE.courts.some((court) => court.id === courtId)
  );
}

export function isExactGameTestCourtPair(
  tenantId: string,
  stationId: string,
  courtId?: string | null,
): boolean {
  return (
    stationId === GAME_TEST_COURT_SCOPE.stationId && isRestrictedGameTestCourt(tenantId, courtId)
  );
}

// Trusted server constants only. Apply before LIMIT, including when the pilot is disabled.
export const GAME_TEST_COURT_PUBLIC_FILTER = `not (tenant_id = '${GAME_TEST_COURT_SCOPE.tenantId}'::uuid
  and coalesce(base_payload #>> '{court,id}', '') in (${GAME_TEST_COURT_SCOPE.courts.map((court) => `'${court.id}'`).join(', ')}))`;

/** Reads the explicit stored grant; broad beta client permissions and admin roles do not grant it. */
export async function hasGameTestCourtAccess(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  if (tenantId !== GAME_TEST_COURT_SCOPE.tenantId) return false;
  const result = await client.query(
    `select 1 from identity.user_access_profiles access
       join identity.users usr on usr.tenant_id = access.tenant_id and usr.id = access.user_id
      where access.tenant_id = $1 and access.user_id = $2 and usr.status = 'ACTIVE'
        and $3 = any(access.permissions)`,
    [tenantId, userId, GAME_TEST_COURTS_PERMISSION],
  );
  return result.rows.length === 1;
}

export interface GameTestCourt {
  readonly id: string;
  readonly title: string;
  readonly stationId: string;
}

interface AdmissionAuditContext {
  readonly commandType: 'game.join.v1' | 'game.waitlist.join.v1';
  readonly correlationId: string;
}

/** Identifier-only rejection audit; does not create an idempotency or business-state record. */
export async function auditGameTestCourtDenial(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly commandType: string;
    readonly correlationId: string;
    readonly gameId?: string;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id
     ) values ($1, $2, $3, 'GAME', $4, 'REJECTED', 'GAME_TEST_COURT_ACCESS_DENIED', $5)`,
    [
      input.tenantId,
      input.actorUserId,
      input.commandType.toUpperCase().replaceAll('.', '_'),
      input.gameId ?? null,
      input.correlationId,
    ],
  );
}

export interface GameTestCourtRepository {
  list(tenantId: string, userId: string): Promise<readonly GameTestCourt[]>;
  hasAccess(tenantId: string, userId: string): Promise<boolean>;
  canJoin(
    tenantId: string,
    userId: string,
    gameId: string,
    audit: AdmissionAuditContext,
  ): Promise<boolean>;
}

export function createGameTestCourtRepository(
  pool: Pool,
  enabled = false,
): GameTestCourtRepository {
  return {
    async canJoin(tenantId, userId, gameId, audit) {
      if (tenantId !== GAME_TEST_COURT_SCOPE.tenantId) return true;
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{
          station_id: string;
          court_id: string | null;
          payment_mode: string;
        }>(
          'select station_id, court_id, payment_mode from games.games where tenant_id = $1 and id = $2',
          [tenantId, gameId],
        );
        const game = result.rows[0];
        // Missing games follow the normal repository rejection/audit path.
        if (!game) return true;
        if (!isRestrictedGameTestCourt(tenantId, game.court_id)) return true;
        const allowed =
          enabled &&
          isExactGameTestCourtPair(tenantId, game.station_id, game.court_id) &&
          game.payment_mode === 'NO_PAYMENT' &&
          (await hasGameTestCourtAccess(client, tenantId, userId));
        if (!allowed)
          await auditGameTestCourtDenial(client, {
            tenantId,
            actorUserId: userId,
            gameId,
            ...audit,
          });
        return allowed;
      });
    },
    async hasAccess(tenantId, userId) {
      if (!enabled || tenantId !== GAME_TEST_COURT_SCOPE.tenantId) return false;
      return withTenantTransaction(pool, tenantId, (client) =>
        hasGameTestCourtAccess(client, tenantId, userId),
      );
    },
    async list(tenantId, userId) {
      if (!enabled || tenantId !== GAME_TEST_COURT_SCOPE.tenantId) return [];
      return withTenantTransaction(pool, tenantId, async (client) => {
        if (!(await hasGameTestCourtAccess(client, tenantId, userId))) return [];
        const result = await client.query<{ internal_id: string }>(
          `select distinct mapping.internal_id
             from integration.external_entity_map mapping
             join locations.profiles station on station.tenant_id = mapping.tenant_id
              and station.id = $2 and station.publication_status = 'PUBLISHED'
            where mapping.tenant_id = $1 and mapping.external_system = 'LK_LEGACY_SNAPSHOT'
              and mapping.sync_status = 'synced' and mapping.sync_error_code is null
              and mapping.entity_type = 'game_court' and mapping.internal_id = any($3::uuid[])`,
          [
            tenantId,
            GAME_TEST_COURT_SCOPE.stationId,
            GAME_TEST_COURT_SCOPE.courts.map((court) => court.id),
          ],
        );
        const ids = new Set(result.rows.map((row) => row.internal_id));
        if (!GAME_TEST_COURT_SCOPE.courts.every((court) => ids.has(court.id))) return [];
        return GAME_TEST_COURT_SCOPE.courts.map((court) => ({
          ...court,
          stationId: GAME_TEST_COURT_SCOPE.stationId,
        }));
      });
    },
  };
}
