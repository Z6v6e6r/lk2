import { randomUUID } from 'node:crypto';

import type { GiftCertificateIssuanceRepository } from '@phub/database';
import type { Logger } from 'pino';

export async function runGiftCertificateSandboxDeliveryBatch(options: {
  readonly repository: Pick<
    GiftCertificateIssuanceRepository,
    'claimDueDelivery' | 'markDeliverySandboxed' | 'markDeliveryFailed'
  >;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
}): Promise<number> {
  let completed = 0;
  for (let index = 0; index < options.batchSize; index += 1) {
    const job = await options.repository.claimDueDelivery({
      tenantId: options.tenantId,
      lockSeconds: 60,
    });
    if (!job) break;
    try {
      // Sandbox deliberately performs no external network call. The durable journal proves
      // scheduling and retry behavior without pretending a real recipient received an email.
      await options.repository.markDeliverySandboxed({
        tenantId: options.tenantId,
        deliveryId: job.id,
        correlationId: randomUUID(),
      });
      completed += 1;
      options.logger.info(
        {
          tenantId: options.tenantId,
          deliveryId: job.id,
          certificateId: job.certificateId,
          mode: 'sandbox',
        },
        'gift certificate email delivery sandboxed',
      );
    } catch (error) {
      const final = job.attemptCount >= options.maxAttempts;
      const delayMs = options.retryBaseMs * 2 ** Math.max(0, job.attemptCount - 1);
      await options.repository.markDeliveryFailed({
        tenantId: options.tenantId,
        deliveryId: job.id,
        errorCode: 'GIFT_CERTIFICATE_EMAIL_SANDBOX_FAILED',
        final,
        retryAt: new Date(Date.now() + delayMs).toISOString(),
      });
      options.logger.error(
        {
          error,
          tenantId: options.tenantId,
          deliveryId: job.id,
          certificateId: job.certificateId,
          final,
        },
        'gift certificate email sandbox delivery failed',
      );
    }
  }
  return completed;
}
