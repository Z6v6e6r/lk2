import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';

import { buildAppWithActiveSession } from '../testing/build-test-app.js';

it('full app rejects missing payment idempotency key before the certificate repository', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const config = loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
    JWT_ISSUER: 'phub-identity',
    JWT_AUDIENCE: 'phub-api',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    GIFT_CERTIFICATE_PAYMENT_MODE: 'sandbox',
  });
  const createPayment = vi.fn();
  const app = await buildAppWithActiveSession({
    config,
    logger: createLogger('gift-full-app-key-test', 'silent'),
    pool: { query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }) } as unknown as Pool,
    giftCertificateSaleRepository: {
      createPayment,
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      confirmSandboxPayment: vi.fn(),
    },
  });
  const token = await new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: [],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject('22222222-2222-4222-8222-222222222222')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  try {
    for (const surface of ['user', 'public']) {
      const response = await app.inject({
        method: 'POST',
        url: `/${surface}/api/v1/local-padel/gift-certificate-orders/55555555-5555-4555-8555-555555555555/payment-intents`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    expect(createPayment).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
