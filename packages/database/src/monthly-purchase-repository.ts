import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SubscriptionPurchaseConsent } from '@phub/api-contracts';
import {
  MonthlyPurchaseError,
  mpOfferId,
  mpHash,
  mpStable,
  mpUuid,
  mpId,
  mpDigest,
  mpOperationId,
  mpPaymentUrl,
  parseMonthlyOwnerQuote,
  parseMonthlyOwnerReceipt,
  parsePurchaseConsent,
  type MonthlyOwnerQuote,
  type MonthlyOwnerReceipt,
} from '@phub/domain/subscription-purchase';
import { withTenantTransaction } from './connection.js';
export interface MonthlyActor {
  tenantId: string;
  tenantKey: string;
  userId: string;
  sessionId: string;
  correlationId: string;
}
export interface MonthlyIdentity {
  providerClientId: string;
  providerMappingId: string;
}
export interface MonthlyScope {
  tenantId: string;
  userId: string;
  keySha256: string;
}
export type MonthlyState =
  'QUOTING' | 'QUOTED' | 'DISPATCH_STARTED' | 'UNKNOWN' | 'PAYMENT_PENDING' | 'PAID';
export interface MonthlyAttempt {
  id: string;
  state: MonthlyState;
  identity: MonthlyIdentity;
  quote: MonthlyOwnerQuote | null;
  quoteExpiresAt: string | null;
  consent: SubscriptionPurchaseConsent | null;
  receipt: MonthlyOwnerReceipt | null;
}
type Row = {
  id: string;
  state: MonthlyState;
  provider_client_id: string;
  provider_mapping_id: string;
  quote: unknown;
  quote_expires_at: Date | string | null;
  consent: unknown;
  consent_hash: string | null;
  receipt: unknown;
};
const unavailable = () => new MonthlyPurchaseError();
const identityChanged = () =>
  new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_IDENTITY_CHANGED', 409);
