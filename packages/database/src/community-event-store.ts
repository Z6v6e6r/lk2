import type { PoolClient, QueryResultRow } from 'pg';

interface SequenceRow extends QueryResultRow {
  readonly last_sequence: number | string;
}

export interface CommunityEventRecord {
  readonly tenantId: string;
  readonly communityId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly targetType: 'POST' | 'COMMENT' | 'REACTION';
  readonly targetId: string;
  readonly targetRevision: number;
  readonly targetStatus?: string;
}

export async function appendCommunityEvent(
  client: PoolClient,
  input: Omit<CommunityEventRecord, 'sequence'>,
): Promise<CommunityEventRecord> {
  const head = await client.query<SequenceRow>(
    `insert into community_content.event_heads (
       tenant_id, community_id, last_sequence, retained_from_sequence, retention_due_at
     ) values ($1, $2, 1, 1, transaction_timestamp() + interval '30 days')
     on conflict (tenant_id, community_id) do update
       set last_sequence = community_content.event_heads.last_sequence + 1,
           retention_due_at = case
             when community_content.event_heads.retained_from_sequence =
                  community_content.event_heads.last_sequence + 1
               then transaction_timestamp() + interval '30 days'
             else community_content.event_heads.retention_due_at
           end,
           updated_at = now()
     returning last_sequence`,
    [input.tenantId, input.communityId],
  );
  const sequence = Number(head.rows[0]?.last_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('COMMUNITY_EVENT_SEQUENCE_INVALID');
  }
  await client.query(
    `insert into community_content.events (
       tenant_id, community_id, sequence, event_type, target_type,
       target_id, target_revision, target_status
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.communityId,
      sequence,
      input.eventType,
      input.targetType,
      input.targetId,
      input.targetRevision,
      input.targetStatus ?? null,
    ],
  );
  return { ...input, sequence };
}
