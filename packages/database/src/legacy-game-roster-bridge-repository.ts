import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface LegacyGameRosterBridgeContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly gameId: string;
  readonly gameRevision: number;
  readonly player: {
    readonly userId: string;
    readonly displayName: string;
    readonly phoneE164: string | null;
    readonly levelLabel: string | null;
    readonly levelValue: number | null;
  };
}

export type ResolveLegacyGameRosterBridgeResult =
  | { readonly outcome: 'resolved'; readonly context: LegacyGameRosterBridgeContext }
  | { readonly outcome: 'actor_not_linked' }
  | { readonly outcome: 'game_not_mapped' };

export interface LegacyGameRosterBridgeRepository {
  resolve(input: {
    readonly tenantId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly externalGameId: string;
  }): Promise<ResolveLegacyGameRosterBridgeResult>;
}

interface BridgeRow extends QueryResultRow {
  readonly user_id: string | null;
  readonly display_name: string | null;
  readonly phone_e164: string | null;
  readonly level_label: string | null;
  readonly level_value: number | string | null;
  readonly game_id: string | null;
  readonly game_revision: number | string | null;
}

function safeRevision(value: number | string | null): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('LEGACY_GAME_BRIDGE_REVISION_INVALID');
  }
  return revision;
}

function safeLevelValue(value: number | string | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 10) {
    throw new Error('LEGACY_GAME_BRIDGE_LEVEL_VALUE_INVALID');
  }
  return numeric;
}

export function createLegacyGameRosterBridgeRepository(
  pool: Pool,
): LegacyGameRosterBridgeRepository {
  return {
    resolve(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<BridgeRow>(
          client,
          `select identity_map.user_id,
                  profile.display_name,
                  profile.phone_e164,
                  profile.level_label,
                  profile.level_value,
                  game.id as game_id,
                  game.revision as game_revision
             from integration.external_identity_map identity_map
             join identity.users actor
               on actor.tenant_id = identity_map.tenant_id
              and actor.id = identity_map.user_id
              and actor.status = 'ACTIVE'
             join profile.user_summaries profile
               on profile.tenant_id = identity_map.tenant_id
              and profile.user_id = identity_map.user_id
             left join integration.external_entity_map mapping
               on mapping.tenant_id = identity_map.tenant_id
              and mapping.external_system = 'LK_LEGACY_SNAPSHOT'
              and mapping.entity_type = 'game'
              and mapping.external_id = $4
             left join integration.legacy_game_merge_redirects redirect
               on redirect.tenant_id = mapping.tenant_id
              and redirect.source_game_id = mapping.internal_id
             left join games.games game
               on game.tenant_id = identity_map.tenant_id
              and game.id = coalesce(redirect.target_game_id, mapping.internal_id)
            where identity_map.tenant_id = $1
              and identity_map.issuer = $2
              and identity_map.subject = $3
            limit 1`,
          [input.tenantId, input.issuer, input.subject, input.externalGameId],
        );
        if (!row?.user_id || !row.display_name) return { outcome: 'actor_not_linked' };
        if (!row.game_id || row.game_revision === null) return { outcome: 'game_not_mapped' };
        return {
          outcome: 'resolved',
          context: {
            tenantId: input.tenantId,
            userId: row.user_id,
            gameId: row.game_id,
            gameRevision: safeRevision(row.game_revision),
            player: {
              userId: row.user_id,
              displayName: row.display_name,
              phoneE164: row.phone_e164,
              levelLabel: row.level_label,
              levelValue: safeLevelValue(row.level_value),
            },
          },
        };
      });
    },
  };
}
