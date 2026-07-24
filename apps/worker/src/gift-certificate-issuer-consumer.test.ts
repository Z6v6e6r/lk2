import { describe, expect, it, vi } from 'vitest';

import {
  deriveGiftCertificateActivationCode,
  GIFT_CERTIFICATE_ISSUER_QUEUE,
  registerGiftCertificateIssuerConsumer,
} from './gift-certificate-issuer-consumer.js';

describe('gift certificate issuer consumer', () => {
  it('derives a stable high-entropy display code without exposing the signing secret', () => {
    const input = {
      secret: 'test-gift-certificate-activation-secret',
      tenantId: '11111111-1111-4111-8111-111111111111',
      certificateId: '22222222-2222-4222-8222-222222222222',
    };
    const first = deriveGiftCertificateActivationCode(input);
    expect(first).toBe(deriveGiftCertificateActivationCode(input));
    expect(first).toMatch(/^PHGC(?:-[0-9A-F]{4}){6}$/);
    expect(first).not.toContain(input.secret);
  });

  it('uses a durable bounded queue for verified payment facts only', async () => {
    const channel = {
      assertQueue: vi.fn().mockResolvedValue({}),
      bindQueue: vi.fn().mockResolvedValue({}),
      prefetch: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'gift-certificate-issuer-test' }),
    };
    await expect(
      registerGiftCertificateIssuerConsumer({
        channel: channel as never,
        repository: {} as never,
        store: {} as never,
        activationSecret: 'test-gift-certificate-activation-secret',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      }),
    ).resolves.toBe('gift-certificate-issuer-test');
    expect(channel.assertQueue).toHaveBeenCalledWith(GIFT_CERTIFICATE_ISSUER_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': 'phub.dead-letter',
      },
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      GIFT_CERTIFICATE_ISSUER_QUEUE,
      'phub.events',
      'commerce.payment.confirmed.v1',
    );
  });
});
