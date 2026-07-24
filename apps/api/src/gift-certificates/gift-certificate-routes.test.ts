import type { GiftCertificateCatalogRepository } from '@phub/database';
import type { PublicGiftCertificateCatalog } from '@phub/gift-certificates';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '11111111-1111-4111-8111-111111111111';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

const catalog: PublicGiftCertificateCatalog = {
  id: '22222222-2222-4222-8222-222222222222',
  catalogNumber: 1,
  title: 'Подарочные сертификаты',
  availableFrom: null,
  availableTo: null,
  flowSteps: ['DESIGN', 'DENOMINATION', 'REVIEW'],
  policy: {
    validityStart: 'ISSUE',
    validityDays: 365,
    activationDeadlineDays: null,
    scheduledDeliveryEnabled: true,
    emailAttachmentEnabled: false,
  },
  designs: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      key: 'green-court',
      audience: 'UNIVERSAL',
      title: 'Зелёный корт',
      description: null,
      imageUrl: 'https://cdn.padlhub.test/gifts/green.webp',
      alt: 'Сертификат на фоне корта',
      codeXPercent: 5.1,
      codeYPercent: 88,
      amountXPercent: 78.3,
      amountYPercent: 88,
      active: true,
      sortOrder: 10,
    },
  ],
  denominations: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      amountMinor: 500_000,
      currency: 'RUB',
      active: true,
      sortOrder: 10,
    },
  ],
  publishedAt: '2026-07-19T10:00:00.000Z',
};

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

function repository(publicCatalog: PublicGiftCertificateCatalog | undefined) {
  return {
    getAdminState: vi.fn(),
    getPublic: vi.fn().mockResolvedValue(publicCatalog),
    saveDraft: vi.fn(),
    publishDraft: vi.fn(),
  } satisfies GiftCertificateCatalogRepository;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('public gift certificate catalog', () => {
  it('returns only the published server-owned catalog without authentication', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('gift-catalog-public-test', 'silent'),
      pool: fakePool(),
      giftCertificateCatalogRepository: repository(catalog),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/gift-certificate-catalog',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('public');
    expect(response.json()).toMatchObject({
      catalogNumber: 1,
      designs: [{ key: 'green-court' }],
      denominations: [{ amountMinor: 500_000, currency: 'RUB' }],
    });
    expect(response.body).not.toContain('provider');
  });

  it('fails closed until a public catalog is explicitly published', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('gift-catalog-public-test', 'silent'),
      pool: fakePool(),
      giftCertificateCatalogRepository: repository(undefined),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/gift-certificate-catalog',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'GIFT_CERTIFICATE_CATALOG_NOT_PUBLISHED' });
  });
});
