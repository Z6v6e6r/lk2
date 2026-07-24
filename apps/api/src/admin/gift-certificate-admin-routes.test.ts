import type { GiftCertificateCatalogRepository } from '@phub/database';
import type { GiftCertificateCatalogView } from '@phub/gift-certificates';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
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
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

const draft: GiftCertificateCatalogView = {
  id: '33333333-3333-4333-8333-333333333333',
  catalogNumber: 1,
  status: 'DRAFT',
  revision: 1,
  title: 'Подарочные сертификаты',
  publicEnabled: false,
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
  designs: [],
  denominations: [],
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:00:00.000Z',
  publishedAt: null,
  archivedAt: null,
};

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(permissions: readonly string[]): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['admin'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_ADMIN_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function repository() {
  const saveDraft = vi
    .fn()
    .mockResolvedValue({ outcome: 'applied', catalog: draft, replayed: false });
  return {
    value: {
      getAdminState: vi.fn().mockResolvedValue({ draft, published: null }),
      getPublic: vi.fn(),
      saveDraft,
      publishDraft: vi.fn(),
    } satisfies GiftCertificateCatalogRepository,
    saveDraft,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('gift certificate catalog admin routes', () => {
  it('saves an audited draft with a CUP token and idempotency key', async () => {
    const giftRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('gift-catalog-admin-test', 'silent'),
      pool: fakePool(),
      giftCertificateCatalogRepository: giftRepository.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/admin/api/v1/local-padel/gift-certificate-catalog/draft',
      headers: {
        authorization: `Bearer ${await token(['gift_certificates.catalog.manage'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'gift-catalog-save-0001',
      },
      payload: {
        expectedRevision: null,
        catalog: {
          title: draft.title,
          publicEnabled: draft.publicEnabled,
          availableFrom: null,
          availableTo: null,
          flowSteps: draft.flowSteps,
          policy: draft.policy,
          designs: [],
          denominations: [],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: draft.id, replayed: false });
    expect(giftRepository.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId: userId, expectedRevision: null }),
    );
  });

  it('does not let catalog managers publish without the publish permission', async () => {
    const giftRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('gift-catalog-admin-test', 'silent'),
      pool: fakePool(),
      giftCertificateCatalogRepository: giftRepository.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/gift-certificate-catalog/draft/publish',
      headers: {
        authorization: `Bearer ${await token(['gift_certificates.catalog.manage'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'gift-catalog-publish-denied-0001',
      },
      payload: { catalogId: draft.id, expectedRevision: draft.revision },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'GIFT_CERTIFICATE_CATALOG_PERMISSION_REQUIRED',
    });
    expect(giftRepository.value.publishDraft).not.toHaveBeenCalled();
  });
});
