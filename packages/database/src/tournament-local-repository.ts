import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { withTenantTransaction } from './connection.js';
import {
  TournamentLocalError,
  tournamentDigest,
  tournamentOwnerOperationId,
  parseTournamentLocalInput,
  parseTournamentCommand,
  parseTournamentReceipt,
  type TournamentLocalInput,
  type TournamentOwnerCommand,
  type TournamentOwnerReceipt,
} from '@phub/domain';
export interface TournamentActor {
  tenantId: string;
  tenantKey: string;
  userId: string;
  sessionId: string;
  correlationId: string;
}
export interface TournamentIdentity {
  providerClientId: string;
  providerMappingId: string;
  providerTenantKey: string;
}
export interface TournamentAttempt {
  id: string;
  tournamentId: string;
  request: TournamentLocalInput;
  command: TournamentOwnerCommand;
  ownerOperationId: string;
  identity: TournamentIdentity;
  state: 'READY' | 'DISPATCHED' | 'COMPLETED';
  receipt: TournamentOwnerReceipt | null;
  originalJoinId: string | null;
}
export interface TournamentScope {
  tenantId: string;
  userId: string;
  tournamentId: string;
}
interface Row extends QueryResultRow {
  tenant_id: string;
  id: string;
  actor_user_id: string;
  tournament_id: string;
  request: unknown;
  request_hash: string;
  owner_command: unknown;
  authority_hash: string;
  owner_operation_id: string;
  provider_client_id: string;
  provider_mapping_id: string;
  provider_tenant_key: string;
  state: TournamentAttempt['state'];
  receipt: unknown;
  receipt_hash: string | null;
  original_join_id: string | null;
}
export const tournamentOwnerKey = (id: string) => 'lk2-tournament:' + id;
async function decode(r: Row): Promise<TournamentAttempt> {
  const request = parseTournamentLocalInput(r.request),
    command = parseTournamentCommand(r.owner_command);
  if (
    (await tournamentDigest('lk2-tournament-request:v1', {
      tournamentId: r.tournament_id,
      ...request,
    })) !== r.request_hash ||
    command.tournamentId !== r.tournament_id ||
    command.action !== request.action ||
    (await tournamentOwnerOperationId(
      r.provider_tenant_key,
      r.provider_client_id,
      tournamentOwnerKey(r.id),
      r.tournament_id,
    )) !== r.owner_operation_id ||
    (request.action === 'LEAVE'
      ? request.originalJoinOperationId !== r.original_join_id
      : r.original_join_id !== null)
  )
    throw new TournamentLocalError('TOURNAMENT_LOCAL_STORED_INVALID');
  if (
    (await tournamentDigest('lk2-tournament-authority:v1', [
      r.id,
      r.tenant_id,
      r.actor_user_id,
      command,
      r.provider_tenant_key,
      r.provider_client_id,
      r.provider_mapping_id,
      r.original_join_id,
    ])) !== r.authority_hash
  )
    throw new TournamentLocalError('TOURNAMENT_LOCAL_STORED_INVALID');
  const receipt =
    r.receipt === null ? null : parseTournamentReceipt(r.receipt, command, r.owner_operation_id);
  if (
    (r.state === 'COMPLETED') !== Boolean(receipt) ||
    (receipt &&
      (await tournamentDigest('lk2-tournament-receipt:v1', receipt.operation)) !== r.receipt_hash)
  )
    throw new TournamentLocalError('TOURNAMENT_LOCAL_STORED_INVALID');
  return {
    id: r.id,
    tournamentId: r.tournament_id,
    request,
    command,
    ownerOperationId: r.owner_operation_id,
    identity: {
      providerClientId: r.provider_client_id,
      providerMappingId: r.provider_mapping_id,
      providerTenantKey: r.provider_tenant_key,
    },
    state: r.state,
    receipt,
    originalJoinId: r.original_join_id,
  };
}
async function row(
  c: PoolClient,
  s: TournamentScope,
  selector: { id?: string; keyHash?: string } = {},
  lock = false,
) {
  const q = await c.query<Row>(
    `select * from booking.tournament_local_attempts where tenant_id=$1 and actor_user_id=$2 ${selector.id ? 'and id=$3' : selector.keyHash ? 'and key_sha256=$3' : 'and tournament_id=$3'} order by created_at desc,id desc limit 1 ${lock ? 'for update' : ''}`,
    [s.tenantId, s.userId, selector.id ?? selector.keyHash ?? s.tournamentId],
  );
  if (!q.rows[0]) return null;
  const a = await decode(q.rows[0]);
  if (a.tournamentId !== s.tournamentId)
    throw new TournamentLocalError('TOURNAMENT_LOCAL_KEY_CONFLICT', 409);
  return a;
}
async function identity(c: PoolClient, a: TournamentActor): Promise<TournamentIdentity | null> {
  const q = await c.query<{
    provider_client_id: string;
    provider_mapping_id: string;
    provider_tenant_key: string;
  }>(
    `select p.external_id provider_client_id,p.id provider_mapping_id,b.provider_tenant_key from identity.refresh_sessions s join identity.users u on u.tenant_id=s.tenant_id and u.id=s.user_id and u.status='ACTIVE' join identity.tenants t on t.id=u.tenant_id and t.active=true and t.tenant_key=$4 join integration.identity_provider_bindings b on b.tenant_id=u.tenant_id and b.provider='VIVA' join integration.external_entity_map p on p.tenant_id=u.tenant_id and p.internal_id=u.id and p.external_system='VIVA' and p.entity_type='viva_profile' and p.sync_status='synced' and p.sync_error_code is null and p.last_synced_at is not null where s.tenant_id=$1 and s.user_id=$2 and s.id=$3 and s.revoked_at is null and s.rotated_at is null and s.expires_at>now() limit 2 for share of s,u,t,b,p`,
    [a.tenantId, a.userId, a.sessionId, a.tenantKey],
  );
  const r = q.rows.length === 1 ? q.rows[0] : undefined;
  return r
    ? {
        providerClientId: r.provider_client_id,
        providerMappingId: r.provider_mapping_id,
        providerTenantKey: r.provider_tenant_key,
      }
    : null;
}
export const sameTournamentIdentity = (a: TournamentIdentity, b: TournamentIdentity) =>
  a.providerClientId === b.providerClientId &&
  a.providerMappingId === b.providerMappingId &&
  a.providerTenantKey === b.providerTenantKey;
