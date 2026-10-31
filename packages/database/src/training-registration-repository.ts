import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { withTenantTransaction } from './connection.js';
import {
  TrainingRegistrationError,
  parseTrainingAuthority,
  parseTrainingReceipt,
  trainingHash,
  trainingOperationId,
  type TrainingAuthority,
  type TrainingReceipt,
} from '@phub/domain/training-registration';
export type TrainingAttemptState =
  | 'PREPARING'
  | 'PREPARED'
  | 'DISPATCH_STARTED'
  | 'CONFIRMED'
  | 'EXPIRED_NOT_DISPATCHED'
  | 'REJECTED_NOT_DISPATCHED';
export interface TrainingScope {
  tenantId: string;
  userId: string;
  trainingId: string;
  keySha256: string;
}
export interface TrainingPublicRequest {
  trainingId: string;
  dateHint: string;
  subscriptionId: string;
}
export interface TrainingAttempt {
  id: string;
  state: TrainingAttemptState;
  request: TrainingPublicRequest;
  authority: TrainingAuthority | null;
  authoritySha256: string | null;
  receipt: TrainingReceipt | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
}
interface Row extends QueryResultRow {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  training_id: string;
  subscription_id: string;
  date_hint: string | Date;
  key_sha256: string;
  public_request_hash: string;
  authority: unknown;
  authority_sha256: string | null;
  preparation_expires_at: Date | string | null;
  state: TrainingAttemptState;
  dispatch_started_at: Date | string | null;
  lease_token: string | null;
  lease_until: Date | string | null;
  receipt: unknown;
  receipt_sha256: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
const timestamp = (v: Date | string): string => new Date(v).toISOString();
export const trainingPublicRequestHash = (v: TrainingPublicRequest): Promise<string> =>
  trainingHash(
    'training-public-registration:v1\0' +
      JSON.stringify({
        trainingId: v.trainingId,
        dateHint: v.dateHint,
        subscriptionId: v.subscriptionId,
      }),
  );
async function decode(r: Row): Promise<TrainingAttempt> {
  const request = {
    trainingId: r.training_id,
    subscriptionId: r.subscription_id,
    dateHint: r.date_hint instanceof Date ? r.date_hint.toISOString().slice(0, 10) : r.date_hint,
  };
  if (
    (await trainingOperationId(r.tenant_id, r.actor_user_id, r.key_sha256)) !== r.id ||
    (await trainingPublicRequestHash(request)) !== r.public_request_hash
  )
    throw new TrainingRegistrationError('TRAINING_REGISTRATION_STORED_EVIDENCE_INVALID');
  const a = r.authority === null ? null : await parseTrainingAuthority(r.authority),
    p = a?.request.preparation;
  if (
    ['PREPARING', 'REJECTED_NOT_DISPATCHED'].includes(r.state) !== (a === null) ||
    (!a && (r.authority_sha256 !== null || r.preparation_expires_at !== null)) ||
    (a &&
      p &&
      (p.operationId !== r.id ||
        p.actor.tenantId !== r.tenant_id ||
        p.actor.userId !== r.actor_user_id ||
        p.target.id !== request.trainingId ||
        p.subscription.id !== request.subscriptionId ||
        p.target.dateHint !== request.dateHint ||
        a.keySha256 !== r.key_sha256 ||
        !r.preparation_expires_at ||
        timestamp(r.preparation_expires_at) !== p.expiresAt ||
        (await trainingHash(JSON.stringify(a))) !== r.authority_sha256))
  )
    throw new TrainingRegistrationError('TRAINING_REGISTRATION_STORED_EVIDENCE_INVALID');
  const receipt = r.receipt === null ? null : a ? await parseTrainingReceipt(r.receipt, a) : null;
  if (
    (r.state === 'CONFIRMED') !== Boolean(receipt) ||
    (receipt && (await trainingHash(JSON.stringify(receipt))) !== r.receipt_sha256) ||
    (['EXPIRED_NOT_DISPATCHED', 'REJECTED_NOT_DISPATCHED'].includes(r.state) &&
      r.dispatch_started_at !== null)
  )
    throw new TrainingRegistrationError('TRAINING_REGISTRATION_STORED_EVIDENCE_INVALID');
  return {
    id: r.id,
    state: r.state,
    request,
    authority: a,
    authoritySha256: r.authority_sha256,
    receipt,
    leaseToken: r.lease_token,
    leaseUntil: r.lease_until === null ? null : timestamp(r.lease_until),
    createdAt: timestamp(r.created_at),
    updatedAt: timestamp(r.updated_at),
  };
}
async function read(
  client: PoolClient,
  s: TrainingScope,
  lock = false,
): Promise<TrainingAttempt | null> {
  const r = await client.query<Row>(
    `select * from booking.training_registration_attempts where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 ${lock ? 'for update' : ''}`,
    [s.tenantId, s.userId, s.keySha256],
  );
  if (r.rows.length !== 1) return null;
  const a = await decode(r.rows[0]!);
  if (a.request.trainingId !== s.trainingId)
    throw new TrainingRegistrationError('TRAINING_REGISTRATION_KEY_CONFLICT', 409);
  return a;
}
async function event(
  client: PoolClient,
  s: TrainingScope,
  a: TrainingAttempt,
  correlationId: string,
  type: string,
) {
  const payload = {
    operationId: a.id,
    trainingId: s.trainingId,
    userId: s.userId,
    status: a.state,
  };
  await client.query(
    `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,result,correlation_id,new_value) values($1,$2,$3,'TRAINING',$4,'SUCCESS',$5,$6::jsonb)`,
    [
      s.tenantId,
      s.userId,
      type.toUpperCase().replaceAll('.', '_'),
      s.trainingId,
      correlationId,
      JSON.stringify(payload),
    ],
  );
  await client.query(
    `insert into audit.outbox_events(id,tenant_id,event_type,aggregate_id,correlation_id,payload,occurred_at) values($1,$2,$3,$4,$5,$6::jsonb,now())`,
    [randomUUID(), s.tenantId, type, s.trainingId, correlationId, JSON.stringify(payload)],
  );
}
export interface TrainingRegistrationRepository {
  ready(): Promise<boolean>;
  context(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    subscriptionId: string;
  }): Promise<{
    providerClientId: string;
    providerMappingId: string;
    providerClientSubscriptionId: string;
  } | null>;
  read(scope: TrainingScope): Promise<TrainingAttempt | null>;
  begin(
    scope: TrainingScope,
    request: TrainingPublicRequest,
    correlationId: string,
  ): Promise<TrainingAttempt>;
  claimPreparation(
    scope: TrainingScope,
  ): Promise<{ attempt: TrainingAttempt; token: string | null } | null>;
  settlePreparation(
    scope: TrainingScope,
    token: string,
    authority: TrainingAuthority | null,
    correlationId: string,
  ): Promise<TrainingAttempt | null>;
  claim(
    scope: TrainingScope,
    correlationId: string,
  ): Promise<{ attempt: TrainingAttempt; token: string | null; recovery: boolean } | null>;
  complete(
    scope: TrainingScope,
    token: string,
    authoritySha256: string,
    receipt: TrainingReceipt,
    correlationId: string,
  ): Promise<TrainingAttempt | null>;
}
export function createTrainingRegistrationRepository(pool: Pool): TrainingRegistrationRepository {
  return {
    async ready() {
      try {
        const r = await pool.query<{ ready: boolean }>(
          "select to_regclass('booking.training_registration_attempts') is not null as ready",
        );
        return r.rows[0]?.ready === true;
      } catch {
        return false;
      }
    },
    context(input) {
      return withTenantTransaction(pool, input.tenantId, async (c) => {
        const result = await c.query<{
          provider_client_id: string;
          provider_mapping_id: string;
          provider_subscription_id: string;
        }>(
          `select profile.external_id provider_client_id, profile.id provider_mapping_id, sub.external_id provider_subscription_id from identity.refresh_sessions s join identity.users u on u.tenant_id=s.tenant_id and u.id=s.user_id and u.status='ACTIVE' join identity.tenants t on t.id=u.tenant_id and t.active=true join integration.identity_provider_bindings b on b.tenant_id=u.tenant_id and b.provider='VIVA' and b.provider_tenant_key='iSkq6G' join integration.external_entity_map profile on profile.tenant_id=u.tenant_id and profile.internal_id=u.id and profile.external_system='VIVA' and profile.entity_type='viva_profile' and profile.sync_status='synced' and profile.sync_error_code is null and profile.last_synced_at is not null join integration.external_entity_map sub on sub.tenant_id=u.tenant_id and sub.internal_id=$4 and sub.external_system='VIVA' and sub.entity_type='subscription' and sub.sync_status='synced' and sub.sync_error_code is null and sub.last_synced_at is not null where s.tenant_id=$1 and s.user_id=$2 and s.id=$3 and s.revoked_at is null and s.rotated_at is null and s.expires_at>now() limit 2`,
          [input.tenantId, input.userId, input.sessionId, input.subscriptionId],
        );
        const r = result.rows.length === 1 ? result.rows[0] : undefined;
        return r
          ? {
              providerClientId: r.provider_client_id,
              providerMappingId: r.provider_mapping_id,
              providerClientSubscriptionId: r.provider_subscription_id,
            }
          : null;
      });
    },
    read(scope) {
      return withTenantTransaction(pool, scope.tenantId, (c) => read(c, scope));
    },
    begin(scope, request, correlationId) {
      return withTenantTransaction(pool, scope.tenantId, async (c) => {
        const id = await trainingOperationId(scope.tenantId, scope.userId, scope.keySha256),
          hash = await trainingPublicRequestHash(request);
        if (request.trainingId !== scope.trainingId)
          throw new TrainingRegistrationError('TRAINING_REGISTRATION_KEY_CONFLICT', 409);
        const inserted = await c.query(
          `insert into booking.training_registration_attempts(tenant_id,id,actor_user_id,training_id,subscription_id,date_hint,key_sha256,public_request_hash) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning id`,
          [
            scope.tenantId,
            id,
            scope.userId,
            scope.trainingId,
            request.subscriptionId,
            request.dateHint,
            scope.keySha256,
            hash,
          ],
        );
        const a = await read(c, scope);
        if (!a) throw new TrainingRegistrationError('TRAINING_REGISTRATION_ATTEMPT_EXISTS', 409);
        if ((await trainingPublicRequestHash(a.request)) !== hash)
          throw new TrainingRegistrationError('TRAINING_REGISTRATION_KEY_CONFLICT', 409);
        if (inserted.rowCount === 1)
          await event(c, scope, a, correlationId, 'training.registration.preparing.v1');
        return a;
      });
    },
    claimPreparation(scope) {
      return withTenantTransaction(pool, scope.tenantId, async (c) => {
        let a = await read(c, scope, true);
        if (!a) return null;
        const token = randomUUID();
        const result = await c.query(
          `update booking.training_registration_attempts set lease_token=$4,lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() where tenant_id=$1 and id=$2 and actor_user_id=$3 and state='PREPARING' and dispatch_started_at is null and authority is null and (lease_until is null or lease_until<=clock_timestamp()) returning id`,
          [scope.tenantId, a.id, scope.userId, token],
        );
        if (result.rowCount !== 1) return { attempt: a, token: null };
        a = (await read(c, scope))!;
        return { attempt: a, token };
      });
    },
    settlePreparation(scope, token, raw, correlationId) {
      return withTenantTransaction(pool, scope.tenantId, async (c) => {
        const a = await read(c, scope, true);
        if (!a) return null;
        const authority = raw === null ? null : await parseTrainingAuthority(raw);
        if (authority) {
          const p = authority.request.preparation;
          if (
            p.operationId !== a.id ||
            p.actor.tenantId !== scope.tenantId ||
            p.actor.userId !== scope.userId ||
            p.target.id !== a.request.trainingId ||
            p.target.dateHint !== a.request.dateHint ||
            p.subscription.id !== a.request.subscriptionId ||
            authority.keySha256 !== scope.keySha256
          )
            throw new TrainingRegistrationError('TRAINING_REGISTRATION_EVIDENCE_INVALID');
        }
        const r = await c.query(
          `update booking.training_registration_attempts set state=$5,authority=$6::jsonb,authority_sha256=$7,preparation_expires_at=$8,lease_token=null,lease_until=null,completed_at=case when $5='REJECTED_NOT_DISPATCHED' then clock_timestamp() else null end,updated_at=clock_timestamp() where tenant_id=$1 and id=$2 and actor_user_id=$3 and state='PREPARING' and dispatch_started_at is null and authority is null and lease_token=$4 and lease_until>clock_timestamp() returning id`,
          [
            scope.tenantId,
            a.id,
            scope.userId,
            token,
            authority ? 'PREPARED' : 'REJECTED_NOT_DISPATCHED',
            authority ? JSON.stringify(authority) : null,
            authority ? await trainingHash(JSON.stringify(authority)) : null,
            authority?.request.preparation.expiresAt ?? null,
          ],
        );
        if (r.rowCount !== 1) return null;
        const settled = (await read(c, scope))!;
        await event(
          c,
          scope,
          settled,
          correlationId,
          authority ? 'training.registration.prepared.v1' : 'training.registration.rejected.v1',
        );
        return settled;
      });
    },
    claim(scope, correlationId) {
      return withTenantTransaction(pool, scope.tenantId, async (c) => {
        let a = await read(c, scope, true);
        if (!a) return null;
        if (a.state !== 'PREPARED' && a.state !== 'DISPATCH_STARTED')
          return { attempt: a, token: null, recovery: false };
        if (a.state === 'PREPARED') {
          const expiry = await c.query(
            `update booking.training_registration_attempts set state='EXPIRED_NOT_DISPATCHED',completed_at=clock_timestamp(),updated_at=clock_timestamp() where tenant_id=$1 and id=$2 and actor_user_id=$3 and state='PREPARED' and dispatch_started_at is null and preparation_expires_at<=clock_timestamp() returning id`,
            [scope.tenantId, a.id, scope.userId],
          );
          if (expiry.rowCount === 1) {
            a = (await read(c, scope))!;
            await event(c, scope, a, correlationId, 'training.registration.expired.v1');
            return { attempt: a, token: null, recovery: false };
          }
        }
        const recovery = a.state === 'DISPATCH_STARTED',
          token = randomUUID();
        const r = await c.query(
          `update booking.training_registration_attempts set state='DISPATCH_STARTED',dispatch_started_at=coalesce(dispatch_started_at,clock_timestamp()),lease_token=$4,lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() where tenant_id=$1 and id=$2 and actor_user_id=$3 and authority_sha256=$5 and ((state='PREPARED' and dispatch_started_at is null and preparation_expires_at>clock_timestamp()) or(state='DISPATCH_STARTED' and (lease_until is null or lease_until<=clock_timestamp()))) returning id`,
          [scope.tenantId, a.id, scope.userId, token, a.authoritySha256],
        );
        if (r.rowCount !== 1) return { attempt: a, token: null, recovery };
        a = (await read(c, scope))!;
        await event(c, scope, a, correlationId, 'training.registration.dispatch-claimed.v1');
        return { attempt: a, token, recovery };
      });
    },
    complete(scope, token, authoritySha256, raw, correlationId) {
      return withTenantTransaction(pool, scope.tenantId, async (c) => {
        const a = await read(c, scope, true);
        if (!a || !a.authority) return null;
        const receipt = await parseTrainingReceipt(raw, a.authority);
        if (Date.parse(receipt.confirmedAt) > Date.now())
          throw new TrainingRegistrationError('TRAINING_REGISTRATION_EVIDENCE_INVALID');
        if (a.state === 'CONFIRMED') {
          if (JSON.stringify(a.receipt) !== JSON.stringify(receipt))
            throw new TrainingRegistrationError('TRAINING_REGISTRATION_RECEIPT_CONFLICT', 409);
          return a;
        }
        const r = await c.query(
          `update booking.training_registration_attempts set state='CONFIRMED',receipt=$6::jsonb,receipt_sha256=$7,completed_at=clock_timestamp(),lease_token=null,lease_until=null,updated_at=clock_timestamp() where tenant_id=$1 and id=$2 and actor_user_id=$3 and state='DISPATCH_STARTED' and lease_token=$4 and lease_until>clock_timestamp() and authority_sha256=$5 returning id`,
          [
            scope.tenantId,
            a.id,
            scope.userId,
            token,
            authoritySha256,
            JSON.stringify(receipt),
            await trainingHash(JSON.stringify(receipt)),
          ],
        );
        if (r.rowCount !== 1) return null;
        const done = (await read(c, scope))!;
        await event(c, scope, done, correlationId, 'training.registration.confirmed.v1');
        return done;
      });
    },
  };
}
