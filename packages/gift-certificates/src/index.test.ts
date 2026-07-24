import { describe, expect, it } from 'vitest';

import {
  buildPublicGiftCertificateCatalog,
  createGiftCertificateOrderRequestSchema,
  giftCertificateCatalogInputSchema,
  giftCertificateMediaAssetSchema,
  giftCertificatePublicationIssues,
  type GiftCertificateCatalogInput,
  type GiftCertificateCatalogView,
} from './index.js';

const catalogInput: GiftCertificateCatalogInput = {
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
      imageUrl: 'https://cdn.padlhub.test/gifts/green-court.webp',
      alt: 'Подарочный сертификат на фоне корта',
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

describe('gift certificate catalog contract', () => {
  it('requires a non-ambiguous flow and validity policy', () => {
    expect(giftCertificateCatalogInputSchema.parse(catalogInput)).toMatchObject({
      policy: { validityStart: 'ISSUE', validityDays: 365 },
    });
    expect(
      giftCertificateCatalogInputSchema.safeParse({
        ...catalogInput,
        flowSteps: ['DESIGN', 'DENOMINATION', 'DESIGN', 'REVIEW'],
      }).success,
    ).toBe(false);
    expect(
      giftCertificateCatalogInputSchema.safeParse({
        ...catalogInput,
        policy: {
          ...catalogInput.policy,
          validityStart: 'ACTIVATION',
          activationDeadlineDays: null,
        },
      }).success,
    ).toBe(false);
  });

  it('projects only active published entries to the public catalog', () => {
    const design = catalogInput.designs[0]!;
    const denomination = catalogInput.denominations[0]!;
    const view: GiftCertificateCatalogView = {
      id: '11111111-1111-4111-8111-111111111111',
      catalogNumber: 3,
      status: 'PUBLISHED',
      revision: 2,
      ...catalogInput,
      designs: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          ...design,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          ...design,
          key: 'hidden-design',
          active: false,
        },
      ],
      denominations: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          ...denomination,
        },
      ],
      createdAt: '2026-07-19T08:00:00.000Z',
      updatedAt: '2026-07-19T08:05:00.000Z',
      publishedAt: '2026-07-19T08:05:00.000Z',
      archivedAt: null,
    };
    expect(giftCertificatePublicationIssues(view)).toEqual([]);
    expect(buildPublicGiftCertificateCatalog(view)).toMatchObject({
      catalogNumber: 3,
      designs: [{ key: 'green-court' }],
      denominations: [{ amountMinor: 500_000 }],
    });
  });

  it('accepts only coherent delivery instructions and PadlHub-owned media paths', () => {
    const request = {
      catalogId: '11111111-1111-4111-8111-111111111111',
      designId: '22222222-2222-4222-8222-222222222222',
      denominationId: '33333333-3333-4333-8333-333333333333',
      buyerEmail: 'BUYER@example.test',
      recipientName: 'Мария',
      recipientEmail: 'recipient@example.test',
      message: null,
      deliveryMode: 'IMMEDIATE',
      scheduledFor: null,
      termsAccepted: true,
    } as const;
    expect(createGiftCertificateOrderRequestSchema.parse(request).buyerEmail).toBe(
      'buyer@example.test',
    );
    expect(
      createGiftCertificateOrderRequestSchema.safeParse({
        ...request,
        deliveryMode: 'SCHEDULED',
      }).success,
    ).toBe(false);
    expect(
      giftCertificateMediaAssetSchema.parse({
        id: '44444444-4444-4444-8444-444444444444',
        status: 'READY',
        mediaUrl:
          '/public/api/v1/local-padel/gift-certificate-media/44444444-4444-4444-8444-444444444444',
        contentType: 'image/webp',
        bytes: 1024,
        width: 1200,
        height: 800,
        sha256: 'a'.repeat(64),
        createdAt: '2026-07-19T10:00:00.000Z',
      }).status,
    ).toBe('READY');
  });
});
