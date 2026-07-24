import { createHash } from 'node:crypto';

import {
  createDatabasePool,
  createGiftCertificateIssuanceRepository,
  createGiftCertificateSaleRepository,
  withTenantTransaction,
} from '@phub/database';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const userId = '11111111-1111-4111-8111-111111111111';
const catalogId = '22222222-2222-4222-8222-222222222222';
const designId = '33333333-3333-4333-8333-333333333333';
const denominationId = '44444444-4444-4444-8444-444444444444';
const pool = createDatabasePool(connectionString);

try {
  const tenant = await pool.query<{ readonly id: string }>(
    "select id from identity.tenants where tenant_key = 'local-padel'",
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error('LOCAL_TENANT_MISSING');

  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `insert into identity.users (tenant_id, id)
       values ($1, $2)
       on conflict (id) do nothing`,
      [tenantId, userId],
    );
    await client.query(
      `insert into gift_certificates.catalog_versions (
         tenant_id, id, catalog_number, status, title, public_enabled,
         flow_steps, validity_start, validity_days, activation_deadline_days,
         scheduled_delivery_enabled, email_attachment_enabled,
         created_by, updated_by, published_at
       ) values (
         $1, $2, 1, 'PUBLISHED', 'Verification catalog', true,
         '["DESIGN","DENOMINATION","REVIEW"]'::jsonb,
         'ISSUE', 365, null, true, true, $3, $3, now()
       )`,
      [tenantId, catalogId, userId],
    );
    await client.query(
      `insert into gift_certificates.designs (
         tenant_id, id, catalog_id, design_key, audience, title,
         image_url, alt_text, active, sort_order
       ) values ($1, $2, $3, 'verification', 'UNIVERSAL', 'Verification',
                 'https://cdn.padlhub.test/gift/verification.webp', 'Verification', true, 10)`,
      [tenantId, designId, catalogId],
    );
    await client.query(
      `insert into gift_certificates.denominations (
         tenant_id, id, catalog_id, amount_minor, currency, active, sort_order
       ) values ($1, $2, $3, 500000, 'RUB', true, 10)`,
      [tenantId, denominationId, catalogId],
    );
  });

  const repository = createGiftCertificateSaleRepository(pool);
  const access = { buyerUserId: userId } as const;
  const orderInput = {
    catalogId,
    designId,
    denominationId,
    buyerEmail: 'buyer@example.test',
    recipientName: 'Verification recipient',
    recipientEmail: 'recipient@example.test',
    message: 'Sensitive verification message',
    deliveryMode: 'IMMEDIATE' as const,
    scheduledFor: null,
    termsAccepted: true as const,
  };
  const createInput = {
    tenantId,
    salesChannel: 'LK' as const,
    access,
    orderNumber: 'GC-VERIFY000001',
    idempotencyKey: 'verify-order-0000001',
    requestHash: '1'.repeat(64),
    correlationId: 'verify-gift-order-0001',
    order: orderInput,
  };
  const created = await repository.createOrder(createInput);
  if (created.outcome !== 'applied' || created.replayed || created.order.amountMinor !== 500_000) {
    throw new Error('ORDER_SNAPSHOT_VERIFICATION_FAILED');
  }
  const replayedOrder = await repository.createOrder(createInput);
  if (replayedOrder.outcome !== 'applied' || !replayedOrder.replayed) {
    throw new Error('ORDER_REPLAY_VERIFICATION_FAILED');
  }

  const paymentInput = {
    tenantId,
    orderId: created.order.id,
    access,
    idempotencyKey: 'verify-payment-00001',
    requestHash: '2'.repeat(64),
    correlationId: 'verify-gift-payment-0001',
    nextActionUrl: (paymentId: string) => `/sandbox/${paymentId}`,
  };
  const payment = await repository.createPayment(paymentInput);
  if (payment.outcome !== 'applied' || payment.intent.payment.amountMinor !== 500_000) {
    throw new Error('PAYMENT_SNAPSHOT_VERIFICATION_FAILED');
  }
  const paymentReplay = await repository.createPayment(paymentInput);
  if (paymentReplay.outcome !== 'applied' || !paymentReplay.intent.replayed) {
    throw new Error('PAYMENT_REPLAY_VERIFICATION_FAILED');
  }

  const confirmation = await repository.confirmSandboxPayment({
    tenantId,
    paymentId: payment.intent.payment.id,
    access,
    idempotencyKey: 'verify-confirm-00001',
    requestHash: '3'.repeat(64),
    correlationId: 'verify-gift-confirm-0001',
  });
  if (
    confirmation.outcome !== 'applied' ||
    confirmation.confirmation.order.status !== 'PAID' ||
    confirmation.confirmation.payment.status !== 'CONFIRMED'
  ) {
    throw new Error('PAYMENT_CONFIRMATION_VERIFICATION_FAILED');
  }
  const secondConfirmation = await repository.confirmSandboxPayment({
    tenantId,
    paymentId: payment.intent.payment.id,
    access,
    idempotencyKey: 'verify-confirm-00002',
    requestHash: '4'.repeat(64),
    correlationId: 'verify-gift-confirm-0002',
  });
  if (secondConfirmation.outcome !== 'applied') {
    throw new Error('SECOND_CONFIRMATION_VERIFICATION_FAILED');
  }

  const paymentEvent = await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{ readonly id: string }>(
      `select id from audit.outbox_events
        where tenant_id = $1 and event_type = 'commerce.payment.confirmed.v1'
          and aggregate_id = $2`,
      [tenantId, payment.intent.payment.id],
    );
    return result.rows[0]?.id;
  });
  if (!paymentEvent) throw new Error('PAYMENT_EVENT_MISSING');
  const issuanceRepository = createGiftCertificateIssuanceRepository(pool);
  const certificateId = '66666666-6666-4666-8666-666666666666';
  const activationCode = 'PHGC-1234-5678-90AB-CDEF-1234-5678';
  const prepared = await issuanceRepository.prepareIssuance({
    tenantId,
    eventId: paymentEvent,
    orderId: created.order.id,
    paymentId: payment.intent.payment.id,
    correlationId: 'verify-gift-issuance-0001',
    proposedCertificateId: certificateId,
    proposedCertificateNumber: 'PH-GC-0123456789ABCDEF',
    proposedActivationTokenDigest: createHash('sha256').update(activationCode).digest('hex'),
  });
  if (prepared.outcome !== 'prepared') throw new Error('ISSUANCE_PREPARATION_FAILED');
  const completion = await issuanceRepository.completeIssuance({
    tenantId,
    eventId: paymentEvent,
    certificateId,
    contentSha256: 'a'.repeat(64),
    objectKey: `gift-certificates/${certificateId}/${'a'.repeat(64)}.pdf`,
    byteSize: 18_000,
    correlationId: 'verify-gift-issuance-0001',
  });
  if (completion !== 'issued') throw new Error('ISSUANCE_COMPLETION_FAILED');
  const duplicate = await issuanceRepository.prepareIssuance({
    tenantId,
    eventId: paymentEvent,
    orderId: created.order.id,
    paymentId: payment.intent.payment.id,
    correlationId: 'verify-gift-issuance-0002',
    proposedCertificateId: '77777777-7777-4777-8777-777777777777',
    proposedCertificateNumber: 'PH-GC-FEDCBA9876543210',
    proposedActivationTokenDigest: 'b'.repeat(64),
  });
  if (duplicate.outcome !== 'duplicate') throw new Error('ISSUANCE_REPLAY_FAILED');
  const fulfillment = await issuanceRepository.getFulfillment(tenantId, created.order.id, access);
  if (!fulfillment?.certificate.downloadReady || fulfillment.certificate.id !== certificateId) {
    throw new Error('ISSUANCE_READ_MODEL_FAILED');
  }
  const delivery = await issuanceRepository.claimDueDelivery({ tenantId, lockSeconds: 60 });
  if (!delivery || delivery.certificateId !== certificateId) {
    throw new Error('DELIVERY_CLAIM_FAILED');
  }
  await issuanceRepository.markDeliverySandboxed({
    tenantId,
    deliveryId: delivery.id,
    correlationId: 'verify-gift-delivery-0001',
  });

  const evidence = await withTenantTransaction(pool, tenantId, async (client) => {
    const events = await client.query<{ readonly event_type: string; readonly count: string }>(
      `select event_type, count(*)::text as count
         from audit.outbox_events
        where tenant_id = $1 and aggregate_id in ($2, $3, $4)
        group by event_type`,
      [tenantId, created.order.id, payment.intent.payment.id, certificateId],
    );
    const sensitiveAudit = await client.query<{ readonly count: string }>(
      `select count(*)::text as count
         from audit.audit_log
        where tenant_id = $1
          and coalesce(new_value::text, '') ~* 'buyer@example|recipient@example|Sensitive verification'`,
      [tenantId],
    );
    return {
      eventCounts: Object.fromEntries(
        events.rows.map((row) => [row.event_type, Number(row.count)]),
      ),
      sensitiveAuditRows: Number(sensitiveAudit.rows[0]?.count ?? '0'),
    };
  });
  if (
    evidence.eventCounts['gift.order.created.v1'] !== 1 ||
    evidence.eventCounts['commerce.payment.confirmed.v1'] !== 1 ||
    evidence.eventCounts['gift.certificate.issued.v1'] !== 1 ||
    evidence.sensitiveAuditRows !== 0
  ) {
    throw new Error('AUDIT_OUTBOX_VERIFICATION_FAILED');
  }

  const rls = await pool.query<{ readonly qualified_name: string; readonly forced: boolean }>(
    `select n.nspname || '.' || c.relname as qualified_name, c.relforcerowsecurity as forced
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where (n.nspname, c.relname) in (
        ('gift_certificates', 'media_assets'),
        ('gift_certificates', 'media_commands'),
        ('gift_certificates', 'purchase_sessions'),
        ('gift_certificates', 'orders'),
        ('gift_certificates', 'sale_commands'),
        ('gift_certificates', 'certificates'),
        ('gift_certificates', 'artifacts'),
        ('gift_certificates', 'deliveries'),
        ('commerce', 'payment_operations')
      )`,
  );
  if (rls.rows.length !== 9 || rls.rows.some((row) => !row.forced)) {
    throw new Error('FORCED_RLS_VERIFICATION_FAILED');
  }

  process.stdout.write(
    `${JSON.stringify({
      orderStatus: confirmation.confirmation.order.status,
      paymentStatus: confirmation.confirmation.payment.status,
      serverAmountMinor: confirmation.confirmation.order.amountMinor,
      eventCounts: evidence.eventCounts,
      sensitiveAuditRows: evidence.sensitiveAuditRows,
      certificateStatus: fulfillment.certificate.status,
      downloadReady: fulfillment.certificate.downloadReady,
      deliveryStatus: 'SANDBOXED',
      forcedRlsTables: rls.rows.length,
    })}\n`,
  );
} finally {
  await pool.end();
}
