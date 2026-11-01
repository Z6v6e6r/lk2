import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { withTenantTransaction } from './connection.js';
import type {
  TournamentNotificationWitness,
  TournamentNotificationIdentity,
} from './tournament-notification-recipient.js';
import { stationMapping as lockCanonicalMapping } from './station-message-notifications.js';
export interface TournamentSource extends QueryResultRow {
  tenant_id: string;
  id: string;
  tournament_id: string;
  owner_namespace: string;
  incarnation_hash: string;
  stream_id: string;
  after_sequence: string;
  completed_sequence: string;
  through_sequence: string | null;
  lease_token: string;
}
export interface TournamentFactRow extends TournamentSource {
  fact_id: string;
  sequence: string;
  message_id: string;
  author_user_id: string;
  fact_hash: string;
  recipient_cursor: string | null;
  snapshot_hash: string | null;
  recipient_through_sequence: string | null;
  fact_lease_token: string;
}
export interface TournamentRecipientRow extends TournamentFactRow {
  context_id: string;
  witness: TournamentNotificationWitness;
  witness_hash: string;
  baseline_sequence: string;
  read_through_sequence: string;
  user_id: string | null;
  recipient_mapping_id: string | null;
  provider_client_id: string | null;
  recipient_lease_token: string;
}
export interface TournamentPublication {
  tournamentId: string;
  incarnationHash: string;
  streamId: string;
  sequence: number;
  messageId: string;
  authorUserId: string;
  factHash: string;
}
export interface TournamentCandidate {
  witness: TournamentNotificationWitness;
  witnessHash: string;
  baselineSequence: number;
  capturedReadThroughSequence: number;
}
export interface TournamentPublicationPage {
  tournamentId: string;
  incarnationHash: string;
  streamId: string;
  throughSequence: number;
  facts: readonly TournamentPublication[];
  nextAfterSequence: number | null;
  hasMore: boolean;
}
export interface TournamentRecipientPage {
  fact: TournamentPublication;
  throughSequence: number;
  snapshotHash: string;
  candidates: readonly TournamentCandidate[];
  nextCursor: string | null;
  hasMore: boolean;
}
/** Strict local ledger boundary; preserve the original normalized owner witness bytes. */
const validWitness = (value: unknown): value is TournamentNotificationWitness => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const w = value as Record<string, unknown>;
  const uuid = (v: unknown) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
  return (
    Object.keys(w).length === 3 &&
    (w.kind === 'PARTICIPANT'
      ? uuid(w.generation) && typeof w.actorHash === 'string' && /^[a-f0-9]{64}$/.test(w.actorHash)
      : w.kind === 'ORGANIZER' &&
        uuid(w.selectedUserId) &&
        Number.isSafeInteger(w.revision) &&
        Number(w.revision) >= 1)
  );
};
const columns = `s.*,f.id fact_id,f.sequence,f.message_id,f.author_user_id,f.fact_hash,f.recipient_cursor,f.snapshot_hash,f.recipient_through_sequence,f.lease_token fact_lease_token`;
export const tournamentFactJoin = `select ${columns} from notifications.tournament_message_facts f join notifications.tournament_message_sources s on s.tenant_id=f.tenant_id and s.id=f.source_id`;
export const tournamentRecipientJoin = `select ${columns},r.id context_id,r.witness,r.witness_hash,r.baseline_sequence,r.read_through_sequence,r.user_id,r.mapping_id recipient_mapping_id,r.provider_client_id,r.lease_token recipient_lease_token from notifications.tournament_message_recipient_outbox r join notifications.tournament_message_facts f on f.tenant_id=r.tenant_id and f.id=r.fact_id join notifications.tournament_message_sources s on s.tenant_id=f.tenant_id and s.id=f.source_id`;
export async function verifyTournamentSource(c: PoolClient, s: TournamentSource) {
  const result = await c.query(
    `select s.id from notifications.tournament_message_sources s join identity.tenants t on t.id=s.tenant_id join integration.identity_provider_bindings b on b.tenant_id=s.tenant_id and b.provider='VIVA' where s.tenant_id=$1 and s.id=$2 and s.enabled and t.active and s.tournament_id=$3 and s.incarnation_hash=$4 and s.stream_id=$5 and s.owner_namespace=$6 and b.provider_tenant_key=s.owner_namespace for share of s,t,b`,
    [s.tenant_id, s.id, s.tournament_id, s.incarnation_hash, s.stream_id, s.owner_namespace],
  );
  if (result.rowCount !== 1) throw Error('TOURNAMENT_SOURCE_UNAVAILABLE');
}
export async function verifyTournamentIdentity(
  c: PoolClient,
  s: TournamentSource,
  identity: TournamentNotificationIdentity,
) {
  if (identity.ownerTenantKey !== s.owner_namespace) throw Error('TOURNAMENT_NAMESPACE_MISMATCH');
  return lockCanonicalMapping(c, s.tenant_id, 'VIVA', 'viva_profile', identity.providerClientId, {
    id: identity.providerMappingId,
    internalId: identity.userId,
  });
}
export const tournamentBinding = (s: TournamentSource) => ({
  tournamentId: s.tournament_id,
  incarnationHash: s.incarnation_hash,
  streamId: s.stream_id,
});
export const tournamentPublication = (f: TournamentFactRow): TournamentPublication => ({
  ...tournamentBinding(f),
  sequence: Number(f.sequence),
  messageId: f.message_id,
  authorUserId: f.author_user_id,
  factHash: f.fact_hash,
});
export const tournamentCandidate = (p: TournamentRecipientRow): TournamentCandidate => ({
  witness: p.witness,
  witnessHash: p.witness_hash,
  baselineSequence: Number(p.baseline_sequence),
  capturedReadThroughSequence: Number(p.read_through_sequence),
});
const sameBinding = (
  s: TournamentSource,
  p: { tournamentId: string; incarnationHash: string; streamId: string },
) =>
  s.tournament_id === p.tournamentId &&
  s.incarnation_hash === p.incarnationHash &&
  s.stream_id === p.streamId;
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const safe = (x: number) => Number.isSafeInteger(x) && x >= 0;
export class TournamentMessageNotificationRepository {
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
      const r = await c.query<TournamentSource>(
        `select * from notifications.tournament_message_sources where tenant_id=$1 and enabled and next_attempt_at<=clock_timestamp() and (through_sequence is null or after_sequence<through_sequence) and (lease_until is null or lease_until<=clock_timestamp()) order by next_attempt_at,id for update skip locked limit 1`,
        [tenantId],
      );
      const s = r.rows[0];
      if (!s) return null;
      s.lease_token = randomUUID();
      await c.query(
        "update notifications.tournament_message_sources set lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds' where tenant_id=$1 and id=$2",
        [tenantId, s.id, s.lease_token],
      );
      return s;
    });
  }
  private async complete(c: PoolClient, s: TournamentSource) {
    // Caller holds source FOR UPDATE before touching fact/recipient rows. Staging is not completion.
    await c.query(
      `update notifications.tournament_message_sources s set completed_sequence=s.through_sequence,through_sequence=null,next_attempt_at=clock_timestamp()+interval '5 seconds' where s.tenant_id=$1 and s.id=$2 and s.through_sequence=s.after_sequence and not exists(select 1 from notifications.tournament_message_facts f where f.tenant_id=s.tenant_id and f.source_id=s.id and f.sequence>s.completed_sequence and f.sequence<=s.through_sequence and not f.fanout_complete)`,
      [s.tenant_id, s.id],
    );
  }
  async storePage(s: TournamentSource, page: TournamentPublicationPage) {
    if (
      !sameBinding(s, page) ||
      !safe(page.throughSequence) ||
      page.throughSequence < Number(s.after_sequence) ||
      (s.through_sequence !== null && page.throughSequence !== Number(s.through_sequence)) ||
      page.facts.length > 50
    )
      throw Error('TOURNAMENT_PUBLICATION_INVALID');
    for (const [i, f] of page.facts.entries())
      if (
        !sameBinding(s, f) ||
        f.sequence !== Number(s.after_sequence) + i + 1 ||
        f.sequence > page.throughSequence ||
        !hash(f.factHash)
      )
        throw Error('TOURNAMENT_PUBLICATION_INVALID');
    const last = page.facts.at(-1)?.sequence ?? Number(s.after_sequence);
    if (
      page.hasMore
        ? page.facts.length !== 50 ||
          page.nextAfterSequence !== last ||
          last >= page.throughSequence
        : page.nextAfterSequence !== null || last !== page.throughSequence
    )
      throw Error('TOURNAMENT_PUBLICATION_INVALID');
    return this.tx(s.tenant_id, async (c) => {
      const locked = await c.query(
        `select id from notifications.tournament_message_sources where tenant_id=$1 and id=$2 and lease_token=$3 and lease_until>clock_timestamp() and after_sequence=$4 and through_sequence is not distinct from $5::bigint for update`,
        [s.tenant_id, s.id, s.lease_token, s.after_sequence, s.through_sequence],
      );
      if (locked.rowCount !== 1) return false;
      await verifyTournamentSource(c, s);
      for (const f of page.facts) {
        await c.query(
          `insert into notifications.tournament_message_facts(tenant_id,id,source_id,sequence,message_id,author_user_id,fact_hash) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [s.tenant_id, randomUUID(), s.id, f.sequence, f.messageId, f.authorUserId, f.factHash],
        );
        if (
          (
            await c.query(
              `select id from notifications.tournament_message_facts where tenant_id=$1 and source_id=$2 and sequence=$3 and message_id=$4 and author_user_id=$5 and fact_hash=$6`,
              [s.tenant_id, s.id, f.sequence, f.messageId, f.authorUserId, f.factHash],
            )
          ).rowCount !== 1
        )
          throw Error('TOURNAMENT_FACT_CONFLICT');
      }
      await c.query(
        `update notifications.tournament_message_sources set after_sequence=$4,through_sequence=$5,lease_token=null,lease_until=null,next_attempt_at=clock_timestamp(),last_error_code=null where tenant_id=$1 and id=$2 and lease_token=$3`,
        [s.tenant_id, s.id, s.lease_token, last, page.throughSequence],
      );
      await this.complete(c, s);
      return true;
    });
  }
  async claimFact(tenantId: string) {
    return this.tx(tenantId, async (c) => {
      const r = await c.query<TournamentFactRow>(
        tournamentFactJoin +
          ` where f.tenant_id=$1 and s.enabled and not f.fanout_complete and f.next_attempt_at<=clock_timestamp() and (f.lease_until is null or f.lease_until<=clock_timestamp()) order by f.next_attempt_at,f.id for update of f skip locked limit 1`,
        [tenantId],
      );
      const f = r.rows[0];
      if (!f) return null;
      f.fact_lease_token = randomUUID();
      await c.query(
        "update notifications.tournament_message_facts set lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds' where tenant_id=$1 and id=$2",
        [tenantId, f.fact_id, f.fact_lease_token],
      );
      return f;
    });
  }
  async storeRecipients(f: TournamentFactRow, page: TournamentRecipientPage) {
    if (
      JSON.stringify(page.fact) !== JSON.stringify(tournamentPublication(f)) ||
      !hash(page.snapshotHash) ||
      !safe(page.throughSequence) ||
      page.throughSequence < Number(f.sequence) ||
      page.candidates.length > 50 ||
      page.hasMore !== (page.nextCursor !== null)
    )
      throw Error('TOURNAMENT_RECIPIENT_PAGE_INVALID');
    if (
      f.recipient_cursor !== null &&
      (f.snapshot_hash !== page.snapshotHash ||
        Number(f.recipient_through_sequence) !== page.throughSequence)
    )
      throw Error('TOURNAMENT_SNAPSHOT_CHANGED');
    if (page.hasMore && page.nextCursor === f.recipient_cursor)
      throw Error('TOURNAMENT_CURSOR_STALLED');
    return this.tx(f.tenant_id, async (c) => {
      await c.query(
        'select id from notifications.tournament_message_sources where tenant_id=$1 and id=$2 for update',
        [f.tenant_id, f.id],
      );
      await verifyTournamentSource(c, f);
      const locked = await c.query(
        `select id from notifications.tournament_message_facts where tenant_id=$1 and id=$2 and lease_token=$3 and lease_until>clock_timestamp() and recipient_cursor is not distinct from $4::text and not fanout_complete for update`,
        [f.tenant_id, f.fact_id, f.fact_lease_token, f.recipient_cursor],
      );
      if (locked.rowCount !== 1) return false;
      for (const p of page.candidates) {
        if (
          !validWitness(p.witness) ||
          !safe(p.baselineSequence) ||
          !safe(p.capturedReadThroughSequence) ||
          p.baselineSequence > p.capturedReadThroughSequence ||
          p.capturedReadThroughSequence >= Number(f.sequence) ||
          createHash('sha256')
            .update('tournament-chat-witness:v1\0' + JSON.stringify(p.witness))
            .digest('hex') !== p.witnessHash
        )
          throw Error('TOURNAMENT_RECIPIENT_INVALID');
        await c.query(
          `insert into notifications.tournament_message_recipient_outbox(tenant_id,id,fact_id,witness,witness_hash,baseline_sequence,read_through_sequence) values($1,$2,$3,$4::jsonb,$5,$6,$7) on conflict do nothing`,
          [
            f.tenant_id,
            randomUUID(),
            f.fact_id,
            JSON.stringify(p.witness),
            p.witnessHash,
            p.baselineSequence,
            p.capturedReadThroughSequence,
          ],
        );
        // Restart may observe a later read position; retain the original candidate instead of rebinding it.
        if (
          (
            await c.query(
              `select id from notifications.tournament_message_recipient_outbox where tenant_id=$1 and fact_id=$2 and witness=$3::jsonb and witness_hash=$4 and baseline_sequence=$5 and read_through_sequence<=$6`,
              [
                f.tenant_id,
                f.fact_id,
                JSON.stringify(p.witness),
                p.witnessHash,
                p.baselineSequence,
                p.capturedReadThroughSequence,
              ],
            )
          ).rowCount !== 1
        )
          throw Error('TOURNAMENT_RECIPIENT_CONFLICT');
      }
      await c.query(
        `update notifications.tournament_message_facts set recipient_cursor=$4,snapshot_hash=$5,recipient_through_sequence=$6,fanout_complete=$7,lease_token=null,lease_until=null,next_attempt_at=clock_timestamp(),last_error_code=null where tenant_id=$1 and id=$2 and lease_token=$3`,
        [
          f.tenant_id,
          f.fact_id,
          f.fact_lease_token,
          page.nextCursor,
          page.snapshotHash,
          page.throughSequence,
          !page.hasMore,
        ],
      );
      await this.complete(c, f);
      return true;
    });
  }
  async restartFact(f: TournamentFactRow) {
    return this.tx(f.tenant_id, (c) =>
      c.query(
        `update notifications.tournament_message_facts set recipient_cursor=null,snapshot_hash=null,recipient_through_sequence=null,lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '30 seconds',last_error_code='TOURNAMENT_RECIPIENT_RESTART' where tenant_id=$1 and id=$2 and lease_token=$3 and not fanout_complete`,
        [f.tenant_id, f.fact_id, f.fact_lease_token],
      ),
    );
  }
  async claimRecipient(tenantId: string) {
    return this.tx(tenantId, async (c) => {
      const r = await c.query<TournamentRecipientRow>(
        tournamentRecipientJoin +
          ` where r.tenant_id=$1 and s.enabled and r.state='PENDING' and r.next_attempt_at<=clock_timestamp() and (r.lease_until is null or r.lease_until<=clock_timestamp()) order by r.next_attempt_at,r.id for update of r skip locked limit 1`,
        [tenantId],
      );
      const p = r.rows[0];
      if (!p) return null;
      p.recipient_lease_token = randomUUID();
      await c.query(
        "update notifications.tournament_message_recipient_outbox set lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds' where tenant_id=$1 and id=$2",
        [tenantId, p.context_id, p.recipient_lease_token],
      );
      return p;
    });
  }
  async hold(tenantId: string, kind: 'source' | 'fact' | 'recipient', id: string, token: string) {
    const table = {
      source: 'tournament_message_sources',
      fact: 'tournament_message_facts',
      recipient: 'tournament_message_recipient_outbox',
    }[kind];
    return this.tx(tenantId, (c) =>
      c.query(
        `update notifications.${table} set lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '30 seconds',last_error_code='TOURNAMENT_DEPENDENCY_UNAVAILABLE' where tenant_id=$1 and id=$2 and lease_token=$3`,
        [tenantId, id, token],
      ),
    );
  }
}