function parsed(r: Row): MonthlyAttempt {
  if (!mpUuid(r.id) || !mpId(r.provider_client_id) || !mpUuid(r.provider_mapping_id))
    throw unavailable();
  const quote = r.quote === null ? null : parseMonthlyOwnerQuote(r.quote, r.id),
    consent = r.consent === null ? null : parsePurchaseConsent(r.consent);
  if (
    (consent && mpHash(mpStable(consent)) !== r.consent_hash) ||
    (r.state !== 'QUOTING' && !quote)
  )
    throw unavailable();
  const receipt = r.receipt === null ? null : parseMonthlyOwnerReceipt(r.receipt, quote!);
  if (
    consent &&
    (!quote ||
      consent.expectedRevision !== quote.revision ||
      consent.amountMinor !== quote.amountMinor)
  )
    throw unavailable();
  if (
    r.state === 'PAID'
      ? receipt?.state !== 'PAID'
      : r.state === 'PAYMENT_PENDING'
        ? receipt?.state !== 'PAYMENT_PENDING'
        : r.state === 'UNKNOWN'
          ? receipt !== null && receipt.state !== 'PROVIDER_UNKNOWN'
          : receipt !== null
  )
    throw unavailable();
  return {
    id: r.id,
    state: r.state,
    identity: { providerClientId: r.provider_client_id, providerMappingId: r.provider_mapping_id },
    quote,
    quoteExpiresAt: r.quote_expires_at === null ? null : new Date(r.quote_expires_at).toISOString(),
    consent,
    receipt,
  };
}
async function identity(c: PoolClient, a: MonthlyActor): Promise<MonthlyIdentity | null> {
  const rows = await c.query<MonthlyIdentity>(
    `select p.external_id as "providerClientId",p.id as "providerMappingId"
    from identity.refresh_sessions s
    join identity.users u on u.tenant_id=s.tenant_id and u.id=s.user_id and u.status='ACTIVE'
    join identity.tenants t on t.id=u.tenant_id and t.active
    join integration.identity_provider_bindings b on b.tenant_id=u.tenant_id and b.provider='VIVA' and b.provider_tenant_key='iSkq6G'
    join integration.external_entity_map p on p.tenant_id=u.tenant_id and p.internal_id=u.id and p.external_system='VIVA' and p.entity_type='viva_profile'
      and p.sync_status='synced' and p.sync_error_code is null and p.last_synced_at is not null
    where s.tenant_id=$1 and s.user_id=$2 and s.id=$3 and s.revoked_at is null and s.rotated_at is null and s.expires_at>clock_timestamp()
      and (select count(*) from integration.identity_provider_bindings bx where bx.tenant_id=u.tenant_id and bx.provider='VIVA')=1
      and (select count(*) from integration.external_entity_map f where f.tenant_id=u.tenant_id and f.external_system='VIVA' and f.entity_type='viva_profile' and f.internal_id=u.id)=1
      and (select count(*) from integration.external_entity_map r where r.tenant_id=u.tenant_id and r.external_system='VIVA' and r.entity_type='viva_profile' and r.external_id=p.external_id)=1 limit 2`,
    [a.tenantId, a.userId, a.sessionId],
  );
  const r = rows.rows[0];
  return rows.rows.length === 1 && r && mpId(r.providerClientId) && mpUuid(r.providerMappingId)
    ? r
    : null;
}
async function ensureIdentity(c: PoolClient, a: MonthlyActor, expected?: MonthlyIdentity) {
  const current = await identity(c, a);
  if (!current || (expected && mpStable(current) !== mpStable(expected))) throw identityChanged();
  return current;
}
async function read(c: PoolClient, s: MonthlyScope, lock = false): Promise<MonthlyAttempt | null> {
  const rows = await c.query<Row>(
    `select * from commerce.monthly_purchase_attempts where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3${lock ? ' for update' : ''}`,
    [s.tenantId, s.userId, s.keySha256],
  );
  if (rows.rows.length > 1) throw unavailable();
  const row = rows.rows.length ? parsed(rows.rows[0]!) : null;
  if (row && row.id !== mpOperationId(s.tenantId, s.userId, s.keySha256)) throw unavailable();
  return row;
}
async function audit(c: PoolClient, a: MonthlyActor, id: string, state: MonthlyState) {
  const payload = { operationId: id, offerId: mpOfferId, state };
  await c.query(
    `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,result,correlation_id,new_value)
    values($1,$2,'SUBSCRIPTION_PURCHASE_STATE','SUBSCRIPTION_PURCHASE',$3,'SUCCESS',$4,$5::jsonb)`,
    [a.tenantId, a.userId, id, a.correlationId, payload],
  );
  await c.query(
    `insert into audit.outbox_events(id,tenant_id,event_type,aggregate_id,correlation_id,payload,occurred_at)
    values($1,$2,'audit.subscription-purchase.state.v1',$3,$4,$5::jsonb,now())`,
    [randomUUID(), a.tenantId, id, a.correlationId, payload],
  );
}
export function createMonthlyPurchaseRepository(pool: Pool) {
  const transact = <T>(a: MonthlyActor, s: MonthlyScope, run: (c: PoolClient) => Promise<T>) => {
    if (a.tenantId !== s.tenantId || a.userId !== s.userId || !mpDigest(s.keySha256))
      throw unavailable();
    return withTenantTransaction(pool, a.tenantId, run);
  };
  return {
    async ready() {
      try {
        return (
          (
            await pool.query<{ ready: boolean }>(
              "select to_regclass('commerce.monthly_purchase_attempts') is not null and to_regclass('commerce.monthly_purchase_launches') is not null as ready",
            )
          ).rows[0]?.ready === true
        );
      } catch {
        return false;
      }
    },
    identity(a: MonthlyActor) {
      return withTenantTransaction(pool, a.tenantId, (c) => identity(c, a));
    },
    read(a: MonthlyActor, s: MonthlyScope) {
      return transact(a, s, async (c) => {
        const row = await read(c, s);
        await ensureIdentity(c, a, row?.identity);
        return row;
      });
    },
    begin(a: MonthlyActor, s: MonthlyScope) {
      return transact(a, s, async (c) => {
        if (s.tenantId !== a.tenantId || s.userId !== a.userId || !mpDigest(s.keySha256))
          throw unavailable();
        const current = await ensureIdentity(c, a),
          id = mpOperationId(a.tenantId, a.userId, s.keySha256);
        await c.query(
          `insert into commerce.monthly_purchase_attempts(tenant_id,id,actor_user_id,originating_session_id,key_sha256,offer_id,provider_client_id,provider_mapping_id)
        values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(tenant_id,actor_user_id,key_sha256) do nothing`,
          [
            a.tenantId,
            id,
            a.userId,
            a.sessionId,
            s.keySha256,
            mpOfferId,
            current.providerClientId,
            current.providerMappingId,
          ],
        );
        const row = await read(c, s, true);
        if (!row || mpStable(row.identity) !== mpStable(current)) throw identityChanged();
        return row;
      });
    },
    restartExpiredQuote(a: MonthlyActor, s: MonthlyScope) {
      return transact(a, s, async (c) => {
        const old = await read(c, s, true);
        if (!old) throw unavailable();
        await ensureIdentity(c, a, old.identity);
        if (old.state !== 'QUOTED') return old;
        const updated = await c.query(
          `update commerce.monthly_purchase_attempts set state='QUOTING',quote=null,quote_expires_at=null,updated_at=now() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='QUOTED' and dispatch_started_at is null and quote_expires_at<=clock_timestamp() returning id`,
          [s.tenantId, s.userId, s.keySha256],
        );
        if (updated.rowCount === 1) await audit(c, a, old.id, 'QUOTING');
        return (await read(c, s))!;
      });
    },
    saveQuote(a: MonthlyActor, s: MonthlyScope, q: MonthlyOwnerQuote) {
      return transact(a, s, async (c) => {
        const old = await read(c, s, true);
        if (!old || old.id !== q.operationId) throw unavailable();
        await ensureIdentity(c, a, old.identity);
        if (old.state !== 'QUOTING') return old;
        const quote = parseMonthlyOwnerQuote(q, old.id);
        await c.query(
          `update commerce.monthly_purchase_attempts set state='QUOTED',quote=$4::jsonb,quote_expires_at=clock_timestamp()+interval '120 seconds',updated_at=now()
        where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3`,
          [s.tenantId, s.userId, s.keySha256, quote],
        );
        await audit(c, a, old.id, 'QUOTED');
        return (await read(c, s))!;
      });
    },
    claimDispatch(a: MonthlyActor, s: MonthlyScope, input: SubscriptionPurchaseConsent) {
      return transact(a, s, async (c) => {
        const consent = parsePurchaseConsent(input);
        await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `monthly-purchase:${a.tenantId}:${a.userId}`,
        ]);
        const old = await read(c, s, true);
        if (!old || !old.quote) throw unavailable();
        await ensureIdentity(c, a, old.identity);
        if (old.consent && mpStable(old.consent) !== mpStable(consent))
          throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_KEY_CONFLICT', 409);
        if (old.state !== 'QUOTED') return { attempt: old, claimed: false };
        if (
          consent.expectedRevision !== old.quote.revision ||
          consent.amountMinor !== old.quote.amountMinor
        )
          throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_PRICE_CHANGED', 409);
        const active = await c.query(
          `select id from commerce.monthly_purchase_attempts where tenant_id=$1 and actor_user_id=$2 and state in ('DISPATCH_STARTED','UNKNOWN','PAYMENT_PENDING') limit 1`,
          [a.tenantId, a.userId],
        );
        if (active.rows.length)
          throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_PENDING', 409);
        const result = await c.query(
          `update commerce.monthly_purchase_attempts set state='DISPATCH_STARTED',consent=$4::jsonb,consent_hash=$5,dispatch_started_at=clock_timestamp(),updated_at=now()
        where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='QUOTED' and quote_expires_at>clock_timestamp() returning id`,
          [s.tenantId, s.userId, s.keySha256, consent, mpHash(mpStable(consent))],
        );
        if (result.rowCount !== 1)
          throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_QUOTE_EXPIRED', 409);
        await audit(c, a, old.id, 'DISPATCH_STARTED');
        return { attempt: (await read(c, s))!, claimed: true };
      });
    },
    saveReceipt(a: MonthlyActor, s: MonthlyScope, value: MonthlyOwnerReceipt) {
      return transact(a, s, async (c) => {
        // Preserve an already returned receipt even after session expiry/revocation.
        // Exposure and later calls still require fresh identity; no credentials persist.
        const old = await read(c, s, true);
        if (!old?.quote || !old.consent) throw unavailable();
        const receipt = parseMonthlyOwnerReceipt(value, old.quote);
        if (
          old.receipt &&
          ((old.receipt.providerTransactionId &&
            old.receipt.providerTransactionId !== receipt.providerTransactionId) ||
            (old.receipt.providerSubscriptionId &&
              old.receipt.providerSubscriptionId !== receipt.providerSubscriptionId))
        )
          throw unavailable();
        if (old.state === 'PAID' || mpStable(old.receipt) === mpStable(receipt)) return old;
        const state = receipt.state === 'PROVIDER_UNKNOWN' ? 'UNKNOWN' : receipt.state;
        await c.query(
          `update commerce.monthly_purchase_attempts set state=$4,receipt=$5::jsonb,updated_at=now() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3`,
          [s.tenantId, s.userId, s.keySha256, state, receipt],
        );
        await audit(c, a, old.id, state);
        return (await read(c, s))!;
      });
    },
    markUnknown(a: MonthlyActor, s: MonthlyScope) {
      return transact(a, s, async (c) => {
        const result = await c.query<{ id: string }>(
          `update commerce.monthly_purchase_attempts set state='UNKNOWN',updated_at=now() where tenant_id=$1 and actor_user_id=$2 and key_sha256=$3 and state='DISPATCH_STARTED' returning id`,
          [s.tenantId, s.userId, s.keySha256],
        );
        if (result.rows[0]) await audit(c, a, result.rows[0].id, 'UNKNOWN');
        return read(c, s);
      });
    },
    createLaunch(a: MonthlyActor, s: MonthlyScope) {
      return transact(a, s, async (c) => {
        const old = await read(c, s, true);
        if (!old) throw unavailable();
        await ensureIdentity(c, a, old.identity);
        const r = old.receipt;
        if (
          old.state !== 'PAYMENT_PENDING' ||
          !r ||
          !mpPaymentUrl(r.paymentUrl) ||
          !r.paymentExpiresAt
        )
          throw unavailable();
        const code = a.tenantId + '.' + randomBytes(32).toString('hex');
        await c.query(
          `update commerce.monthly_purchase_launches set used_at=clock_timestamp() where tenant_id=$1 and operation_id=$2 and actor_user_id=$3 and used_at is null`,
          [a.tenantId, old.id, a.userId],
        );
        const inserted = await c.query<{ expires_at: Date }>(
          `insert into commerce.monthly_purchase_launches(tenant_id,id,operation_id,actor_user_id,session_id,code_hash,created_at,expires_at)
        select $1,$2,$3,$4,$5,$6,statement_timestamp(),least(statement_timestamp()+interval '60 seconds',$7::timestamptz) where $7::timestamptz>statement_timestamp()+interval '1 second' returning expires_at`,
          [
            a.tenantId,
            randomUUID(),
            old.id,
            a.userId,
            a.sessionId,
            mpHash(code),
            r.paymentExpiresAt,
          ],
        );
        if (inserted.rows.length !== 1) throw unavailable();
        return {
          contractVersion: 1 as const,
          operationId: old.id,
          launchCode: code,
          expiresAt: inserted.rows[0]!.expires_at.toISOString(),
        };
      });
    },
    consumeLaunch(operationId: string, code: string) {
      const tenantId = code.slice(0, 36);
      if (
        !mpUuid(operationId) ||
        !mpUuid(tenantId) ||
        !/^[-a-f0-9]{36}\.[a-f0-9]{64}$(?![\s\S])/.test(code)
      )
        throw unavailable();
      return withTenantTransaction(pool, tenantId, async (c) => {
        const result = await c.query<{
          actor_user_id: string;
          session_id: string;
          key_sha256: string;
          tenant_key: string;
          id: string;
        }>(
          `select l.id,l.actor_user_id,l.session_id,a.key_sha256,t.tenant_key
          from commerce.monthly_purchase_launches l join commerce.monthly_purchase_attempts a on a.tenant_id=l.tenant_id and a.id=l.operation_id and a.actor_user_id=l.actor_user_id
          join identity.tenants t on t.id=l.tenant_id and t.active where l.tenant_id=$1 and l.operation_id=$2 and l.code_hash=$3 and l.used_at is null and l.expires_at>clock_timestamp()`,
          [tenantId, operationId, mpHash(code)],
        );
        if (result.rows.length !== 1) throw unavailable();
        const row = result.rows[0]!,
          s = { tenantId, userId: row.actor_user_id, keySha256: row.key_sha256 },
          attempt = await read(c, s, true);
        if (
          !attempt ||
          attempt.state !== 'PAYMENT_PENDING' ||
          !attempt.receipt ||
          !mpPaymentUrl(attempt.receipt.paymentUrl) ||
          !attempt.receipt.paymentExpiresAt ||
          Date.parse(attempt.receipt.paymentExpiresAt) <= Date.now()
        )
          throw unavailable();
        const used = await c.query(
          `update commerce.monthly_purchase_launches set used_at=clock_timestamp() where tenant_id=$1 and id=$2 and used_at is null and expires_at>clock_timestamp() returning id`,
          [tenantId, row.id],
        );
        if (used.rowCount !== 1) throw unavailable();
        const liveLaunch = await c.query(
          `select id from commerce.monthly_purchase_launches where tenant_id=$1 and id=$2 and expires_at>clock_timestamp()`,
          [tenantId, row.id],
        );
        if (liveLaunch.rowCount !== 1) throw unavailable();
        await ensureIdentity(
          c,
          {
            tenantId,
            tenantKey: row.tenant_key,
            userId: row.actor_user_id,
            sessionId: row.session_id,
            correlationId: 'payment-launch',
          },
          attempt.identity,
        );
        if (Date.parse(attempt.receipt.paymentExpiresAt) <= Date.now()) throw unavailable();
        return attempt.receipt.paymentUrl;
      });
    },
  };
}
export type MonthlyPurchaseRepository = ReturnType<typeof createMonthlyPurchaseRepository>;
