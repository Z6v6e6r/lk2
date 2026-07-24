import type { GiftCertificateSaleRepository } from '@phub/database';
import type { GiftCertificateOrderView } from '@phub/gift-certificates';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const catalogId = '22222222-2222-4222-8222-222222222222';
const designId = '33333333-3333-4333-8333-333333333333';
const denominationId = '44444444-4444-4444-8444-444444444444';
const orderId = '55555555-5555-4555-8555-555555555555';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

const baseEnvironment = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
} as const;

const order: GiftCertificateOrderView = {
  id: orderId,
  orderNumber: 'GC-ABCDEF123456',
  salesChannel: 'PUBLIC_WEB',
  status: 'PAYMENT_PENDING',
  revision: 1,
  catalog: { id: catalogId, catalogNumber: 7 },
  design: {
    id: designId,
    key: 'classic',
    title: 'Классический',
    imageUrl: 'https://cdn.padlhub.test/gift/classic.webp',
    alt: 'Сертификат',
  },
  amountMinor: 500_000,
  currency: 'RUB',
  policy: {
    validityStart: 'ISSUE',
    validityDays: 365,
    activationDeadlineDays: null,
    scheduledDeliveryEnabled: true,
    emailAttachmentEnabled: true,
  },
  buyerEmailMasked: 'b****@example.test',
  recipientName: 'Мария',
  recipientEmailMasked: 'r******@example.test',
  deliveryMode: 'IMMEDIATE',
  scheduledFor: null,
  createdAt: '2026-07-19T10:00:00.000Z',
  paidAt: null,
};

const request = {
  catalogId,
  designId,
  denominationId,
  buyerEmail: 'buyer@example.test',
  recipientName: 'Мария',
  recipientEmail: 'recipient@example.test',
  message: 'С праздником!',
  deliveryMode: 'IMMEDIATE' as const,
  scheduledFor: null,
  termsAccepted: true,
};

function fakePool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }),
  } as unknown as Pool;
}

function repository() {
  const createOrder = vi
    .fn<GiftCertificateSaleRepository['createOrder']>()
    .mockResolvedValue({ outcome: 'applied', order, replayed: false } as const);
  return {
    value: {
      createOrder,
      getOrder: vi.fn<GiftCertificateSaleRepository['getOrder']>(),
      createPayment: vi.fn<GiftCertificateSaleRepository['createPayment']>(),
      confirmSandboxPayment: vi.fn<GiftCertificateSaleRepository['confirmSandboxPayment']>(),
    } satisfies GiftCertificateSaleRepository,
    createOrder,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('gift certificate sale routes', () => {
  it('creates an anonymous order behind a scoped HttpOnly purchase session', async () => {
    const sale = repository();
    const app = await buildApp({
      config: loadConfig({ ...baseEnvironment, GIFT_CERTIFICATE_PAYMENT_MODE: 'sandbox' }),
      logger: createLogger('gift-sale-route-test', 'silent'),
      pool: fakePool(),
      giftCertificateSaleRepository: sale.value,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/public/api/v1/local-padel/gift-certificate-orders',
      headers: { 'idempotency-key': 'gift-order-public-0001' },
      payload: request,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: orderId, amountMinor: 500_000, replayed: false });
    expect(response.headers['set-cookie']).toContain('phub_gift_purchase=');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(response.headers['set-cookie']).not.toContain('buyer@example.test');
    const createdInput = sale.createOrder.mock.calls[0]?.[0];
    expect(createdInput).toMatchObject({ tenantId, salesChannel: 'PUBLIC_WEB', order: request });
    if (!createdInput || !('purchaseSessionHash' in createdInput.access)) {
      throw new Error('Expected an anonymous purchase session');
    }
    expect(createdInput.access.purchaseSessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createdInput).not.toHaveProperty('amountMinor');
  });

  it('physically disables the hosted payment sandbox when the runtime flag is off', async () => {
    const sale = repository();
    const app = await buildApp({
      config: loadConfig(baseEnvironment),
      logger: createLogger('gift-sale-route-test', 'silent'),
      pool: fakePool(),
      giftCertificateSaleRepository: sale.value,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/public/api/v1/local-padel/gift-certificate-orders/${orderId}/payment-intents`,
      headers: { 'idempotency-key': 'gift-payment-public-0001' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'GIFT_PAYMENT_SANDBOX_DISABLED' });
    expect(sale.value.createPayment).not.toHaveBeenCalled();
  });

  it('returns issuance state and signs only a session-owned ready PDF', async () => {
    const sale = repository();
    sale.value.getOrder = vi.fn().mockResolvedValue({
      ...order,
      status: 'PAID',
      paidAt: '2026-07-19T10:01:00.000Z',
    });
    const fulfillment = {
      certificate: {
        id: '66666666-6666-4666-8666-666666666666',
        certificateNumber: 'PH-GC-0123456789ABCDEF',
        status: 'ISSUED',
        amountMinor: 500_000,
        currency: 'RUB',
        issuedAt: '2026-07-19T10:01:01.000Z',
        validFrom: '2026-07-19T10:01:01.000Z',
        validUntil: '2027-07-19T10:01:01.000Z',
        activationDeadlineAt: null,
        downloadReady: true,
      },
      delivery: {
        status: 'SANDBOXED',
        scheduledFor: '2026-07-19T10:01:01.000Z',
        deliveredAt: '2026-07-19T10:01:02.000Z',
      },
    } as const;
    const issuanceRepository = {
      getFulfillment: vi.fn().mockResolvedValue(fulfillment),
      getArtifactForOwnedOrder: vi.fn().mockResolvedValue({
        certificateId: fulfillment.certificate.id,
        certificateNumber: fulfillment.certificate.certificateNumber,
        objectKey: `gift-certificates/${fulfillment.certificate.id}/${'a'.repeat(64)}.pdf`,
      }),
    };
    const artifactStore = {
      readPdf: vi
        .fn()
        .mockResolvedValue(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(1_019)])),
    };
    const app = await buildApp({
      config: loadConfig({
        ...baseEnvironment,
        GIFT_CERTIFICATE_ISSUANCE_ENABLED: 'true',
        GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET: 'test-gift-certificate-activation-secret',
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'padlhub-media',
        S3_ACCESS_KEY: 'padlhub',
        S3_SECRET_KEY: 'test-secret',
      }),
      logger: createLogger('gift-sale-route-test', 'silent'),
      pool: fakePool(),
      giftCertificateSaleRepository: sale.value,
      giftCertificateIssuanceRepository: issuanceRepository as never,
      giftCertificateArtifactStore: artifactStore,
    });
    apps.push(app);
    const cookie = `phub_gift_purchase=${'a'.repeat(43)}`;

    const detail = await app.inject({
      method: 'GET',
      url: `/public/api/v1/local-padel/gift-certificate-orders/${orderId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ fulfillment });

    const download = await app.inject({
      method: 'GET',
      url: `/public/api/v1/local-padel/gift-certificate-orders/${orderId}/certificate.pdf`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['content-disposition']).toBe(
      'attachment; filename="PH-GC-0123456789ABCDEF.pdf"',
    );
    expect(download.headers['cache-control']).toBe('private, no-store');
  });
});