async function event(c: PoolClient, a: TournamentActor, x: TournamentAttempt, type: string) {
  const { randomUUID } = await import('node:crypto');
  const payload = {
    operationId: x.id,
    tournamentId: x.tournamentId,
    userId: a.userId,
    state: x.state,
  };
  await c.query(
    `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,result,correlation_id,new_value) values($1,$2,$3,'TOURNAMENT',$4,'SUCCESS',$5,$6::jsonb)`,
    [a.tenantId, a.userId, type, x.tournamentId, a.correlationId, JSON.stringify(payload)],
  );
  await c.query(
    `insert into audit.outbox_events(id,tenant_id,event_type,aggregate_id,correlation_id,payload,occurred_at) values($1,$2,$3,$4,$5,$6::jsonb,now())`,
    [randomUUID(), a.tenantId, type, x.tournamentId, a.correlationId, JSON.stringify(payload)],
  );
}
export function createTournamentLocalRepository(pool: Pool) {
  return {
    async ready() {
      return (
        (
          await pool.query<{ ready: boolean }>(
            "select to_regclass('booking.tournament_local_attempts') is not null as ready",
          )
        ).rows[0]?.ready === true
      );
    },
    context: (a: TournamentActor) => withTenantTransaction(pool, a.tenantId, (c) => identity(c, a)),
    read: (s: TournamentScope, selector: { id?: string; keyHash?: string } = {}) =>
      withTenantTransaction(pool, s.tenantId, (c) => row(c, s, selector)),
    registeredJoinCandidate(s: TournamentScope) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        const q = await c.query<Row>(
          `select * from booking.tournament_local_attempts where tenant_id=$1 and actor_user_id=$2 and tournament_id=$3 and state='COMPLETED' and owner_command->>'action'='JOIN' and receipt->'operation'->>'outcome'='REGISTERED' order by created_at desc,id desc limit 1`,
          [s.tenantId, s.userId, s.tournamentId],
        );
        return q.rows[0] ? await decode(q.rows[0]) : null;
      });
    },
    begin(
      a: TournamentActor,
      tournamentId: string,
      keyHash: string,
      request: TournamentLocalInput,
      ctx: TournamentIdentity,
      date: string,
    ) {
      return withTenantTransaction(pool, a.tenantId, async (c) => {
        const s = { tenantId: a.tenantId, userId: a.userId, tournamentId };
        // Per-actor row lock serializes different keys and original JOIN/LEAVE selection.
        await c.query('select id from identity.users where tenant_id=$1 and id=$2 for update', [
          a.tenantId,
          a.userId,
        ]);
        const previous = await row(c, s, { keyHash }, true);
        if (previous) {
          if (JSON.stringify(previous.request) !== JSON.stringify(request))
            throw new TournamentLocalError('TOURNAMENT_LOCAL_KEY_CONFLICT', 409);
          return previous;
        }
        const fresh = await identity(c, a);
        if (!fresh || !sameTournamentIdentity(fresh, ctx))
          throw new TournamentLocalError('TOURNAMENT_LOCAL_IDENTITY_UNAVAILABLE', 403);
        const pending = await c.query(
          "select id from booking.tournament_local_attempts where tenant_id=$1 and actor_user_id=$2 and tournament_id=$3 and state<>'COMPLETED'",
          [a.tenantId, a.userId, tournamentId],
        );
        if (pending.rows.length) throw new TournamentLocalError('TOURNAMENT_LOCAL_PENDING', 409);
        const original =
          request.action === 'LEAVE'
            ? await row(c, s, { id: request.originalJoinOperationId! }, true)
            : null;
        if (
          request.action === 'LEAVE' &&
          (!original ||
            original.receipt?.operation.outcome !== 'REGISTERED' ||
            original.request.action !== 'JOIN' ||
            !sameTournamentIdentity(original.identity, ctx))
        )
          throw new TournamentLocalError('TOURNAMENT_LOCAL_ORIGINAL_REQUIRED', 409);
        const { randomUUID } = await import('node:crypto');
        const id = randomUUID();
        const command = parseTournamentCommand({
          schemaVersion: 1,
          action: request.action,
          tournamentId,
          date: original?.command.date ?? date,
          ...(original ? { originalJoinOperationId: original.ownerOperationId } : {}),
        });
        const ownerId = await tournamentOwnerOperationId(
          ctx.providerTenantKey,
          ctx.providerClientId,
          tournamentOwnerKey(id),
          tournamentId,
        );
        const q = await c.query<Row>(
          `insert into booking.tournament_local_attempts(tenant_id,id,actor_user_id,tournament_id,key_sha256,request,request_hash,owner_command,owner_operation_id,provider_tenant_key,provider_client_id,provider_mapping_id,original_join_id,authority_hash,state) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,'READY') returning *`,
          [
            a.tenantId,
            id,
            a.userId,
            tournamentId,
            keyHash,
            JSON.stringify(request),
            await tournamentDigest('lk2-tournament-request:v1', { tournamentId, ...request }),
            JSON.stringify(command),
            ownerId,
            ctx.providerTenantKey,
            ctx.providerClientId,
            ctx.providerMappingId,
            original?.id ?? null,
            await tournamentDigest('lk2-tournament-authority:v1', [
              id,
              a.tenantId,
              a.userId,
              command,
              ctx.providerTenantKey,
              ctx.providerClientId,
              ctx.providerMappingId,
              original?.id ?? null,
            ]),
          ],
        );
        const x = await decode(q.rows[0]!);
        await event(c, a, x, 'tournament.local.prepared');
        return x;
      });
    },
    claim(a: TournamentActor, s: TournamentScope, id: string): Promise<string | null> {
      return withTenantTransaction(pool, a.tenantId, async (c) => {
        await c.query('select id from identity.users where tenant_id=$1 and id=$2 for update', [
          a.tenantId,
          a.userId,
        ]);
        const x = await row(c, s, { id }, true);
        if (!x) return null;
        const ctx = await identity(c, a);
        if (!ctx || !sameTournamentIdentity(ctx, x.identity))
          throw new TournamentLocalError('TOURNAMENT_LOCAL_IDENTITY_UNAVAILABLE', 403);
        if (x.state === 'COMPLETED') return null;
        const { randomUUID } = await import('node:crypto');
        const token = randomUUID();
        const q = await c.query(
          `update booking.tournament_local_attempts set state='DISPATCHED',dispatch_started_at=coalesce(dispatch_started_at,now()),lease_token=$4,lease_until=now()+interval '30 seconds',updated_at=now() where tenant_id=$1 and actor_user_id=$2 and id=$3 and state<>'COMPLETED' and (lease_until is null or lease_until<=now()) returning id`,
          [a.tenantId, a.userId, id, token],
        );
        if (!q.rows.length) return null;
        await event(c, a, { ...x, state: 'DISPATCHED' }, 'tournament.local.dispatch');
        return token;
      });
    },
    complete(
      a: TournamentActor,
      s: TournamentScope,
      id: string,
      token: string,
      receipt: TournamentOwnerReceipt,
    ) {
      return withTenantTransaction(pool, a.tenantId, async (c) => {
        const x = await row(c, s, { id }, true);
        if (!x) throw new TournamentLocalError();
        const r = parseTournamentReceipt(receipt, x.command, x.ownerOperationId);
        const hash = await tournamentDigest('lk2-tournament-receipt:v1', r.operation);
        if (x.receipt) {
          if ((await tournamentDigest('lk2-tournament-receipt:v1', x.receipt.operation)) !== hash)
            throw new TournamentLocalError('TOURNAMENT_LOCAL_RECEIPT_CONFLICT', 409);
          return x;
        }
        const q = await c.query<Row>(
          `update booking.tournament_local_attempts set state='COMPLETED',receipt=$5::jsonb,receipt_hash=$6,lease_token=null,lease_until=null,updated_at=now() where tenant_id=$1 and actor_user_id=$2 and id=$3 and lease_token=$4 and state='DISPATCHED' returning *`,
          [a.tenantId, a.userId, id, token, JSON.stringify(r), hash],
        );
        if (!q.rows[0]) return await row(c, s, { id });
        const done = await decode(q.rows[0]);
        await event(c, a, done, 'tournament.local.completed');
        return done;
      });
    },
  };
}
export type TournamentLocalRepository = ReturnType<typeof createTournamentLocalRepository>;
