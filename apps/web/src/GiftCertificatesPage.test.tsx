// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GiftCertificatesPage, type GiftCertificateSaleGateway } from './GiftCertificatesPage.js';

const catalog = {
  id: '11111111-1111-4111-8111-111111111111',
  catalogNumber: 3,
  title: 'Подарочные сертификаты',
  availableFrom: null,
  availableTo: null,
  flowSteps: ['DESIGN', 'DENOMINATION', 'MESSAGE', 'DELIVERY', 'REVIEW'] as const,
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
      imageUrl: 'https://cdn.padlhub.test/gift/classic.webp',
      alt: 'Сертификат',
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
  publishedAt: '2026-07-19T10:00:00.000Z',
};

const order = {
  id: '44444444-4444-4444-8444-444444444444',
  orderNumber: 'GC-ABCDEF123456',
  salesChannel: 'PUBLIC_WEB' as const,
  status: 'PAYMENT_PENDING' as const,
  revision: 1,
  catalog: { id: catalog.id, catalogNumber: 3 },
  design: {
    id: catalog.designs[0]!.id,
    key: 'classic',
    title: 'Классический',
    imageUrl: catalog.designs[0]!.imageUrl,
    alt: 'Сертификат',
  },
  amountMinor: 500_000,
  currency: 'RUB' as const,
  policy: catalog.policy,
  buyerEmailMasked: 'b****@example.test',
  recipientName: 'Мария',
  recipientEmailMasked: 'm****@example.test',
  deliveryMode: 'IMMEDIATE' as const,
  scheduledFor: null,
  createdAt: '2026-07-19T10:00:00.000Z',
  paidAt: null,
  replayed: false,
};

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('GiftCertificatesPage', () => {
  it('submits only catalog selectors and recipient input, then exposes the hosted sandbox action', async () => {
    const createOrder = vi.fn().mockResolvedValue(order);
    const createPayment = vi.fn().mockResolvedValue({
      payment: {
        id: '55555555-5555-4555-8555-555555555555',
        orderId: order.id,
        provider: 'PADLHUB_SANDBOX',
        status: 'PENDING',
        amountMinor: 500_000,
        currency: 'RUB',
        createdAt: '2026-07-19T10:00:01.000Z',
        confirmedAt: null,
      },
      nextAction: {
        type: 'REDIRECT',
        url: '/public/api/v1/local-padel/gift-certificate-payment-sandbox/payment-id',
      },
      replayed: false,
    });
    const gateway = {
      getCatalog: vi.fn().mockResolvedValue(catalog),
      createOrder,
      createPayment,
      getOrder: vi.fn(),
      downloadCertificate: vi.fn(),
    } satisfies GiftCertificateSaleGateway;
    render(<GiftCertificatesPage gateway={gateway} surface="public" />);

    const title = await screen.findByRole('heading', { name: 'Идеальный подарок без хлопот' });
    expect(screen.queryByText('Главная')).not.toBeInTheDocument();
    expect(title.querySelector('.gift-sale-title-gradient')).toHaveTextContent('без хлопот');
    fireEvent.change(screen.getByLabelText('Ваша почта'), {
      target: { value: 'buyer@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Имя получателя'), { target: { value: 'Мария' } });
    fireEvent.change(screen.getByLabelText('Почта получателя'), {
      target: { value: 'maria@example.test' },
    });
    fireEvent.click(
      screen.getByLabelText('Принимаю условия тестового оформления и обработку данных заказа.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Оформить тестовый заказ' }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    expect(createOrder.mock.calls[0]?.[0]).toEqual({
      catalogId: catalog.id,
      designId: catalog.designs[0]!.id,
      denominationId: catalog.denominations[0]!.id,
      buyerEmail: 'buyer@example.test',
      recipientName: 'Мария',
      recipientEmail: 'maria@example.test',
      message: null,
      deliveryMode: 'IMMEDIATE',
      scheduledFor: null,
      termsAccepted: true,
    });
    expect(createOrder.mock.calls[0]?.[0]).not.toHaveProperty('amountMinor');
    expect(createPayment).toHaveBeenCalledWith(order.id);
    expect(await screen.findByRole('link', { name: 'Перейти к тестовой оплате' })).toHaveAttribute(
      'href',
      '/public/api/v1/local-padel/gift-certificate-payment-sandbox/payment-id',
    );
  });

  it('renders the layered mobile intro in LK and connects its CTA to the existing designer', async () => {
    const gateway = {
      getCatalog: vi.fn().mockResolvedValue(catalog),
      createOrder: vi.fn(),
      createPayment: vi.fn(),
      getOrder: vi.fn(),
      downloadCertificate: vi.fn(),
    } satisfies GiftCertificateSaleGateway;
    const { container } = render(<GiftCertificatesPage gateway={gateway} surface="user" />);

    expect(await screen.findByRole('heading', { name: 'Подарочная карта' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Пример двух подарочных карт ПадлХАБ' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Идеальный подарок без хлопот' }),
    ).not.toBeInTheDocument();

    const decorations = container.querySelectorAll('.gift-sale-mobile-decor');
    expect(decorations).toHaveLength(4);
    for (const decoration of decorations) {
      expect(decoration).toHaveAttribute('alt', '');
      expect(decoration).toHaveAttribute('aria-hidden', 'true');
    }

    const scrollIntoView = vi.fn();
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Перейти к дизайну' }));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    } finally {
      if (matchMediaDescriptor) {
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
      if (scrollDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor);
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
      }
    }
  });

  it('renders the selected certificate design with its denomination in the order summary', async () => {
    const gateway = {
      getCatalog: vi.fn().mockResolvedValue(catalog),
      createOrder: vi.fn(),
      createPayment: vi.fn(),
      getOrder: vi.fn(),
      downloadCertificate: vi.fn(),
    } satisfies GiftCertificateSaleGateway;
    render(<GiftCertificatesPage gateway={gateway} surface="user" />);

    expect(await screen.findByRole('complementary', { name: 'Ваш выбор' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /Сертификат\. Номинал 5.000.₽/,
      }),
    ).toHaveAttribute('src', catalog.designs[0]!.imageUrl);
  });

  it('recovers a paid order and exposes its private PDF when issuance is ready', async () => {
    window.history.replaceState({}, '', `/?orderId=${order.id}`);
    const getOrder = vi.fn().mockResolvedValue({
      ...order,
      status: 'PAID',
      paidAt: '2026-07-19T10:01:00.000Z',
      fulfillment: {
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
      },
    });
    const gateway = {
      getCatalog: vi.fn().mockResolvedValue(catalog),
      createOrder: vi.fn(),
      createPayment: vi.fn(),
      getOrder,
      downloadCertificate: vi.fn(),
    } satisfies GiftCertificateSaleGateway;

    render(<GiftCertificatesPage gateway={gateway} surface="public" />);

    expect(await screen.findByText('Сертификат PH-GC-0123456789ABCDEF готов')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скачать PDF' })).toBeEnabled();
    expect(screen.getByText(/письмо наружу не отправлялось/)).toBeInTheDocument();
    expect(getOrder).toHaveBeenCalledWith(order.id);
  });
});
