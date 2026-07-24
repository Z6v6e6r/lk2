import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { GiftCertificateIssuanceRepository } from '@phub/database';
import { giftCertificatePaymentConfirmedEventSchema } from '@phub/gift-certificates';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import sharp from 'sharp';

import type { GiftCertificateArtifactStore } from './gift-certificate-artifact-store.js';
import { renderGiftCertificatePdf } from './gift-certificate-pdf.js';

export const GIFT_CERTIFICATE_ISSUER_QUEUE = 'phub.gift-certificate-issuer.v1';

export function deriveGiftCertificateActivationCode(input: {
  readonly secret: string;
  readonly tenantId: string;
  readonly certificateId: string;
}): string {
  const value = createHmac('sha256', input.secret)
    .update(`${input.tenantId}:${input.certificateId}:activation:v1`)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return `PHGC-${value.match(/.{1,4}/g)?.join('-') ?? value}`;
}

function activationDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function certificateNumber(certificateId: string): string {
  return `PH-GC-${certificateId.replaceAll('-', '').slice(0, 16).toUpperCase()}`;
}

function mediaAssetId(value: string): string | undefined {
  return /\/gift-certificate-media\/([0-9a-f-]{36})$/i.exec(value)?.[1];
}

async function designImage(options: {
  readonly repository: Pick<GiftCertificateIssuanceRepository, 'getDesignMediaObjectKey'>;
  readonly store: GiftCertificateArtifactStore;
  readonly tenantId: string;
  readonly imageUrl: string;
}): Promise<Buffer | undefined> {
  const assetId = mediaAssetId(options.imageUrl);
  if (!assetId) return undefined;
  const objectKey = await options.repository.getDesignMediaObjectKey(options.tenantId, assetId);
  if (!objectKey) return undefined;
  const source = await options.store.readPrivateObject(objectKey, 8 * 1_024 * 1_024);
  return sharp(source)
    .rotate()
    .resize(1990, 1280, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();
}

async function handleMessage(options: {
  readonly channel: Channel;
  readonly repository: GiftCertificateIssuanceRepository;
  readonly store: GiftCertificateArtifactStore;
  readonly activationSecret: string;
  readonly logger: Logger;
  readonly message: ConsumeMessage;
}): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(options.message.content.toString('utf8')) as unknown;
  } catch {
    options.logger.warn(
      { messageId: options.message.properties.messageId },
      'invalid gift payment event JSON sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  const parsed = giftCertificatePaymentConfirmedEventSchema.safeParse(decoded);
  if (!parsed.success) {
    options.logger.warn(
      {
        messageId: options.message.properties.messageId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      },
      'invalid gift payment event contract sent to dead letter',
    );
    options.channel.nack(options.message, false, false);
    return;
  }
  const event = parsed.data;
  const proposedCertificateId = randomUUID();
  const proposedCode = deriveGiftCertificateActivationCode({
    secret: options.activationSecret,
    tenantId: event.tenantId,
    certificateId: proposedCertificateId,
  });
  try {
    const prepared = await options.repository.prepareIssuance({
      tenantId: event.tenantId,
      eventId: event.id,
      orderId: event.payload.orderId,
      paymentId: event.payload.paymentId,
      correlationId: event.correlationId,
      proposedCertificateId,
      proposedCertificateNumber: certificateNumber(proposedCertificateId),
      proposedActivationTokenDigest: activationDigest(proposedCode),
    });
    if (prepared.outcome === 'duplicate') {
      options.channel.ack(options.message);
      return;
    }
    if (prepared.outcome === 'dependency_missing') {
      throw new Error('GIFT_CERTIFICATE_ISSUANCE_DEPENDENCY_MISSING');
    }
    const document = prepared.document;
    const activationCode = deriveGiftCertificateActivationCode({
      secret: options.activationSecret,
      tenantId: document.tenantId,
      certificateId: document.certificateId,
    });
    if (activationDigest(activationCode) !== document.activationTokenDigest) {
      throw new Error('GIFT_CERTIFICATE_ACTIVATION_SECRET_MISMATCH');
    }
    const designImagePng = await designImage({
      repository: options.repository,
      store: options.store,
      tenantId: document.tenantId,
      imageUrl: document.designImageUrl,
    });
    const pdf = await renderGiftCertificatePdf({
      certificateNumber: document.certificateNumber,
      activationCode,
      recipientName: document.recipientName,
      recipientMessage: document.recipientMessage,
      designTitle: document.designTitle,
      amountMinor: document.amountMinor,
      codeXPercent: document.codeXPercent,
      codeYPercent: document.codeYPercent,
      amountXPercent: document.amountXPercent,
      amountYPercent: document.amountYPercent,
      validityStart: document.policy.validityStart,
      validityDays: document.policy.validityDays,
      activationDeadlineDays: document.policy.activationDeadlineDays,
      ...(designImagePng ? { designImagePng } : {}),
    });
    const contentSha256 = createHash('sha256').update(pdf).digest('hex');
    const objectKey = `gift-certificates/${document.certificateId}/${contentSha256}.pdf`;
    await options.store.putPdf({
      key: objectKey,
      body: pdf,
      sha256: contentSha256,
      certificateNumber: document.certificateNumber,
    });
    const result = await options.repository.completeIssuance({
      tenantId: document.tenantId,
      eventId: document.eventId,
      certificateId: document.certificateId,
      contentSha256,
      objectKey,
      byteSize: pdf.length,
      correlationId: document.correlationId,
    });
    options.channel.ack(options.message);
    options.logger.info(
      {
        eventId: event.id,
        tenantId: event.tenantId,
        orderId: document.orderId,
        certificateId: document.certificateId,
        result,
      },
      'gift certificate issuance event processed',
    );
  } catch (error) {
    options.logger.error(
      { error, eventId: event.id, tenantId: event.tenantId, orderId: event.payload.orderId },
      'gift certificate issuance failed and will be retried',
    );
    options.channel.nack(options.message, false, true);
  }
}

export async function registerGiftCertificateIssuerConsumer(options: {
  readonly channel: Channel;
  readonly repository: GiftCertificateIssuanceRepository;
  readonly store: GiftCertificateArtifactStore;
  readonly activationSecret: string;
  readonly logger: Logger;
}): Promise<string> {
  await options.channel.assertQueue(GIFT_CERTIFICATE_ISSUER_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': 'phub.dead-letter',
    },
  });
  await options.channel.bindQueue(
    GIFT_CERTIFICATE_ISSUER_QUEUE,
    'phub.events',
    'commerce.payment.confirmed.v1',
  );
  await options.channel.prefetch(1);
  const consumer = await options.channel.consume(
    GIFT_CERTIFICATE_ISSUER_QUEUE,
    (message) => {
      if (message) void handleMessage({ ...options, message });
    },
    { noAck: false },
  );
  return consumer.consumerTag;
}
