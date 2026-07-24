import {
  GIFT_CERTIFICATE_ISSUED_EVENT,
  giftCertificateFulfillmentViewSchema,
  giftCertificatePolicySchema,
  type GiftCertificateFulfillmentView,
  type GiftCertificatePolicy,
} from '@phub/gift-certificates';
import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';
import type { GiftCertificateSaleAccess } from './gift-certificate-sale-repository.js';

export const GIFT_CERTIFICATE_ISSUANCE_CONSUMER = 'gift-certificate-issuer-v1';

export interface GiftCertificateIssuanceDocument {
  readonly tenantId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly certificateId: string;
  readonly certificateNumber: string;
  readonly activationTokenDigest: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly recipientMessage: string | null;
  readonly designTitle: string;
  readonly designImageUrl: string;
  readonly codeXPercent: number;
  readonly codeYPercent: number;
  readonly amountXPercent: number;
  readonly amountYPercent: number;
  readonly amountMinor: number;
  readonly currency: 'RUB';
  readonly policy: GiftCertificatePolicy;
  readonly deliveryAvailableAt: string;
}

export type PrepareGiftCertificateIssuanceResult =
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'dependency_missing' }
  | { readonly outcome: 'prepared'; readonly document: GiftCertificateIssuanceDocument };

export interface GiftCertificateArtifactAccess {
  readonly certificateId: string;
  readonly certificateNumber: string;
  readonly objectKey: string;
}

export interface GiftCertificateDeliveryJob {
  readonly id: string;
  readonly certificateId: string;
  readonly certificateNumber: string;
  readonly orderNumber: string;
  readonly recipientEmail: string;
  readonly recipientName: string;
  readonly objectKey: string;
  readonly attemptCount: number;
}

export interface GiftCertificateIssuanceRepository {
  prepareIssuance(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly orderId: string;
    readonly paymentId: string;
    readonly correlationId: string;
    readonly proposedCertificateId: string;
    readonly proposedCertificateNumber: string;
    readonly proposedActivationTokenDigest: string;
  }): Promise<PrepareGiftCertificateIssuanceResult>;
  completeIssuance(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly certificateId: string;
    readonly contentSha256: string;
    readonly objectKey: string;
    readonly byteSize: number;
    readonly correlationId: string;
  }): Promise<'issued' | 'duplicate'>;
  getDesignMediaObjectKey(tenantId: string, assetId: string): Promise<string | undefined>;
  getFulfillment(
    tenantId: string,
    orderId: string,
    access: GiftCertificateSaleAccess,
  ): Promise<GiftCertificateFulfillmentView | undefined>;
  getArtifactForOwnedOrder(
    tenantId: string,
    orderId: string,
    access: GiftCertificateSaleAccess,
  ): Promise<GiftCertificateArtifactAccess | undefined>;
  claimDueDelivery(input: {
    readonly tenantId: string;
    readonly lockSeconds: number;
  }): Promise<GiftCertificateDeliveryJob | undefined>;
  markDeliverySandboxed(input: {
    readonly tenantId: string;
    readonly deliveryId: string;
    readonly correlationId: string;
  }): Promise<void>;
  markDeliveryFailed(input: {
    readonly tenantId: string;
    readonly deliveryId: string;
    readonly errorCode: string;
    readonly final: boolean;
    readonly retryAt: string;
  }): Promise<void>;
}

interface IssuanceRow extends QueryResultRow {
  readonly certificate_id: string;
  readonly certificate_number: string;
  readonly activation_token_digest: string;
  readonly certificate_status: 'PREPARING' | 'ISSUED' | 'VOIDED';
  readonly order_id: string;
  readonly order_number: string;
  readonly recipient_name: string;
  readonly recipient_email: string;
  readonly recipient_message: string | null;
  readonly design_snapshot: unknown;
  readonly amount_minor: string | number;
  readonly currency: 'RUB';
  readonly policy_snapshot: unknown;
  readonly delivery_available_at: Date | string;
}

