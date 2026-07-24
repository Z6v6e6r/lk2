// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GiftCertificateWorkspace } from './GiftCertificateWorkspace.js';
import type { NotificationAdminClient } from './notification-admin-client.js';

const draft = {
  id: '11111111-1111-4111-8111-111111111111',
  catalogNumber: 1,
  status: 'DRAFT' as const,
  revision: 2,
  title: 'Подарочные сертификаты',
  publicEnabled: true,
  availableFrom: null,
  availableTo: null,
  flowSteps: ['DESIGN', 'DENOMINATION', 'REVIEW'] as const,
  policy: {
    validityStart: 'ISSUE' as const,
    validityDays: 365,
    activationDeadlineDays: null,
    scheduledDeliveryEnabled: true,
    emailAttachmentEnabled: true,
  },
  designs: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      key: 'classic',
      audience: 'UNIVERSAL' as const,
      title: 'Классический',
      description: null,
      imageUrl: 'https://cdn.padlhub.test/gifts/classic.webp',
      alt: 'Подарочный сертификат ПаделХАБ',
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
      id: '33333333-3333-4333-8333-333333333333',
      amountMinor: 500_000,
      currency: 'RUB' as const,
      active: true,
      sortOrder: 10,
    },
  ],
  createdAt: '2026-07-19T07:00:00.000Z',
  updatedAt: '2026-07-19T07:10:00.000Z',
  publishedAt: null,
  archivedAt: null,
};

afterEach(cleanup);

describe('GiftCertificateWorkspace', () => {
  it('loads a valid draft and requires saving edits before publication', async () => {
    const client = {
      getGiftCertificateCatalogState: vi.fn().mockResolvedValue({ draft, published: null }),
      saveGiftCertificateCatalogDraft: vi.fn(),
      publishGiftCertificateCatalogDraft: vi.fn(),
    } as unknown as NotificationAdminClient;

    render(<GiftCertificateWorkspace client={client} />);

    const publish = await screen.findByRole('button', { name: 'Опубликовать' });
    expect(publish).toBeEnabled();
    expect(screen.getByDisplayValue('Подарочные сертификаты')).toBeInTheDocument();
    expect(screen.getByText(/5.000 ₽/)).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Подарочные сертификаты'), {
      target: { value: 'Новая витрина' },
    });

    expect(publish).toBeDisabled();
    expect(screen.getByText('Есть изменения')).toBeInTheDocument();
  });

  it('uploads a design image and stores only its stable PadlHub media URL in the draft', async () => {
    const mediaUrl =
      '/public/api/v1/local-padel/gift-certificate-media/44444444-4444-4444-8444-444444444444';
    const uploadGiftCertificateMedia = vi.fn().mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      status: 'READY',
      mediaUrl,
      contentType: 'image/webp',
      bytes: 1200,
      width: 800,
      height: 500,
      sha256: 'a'.repeat(64),
      createdAt: '2026-07-19T10:00:00.000Z',
      replayed: false,
    });
    const client = {
      getGiftCertificateCatalogState: vi.fn().mockResolvedValue({ draft, published: null }),
      saveGiftCertificateCatalogDraft: vi.fn(),
      publishGiftCertificateCatalogDraft: vi.fn(),
      uploadGiftCertificateMedia,
    } as unknown as NotificationAdminClient;
    render(<GiftCertificateWorkspace client={client} />);
    const input = await screen.findByLabelText('Загрузить изображение для дизайна Классический');
    const file = new File(['png-bytes'], 'design.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadGiftCertificateMedia).toHaveBeenCalledWith(file));
    expect(await screen.findByDisplayValue(mediaUrl)).toBeInTheDocument();
    expect(screen.getByText('Изображение загружено.')).toBeInTheDocument();
  });
});
