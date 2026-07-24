import {
  GIFT_CERTIFICATE_ORDER_CREATED_EVENT,
  GIFT_CERTIFICATE_PAYMENT_CONFIRMED_EVENT,
  createGiftCertificateOrderRequestSchema,
  giftCertificateOrderViewSchema,
  giftCertificatePaymentConfirmationSchema,
  giftCertificatePaymentIntentSchema,
  giftCertificatePaymentViewSchema,
  giftCertificatePolicySchema,
  type CreateGiftCertificateOrderRequest,
  type GiftCertificateOrderView,
  type GiftCertificatePaymentConfirmation,
  type GiftCertificatePaymentIntent,
  type GiftCertificatePaymentView,
  type GiftCertificateSalesChannel,
} from '@phub/gift-certificates';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type GiftCertificateSaleAccess =
  | { readonly buyerUserId: string; readonly purchaseSessionHash?: never }
  | { readonly buyerUserId?: never; readonly purchaseSessionHash: string };

type SaleCommandType = 'CREATE_ORDER' | 'CREATE_PAYMENT' | 'CONFIRM_SANDBOX_PAYMENT';

export type GiftCertificateOrderCommandResult =
  | {
      readonly outcome: 'applied';
      readonly order: GiftCertificateOrderView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'catalog_stale' }
  | { readonly outcome: 'design_unavailable' }
  | { readonly outcome: 'denomination_unavailable' }
  | { readonly outcome: 'scheduled_delivery_unavailable' };

export type GiftCertificatePaymentCommandResult =
  | { readonly outcome: 'applied'; readonly intent: GiftCertificatePaymentIntent }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'order_not_found' }
  | { readonly outcome: 'order_not_payable' };

export type GiftCertificatePaymentConfirmationResult =
  | { readonly outcome: 'applied'; readonly confirmation: GiftCertificatePaymentConfirmation }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'payment_not_found' }
  | { readonly outcome: 'payment_amount_mismatch' };