interface FulfillmentRow extends QueryResultRow {
  readonly id: string;
  readonly certificate_number: string;
  readonly status: 'PREPARING' | 'ISSUED' | 'VOIDED';
  readonly amount_minor: string | number;
  readonly currency: 'RUB';
  readonly issued_at: Date | string | null;
  readonly valid_from: Date | string | null;
  readonly valid_until: Date | string | null;
  readonly activation_deadline_at: Date | string | null;
  readonly artifact_status: 'PENDING' | 'READY' | null;
  readonly delivery_status: 'PENDING' | 'SANDBOXED' | 'DELIVERED' | 'FAILED' | null;
  readonly delivery_scheduled_for: Date | string | null;
  readonly delivered_at: Date | string | null;
}

interface ArtifactRow extends QueryResultRow {
  readonly certificate_id: string;
  readonly certificate_number: string;
  readonly object_key: string;
}

interface DeliveryRow extends QueryResultRow {
  readonly id: string;
  readonly certificate_id: string;
  readonly certificate_number: string;
  readonly order_number: string;
  readonly recipient_email: string;
  readonly recipient_name: string;
  readonly object_key: string;
  readonly attempt_count: number;
}

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function accessParts(access: GiftCertificateSaleAccess): readonly [string | null, string | null] {
  return [access.buyerUserId ?? null, access.purchaseSessionHash ?? null];
}

function ownedOrderPredicate(): string {
  return `(
    ($3::uuid is not null and o.buyer_user_id = $3::uuid)
    or
    ($4::text is not null and exists (
      select 1 from gift_certificates.purchase_sessions s
       where s.tenant_id = o.tenant_id
         and s.id = o.purchase_session_id
         and s.secret_hash = $4
         and s.expires_at > now()
    ))
  )`;
}

