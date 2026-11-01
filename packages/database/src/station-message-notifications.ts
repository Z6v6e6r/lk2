import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { withTenantTransaction } from './connection.js';
export interface StationSource extends QueryResultRow {
  tenant_id: string;
  id: string;
  community_id: string;
  mapping_id: string;
  owner_namespace: string;
  private_community_id: string;
  incarnation_hash: string;
  stream_id: string;
  after_sequence: string;
  through_sequence: string | null;
  lease_token: string;
}
export interface StationFactRow extends StationSource {
  fact_id: string;
  sequence: string;
  message_id: string;
  author_player_id: string;
  proof_hash: string;
  after_player_id: string | null;
  fact_lease_token: string;
}
export interface StationRecipientRow extends StationFactRow {
  context_id: string;
  player_id: string;
  membership_epoch: string;
  baseline_sequence: string;
  read_through_sequence: string;
  user_id: string | null;
  recipient_mapping_id: string | null;
  recipient_lease_token: string;
}
export const stationFactJoin = `select s.*,f.id fact_id,f.sequence,f.message_id,f.author_player_id,f.proof_hash,f.after_player_id,f.lease_token fact_lease_token from notifications.station_message_facts f join notifications.station_message_sources s on s.tenant_id=f.tenant_id and s.id=f.source_id`;
export const stationRecipientJoin = `select s.*,f.id fact_id,f.sequence,f.message_id,f.author_player_id,f.proof_hash,f.after_player_id,f.lease_token fact_lease_token,r.id context_id,r.player_id,r.membership_epoch,r.baseline_sequence,r.read_through_sequence,r.user_id,r.mapping_id recipient_mapping_id,r.lease_token recipient_lease_token from notifications.station_message_recipient_outbox r join notifications.station_message_facts f on f.tenant_id=r.tenant_id and f.id=r.fact_id join notifications.station_message_sources s on s.tenant_id=f.tenant_id and s.id=f.source_id`;
/** No upsert/mint/phone fallback. Hold map then ACTIVE user through the caller transaction.
 * User NOWAIT yields to existing auth user→map custody instead of creating a deadlock cycle.
 * 0042 canonical_internal uniqueness protects the reverse identity while map FOR SHARE blocks rebind/status changes. */
