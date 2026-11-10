import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

/** Integration-only source system for games imported from LK1 (Viva/Mongo snapshots). */
const LK1_EXTERNAL_SYSTEM = 'LK_LEGACY_SNAPSHOT';

/**
 * LK2 stores two kinds of legacy game aliases under the same mapping key: the provider game id LK1
 * itself uses (`pay_…`, `slot_…`) and a pseudonymous 64-hex association hash derived inside the
 * legacy adapter. Only the former identifies a record in LK1's `lk_games`, so sending the hash makes
 * the import fail with `LK1_GAME_NOT_FOUND` and the score never arrives.
 */
const PSEUDONYMOUS_ALIAS = /^[0-9a-f]{64}$/u;

/**
 * Chooses the alias LK1 can actually resolve. Deterministic for stable behaviour across replays:
 * the pseudonymous hash is dropped and the remaining aliases are ordered.
 */
export function selectLk1GameId(aliases: readonly string[]): string | null {
  const usable = [...new Set(aliases.filter((alias) => alias.length > 0))]
    .filter((alias) => !PSEUDONYMOUS_ALIAS.test(alias))
    .sort();
  return usable[0] ?? null;
}

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
  readonly lk1_game_aliases: readonly string[] | null;
  readonly submitter_phone: string | null;
}

const HANDOFF_SQL = `
  select r.game_id, r.id as result_id, r.revision, r.confirmed_at,
         (
           select array_agg(mapping.external_id)
             from integration.external_entity_map mapping
            where mapping.tenant_id = r.tenant_id
              and mapping.internal_id = r.game_id
              and mapping.external_system = '${LK1_EXTERNAL_SYSTEM}'
              and mapping.entity_type = 'game'
         ) as lk1_game_aliases,
         summary.phone_e164 as submitter_phone
    from games.results r
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
          lk1GameId: selectLk1GameId(row.lk1_game_aliases ?? []),
          submitterPhoneE164: row.submitter_phone,
          confirmedAt: new Date(row.confirmed_at).toISOString(),
        };
      });
    },
  };
}
