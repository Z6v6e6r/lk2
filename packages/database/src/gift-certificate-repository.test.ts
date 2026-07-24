import type { GiftCertificateCatalogInput } from '@phub/gift-certificates';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createGiftCertificateCatalogRepository } from './gift-certificate-repository.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';
const catalogId = '33333333-3333-4333-8333-333333333333';
const designId = '44444444-4444-4444-8444-444444444444';
const denominationId = '55555555-5555-4555-8555-555555555555';
const now = '2026-07-19T10:00:00.000Z';

const catalog: GiftCertificateCatalogInput = {
  title: 'Подарочные сертификаты',
  publicEnabled: true,
  availableFrom: null,
  availableTo: null,
  flowSteps: ['RECIPIENT_KIND', 'DESIGN', 'DENOMINATION', 'DELIVERY', 'REVIEW'],
  policy: {
    validityStart: 'ISSUE',
    validityDays: 365,
    activationDeadlineDays: null,
    scheduledDeliveryEnabled: true,
    emailAttachmentEnabled: false,
  },
  designs: [
    {
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
  denominations: [{ amountMinor: 500_000, currency: 'RUB', active: true, sortOrder: 10 }],
};

function catalogRow(status: 'DRAFT' | 'PUBLISHED' = 'DRAFT') {
  return {
    id: catalogId,
    catalog_number: 1,
    status,
    title: catalog.title,
    public_enabled: true,
    available_from: null,
    available_to: null,
    flow_steps: catalog.flowSteps,
    validity_start: 'ISSUE',
    validity_days: 365,
    activation_deadline_days: null,
    scheduled_delivery_enabled: true,
    email_attachment_enabled: false,
    revision: status === 'PUBLISHED' ? 2 : 1,
    created_at: now,
    updated_at: now,
    published_at: status === 'PUBLISHED' ? now : null,
    archived_at: null,
  };
}

function publicPool(): Pool {
  const client = {
    query: vi.fn((text: string) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      if (text.includes('from gift_certificates.catalog_versions')) {
        return Promise.resolve({ rows: [catalogRow('PUBLISHED')] });
      }
      if (text.includes('from gift_certificates.designs')) {
        return Promise.resolve({
          rows: [
            {
              id: designId,
              design_key: catalog.designs[0]?.key,
              audience: 'UNIVERSAL',
              title: catalog.designs[0]?.title,
              description: null,
              image_url: catalog.designs[0]?.imageUrl,
              alt_text: catalog.designs[0]?.alt,
              code_x_percent: catalog.designs[0]?.codeXPercent,
              code_y_percent: catalog.designs[0]?.codeYPercent,
              amount_x_percent: catalog.designs[0]?.amountXPercent,
              amount_y_percent: catalog.designs[0]?.amountYPercent,
              active: true,
              sort_order: 10,
            },
          ],
        });
      }
      if (text.includes('from gift_certificates.denominations')) {
        return Promise.resolve({
          rows: [
            {
              id: denominationId,
              amount_minor: '500000',
              currency: 'RUB',
              active: true,
              sort_order: 10,
            },
          ],
        });
      }
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

describe('gift certificate catalog repository', () => {
  it('returns a bounded public projection from one published version', async () => {
    const repository = createGiftCertificateCatalogRepository(publicPool());
    await expect(repository.getPublic(tenantId, now)).resolves.toMatchObject({
      id: catalogId,
      catalogNumber: 1,
      designs: [{ id: designId, key: 'green-court' }],
      denominations: [{ id: denominationId, amountMinor: 500_000, currency: 'RUB' }],
    });
  });

  it('parses the command input before opening a write transaction', () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as Pool;
    const repository = createGiftCertificateCatalogRepository(pool);
    expect(() =>
      repository.saveDraft({
        tenantId,
        actorUserId,
        expectedRevision: null,
        idempotencyKey: 'gift-catalog-save-0001',
        requestHash: 'a'.repeat(64),
        correlationId: 'gift-catalog-test',
        catalog: { ...catalog, flowSteps: ['DESIGN', 'DENOMINATION', 'DESIGN'] },
      }),
    ).toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
