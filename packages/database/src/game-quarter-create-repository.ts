import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  QuarterCreateError,
  parseQuarterContext,
  parseQuarterRequest,
  parseQuarterAdmission,
  parseQuarterReceipt,
  qcAdmissionHash,
  qcHash,
  qcEqual,
  qcDraftId,
  qcOperationId,
  type QuarterContext,
  type QuarterInput,
  type QuarterRequest,
  type QuarterAdmission,
  type QuarterReceipt,
  type QuarterRejection,
} from '@phub/domain/quarter-create';
import { withTenantTransaction } from './connection.js';
import { resolveGameCreateLocationBinding } from './game-create-location-binding-repository.js';
export interface QuarterScope {
  tenantId: string;
  userId: string;
  keySha256: string;
  idempotencyKey: string;
}
export interface QuarterActor {
  tenantKey: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  correlationId: string;
}
export type QuarterState =
  | 'PREPARING'
  | 'PREPARED'
  | 'DISPATCH_STARTED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'EXPIRED_NOT_DISPATCHED'
  | 'REFUSED_NOT_DISPATCHED';
export interface QuarterAttempt {
  id: string;
  draftId: string;
  request: QuarterRequest;
  context: QuarterContext | null;
  state: QuarterState;
  admission: QuarterAdmission | null;
  admissionHash: string | null;
  receipt: QuarterReceipt | QuarterRejection | null;
  gameId: string | null;
  leaseToken: string | null;
}
interface QuarterRow {
  id: string;
  draft_id: string;
  request: unknown;
  context: unknown;
  state: QuarterState;
  admission: unknown;
  admission_hash: string | null;
  receipt: unknown;
  game_id: string | null;
  lease_token: string | null;
  request_hash: string;
  station_id: string;
  court_id: string;
  starts_at: Date | string;
}
type CommandFence = { id: string; command_type: string; request_hash: string };
async function read(c: PoolClient, s: QuarterScope, lock = false): Promise<QuarterAttempt | null> {
  const r = await c.query<QuarterRow>(
    `select * from games.quarter_create_attempts where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3${lock ? ' for update' : ''}`,
    [s.tenantId, s.userId, s.keySha256],
  );
  if (r.rows.length !== 1) return null;
  const row = r.rows[0]!;
  const fence = await c.query<CommandFence>(
    `select id,command_type,request_hash from games.command_idempotency where tenant_id=$1 and principal_key=$2 and idempotency_key=$3`,
    [s.tenantId, `user:${s.userId}`, s.idempotencyKey],
  );
  if (
    fence.rows.length !== 1 ||
    fence.rows[0]!.id !== row.id ||
    fence.rows[0]!.command_type !== 'game.quarter-create.v1' ||
    'sha256:' + fence.rows[0]!.request_hash !== row.request_hash
  )
    throw new QuarterCreateError();
  const request = parseQuarterRequest(row.request),
    admission = row.admission ? await parseQuarterAdmission(row.admission) : null;
  if (
    row.id !== (await qcOperationId(s.tenantId, s.userId, s.keySha256)) ||
    row.draft_id !== request.target.draftId ||
    row.draft_id !== (await qcDraftId(s.tenantId, s.userId, s.keySha256)) ||
    row.request_hash !== (await qcHash(JSON.stringify(request))) ||
    row.station_id !== request.target.stationId ||
    row.court_id !== request.target.courtId ||
    new Date(row.starts_at).toISOString() !== request.target.startsAt
  )
    throw new QuarterCreateError();
  if (
    admission &&
    ((await qcAdmissionHash(admission)) !== row.admission_hash ||
      !qcEqual({ ...admission, preparation: undefined }, { ...request, preparation: undefined }) ||
      admission.preparation.actor.tenantId !== s.tenantId ||
      admission.preparation.actor.userId !== s.userId ||
      admission.preparation.idempotencyKeySha256 !== s.keySha256 ||
      admission.preparation.operationId !== row.id)
  )
    throw new QuarterCreateError();
  const context = row.context ? parseQuarterContext(row.context) : null;
  if (admission) {
    const p = admission.preparation;
    if (
      !qcEqual(context, {
        providerClientId: p.actor.providerClientId,
        providerMappingId: p.actor.providerMappingId,
        providerClientSubscriptionId: p.subscription.providerClientSubscriptionId,
        stationMappingId: p.target.stationMappingId,
        courtMappingId: p.target.courtMappingId,
        mappingVersion: p.target.mappingVersion,
        providerStationId: p.target.providerStationId,
        providerRoomId: p.target.providerRoomId,
      })
    )
      throw new QuarterCreateError();
  }
  const receipt =
    row.receipt && admission
      ? await parseQuarterReceipt(row.receipt, admission, row.state === 'REJECTED')
      : null;
  return {
    id: row.id,
    draftId: row.draft_id,
    request,
    context,
    state: row.state,
    admission,
    admissionHash: row.admission_hash,
    receipt,
    gameId: row.game_id,
    leaseToken: row.lease_token,
  };
}
async function audit(
  c: PoolClient,
  s: QuarterScope,
  id: string,
  correlationId: string,
  state: string,
) {
  const eventId = randomUUID(),
    payload = JSON.stringify({ operationId: id, state });
  if (['CONFIRMED', 'REJECTED', 'EXPIRED_NOT_DISPATCHED', 'REFUSED_NOT_DISPATCHED'].includes(state))
    await c.query(
      `update games.command_idempotency set state=$3,result_payload=$4::jsonb,error_code=$5,completed_at=clock_timestamp() where tenant_id=$1 and id=$2 and command_type='game.quarter-create.v1' and state='IN_PROGRESS'`,
      [
        s.tenantId,
        id,
        state === 'CONFIRMED' ? 'COMPLETED' : 'FAILED',
        payload,
        state === 'CONFIRMED'
          ? null
          : state === 'REJECTED'
            ? 'GAME_QUARTER_CREATE_REJECTED'
            : 'GAME_QUARTER_CREATE_NOT_DISPATCHED',
      ],
    );

  await c.query(
    `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,result,correlation_id,new_value) values($1,$2,'GAME_QUARTER_CREATE_STATE','GAME_CREATE_OPERATION',$3,'SUCCESS',$4,$5::jsonb)`,
    [s.tenantId, s.userId, id, correlationId, payload],
  );
  // Audit-only namespace. Never emits game/roster/enrollment notifications from draft custody.
  await c.query(
    `insert into audit.outbox_events(id,tenant_id,event_type,aggregate_id,correlation_id,payload,occurred_at) values($1,$2,'audit.game-quarter-create.state.v1',$3,$4,$5::jsonb,now())`,
    [eventId, s.tenantId, id, correlationId, payload],
  );
}
async function identity(c: PoolClient, a: QuarterActor, subscriptionId: string) {
  const r = await c.query<
    Pick<QuarterContext, 'providerClientId' | 'providerMappingId' | 'providerClientSubscriptionId'>
  >(
    `select p.external_id as "providerClientId",p.id as "providerMappingId",s.external_id as "providerClientSubscriptionId" from identity.refresh_sessions session join identity.users u on u.tenant_id=session.tenant_id and u.id=session.user_id and u.status='ACTIVE' join identity.tenants t on t.id=u.tenant_id and t.active join integration.identity_provider_bindings b on b.tenant_id=u.tenant_id and b.provider='VIVA' and b.provider_tenant_key='iSkq6G' join integration.external_entity_map p on p.tenant_id=u.tenant_id and p.internal_id=u.id and p.external_system='VIVA' and p.entity_type='viva_profile' and p.sync_status='synced' and p.sync_error_code is null and p.last_synced_at is not null join integration.external_entity_map s on s.tenant_id=u.tenant_id and s.internal_id=$4 and s.external_system='VIVA' and s.entity_type='subscription' and s.sync_status='synced' and s.sync_error_code is null and s.last_synced_at is not null where session.tenant_id=$1 and session.user_id=$2 and session.id=$3 and session.revoked_at is null and session.rotated_at is null and session.expires_at>clock_timestamp() limit 2`,
    [a.tenantId, a.userId, a.sessionId, subscriptionId],
  );
  return r.rows.length === 1
    ? (r.rows[0] as Pick<
        QuarterContext,
        'providerClientId' | 'providerMappingId' | 'providerClientSubscriptionId'
      >)
    : null;
}
export function createQuarterCreateRepository(pool: Pool) {
  return {
    async ready() {
      try {
        return (
          (
            await pool.query<{ ready: boolean }>(
              "select to_regclass('games.quarter_create_attempts') is not null as ready",
            )
          ).rows[0]?.ready === true
        );
      } catch {
        return false;
      }
    },
    async commandRead(s: QuarterScope) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `game-command:${s.tenantId}:user:${s.userId}:${s.idempotencyKey}`,
        ]);
        const old = await c.query<CommandFence>(
          `select command_type from games.command_idempotency where tenant_id=$1 and principal_key=$2 and idempotency_key=$3 for update`,
          [s.tenantId, `user:${s.userId}`, s.idempotencyKey],
        );
        if (old.rows.length && old.rows[0]!.command_type !== 'game.quarter-create.v1')
          throw new QuarterCreateError('GAME_QUARTER_CREATE_KEY_CONFLICT', 409);
        const a = await read(c, s);
        if (old.rows.length && !a) throw new QuarterCreateError();
        return a;
      });
    },
    async locations(tenantId: string) {
      return withTenantTransaction(pool, tenantId, async (c) => {
        await c.query("set local statement_timeout='3000ms'");
        const rows = await c.query<{
          station_id: string;
          court_id: string;
          station_title: string;
          court_name: string;
        }>(
          `select b.station_id,b.court_id,p.title station_title,min(g.court_name) court_name from integration.game_create_location_bindings b join locations.profiles p on p.tenant_id=b.tenant_id and p.id=b.station_id and p.publication_status='PUBLISHED' join games.games g on g.tenant_id=b.tenant_id and g.station_id=b.station_id and g.court_id=b.court_id and nullif(trim(g.court_name),'') is not null where b.tenant_id=$1 and b.state='ACTIVE' and b.expires_at>clock_timestamp() group by b.station_id,b.court_id,p.title having count(distinct trim(g.court_name))=1 order by b.station_id,b.court_id limit 26`,
          [tenantId],
        );
        if (rows.rows.length > 25) throw new QuarterCreateError();
        const items = [];
        for (const r of rows.rows) {
          const binding = await resolveGameCreateLocationBinding(c, {
            tenantId,
            stationId: r.station_id,
            courtId: r.court_id,
          });
          if (binding)
            items.push({
              stationId: r.station_id,
              courtId: r.court_id,
              stationTitle: r.station_title,
              courtName: r.court_name,
            });
        }
        return { items };
      });
    },
    async expirePrepared(s: QuarterScope, correlationId: string) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        const r = await c.query<{ id: string }>(
          `update games.quarter_create_attempts set state='EXPIRED_NOT_DISPATCHED',updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='PREPARED' and dispatch_started_at is null and expires_at<=clock_timestamp() returning id`,
          [s.tenantId, s.userId, s.keySha256],
        );
        if (r.rows[0]) await audit(c, s, r.rows[0].id, correlationId, 'EXPIRED_NOT_DISPATCHED');
        return read(c, s);
      });
    },
    identity: (a: QuarterActor, subscriptionId: string) =>
      withTenantTransaction(pool, a.tenantId, (c) => identity(c, a, subscriptionId)),
    context: (a: QuarterActor, q: QuarterInput) =>
      withTenantTransaction(pool, a.tenantId, async (c) => {
        const actor = await identity(c, a, q.subscriptionId);
        if (!actor) return null;
        const location = await resolveGameCreateLocationBinding(c, {
          tenantId: a.tenantId,
          stationId: q.stationId,
          courtId: q.courtId,
        });
        return location
          ? {
              ...actor,
              stationMappingId: location.id,
              courtMappingId: location.court_mapping_id,
              mappingVersion: `create-location:${location.revision}:${location.evidence_digest}`,
              providerStationId: location.provider_studio_id,
              providerRoomId: location.provider_room_id,
            }
          : null;
      }),
    read: (s: QuarterScope) => withTenantTransaction(pool, s.tenantId, (c) => read(c, s)),
    async begin(
      s: QuarterScope,
      q: QuarterInput,
      context: QuarterContext | null,
      correlationId: string,
      refuseAbsent = false,
    ) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `game-command:${s.tenantId}:user:${s.userId}:${s.idempotencyKey}`,
        ]);
        const id = await qcOperationId(s.tenantId, s.userId, s.keySha256),
          draftId = await qcDraftId(s.tenantId, s.userId, s.keySha256),
          request: QuarterRequest = {
            contractVersion: 1,
            action: 'CREATE_GAME',
            subscriptionId: q.subscriptionId,
            target: {
              draftId,
              expectedRevision: 1,
              stationId: q.stationId,
              courtId: q.courtId,
              startsAt: q.startsAt,
              durationMinutes: 60,
            },
          };
        const hash = await qcHash(JSON.stringify(request));
        const old = await c.query<CommandFence>(
          `select id,command_type,request_hash from games.command_idempotency where tenant_id=$1 and principal_key=$2 and idempotency_key=$3 for update`,
          [s.tenantId, `user:${s.userId}`, s.idempotencyKey],
        );
        if (old.rows.length) {
          if (
            old.rows[0]!.id !== id ||
            old.rows[0]!.command_type !== 'game.quarter-create.v1' ||
            old.rows[0]!.request_hash !== hash.slice(7)
          )
            throw new QuarterCreateError('GAME_QUARTER_CREATE_KEY_CONFLICT', 409);
          const existing = await read(c, s);
          if (!existing) throw new QuarterCreateError();
          return existing;
        }
        if (!context && !refuseAbsent) throw new QuarterCreateError();
        if (context) context = parseQuarterContext(context);
        await c.query(
          `insert into games.command_idempotency(tenant_id,id,actor_user_id,principal_key,idempotency_key,command_type,request_hash,state,error_code,completed_at) values($1,$2,$3,$4,$5,'game.quarter-create.v1',$6,$7,$8,case when $7='FAILED' then clock_timestamp() else null end)`,
          [
            s.tenantId,
            id,
            s.userId,
            `user:${s.userId}`,
            s.idempotencyKey,
            hash.slice(7),
            refuseAbsent ? 'FAILED' : 'IN_PROGRESS',
            refuseAbsent ? 'GAME_QUARTER_CREATE_NOT_DISPATCHED' : null,
          ],
        );
        const r = await c.query<{ id: string }>(
          `insert into games.quarter_create_attempts(tenant_id,id,draft_id,actor_user_id,key_sha256,request_hash,request,context,station_id,court_id,starts_at,state) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12) on conflict do nothing returning id`,
          [
            s.tenantId,
            id,
            draftId,
            s.userId,
            s.keySha256,
            hash,
            JSON.stringify(request),
            context ? JSON.stringify(context) : null,
            q.stationId,
            q.courtId,
            q.startsAt,
            refuseAbsent ? 'REFUSED_NOT_DISPATCHED' : 'PREPARING',
          ],
        );
        const a = await read(c, s);
        if (!a || !qcEqual(a.request, request))
          throw new QuarterCreateError('GAME_QUARTER_CREATE_KEY_CONFLICT', 409);
        if (r.rowCount === 1)
          await audit(
            c,
            s,
            id,
            correlationId,
            refuseAbsent ? 'REFUSED_NOT_DISPATCHED' : 'PREPARING',
          );
        return a;
      });
    },
    async claimPreparation(s: QuarterScope) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        const token = randomUUID();
        const r = await c.query<{ id: string }>(
          `update games.quarter_create_attempts set lease_token=$4,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='PREPARING' and dispatch_started_at is null and (lease_until is null or lease_until<=clock_timestamp()) returning id`,
          [s.tenantId, s.userId, s.keySha256, token],
        );
        return r.rowCount === 1 ? token : null;
      });
    },
    async prepared(s: QuarterScope, token: string, raw: QuarterAdmission, correlationId: string) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        const a = await read(c, s, true),
          q = await parseQuarterAdmission(raw);
        if (
          !a ||
          !qcEqual(a.request, {
            contractVersion: q.contractVersion,
            action: q.action,
            subscriptionId: q.subscriptionId,
            target: q.target,
          }) ||
          q.preparation.operationId !== a.id ||
          q.preparation.actor.tenantId !== s.tenantId ||
          q.preparation.actor.userId !== s.userId ||
          q.preparation.idempotencyKeySha256 !== s.keySha256
        )
          throw new QuarterCreateError();
        const p = q.preparation,
          expected = {
            providerClientId: p.actor.providerClientId,
            providerMappingId: p.actor.providerMappingId,
            providerClientSubscriptionId: p.subscription.providerClientSubscriptionId,
            stationMappingId: p.target.stationMappingId,
            courtMappingId: p.target.courtMappingId,
            mappingVersion: p.target.mappingVersion,
            providerStationId: p.target.providerStationId,
            providerRoomId: p.target.providerRoomId,
          };
        if (!qcEqual(expected, a.context)) throw new QuarterCreateError();
        const r = await c.query<{ id: string }>(
          `update games.quarter_create_attempts set admission=$5::jsonb,admission_hash=$6,expires_at=$7,state='PREPARED',lease_token=null,lease_until=null,updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='PREPARING' and lease_token=$4 and lease_until>clock_timestamp() and dispatch_started_at is null returning id`,
          [
            s.tenantId,
            s.userId,
            s.keySha256,
            token,
            JSON.stringify(q),
            await qcAdmissionHash(q),
            p.expiresAt,
          ],
        );
        if (r.rowCount === 1) await audit(c, s, a.id, correlationId, 'PREPARED');
        return read(c, s);
      });
    },
    async refusePreparation(s: QuarterScope, token: string, correlationId: string) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        const r = await c.query<{ id: string }>(
          `update games.quarter_create_attempts set state='REFUSED_NOT_DISPATCHED',lease_token=null,lease_until=null,updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='PREPARING' and dispatch_started_at is null and lease_token=$4 and lease_until>clock_timestamp() returning id`,
          [s.tenantId, s.userId, s.keySha256, token],
        );
        if (r.rows[0]) await audit(c, s, r.rows[0].id, correlationId, 'REFUSED_NOT_DISPATCHED');
        return read(c, s);
      });
    },
    async claimDispatch(s: QuarterScope, correlationId: string) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        const a = await read(c, s, true);
        if (!a) return null;
        const expired = await c.query(
          `update games.quarter_create_attempts set state='EXPIRED_NOT_DISPATCHED',updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='PREPARED' and dispatch_started_at is null and expires_at<=clock_timestamp() returning id`,
          [s.tenantId, s.userId, s.keySha256],
        );
        if (expired.rowCount === 1) {
          await audit(c, s, a.id, correlationId, 'EXPIRED_NOT_DISPATCHED');
          return null;
        }
        const token = randomUUID(),
          r = await c.query(
            `update games.quarter_create_attempts set state='DISPATCH_STARTED',dispatch_started_at=coalesce(dispatch_started_at,clock_timestamp()),lease_token=$4,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and ((state='PREPARED' and expires_at>clock_timestamp()) or(state='DISPATCH_STARTED' and (lease_until is null or lease_until<=clock_timestamp()))) returning id`,
            [s.tenantId, s.userId, s.keySha256, token],
          );
        if (r.rowCount !== 1) return null;
        await audit(c, s, a.id, correlationId, 'DISPATCH_STARTED');
        return {
          attempt: (await read(c, s))!,
          token,
          recoveryOnly: a.state === 'DISPATCH_STARTED',
        };
      });
    },
    async complete(
      s: QuarterScope,
      token: string,
      raw: QuarterReceipt | QuarterRejection,
      rejected: boolean,
      correlationId: string,
    ) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        const a = await read(c, s, true);
        if (!a?.admission) return null;
        const receipt = await parseQuarterReceipt(raw, a.admission, rejected);
        if (a.receipt) {
          if (!qcEqual(a.receipt, receipt)) throw new QuarterCreateError();
          return a;
        }
        const state = rejected ? 'REJECTED' : 'CONFIRMED',
          r = await c.query(
            `update games.quarter_create_attempts set state=$5,receipt=$6::jsonb,lease_token=null,lease_until=null,updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='DISPATCH_STARTED' and lease_token=$4 and dispatch_started_at is not null returning id`,
            [s.tenantId, s.userId, s.keySha256, token, state, JSON.stringify(receipt)],
          );
        if (r.rowCount === 1) await audit(c, s, a.id, correlationId, state);
        return read(c, s);
      });
    },
    async project(s: QuarterScope, mutate: boolean) {
      return withTenantTransaction(pool, s.tenantId, async (c) => {
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `legacy-game-import:${s.tenantId}`,
        ]);
        const a = await read(c, s, mutate);
        if (
          a?.state !== 'CONFIRMED' ||
          !a.context ||
          !a.receipt ||
          !('providerExerciseId' in a.receipt)
        )
          return null;
        const maps = await c.query<{
          internal_id: string;
          external_system: string;
          entity_type: string;
        }>(
          `select internal_id,external_system,entity_type from integration.external_entity_map where tenant_id=$1 and external_id=$2 and ((external_system='VIVA' and entity_type='exercise') or(external_system='LK_LEGACY_SNAPSHOT' and entity_type='game')) and sync_status='synced' and sync_error_code is null and last_synced_at is not null for share`,
          [s.tenantId, a.receipt.providerExerciseId],
        );
        if (
          maps.rows.length !== 2 ||
          !maps.rows.some((r) => r.external_system === 'VIVA' && r.entity_type === 'exercise') ||
          !maps.rows.some(
            (r) => r.external_system === 'LK_LEGACY_SNAPSHOT' && r.entity_type === 'game',
          )
        )
          return null;
        const resolve = async (id: string) => {
          const visited = new Set<string>();
          for (let n = 0; n < 16; n++) {
            if (visited.has(id)) return null;
            visited.add(id);
            const r = await c.query<{ target_game_id: string }>(
              'select target_game_id from integration.legacy_game_merge_redirects where tenant_id=$1 and source_game_id=$2',
              [s.tenantId, id],
            );
            if (!r.rows.length) return id;
            if (r.rows.length !== 1) return null;
            id = r.rows[0]!.target_game_id;
          }
          return null;
        };
        const ids = await Promise.all(maps.rows.map((r) => resolve(r.internal_id)));
        if (!ids[0] || ids[0] !== ids[1] || (a.gameId && (await resolve(a.gameId)) !== ids[0]))
          return null;
        const t = a.request.target,
          r = await c.query(
            `select g.id from games.games g join games.participations p on p.tenant_id=g.tenant_id and p.game_id=g.id and p.user_id=$3 and p.role='ORGANIZER' and p.state in ('ACTIVE','LEFT','REMOVED') join integration.external_entity_map profile on profile.tenant_id=g.tenant_id and profile.internal_id=$3 and profile.id=$9 and profile.external_system='VIVA' and profile.entity_type='viva_profile' and profile.external_id=$10 and profile.sync_status='synced' and profile.sync_error_code is null where g.tenant_id=$1 and g.id=$2 and g.organizer_user_id=$3 and g.station_id=$4 and g.court_id=$5 and g.starts_at=$6 and g.ends_at=$7 and g.capacity=4 and g.lifecycle_state=any($8::text[]) for share of g,p,profile`,
            [
              s.tenantId,
              ids[0],
              s.userId,
              t.stationId,
              t.courtId,
              t.startsAt,
              a.admission!.preparation.target.endsAt,
              ['SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED'],
              a.context.providerMappingId,
              a.context.providerClientId,
            ],
          );
        if (r.rows.length !== 1) return null;
        if (mutate)
          await c.query(
            `update games.quarter_create_attempts set game_id=$4,updated_at=clock_timestamp() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='CONFIRMED' and game_id is not distinct from $5::uuid`,
            [s.tenantId, s.userId, s.keySha256, ids[0], a.gameId],
          );
        return ids[0];
      });
    },
  };
}
export type QuarterCreateRepository = ReturnType<typeof createQuarterCreateRepository>;