export async function stationMapping(
  client: PoolClient,
  tenantId: string,
  system: 'LK_LEGACY' | 'VIVA',
  entity: 'community' | 'viva_profile',
  externalId: string,
  expected?: { id: string; internalId: string },
) {
  const result = await client.query<{ id: string; internal_id: string }>(
    `select m.id,m.internal_id from integration.external_entity_map m where m.tenant_id=$1 and m.external_system=$2 and m.entity_type=$3 and m.external_id=$4 and m.sync_status='synced' and m.sync_error_code is null and m.last_synced_at is not null and (select count(*) from integration.external_entity_map r where r.tenant_id=m.tenant_id and r.external_system=m.external_system and r.entity_type=m.entity_type and r.internal_id=m.internal_id)=1 for share of m`,
    [tenantId, system, entity, externalId],
  );
  if (result.rowCount !== 1) throw Error('STATION_MAPPING_UNAVAILABLE');
  const row = result.rows[0]!;
  if (expected && (row.id !== expected.id || row.internal_id !== expected.internalId))
    throw Error('STATION_MAPPING_CHANGED');
  if (
    system === 'VIVA' &&
    (
      await client.query(
        "select id from identity.users where tenant_id=$1 and id=$2 and status='ACTIVE' for share nowait",
        [tenantId, row.internal_id],
      )
    ).rowCount !== 1
  )
    throw Error('STATION_RECIPIENT_UNAVAILABLE');
  return row;
}
export async function verifyStationSource(client: PoolClient, s: StationSource) {
  if (
    (
      await client.query(
        `select s.id from notifications.station_message_sources s join identity.tenants t on t.id=s.tenant_id where s.tenant_id=$1 and s.id=$2 and s.enabled and t.active and s.mapping_id=$3 and s.community_id=$4 and s.private_community_id=$5 and s.incarnation_hash=$6 and s.stream_id=$7 for share of s,t`,
        [
          s.tenant_id,
          s.id,
          s.mapping_id,
          s.community_id,
          s.private_community_id,
          s.incarnation_hash,
          s.stream_id,
        ],
      )
    ).rowCount !== 1
  )
    throw Error('STATION_SOURCE_UNAVAILABLE');
  if (
    (
      await client.query(
        "select tenant_id from integration.identity_provider_bindings where tenant_id=$1 and provider='VIVA' and provider_tenant_key=$2 for share",
        [s.tenant_id, s.owner_namespace],
      )
    ).rowCount !== 1
  )
    throw Error('STATION_NAMESPACE_MISMATCH');
  await stationMapping(client, s.tenant_id, 'LK_LEGACY', 'community', s.private_community_id, {
    id: s.mapping_id,
    internalId: s.community_id,
  });
}
export class StationMessageNotificationRepository {
  constructor(readonly pool: Pool) {}
  tx<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) {
    return withTenantTransaction(this.pool, tenantId, async (c) => {
      await c.query(
        "select set_config('lock_timeout','2s',true),set_config('statement_timeout','4s',true)",
      );
      return fn(c);
    });
  }
  async claimSource(tenantId: string) {
    return this.tx(tenantId, async (c) => {
      const r = await c.query<StationSource>(
        `select * from notifications.station_message_sources where tenant_id=$1 and enabled and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()) order by next_attempt_at,id for update skip locked limit 1`,
        [tenantId],
      );
      const s = r.rows[0];
      if (!s) return null;
      s.lease_token = randomUUID();
      await c.query(
        "update notifications.station_message_sources set lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds' where tenant_id=$1 and id=$2",
        [tenantId, s.id, s.lease_token],
      );
      return s;
    });
  }
  async storePage(
    s: StationSource,
    page: {
      throughSequence: number;
      items: readonly {
        messageId: string;
        sequence: number;
        authorPlayerId: string;
        proofHash: string;
      }[];
      nextAfterSequence: number | null;
      complete: boolean;
    },
  ) {
    return this.tx(s.tenant_id, async (c) => {
      const lock = await c.query(
        `select id from notifications.station_message_sources where tenant_id=$1 and id=$2 and lease_token=$3 and lease_until>clock_timestamp() and after_sequence=$4 and through_sequence is not distinct from $5::bigint for update`,
        [s.tenant_id, s.id, s.lease_token, s.after_sequence, s.through_sequence],
      );
      if (lock.rowCount !== 1) return false;
      await verifyStationSource(c, s);
      for (const f of page.items) {
        await c.query(
          `insert into notifications.station_message_facts(tenant_id,id,source_id,sequence,message_id,author_player_id,proof_hash) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [s.tenant_id, randomUUID(), s.id, f.sequence, f.messageId, f.authorPlayerId, f.proofHash],
        );
        if (
          (
            await c.query(
              `select id from notifications.station_message_facts where tenant_id=$1 and source_id=$2 and sequence=$3 and message_id=$4 and author_player_id=$5 and proof_hash=$6`,
              [s.tenant_id, s.id, f.sequence, f.messageId, f.authorPlayerId, f.proofHash],
            )
          ).rowCount !== 1
        )
          throw Error('STATION_FACT_CONFLICT');
      }
      await c.query(
        `update notifications.station_message_sources set after_sequence=$4,through_sequence=$5,lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '5 seconds',last_error_code=null where tenant_id=$1 and id=$2 and lease_token=$3`,
        [
          s.tenant_id,
          s.id,
          s.lease_token,
          page.items.at(-1)?.sequence ?? Number(s.after_sequence),
          page.complete ? null : page.throughSequence,
        ],
      );
      return true;
    });
  }
  async claimFact(tenantId: string) {
    return this.tx(tenantId, async (c) => {
      const r = await c.query<StationFactRow>(
        stationFactJoin +
          ` where f.tenant_id=$1 and s.enabled and not f.fanout_complete and f.next_attempt_at<=clock_timestamp() and (f.lease_until is null or f.lease_until<=clock_timestamp()) order by f.next_attempt_at,f.id for update of f skip locked limit 1`,
        [tenantId],
      );
      const f = r.rows[0];
      if (!f) return null;
      f.fact_lease_token = randomUUID();
      await c.query(
        "update notifications.station_message_facts set lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds' where tenant_id=$1 and id=$2",
        [tenantId, f.fact_id, f.fact_lease_token],
      );
      return f;
    });
  }
  async storeRecipients(
    f: StationFactRow,
    page: {
      items: readonly {
        playerId: string;
        membershipEpoch: number;
        baselineSequence: number;
        readThroughSequence: number;
      }[];
      nextAfterPlayerId: string | null;
      complete: boolean;
    },
  ) {
    return this.tx(f.tenant_id, async (c) => {
      const locked = await c.query(
        `select id from notifications.station_message_facts where tenant_id=$1 and id=$2 and lease_token=$3 and lease_until>clock_timestamp() and after_player_id is not distinct from $4::text and not fanout_complete for update`,
        [f.tenant_id, f.fact_id, f.fact_lease_token, f.after_player_id],
      );
      if (locked.rowCount !== 1) return false;
      await verifyStationSource(c, f);
      for (const p of page.items) {
        await c.query(
          `insert into notifications.station_message_recipient_outbox(tenant_id,id,fact_id,player_id,membership_epoch,baseline_sequence,read_through_sequence) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [
            f.tenant_id,
            randomUUID(),
            f.fact_id,
            p.playerId,
            p.membershipEpoch,
            p.baselineSequence,
            p.readThroughSequence,
          ],
        );
        const exact = await c.query(
          `select id from notifications.station_message_recipient_outbox where tenant_id=$1 and fact_id=$2 and player_id=$3 and membership_epoch=$4 and baseline_sequence=$5 and read_through_sequence=$6`,
          [
            f.tenant_id,
            f.fact_id,
            p.playerId,
            p.membershipEpoch,
            p.baselineSequence,
            p.readThroughSequence,
          ],
        );
        if (exact.rowCount !== 1) throw Error('STATION_RECIPIENT_CONFLICT');
      }
      await c.query(
        `update notifications.station_message_facts set after_player_id=$4,fanout_complete=$5,lease_token=null,lease_until=null,next_attempt_at=clock_timestamp(),last_error_code=null where tenant_id=$1 and id=$2 and lease_token=$3`,
        [f.tenant_id, f.fact_id, f.fact_lease_token, page.nextAfterPlayerId, page.complete],
      );
      return true;
    });
  }
  async claimRecipient(tenantId: string) {
    return this.tx(tenantId, async (c) => {
      const r = await c.query<StationRecipientRow>(
        stationRecipientJoin +
          ` where r.tenant_id=$1 and s.enabled and r.state='PENDING' and r.next_attempt_at<=clock_timestamp() and (r.lease_until is null or r.lease_until<=clock_timestamp()) order by r.next_attempt_at,r.id for update of r skip locked limit 1`,
        [tenantId],
      );
      const p = r.rows[0];
      if (!p) return null;
      p.recipient_lease_token = randomUUID();
      await c.query(
        "update notifications.station_message_recipient_outbox set lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds' where tenant_id=$1 and id=$2",
        [tenantId, p.context_id, p.recipient_lease_token],
      );
      return p;
    });
  }
  async hold(tenantId: string, kind: 'source' | 'fact' | 'recipient', id: string, token: string) {
    const table = {
      source: 'station_message_sources',
      fact: 'station_message_facts',
      recipient: 'station_message_recipient_outbox',
    }[kind];
    await this.tx(tenantId, (c) =>
      c.query(
        `update notifications.${table} set lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '30 seconds',last_error_code='STATION_DEPENDENCY_UNAVAILABLE' where tenant_id=$1 and id=$2 and lease_token=$3`,
        [tenantId, id, token],
      ),
    );
  }
}