export function createGiftCertificateIssuanceRepository(
  pool: Pool,
): GiftCertificateIssuanceRepository {
  return {
    prepareIssuance(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          input.orderId,
        ]);
        await client.query(
          `insert into audit.inbox_events (consumer_name, event_id, tenant_id)
           values ($1, $2, $3)
           on conflict (consumer_name, event_id) do nothing`,
          [GIFT_CERTIFICATE_ISSUANCE_CONSUMER, input.eventId, input.tenantId],
        );
        const inbox = await queryOne<{ readonly processed_at: Date | string | null }>(
          client,
          `select processed_at from audit.inbox_events
            where consumer_name = $1 and event_id = $2
            for update`,
          [GIFT_CERTIFICATE_ISSUANCE_CONSUMER, input.eventId],
        );
        if (inbox?.processed_at) return { outcome: 'duplicate' };

        const order = await queryOne<
          QueryResultRow & {
            readonly order_id: string;
            readonly order_number: string;
            readonly recipient_name: string;
            readonly recipient_email: string;
            readonly recipient_message: string | null;
            readonly design_snapshot: unknown;
            readonly amount_minor: string | number;
            readonly currency: 'RUB';
            readonly policy_snapshot: unknown;
            readonly delivery_available_at: Date | string;
          }
        >(
          client,
          `select o.id as order_id, o.order_number, o.recipient_name, o.recipient_email,
                  o.recipient_message, o.design_snapshot, o.amount_minor, o.currency,
                  o.policy_snapshot, coalesce(o.scheduled_for, now()) as delivery_available_at
             from gift_certificates.orders o
             join commerce.payment_operations p
               on p.tenant_id = o.tenant_id and p.order_id = o.id
            where o.tenant_id = $1 and o.id = $2 and p.id = $3
              and o.status = 'PAID' and p.status = 'CONFIRMED'
              and p.amount_minor = o.amount_minor and p.currency = o.currency
            for update of o, p`,
          [input.tenantId, input.orderId, input.paymentId],
        );
        if (!order) return { outcome: 'dependency_missing' };
        const policy = giftCertificatePolicySchema.parse(order.policy_snapshot);
        await client.query(
          `insert into gift_certificates.certificates (
             tenant_id, id, order_id, certificate_number, activation_token_digest,
             amount_minor, currency, validity_start, validity_days, activation_deadline_days
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (tenant_id, order_id) do nothing`,
          [
            input.tenantId,
            input.proposedCertificateId,
            order.order_id,
            input.proposedCertificateNumber,
            input.proposedActivationTokenDigest,
            Number(order.amount_minor),
            order.currency,
            policy.validityStart,
            policy.validityDays,
            policy.activationDeadlineDays,
          ],
        );
        const certificate = await queryOne<IssuanceRow>(
          client,
          `select c.id as certificate_id, c.certificate_number, c.activation_token_digest,
                  c.status as certificate_status, o.id as order_id, o.order_number,
                  o.recipient_name, o.recipient_email, o.recipient_message,
                  o.design_snapshot, o.amount_minor, o.currency, o.policy_snapshot,
                  coalesce(o.scheduled_for, now()) as delivery_available_at
             from gift_certificates.certificates c
             join gift_certificates.orders o
               on o.tenant_id = c.tenant_id and o.id = c.order_id
            where c.tenant_id = $1 and c.order_id = $2
            for update of c`,
          [input.tenantId, input.orderId],
        );
        if (!certificate) throw new Error('GIFT_CERTIFICATE_PREPARATION_WRITE_LOST');
        if (certificate.certificate_status !== 'PREPARING') {
          await client.query(
            `update audit.inbox_events set processed_at = coalesce(processed_at, now())
              where consumer_name = $1 and event_id = $2`,
            [GIFT_CERTIFICATE_ISSUANCE_CONSUMER, input.eventId],
          );
          return { outcome: 'duplicate' };
        }
        await client.query(
          `insert into gift_certificates.artifacts (tenant_id, certificate_id)
           values ($1, $2)
           on conflict (tenant_id, certificate_id) do nothing`,
          [input.tenantId, certificate.certificate_id],
        );
        const design = certificate.design_snapshot as Record<string, unknown>;
        return {
          outcome: 'prepared',
          document: {
            tenantId: input.tenantId,
            eventId: input.eventId,
            correlationId: input.correlationId,
            certificateId: certificate.certificate_id,
            certificateNumber: certificate.certificate_number,
            activationTokenDigest: certificate.activation_token_digest,
            orderId: certificate.order_id,
            orderNumber: certificate.order_number,
            recipientName: certificate.recipient_name,
            recipientEmail: certificate.recipient_email,
            recipientMessage: certificate.recipient_message,
            designTitle: typeof design.title === 'string' ? design.title : 'Подарочный сертификат',
            designImageUrl: typeof design.imageUrl === 'string' ? design.imageUrl : '',
            codeXPercent: typeof design.codeXPercent === 'number' ? design.codeXPercent : 5.1,
            codeYPercent: typeof design.codeYPercent === 'number' ? design.codeYPercent : 88,
            amountXPercent:
              typeof design.amountXPercent === 'number' ? design.amountXPercent : 78.3,
            amountYPercent: typeof design.amountYPercent === 'number' ? design.amountYPercent : 88,
            amountMinor: Number(certificate.amount_minor),
            currency: certificate.currency,
            policy: giftCertificatePolicySchema.parse(certificate.policy_snapshot),
            deliveryAvailableAt: timestamp(certificate.delivery_available_at),
          },
        };
      });
    },

    completeIssuance(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          input.certificateId,
        ]);
        const certificate = await queryOne<
          QueryResultRow & {
            readonly status: 'PREPARING' | 'ISSUED' | 'VOIDED';
            readonly order_id: string;
            readonly validity_start: 'ISSUE' | 'ACTIVATION';
            readonly validity_days: number;
            readonly activation_deadline_days: number | null;
            readonly recipient_email: string;
            readonly available_at: Date | string;
          }
        >(
          client,
          `select c.status, c.order_id, c.validity_start, c.validity_days,
                  c.activation_deadline_days, o.recipient_email,
                  coalesce(o.scheduled_for, now()) as available_at
             from gift_certificates.certificates c
             join gift_certificates.orders o
               on o.tenant_id = c.tenant_id and o.id = c.order_id
            where c.tenant_id = $1 and c.id = $2
            for update of c`,
          [input.tenantId, input.certificateId],
        );
        if (!certificate) throw new Error('GIFT_CERTIFICATE_PREPARATION_MISSING');
        if (certificate.status !== 'PREPARING') {
          await client.query(
            `update audit.inbox_events set processed_at = coalesce(processed_at, now())
              where consumer_name = $1 and event_id = $2`,
            [GIFT_CERTIFICATE_ISSUANCE_CONSUMER, input.eventId],
          );
          return 'duplicate';
        }
        await client.query(
          `update gift_certificates.artifacts
              set status = 'READY', object_key = $3, content_sha256 = $4,
                  content_type = 'application/pdf', byte_size = $5,
                  generated_at = now(), updated_at = now()
            where tenant_id = $1 and certificate_id = $2 and status = 'PENDING'`,
          [
            input.tenantId,
            input.certificateId,
            input.objectKey,
            input.contentSha256,
            input.byteSize,
          ],
        );
        await client.query(
          `update gift_certificates.certificates
              set status = 'ISSUED', issued_at = now(), updated_at = now(),
                  valid_from = case when validity_start = 'ISSUE' then now() else null end,
                  valid_until = case when validity_start = 'ISSUE'
                    then now() + make_interval(days => validity_days) else null end,
                  activation_deadline_at = case when validity_start = 'ACTIVATION'
                    then now() + make_interval(days => activation_deadline_days) else null end
            where tenant_id = $1 and id = $2 and status = 'PREPARING'`,
          [input.tenantId, input.certificateId],
        );
        await client.query(
          `insert into gift_certificates.deliveries (
             tenant_id, certificate_id, channel, recipient_email, available_at, next_attempt_at
           ) values ($1, $2, 'EMAIL', $3, $4, $4)
           on conflict (tenant_id, certificate_id, channel) do nothing`,
          [
            input.tenantId,
            input.certificateId,
            certificate.recipient_email,
            certificate.available_at,
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
           ) values ($1, 'GIFT_CERTIFICATE_ISSUED', 'GIFT_CERTIFICATE', $2,
                     'SUCCESS', $3, $4::jsonb)`,
          [
            input.tenantId,
            input.certificateId,
            input.correlationId,
            JSON.stringify({ orderId: certificate.order_id, artifactReady: true }),
          ],
        );
        await client.query(
          `insert into audit.outbox_events (
             tenant_id, event_type, aggregate_id, correlation_id, payload
           ) values ($1, $2, $3, $4, $5::jsonb)`,
          [
            input.tenantId,
            GIFT_CERTIFICATE_ISSUED_EVENT,
            input.certificateId,
            input.correlationId,
            JSON.stringify({ certificateId: input.certificateId, orderId: certificate.order_id }),
          ],
        );
        await client.query(
          `update audit.inbox_events set processed_at = now()
            where consumer_name = $1 and event_id = $2`,
          [GIFT_CERTIFICATE_ISSUANCE_CONSUMER, input.eventId],
        );
        return 'issued';
      });
    },

    getDesignMediaObjectKey(tenantId, assetId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<{ readonly object_key: string }>(
          client,
          `select object_key from gift_certificates.media_assets
            where tenant_id = $1 and id = $2 and status = 'READY'`,
          [tenantId, assetId],
        );
        return row?.object_key;
      });
    },

    getFulfillment(tenantId, orderId, access) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const [buyerUserId, sessionHash] = accessParts(access);
        const row = await queryOne<FulfillmentRow>(
          client,
          `select c.id, c.certificate_number, c.status, c.amount_minor, c.currency,
                  c.issued_at, c.valid_from, c.valid_until, c.activation_deadline_at,
                  a.status as artifact_status, d.status as delivery_status,
                  d.available_at as delivery_scheduled_for, d.delivered_at
             from gift_certificates.orders o
             join gift_certificates.certificates c
               on c.tenant_id = o.tenant_id and c.order_id = o.id
             left join gift_certificates.artifacts a
               on a.tenant_id = c.tenant_id and a.certificate_id = c.id
             left join gift_certificates.deliveries d
               on d.tenant_id = c.tenant_id and d.certificate_id = c.id and d.channel = 'EMAIL'
            where o.tenant_id = $1 and o.id = $2 and ${ownedOrderPredicate()}`,
          [tenantId, orderId, buyerUserId, sessionHash],
        );
        if (!row) return undefined;
        return giftCertificateFulfillmentViewSchema.parse({
          certificate: {
            id: row.id,
            certificateNumber: row.certificate_number,
            status: row.status,
            amountMinor: Number(row.amount_minor),
            currency: row.currency,
            issuedAt: nullableTimestamp(row.issued_at),
            validFrom: nullableTimestamp(row.valid_from),
            validUntil: nullableTimestamp(row.valid_until),
            activationDeadlineAt: nullableTimestamp(row.activation_deadline_at),
            downloadReady: row.artifact_status === 'READY',
          },
          delivery: row.delivery_status
            ? {
                status: row.delivery_status,
                scheduledFor: timestamp(row.delivery_scheduled_for as Date | string),
                deliveredAt: nullableTimestamp(row.delivered_at),
              }
            : null,
        });
      });
    },

    getArtifactForOwnedOrder(tenantId, orderId, access) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const [buyerUserId, sessionHash] = accessParts(access);
        const row = await queryOne<ArtifactRow>(
          client,
          `select c.id as certificate_id, c.certificate_number, a.object_key
             from gift_certificates.orders o
             join gift_certificates.certificates c
               on c.tenant_id = o.tenant_id and c.order_id = o.id and c.status = 'ISSUED'
             join gift_certificates.artifacts a
               on a.tenant_id = c.tenant_id and a.certificate_id = c.id and a.status = 'READY'
            where o.tenant_id = $1 and o.id = $2 and ${ownedOrderPredicate()}`,
          [tenantId, orderId, buyerUserId, sessionHash],
        );
        return row
          ? {
              certificateId: row.certificate_id,
              certificateNumber: row.certificate_number,
              objectKey: row.object_key,
            }
          : undefined;
      });
    },

    claimDueDelivery(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<DeliveryRow>(
          client,
          `with due as (
             select d.id
               from gift_certificates.deliveries d
              where d.tenant_id = $1 and d.status = 'PENDING'
                and d.available_at <= now() and d.next_attempt_at <= now()
              order by d.next_attempt_at, d.id
              for update skip locked
              limit 1
           ), claimed as (
             update gift_certificates.deliveries d
                set attempt_count = attempt_count + 1,
                    next_attempt_at = now() + make_interval(secs => $2),
                    updated_at = now()
               from due
              where d.tenant_id = $1 and d.id = due.id
              returning d.*
           )
           select c.id, c.certificate_id, cert.certificate_number, o.order_number,
                  c.recipient_email, o.recipient_name, a.object_key, c.attempt_count
             from claimed c
             join gift_certificates.certificates cert
               on cert.tenant_id = c.tenant_id and cert.id = c.certificate_id
             join gift_certificates.orders o
               on o.tenant_id = cert.tenant_id and o.id = cert.order_id
             join gift_certificates.artifacts a
               on a.tenant_id = cert.tenant_id and a.certificate_id = cert.id
              and a.status = 'READY'`,
          [input.tenantId, input.lockSeconds],
        );
        return row
          ? {
              id: row.id,
              certificateId: row.certificate_id,
              certificateNumber: row.certificate_number,
              orderNumber: row.order_number,
              recipientEmail: row.recipient_email,
              recipientName: row.recipient_name,
              objectKey: row.object_key,
              attemptCount: row.attempt_count,
            }
          : undefined;
      });
    },

    markDeliverySandboxed(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const updated = await queryOne<{ readonly certificate_id: string }>(
          client,
          `update gift_certificates.deliveries
              set status = 'SANDBOXED', delivered_at = now(), updated_at = now(),
                  last_error_code = null
            where tenant_id = $1 and id = $2 and status = 'PENDING'
            returning certificate_id`,
          [input.tenantId, input.deliveryId],
        );
        if (!updated) return;
        await client.query(
          `insert into audit.audit_log (
             tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
           ) values ($1, 'GIFT_CERTIFICATE_EMAIL_SANDBOXED', 'GIFT_CERTIFICATE', $2,
                     'SUCCESS', $3, '{"channel":"EMAIL","mode":"SANDBOX"}'::jsonb)`,
          [input.tenantId, updated.certificate_id, input.correlationId],
        );
      });
    },

    markDeliveryFailed(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(
          `update gift_certificates.deliveries
              set status = case when $4 then 'FAILED' else 'PENDING' end,
                  last_error_code = $3, next_attempt_at = $5, updated_at = now()
            where tenant_id = $1 and id = $2 and status = 'PENDING'`,
          [input.tenantId, input.deliveryId, input.errorCode, input.final, input.retryAt],
        );
      });
    },
  };
}
