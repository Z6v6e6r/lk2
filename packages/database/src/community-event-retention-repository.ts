import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

interface ClaimedHeadRow extends QueryResultRow {
  readonly community_id: string;
}

interface HeadRow extends QueryResultRow {
  readonly last_sequence: number | string;
  readonly retained_from_sequence: number | string;
}

interface EventExpiryRow extends QueryResultRow {
  readonly sequence: number | string;
  readonly occurred_at: Date | string;
  readonly expired: boolean;
}

export interface CommunityEventRetentionRepository {
  claimDue(input: {
    readonly tenantId: string;
    readonly claimToken: string;
    readonly batchSize: number;
    readonly leaseMs: number;
  }): Promise<readonly string[]>;
  purgeClaimed(input: {
    readonly tenantId: string;
    readonly communityId: string;
    readonly claimToken: string;
    readonly batchSize: number;
    readonly correlationId: string;
  }): Promise<
    | {
        readonly outcome: 'purged';
        readonly deleted: number;
        readonly retainedFromSequence: number;
      }
    | { readonly outcome: 'claim_lost' }
  >;
  releaseClaim(input: {
    readonly tenantId: string;
    readonly communityId: string;
    readonly claimToken: string;
  }): Promise<boolean>;
}

function assertLimit(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error('COMMUNITY_EVENT_RETENTION_LIMIT_INVALID');
  }
}

function safeSequence(value: number | string, code: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(code);
  return sequence;
}

