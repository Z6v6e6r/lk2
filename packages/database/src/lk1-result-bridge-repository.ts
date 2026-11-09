import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

/** Integration-only source system for games imported from LK1 (Viva/Mongo snapshots). */
const LK1_EXTERNAL_SYSTEM = 'LK_LEGACY_SNAPSHOT';

/**
 * The identity LK1 needs to accept a result for a game it owns. LK2 keeps per-set scores and its
 * own confirmation quorum; LK1 stores one score per game and identifies the submitter by phone, so
 * this read supplies the legacy game id and the phone of the participant who confirmed the result.
 */
export interface Lk1ResultHandoff {
  readonly tenantId: string;
  readonly gameId: string;
  readonly resultId: string;
  readonly resultRevision: number;
  /** LK1 game identifier; null when the game exists only in LK2, so LK1 has nothing to import. */
  readonly lk1GameId: string | null;
  /** Phone of the confirming participant; null when the profile carries no phone. Never logged. */
  readonly submitterPhoneE164: string | null;
  readonly confirmedAt: string;
}

export interface Lk1ResultBridgeRepository {
  loadHandoff(input: {
    readonly tenantId: string;
    readonly resultId: string;
  }): Promise<Lk1ResultHandoff | undefined>;
}

interface HandoffRow extends QueryResultRow {
  readonly game_id: string;
  readonly result_id: string;
  readonly revision: number;
  readonly confirmed_at: Date | string;
  readonly lk1_game_id: string | null;
  readonly submitter_phone: string | null;
}

const HANDOFF_SQL = `
  select r.game_id, r.id as result_id, r.revision, r.confirmed_at,
         map.external_id as lk1_game_id,
         summary.phone_e164 as submitter_phone
    from games.results r
    left join integration.external_entity_map map
      on map.tenant_id = r.tenant_id
     and map.internal_id = r.game_id
     and map.external_system = '${LK1_EXTERNAL_SYSTEM}'
     and map.entity_type = 'game'
    left join profile.user_summaries summary
      on summary.tenant_id = r.tenant_id
     and summary.user_id = r.confirmed_by_user_id
   where r.tenant_id = $1 and r.id = $2 and r.state = 'CONFIRMED'
`;

export function createLk1ResultBridgeRepository(pool: Pool): Lk1ResultBridgeRepository {
  return {
    loadHandoff(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const { rows } = await client.query<HandoffRow>(HANDOFF_SQL, [
          input.tenantId,
          input.resultId,
        ]);
        const row = rows[0];
        if (!row) return undefined;
        return {
          tenantId: input.tenantId,
          gameId: row.game_id,
          resultId: row.result_id,
          resultRevision: row.revision,
          lk1GameId: row.lk1_game_id,
          submitterPhoneE164: row.submitter_phone,
          confirmedAt: new Date(row.confirmed_at).toISOString(),
        };
      });
    },
  };
}
