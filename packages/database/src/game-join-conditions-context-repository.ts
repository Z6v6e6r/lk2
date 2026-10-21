import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface GameJoinConditionsContextInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly gameId: string;
  readonly subscriptionInstanceId: string;
}
export interface GameJoinConditionsContext {
  readonly revision: number;
  readonly sourceVersion: string;
  readonly providerTenantKey: string;
  readonly legacyGameId: string;
  readonly providerClientId: string;
  readonly providerSubscriptionId: string;
  readonly startsAt: string;
  readonly durationMinutes: 90;
}
interface ContextRow {
  readonly revision: string | number;
  readonly source_version: string;
  readonly provider_tenant_key: string;
  readonly provider_client_id: string;
  readonly provider_subscription_id: string;
  readonly starts_at: Date | string;
  readonly ends_at: Date | string;
  readonly aliases: readonly {
    readonly id: string;
    readonly version: string;
    readonly status: string;
    readonly error: string | null;
    readonly syncedAt: string | null;
  }[];
}

/** This resolves integration keys, never ownership from a tenant-wide subscription mapping. */
export function createGameJoinConditionsContextRepository(
  pool: Pool,
  providerTenantKey = 'iSkq6G',
) {
  return {
    async resolve(
      input: GameJoinConditionsContextInput,
      signal?: AbortSignal,
    ): Promise<GameJoinConditionsContext | null> {
      const client = await pool.connect();
      try {
        if (signal?.aborted) return null;
        await client.query('begin read only');
        await client.query("select set_config('statement_timeout', '1500ms', true)");
        await client.query("select set_config('app.tenant_id', $1, true)", [input.tenantId]);
        const result = await client.query<ContextRow>(
          `
          select game.revision, sync.source_external_version as source_version,
                 profile.external_id as provider_client_id, binding.provider_tenant_key,
                 subscription.external_id as provider_subscription_id,
                 game.starts_at, game.ends_at,
                 (select jsonb_agg(jsonb_build_object('id', alias.external_id,
                          'version', alias.external_version, 'status', alias.sync_status,
                          'error', alias.sync_error_code, 'syncedAt', alias.last_synced_at) order by alias.external_id)
                    from integration.external_entity_map alias
                   where alias.tenant_id = game.tenant_id
                     and alias.external_system = 'LK_LEGACY_SNAPSHOT'
                     and alias.entity_type = 'game' and alias.internal_id = game.id) as aliases
            from identity.refresh_sessions session
            join identity.users actor on actor.tenant_id = session.tenant_id
             and actor.id = session.user_id and actor.status = 'ACTIVE'
            join identity.tenants tenant on tenant.id = actor.tenant_id and tenant.active = true
            join integration.identity_provider_bindings binding on binding.tenant_id = actor.tenant_id
             and binding.provider = 'VIVA' and binding.provider_tenant_key = $6
            join integration.external_entity_map profile on profile.tenant_id = actor.tenant_id
             and profile.internal_id = actor.id and profile.external_system = 'VIVA'
             and profile.entity_type = 'viva_profile' and profile.sync_status = 'synced'
             and profile.sync_error_code is null and profile.last_synced_at is not null
            join games.games game on game.tenant_id = actor.tenant_id and game.id = $4
             and game.visibility = 'PUBLIC' and game.lifecycle_state = 'SCHEDULED'
             and game.starts_at > now() and game.capacity = 4
             and (game.join_cutoff_at is null or game.join_cutoff_at > now())
             and game.payment_mode in ('SPLIT', 'SUBSCRIPTION')
            join integration.legacy_game_roster_sync_state sync on sync.tenant_id = game.tenant_id
             and sync.game_id = game.id and sync.mode = 'MIRROR' and sync.conflict_code is null
             and sync.last_synced_game_revision = game.revision
            join integration.external_entity_map subscription on subscription.tenant_id = actor.tenant_id
             and subscription.internal_id = $5 and subscription.external_system = 'VIVA'
             and subscription.entity_type = 'subscription' and subscription.sync_status = 'synced'
             and subscription.sync_error_code is null and subscription.last_synced_at is not null
           where session.tenant_id = $1 and session.user_id = $2 and session.id = $3
             and session.revoked_at is null and session.rotated_at is null and session.expires_at > now()
           limit 2`,
          [
            input.tenantId,
            input.userId,
            input.sessionId,
            input.gameId,
            input.subscriptionInstanceId,
            providerTenantKey,
          ],
        );
        if (result.rows.length !== 1) return null;
        const row = result.rows[0]!;
        const aliases = row.aliases;
        if (
          !Array.isArray(aliases) ||
          aliases.length < 2 ||
          aliases.length > 100 ||
          !row.source_version ||
          row.provider_tenant_key !== providerTenantKey ||
          aliases.some(
            (alias: ContextRow['aliases'][number]) =>
              alias.status !== 'synced' ||
              alias.error !== null ||
              !alias.syncedAt ||
              alias.version !== row.source_version,
          ) ||
          new Set(aliases.map((alias: ContextRow['aliases'][number]) => alias.id)).size !==
            aliases.length
        )
          return null;
        const hashed = new Set(
          aliases
            .filter((alias: ContextRow['aliases'][number]) => /^[a-f0-9]{64}$/.test(alias.id))
            .map((alias: ContextRow['aliases'][number]) => alias.id),
        );
        const candidates: ContextRow['aliases'] = aliases.filter(
          (alias: ContextRow['aliases'][number]) =>
            /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(alias.id) &&
            !hashed.has(alias.id) &&
            hashed.has(
              createHash('sha256')
                .update(`phub-local-public-clone-v1:game:${alias.id}`)
                .digest('hex'),
            ),
        );
        if (candidates.length !== 1 || hashed.size !== 1 || aliases.length !== 2) return null;
        const revision = Number(row.revision);
        const start = new Date(row.starts_at),
          end = new Date(row.ends_at);
        if (
          !Number.isSafeInteger(revision) ||
          revision < 1 ||
          !Number.isFinite(start.getTime()) ||
          end.getTime() - start.getTime() !== 90 * 60_000 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.provider_client_id,
          ) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.provider_subscription_id,
          )
        )
          return null;
        // The LK1 entry accepts an explicitly zoned Moscow wall clock; preserve the same instant.
        const startsAt =
          new Date(start.getTime() + 3 * 60 * 60_000).toISOString().slice(0, 19) + '+03:00';
        return {
          revision,
          sourceVersion: row.source_version,
          providerTenantKey: row.provider_tenant_key,
          legacyGameId: candidates[0]!.id,
          providerClientId: row.provider_client_id,
          providerSubscriptionId: row.provider_subscription_id,
          startsAt,
          durationMinutes: 90,
        };
      } finally {
        // A read-only rollback ends the snapshot even on a safe refusal. No durable changes.
        try {
          await client.query('rollback');
        } finally {
          client.release();
        }
      }
    },
  };
}
