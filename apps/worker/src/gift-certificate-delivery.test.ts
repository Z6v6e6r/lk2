import { describe, expect, it, vi } from 'vitest';

import { runGiftCertificateSandboxDeliveryBatch } from './gift-certificate-delivery.js';

describe('gift certificate sandbox delivery', () => {
  it('journals a due delivery without making an external email call or logging PII', async () => {
    const claimDueDelivery = vi
      .fn()
      .mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        certificateId: '22222222-2222-4222-8222-222222222222',
        certificateNumber: 'PH-GC-0123456789ABCDEF',
        orderNumber: 'GC-ABCDEF123456',
        recipientEmail: 'recipient@example.test',
        recipientName: 'Получатель',
        objectKey: `gift-certificates/22222222-2222-4222-8222-222222222222/${'a'.repeat(64)}.pdf`,
        attemptCount: 1,
      })
      .mockResolvedValueOnce(undefined);
    const markDeliverySandboxed = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), error: vi.fn() };

    await expect(
      runGiftCertificateSandboxDeliveryBatch({
        repository: {
          claimDueDelivery,
          markDeliverySandboxed,
          markDeliveryFailed: vi.fn(),
        },
        logger: logger as never,
        tenantId: '33333333-3333-4333-8333-333333333333',
        batchSize: 10,
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toBe(1);

    expect(markDeliverySandboxed).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain('recipient@example.test');
    expect(logged).not.toContain('Получатель');
  });
});