export interface GiftCertificateSaleRepository {
  createOrder(input: {
    readonly tenantId: string;
    readonly salesChannel: GiftCertificateSalesChannel;
    readonly access: GiftCertificateSaleAccess;
    readonly purchaseSessionExpiresAt?: string;
    readonly orderNumber: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly order: CreateGiftCertificateOrderRequest;
  }): Promise<GiftCertificateOrderCommandResult>;
  getOrder(
    tenantId: string,
    orderId: string,
    access: GiftCertificateSaleAccess,
  ): Promise<GiftCertificateOrderView | undefined>;
  createPayment(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly access: GiftCertificateSaleAccess;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly nextActionUrl: (paymentId: string) => string;
  }): Promise<GiftCertificatePaymentCommandResult>;
  confirmSandboxPayment(input: {
    readonly tenantId: string;
    readonly paymentId: string;
    readonly access: GiftCertificateSaleAccess;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<GiftCertificatePaymentConfirmationResult>;
}

interface OrderRow extends QueryResultRow {
  readonly id: string;
  readonly order_number: string;
  readonly sales_channel: GiftCertificateSalesChannel;
  readonly status: 'PAYMENT_PENDING' | 'PAID' | 'PAYMENT_FAILED' | 'CANCELLED';
  readonly revision: number;
  readonly catalog_id: string;
  readonly catalog_number: number;
  readonly design_id: string;
  readonly design_snapshot: unknown;
  readonly policy_snapshot: unknown;
  readonly amount_minor: string | number;
  readonly currency: 'RUB';
  readonly buyer_email: string;
  readonly recipient_name: string;
  readonly recipient_email: string;
  readonly delivery_mode: 'IMMEDIATE' | 'SCHEDULED';
  readonly scheduled_for: Date | string | null;
  readonly created_at: Date | string;
  readonly paid_at: Date | string | null;
}

interface PaymentRow extends QueryResultRow {
  readonly id: string;
  readonly order_id: string;
  readonly provider: 'PADLHUB_SANDBOX';
  readonly status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  readonly amount_minor: string | number;
  readonly currency: 'RUB';
  readonly created_at: Date | string;
  readonly confirmed_at: Date | string | null;
}

interface CatalogSaleRow extends QueryResultRow {
  readonly catalog_number: number;
  readonly scheduled_delivery_enabled: boolean;
  readonly scheduled_delivery_valid: boolean;
  readonly policy_snapshot: unknown;
}

interface DesignSaleRow extends QueryResultRow {
  readonly id: string;
  readonly design_key: string;
  readonly title: string;
  readonly image_url: string;
  readonly alt_text: string;
  readonly code_x_percent: string | number;
  readonly code_y_percent: string | number;
  readonly amount_x_percent: string | number;
  readonly amount_y_percent: string | number;
}

interface DenominationSaleRow extends QueryResultRow {
  readonly id: string;
  readonly amount_minor: string | number;
  readonly currency: 'RUB';
}

interface PurchaseSessionRow extends QueryResultRow {
  readonly id: string;
}

interface SaleCommandRow extends QueryResultRow {
  readonly command_type: SaleCommandType;
  readonly request_hash: string;
  readonly result_payload: unknown;
}

const ORDER_COLUMNS = `
  id, order_number, sales_channel, status, revision,
  catalog_id, catalog_number, design_id, design_snapshot, policy_snapshot,
  amount_minor, currency, buyer_email, recipient_name, recipient_email,
  delivery_mode, scheduled_for, created_at, paid_at
`;

const PAYMENT_COLUMNS = `
  id, order_id, provider, status, amount_minor, currency, created_at, confirmed_at
`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

function mapOrder(row: OrderRow): GiftCertificateOrderView {
  const design = row.design_snapshot as Record<string, unknown>;
  return giftCertificateOrderViewSchema.parse({
    id: row.id,
    orderNumber: row.order_number,
    salesChannel: row.sales_channel,
    status: row.status,
    revision: row.revision,
    catalog: { id: row.catalog_id, catalogNumber: row.catalog_number },
    design: { id: row.design_id, ...design },
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    policy: giftCertificatePolicySchema.parse(row.policy_snapshot),
    buyerEmailMasked: maskEmail(row.buyer_email),
    recipientName: row.recipient_name,
    recipientEmailMasked: maskEmail(row.recipient_email),
    deliveryMode: row.delivery_mode,
    scheduledFor: nullableTimestamp(row.scheduled_for),
    createdAt: timestamp(row.created_at),
    paidAt: nullableTimestamp(row.paid_at),
  });
}

function mapPayment(row: PaymentRow): GiftCertificatePaymentView {
  return giftCertificatePaymentViewSchema.parse({
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    status: row.status,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    createdAt: timestamp(row.created_at),
    confirmedAt: nullableTimestamp(row.confirmed_at),
  });
}

async function currentCommand(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<SaleCommandRow | undefined> {
  return queryOne<SaleCommandRow>(
    client,
    `select command_type, request_hash, result_payload
       from gift_certificates.sale_commands
      where tenant_id = $1 and idempotency_key = $2
      for update`,
    [tenantId, idempotencyKey],
  );
}

function replay<T>(
  command: SaleCommandRow | undefined,
  commandType: SaleCommandType,
  requestHash: string,
  parse: (payload: unknown) => T,
):
  | { readonly outcome: 'replayed'; readonly value: T }
  | { readonly outcome: 'conflict' }
  | undefined {
  if (!command) return undefined;
  if (command.command_type !== commandType || command.request_hash !== requestHash) {
    return { outcome: 'conflict' };
  }
  return { outcome: 'replayed', value: parse(command.result_payload) };
}

async function storeCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly commandType: SaleCommandType;
    readonly requestHash: string;
    readonly orderId: string;
    readonly actorUserId?: string;
    readonly result: unknown;
  },
): Promise<void> {
  await client.query(
    `insert into gift_certificates.sale_commands (
       tenant_id, idempotency_key, command_type, request_hash,
       order_id, actor_user_id, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.idempotencyKey,
      input.commandType,
      input.requestHash,
      input.orderId,
      input.actorUserId ?? null,
      JSON.stringify(input.result),
    ],
  );
}

function accessParameters(
  access: GiftCertificateSaleAccess,
): readonly [string | null, string | null] {
  return [access.buyerUserId ?? null, access.purchaseSessionHash ?? null];
}

async function loadOwnedOrder(
  client: PoolClient,
  tenantId: string,
  orderId: string,
  access: GiftCertificateSaleAccess,
  lock = false,
): Promise<OrderRow | undefined> {
  const [buyerUserId, sessionHash] = accessParameters(access);
  return queryOne<OrderRow>(
    client,
    `select ${ORDER_COLUMNS}
       from gift_certificates.orders o
      where o.tenant_id = $1 and o.id = $2
        and (
          ($3::uuid is not null and o.buyer_user_id = $3::uuid)
          or
          ($4::text is not null and exists (
            select 1 from gift_certificates.purchase_sessions s
             where s.tenant_id = o.tenant_id
               and s.id = o.purchase_session_id
               and s.secret_hash = $4
               and s.expires_at > now()
          ))
        )
      ${lock ? 'for update of o' : ''}`,
    [tenantId, orderId, buyerUserId, sessionHash],
  );
}

async function recordFact(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId?: string;
    readonly action: 'GIFT_CERTIFICATE_ORDER_CREATED' | 'GIFT_CERTIFICATE_PAYMENT_CONFIRMED';
    readonly eventType:
      typeof GIFT_CERTIFICATE_ORDER_CREATED_EVENT | typeof GIFT_CERTIFICATE_PAYMENT_CONFIRMED_EVENT;
    readonly aggregateId: string;
    readonly order: GiftCertificateOrderView;
    readonly correlationId: string;
    readonly paymentId?: string;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, $3, 'GIFT_CERTIFICATE_ORDER', $4,
               'SUCCESS', $5, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId ?? null,
      input.action,
      input.order.id,
      input.correlationId,
      JSON.stringify({
        orderNumber: input.order.orderNumber,
        status: input.order.status,
        amountMinor: input.order.amountMinor,
        currency: input.order.currency,
        salesChannel: input.order.salesChannel,
        ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      }),
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      input.eventType,
      input.aggregateId,
      input.correlationId,
      JSON.stringify({
        orderId: input.order.id,
        ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      }),
    ],
  );
}

export function createGiftCertificateSaleRepository(pool: Pool): GiftCertificateSaleRepository {
  return {
    createOrder(input) {
      const orderInput = createGiftCertificateOrderRequestSchema.parse(input.order);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = replay(
          await currentCommand(client, input.tenantId, input.idempotencyKey),
          'CREATE_ORDER',
          input.requestHash,
          (payload) => giftCertificateOrderViewSchema.parse(payload),
        );
        if (command?.outcome === 'conflict') return { outcome: 'idempotency_conflict' };
        if (command?.outcome === 'replayed') {
          return { outcome: 'applied', order: command.value, replayed: true };
        }

        const catalog = await queryOne<CatalogSaleRow>(
          client,
          `select catalog_number, scheduled_delivery_enabled,
                  ($3::timestamptz is null or $3::timestamptz > now() + interval '5 minutes')
                    as scheduled_delivery_valid,
                  jsonb_build_object(
                    'validityStart', validity_start,
                    'validityDays', validity_days,
                    'activationDeadlineDays', activation_deadline_days,
                    'scheduledDeliveryEnabled', scheduled_delivery_enabled,
                    'emailAttachmentEnabled', email_attachment_enabled
                  ) as policy_snapshot
             from gift_certificates.catalog_versions
            where tenant_id = $1 and id = $2 and status = 'PUBLISHED'
              and public_enabled = true
              and (available_from is null or available_from <= now())
              and (available_to is null or available_to > now())
            for share`,
          [input.tenantId, orderInput.catalogId, orderInput.scheduledFor],
        );
        if (!catalog) return { outcome: 'catalog_stale' };
        if (orderInput.deliveryMode === 'SCHEDULED' && !catalog.scheduled_delivery_enabled) {
          return { outcome: 'scheduled_delivery_unavailable' };
        }
        if (!catalog.scheduled_delivery_valid) {
          return { outcome: 'scheduled_delivery_unavailable' };
        }

        const design = await queryOne<DesignSaleRow>(
          client,
          `select id, design_key, title, image_url, alt_text,
                  code_x_percent, code_y_percent, amount_x_percent, amount_y_percent
             from gift_certificates.designs
            where tenant_id = $1 and catalog_id = $2 and id = $3 and active = true`,
          [input.tenantId, orderInput.catalogId, orderInput.designId],
        );
        if (!design) return { outcome: 'design_unavailable' };
        const denomination = await queryOne<DenominationSaleRow>(
          client,
          `select id, amount_minor, currency
             from gift_certificates.denominations
            where tenant_id = $1 and catalog_id = $2 and id = $3 and active = true`,
          [input.tenantId, orderInput.catalogId, orderInput.denominationId],
        );
        if (!denomination) return { outcome: 'denomination_unavailable' };

        let purchaseSessionId: string | null = null;
        if ('purchaseSessionHash' in input.access && input.access.purchaseSessionHash) {
          if (!input.purchaseSessionExpiresAt)
            throw new Error('GIFT_PURCHASE_SESSION_EXPIRY_MISSING');
          const session = await queryOne<PurchaseSessionRow>(
            client,
            `insert into gift_certificates.purchase_sessions (
               tenant_id, secret_hash, expires_at
             ) values ($1, $2, $3)
             on conflict (tenant_id, secret_hash) do update set
               last_used_at = now(),
               expires_at = greatest(gift_certificates.purchase_sessions.expires_at, excluded.expires_at)
             returning id`,
            [input.tenantId, input.access.purchaseSessionHash, input.purchaseSessionExpiresAt],
          );
          if (!session) throw new Error('GIFT_PURCHASE_SESSION_WRITE_LOST');
          purchaseSessionId = session.id;
        }

        const policy = giftCertificatePolicySchema.parse(catalog.policy_snapshot);
        const designSnapshot = {
          key: design.design_key,
          title: design.title,
          imageUrl: design.image_url,
          alt: design.alt_text,
          codeXPercent: Number(design.code_x_percent),
          codeYPercent: Number(design.code_y_percent),
          amountXPercent: Number(design.amount_x_percent),
          amountYPercent: Number(design.amount_y_percent),
        };
        const inserted = await queryOne<OrderRow>(
          client,
          `insert into gift_certificates.orders (
             tenant_id, order_number, sales_channel, buyer_user_id, purchase_session_id,
             buyer_email, recipient_name, recipient_email, recipient_message,
             delivery_mode, scheduled_for, catalog_id, catalog_number,
             design_id, denomination_id, design_snapshot, policy_snapshot,
             amount_minor, currency
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18, $19
           ) returning ${ORDER_COLUMNS}`,
          [
            input.tenantId,
            input.orderNumber,
            input.salesChannel,
            input.access.buyerUserId ?? null,
            purchaseSessionId,
            orderInput.buyerEmail,
            orderInput.recipientName,
            orderInput.recipientEmail,
            orderInput.message,
            orderInput.deliveryMode,
            orderInput.scheduledFor,
            orderInput.catalogId,
            catalog.catalog_number,
            design.id,
            denomination.id,
            JSON.stringify(designSnapshot),
            JSON.stringify(policy),
            Number(denomination.amount_minor),
            denomination.currency,
          ],
        );
        if (!inserted) throw new Error('GIFT_CERTIFICATE_ORDER_WRITE_LOST');
        const order = mapOrder(inserted);
        await recordFact(client, {
          tenantId: input.tenantId,
          ...(input.access.buyerUserId ? { actorUserId: input.access.buyerUserId } : {}),
          action: 'GIFT_CERTIFICATE_ORDER_CREATED',
          eventType: GIFT_CERTIFICATE_ORDER_CREATED_EVENT,
          aggregateId: order.id,
          order,
          correlationId: input.correlationId,
        });
        await storeCommand(client, {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'CREATE_ORDER',
          requestHash: input.requestHash,
          orderId: order.id,
          ...(input.access.buyerUserId ? { actorUserId: input.access.buyerUserId } : {}),
          result: order,
        });
        return { outcome: 'applied', order, replayed: false };
      });
    },

    getOrder(tenantId, orderId, access) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await loadOwnedOrder(client, tenantId, orderId, access);
        return row ? mapOrder(row) : undefined;
      });
    },

    createPayment(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = replay(
          await currentCommand(client, input.tenantId, input.idempotencyKey),
          'CREATE_PAYMENT',
          input.requestHash,
          (payload) => giftCertificatePaymentIntentSchema.parse(payload),
        );
        if (command?.outcome === 'conflict') return { outcome: 'idempotency_conflict' };
        if (command?.outcome === 'replayed') {
          return {
            outcome: 'applied',
            intent: { ...command.value, replayed: true },
          };
        }
        const orderRow = await loadOwnedOrder(
          client,
          input.tenantId,
          input.orderId,
          input.access,
          true,
        );
        if (!orderRow) return { outcome: 'order_not_found' };
        if (orderRow.status !== 'PAYMENT_PENDING') return { outcome: 'order_not_payable' };
        const paymentRow = await queryOne<PaymentRow>(
          client,
          `insert into commerce.payment_operations (
             tenant_id, order_id, provider, amount_minor, currency
           ) values ($1, $2, 'PADLHUB_SANDBOX', $3, $4)
           on conflict (tenant_id, order_id) do update set order_id = excluded.order_id
           returning ${PAYMENT_COLUMNS}`,
          [input.tenantId, input.orderId, orderRow.amount_minor, orderRow.currency],
        );
        if (!paymentRow) throw new Error('GIFT_CERTIFICATE_PAYMENT_WRITE_LOST');
        const intent = giftCertificatePaymentIntentSchema.parse({
          payment: mapPayment(paymentRow),
          nextAction: { type: 'REDIRECT', url: input.nextActionUrl(paymentRow.id) },
          replayed: false,
        });
        await storeCommand(client, {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'CREATE_PAYMENT',
          requestHash: input.requestHash,
          orderId: input.orderId,
          ...(input.access.buyerUserId ? { actorUserId: input.access.buyerUserId } : {}),
          result: intent,
        });
        return { outcome: 'applied', intent };
      });
    },

    confirmSandboxPayment(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = replay(
          await currentCommand(client, input.tenantId, input.idempotencyKey),
          'CONFIRM_SANDBOX_PAYMENT',
          input.requestHash,
          (payload) => giftCertificatePaymentConfirmationSchema.parse(payload),
        );
        if (command?.outcome === 'conflict') return { outcome: 'idempotency_conflict' };
        if (command?.outcome === 'replayed') {
          return {
            outcome: 'applied',
            confirmation: { ...command.value, replayed: true },
          };
        }

        const [buyerUserId, sessionHash] = accessParameters(input.access);
        const paymentRow = await queryOne<
          PaymentRow & { readonly order_status: OrderRow['status'] }
        >(
          client,
          `select p.id, p.order_id, p.provider, p.status, p.amount_minor, p.currency,
                  p.created_at, p.confirmed_at,
                  o.status as order_status
             from commerce.payment_operations p
             join gift_certificates.orders o
               on o.tenant_id = p.tenant_id and o.id = p.order_id
            where p.tenant_id = $1 and p.id = $2
              and (
                ($3::uuid is not null and o.buyer_user_id = $3::uuid)
                or
                ($4::text is not null and exists (
                  select 1 from gift_certificates.purchase_sessions s
                   where s.tenant_id = o.tenant_id
                     and s.id = o.purchase_session_id
                     and s.secret_hash = $4
                     and s.expires_at > now()
                ))
              )
            for update of p, o`,
          [input.tenantId, input.paymentId, buyerUserId, sessionHash],
        );
        if (!paymentRow) return { outcome: 'payment_not_found' };
        let payment = mapPayment(paymentRow);
        let orderRow = await loadOwnedOrder(
          client,
          input.tenantId,
          payment.orderId,
          input.access,
          true,
        );
        if (!orderRow) return { outcome: 'payment_not_found' };
        if (Number(paymentRow.amount_minor) !== Number(orderRow.amount_minor)) {
          return { outcome: 'payment_amount_mismatch' };
        }
        const transitioned = payment.status === 'PENDING' || orderRow.status === 'PAYMENT_PENDING';
        if (payment.status === 'PENDING') {
          const confirmedPayment = await queryOne<PaymentRow>(
            client,
            `update commerce.payment_operations
                set status = 'CONFIRMED', confirmed_at = now()
              where tenant_id = $1 and id = $2 and status = 'PENDING'
              returning ${PAYMENT_COLUMNS}`,
            [input.tenantId, input.paymentId],
          );
          if (!confirmedPayment) throw new Error('GIFT_CERTIFICATE_PAYMENT_CONFIRM_LOST');
          payment = mapPayment(confirmedPayment);
        }
        if (orderRow.status === 'PAYMENT_PENDING') {
          const paidOrder = await queryOne<OrderRow>(
            client,
            `update gift_certificates.orders
                set status = 'PAID', revision = revision + 1,
                    paid_at = coalesce(paid_at, now()), updated_at = now()
              where tenant_id = $1 and id = $2 and status = 'PAYMENT_PENDING'
              returning ${ORDER_COLUMNS}`,
            [input.tenantId, orderRow.id],
          );
          if (!paidOrder) throw new Error('GIFT_CERTIFICATE_ORDER_CONFIRM_LOST');
          orderRow = paidOrder;
        }
        const order = mapOrder(orderRow);
        const confirmation = giftCertificatePaymentConfirmationSchema.parse({
          order,
          payment,
          replayed: false,
        });
        if (transitioned) {
          await recordFact(client, {
            tenantId: input.tenantId,
            ...(input.access.buyerUserId ? { actorUserId: input.access.buyerUserId } : {}),
            action: 'GIFT_CERTIFICATE_PAYMENT_CONFIRMED',
            eventType: GIFT_CERTIFICATE_PAYMENT_CONFIRMED_EVENT,
            aggregateId: payment.id,
            order,
            paymentId: payment.id,
            correlationId: input.correlationId,
          });
        }
        await storeCommand(client, {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'CONFIRM_SANDBOX_PAYMENT',
          requestHash: input.requestHash,
          orderId: order.id,
          ...(input.access.buyerUserId ? { actorUserId: input.access.buyerUserId } : {}),
          result: confirmation,
        });
        return { outcome: 'applied', confirmation };
      });
    },
  };
}