export function createCommunityEventRetentionRepository(
  pool: Pool,
): CommunityEventRetentionRepository {
  return {
    claimDue(input) {
      assertLimit(input.batchSize, 100);
      if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 600_000) {
        throw new Error('COMMUNITY_EVENT_RETENTION_LEASE_INVALID');
      }
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<ClaimedHeadRow>(
          `with candidates as (
             select head.tenant_id, head.community_id
               from community_content.event_heads head
              where head.tenant_id = $1
                and (
                  head.retention_due_at <= clock_timestamp()
                  or (
                    head.retention_due_at is null
                    and head.retained_from_sequence <= head.last_sequence
                    and exists (
                      select 1
                        from community_content.events first_retained
                       where first_retained.tenant_id = head.tenant_id
                         and first_retained.community_id = head.community_id
                         and first_retained.sequence = head.retained_from_sequence
                         and first_retained.occurred_at <
                           clock_timestamp() - interval '30 days'
                    )
                  )
                )
                and (
                  head.purge_claim_expires_at is null
                  or head.purge_claim_expires_at <= clock_timestamp()
                )
              order by head.retention_due_at nulls first, head.community_id
              for update skip locked
              limit $2
           )
           update community_content.event_heads head
              set purge_claim_token = $3::uuid,
                  purge_claim_expires_at =
                    clock_timestamp() + ($4::integer * interval '1 millisecond'),
                  updated_at = clock_timestamp()
             from candidates
            where head.tenant_id = candidates.tenant_id
              and head.community_id = candidates.community_id
           returning head.community_id`,
          [input.tenantId, input.batchSize, input.claimToken, input.leaseMs],
        );
        return result.rows.map((row) => row.community_id);
      });
    },

    purgeClaimed(input) {
      assertLimit(input.batchSize, 5_000);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query("set local lock_timeout = '2s'");
        await client.query("set local statement_timeout = '10s'");
        const head = await queryOne<HeadRow>(
          client,
          `select last_sequence, retained_from_sequence
             from community_content.event_heads
            where tenant_id = $1 and community_id = $2
              and purge_claim_token = $3::uuid
              and purge_claim_expires_at > clock_timestamp()
            for update`,
          [input.tenantId, input.communityId, input.claimToken],
        );
        if (!head) return { outcome: 'claim_lost' as const };

        const lastSequence = safeSequence(head.last_sequence, 'COMMUNITY_EVENT_HEAD_INVALID');
        const retainedFromSequence = safeSequence(
          head.retained_from_sequence,
          'COMMUNITY_EVENT_HEAD_INVALID',
        );
        if (retainedFromSequence < 1 || retainedFromSequence > lastSequence + 1) {
          throw new Error('COMMUNITY_EVENT_HEAD_INVALID');
        }

        const candidates = await client.query<EventExpiryRow>(
          `with cutoff as materialized (
             select clock_timestamp() - interval '30 days' as expires_before
           )
           select event.sequence, event.occurred_at,
                  event.occurred_at < cutoff.expires_before as expired
             from community_content.events event
             cross join cutoff
            where event.tenant_id = $1 and event.community_id = $2
              and event.sequence >= $3
            order by event.sequence
            limit $4`,
          [input.tenantId, input.communityId, retainedFromSequence, input.batchSize],
        );
        const first = candidates.rows[0];
        if (
          first &&
          safeSequence(first.sequence, 'COMMUNITY_EVENT_SEQUENCE_INVALID') !== retainedFromSequence
        ) {
          throw new Error('COMMUNITY_EVENT_STREAM_GAP');
        }
        if (!first && retainedFromSequence !== lastSequence + 1) {
          throw new Error('COMMUNITY_EVENT_STREAM_GAP');
        }

        const expiredPrefix: number[] = [];
        for (const event of candidates.rows) {
          if (!event.expired) break;
          expiredPrefix.push(safeSequence(event.sequence, 'COMMUNITY_EVENT_SEQUENCE_INVALID'));
        }
        if (expiredPrefix.length > 0) {
          const deleted = await client.query(
            `delete from community_content.events
              where tenant_id = $1 and community_id = $2
                and sequence = any($3::bigint[])`,
            [input.tenantId, input.communityId, expiredPrefix],
          );
          if ((deleted.rowCount ?? 0) !== expiredPrefix.length) {
            throw new Error('COMMUNITY_EVENT_PURGE_COUNT_MISMATCH');
          }
        }

        const nextRetained = expiredPrefix.at(-1) ?? retainedFromSequence - 1;
        const resultingRetained = nextRetained + 1;
        const next = await queryOne<EventExpiryRow>(
          client,
          `select sequence, occurred_at, false as expired
             from community_content.events
            where tenant_id = $1 and community_id = $2 and sequence >= $3
            order by sequence
            limit 1`,
          [input.tenantId, input.communityId, resultingRetained],
        );
        if (
          next &&
          safeSequence(next.sequence, 'COMMUNITY_EVENT_SEQUENCE_INVALID') !== resultingRetained
        ) {
          throw new Error('COMMUNITY_EVENT_STREAM_GAP');
        }
        if (!next && resultingRetained !== lastSequence + 1) {
          throw new Error('COMMUNITY_EVENT_STREAM_GAP');
        }

        await client.query(
          `update community_content.event_heads
              set retained_from_sequence = $4,
                  retention_due_at = case
                    when $5::timestamptz is null then null
                    else $5::timestamptz + interval '30 days'
                  end,
                  purge_claim_token = null,
                  purge_claim_expires_at = null,
                  updated_at = clock_timestamp()
            where tenant_id = $1 and community_id = $2
              and purge_claim_token = $3::uuid`,
          [
            input.tenantId,
            input.communityId,
            input.claimToken,
            resultingRetained,
            next?.occurred_at ?? null,
          ],
        );

        if (expiredPrefix.length > 0) {
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id,
               result, correlation_id, old_value, new_value
             ) values ($1, null, 'COMMUNITY_EVENT_RETENTION_PURGED', 'COMMUNITY', $2,
                       'SUCCESS', $3,
                       jsonb_build_object('retainedFromSequence', $4::bigint),
                       jsonb_build_object(
                         'retainedFromSequence', $5::bigint,
                         'deletedCount', $6::integer,
                         'retentionDays', 30
                       ))`,
            [
              input.tenantId,
              input.communityId,
              input.correlationId,
              retainedFromSequence,
              resultingRetained,
              expiredPrefix.length,
            ],
          );
        }
        return {
          outcome: 'purged' as const,
          deleted: expiredPrefix.length,
          retainedFromSequence: resultingRetained,
        };
      });
    },

    releaseClaim(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query(
          `update community_content.event_heads
              set purge_claim_token = null,
                  purge_claim_expires_at = null,
                  updated_at = clock_timestamp()
            where tenant_id = $1 and community_id = $2
              and purge_claim_token = $3::uuid`,
          [input.tenantId, input.communityId, input.claimToken],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },
  };
}
