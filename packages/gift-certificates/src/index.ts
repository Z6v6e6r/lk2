import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const nullableDateTime = dateTime.nullable();
const nullableText = (maxLength: number) => z.string().trim().min(1).max(maxLength).nullable();

export const giftCertificateCatalogStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export type GiftCertificateCatalogStatus = z.infer<typeof giftCertificateCatalogStatusSchema>;

export const giftCertificateAudienceSchema = z.enum(['FOR_HER', 'FOR_HIM', 'UNIVERSAL']);
export type GiftCertificateAudience = z.infer<typeof giftCertificateAudienceSchema>;

export const giftCertificateFlowStepSchema = z.enum([
  'RECIPIENT_KIND',
  'DESIGN',
  'DENOMINATION',
  'MESSAGE',
  'DELIVERY',
  'REVIEW',
]);
export type GiftCertificateFlowStep = z.infer<typeof giftCertificateFlowStepSchema>;

export const giftCertificateValidityStartSchema = z.enum(['ISSUE', 'ACTIVATION']);
export type GiftCertificateValidityStart = z.infer<typeof giftCertificateValidityStartSchema>;

export const giftCertificateDesignInputSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    audience: giftCertificateAudienceSchema,
    title: z.string().trim().min(1).max(120),
    description: nullableText(500),
    imageUrl: z
      .string()
      .max(2_000)
      .refine(
        (value) =>
          (z.string().url().safeParse(value).success && value.startsWith('https://')) ||
          /^\/public\/api\/v1\/[a-z0-9][a-z0-9-]{1,62}\/gift-certificate-media\/[0-9a-f-]{36}$/.test(
            value,
          ),
        'certificate images must use HTTPS or a PadlHub media path',
      ),
    alt: z.string().trim().min(1).max(180),
    codeXPercent: z.number().min(0).max(100),
    codeYPercent: z.number().min(0).max(100),
    amountXPercent: z.number().min(0).max(100),
    amountYPercent: z.number().min(0).max(100),
    active: z.boolean(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .strict();
export type GiftCertificateDesignInput = z.infer<typeof giftCertificateDesignInputSchema>;

export const giftCertificateDesignViewSchema = giftCertificateDesignInputSchema.extend({
  id: uuid,
});
export type GiftCertificateDesignView = z.infer<typeof giftCertificateDesignViewSchema>;

export const giftCertificateDenominationInputSchema = z
  .object({
    amountMinor: z.number().int().min(10_000).max(100_000_000),
    currency: z.literal('RUB'),
    active: z.boolean(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .strict();
export type GiftCertificateDenominationInput = z.infer<
  typeof giftCertificateDenominationInputSchema
>;

export const giftCertificateDenominationViewSchema = giftCertificateDenominationInputSchema.extend({
  id: uuid,
});
export type GiftCertificateDenominationView = z.infer<typeof giftCertificateDenominationViewSchema>;

export const giftCertificatePolicySchema = z
  .object({
    validityStart: giftCertificateValidityStartSchema,
    validityDays: z.number().int().min(1).max(3_650),
    activationDeadlineDays: z.number().int().min(1).max(3_650).nullable(),
    scheduledDeliveryEnabled: z.boolean(),
    emailAttachmentEnabled: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.validityStart === 'ACTIVATION' && value.activationDeadlineDays === null) {
      context.addIssue({
        code: 'custom',
        path: ['activationDeadlineDays'],
        message: 'activation-based validity requires an activation deadline',
      });
    }
    if (value.validityStart === 'ISSUE' && value.activationDeadlineDays !== null) {
      context.addIssue({
        code: 'custom',
        path: ['activationDeadlineDays'],
        message: 'issue-based validity cannot have a separate activation deadline',
      });
    }
  });
export type GiftCertificatePolicy = z.infer<typeof giftCertificatePolicySchema>;

const catalogFields = {
  title: z.string().trim().min(1).max(160),
  publicEnabled: z.boolean(),
  availableFrom: nullableDateTime,
  availableTo: nullableDateTime,
  flowSteps: z.array(giftCertificateFlowStepSchema).min(3).max(6),
  policy: giftCertificatePolicySchema,
} as const;

function validateCatalogCollections(
  value: {
    readonly availableFrom: string | null;
    readonly availableTo: string | null;
    readonly flowSteps: readonly GiftCertificateFlowStep[];
    readonly designs: readonly GiftCertificateDesignInput[];
    readonly denominations: readonly GiftCertificateDenominationInput[];
  },
  context: z.RefinementCtx,
): void {
  if (
    value.availableFrom !== null &&
    value.availableTo !== null &&
    Date.parse(value.availableTo) <= Date.parse(value.availableFrom)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['availableTo'],
      message: 'catalog availability end must be after its start',
    });
  }

  const seenSteps = new Set<GiftCertificateFlowStep>();
  value.flowSteps.forEach((step, index) => {
    if (seenSteps.has(step)) {
      context.addIssue({
        code: 'custom',
        path: ['flowSteps', index],
        message: 'flow steps must be unique',
      });
    }
    seenSteps.add(step);
  });
  for (const requiredStep of ['DESIGN', 'DENOMINATION', 'REVIEW'] as const) {
    if (!seenSteps.has(requiredStep)) {
      context.addIssue({
        code: 'custom',
        path: ['flowSteps'],
        message: `${requiredStep} is required`,
      });
    }
  }

  const designKeys = new Set<string>();
  value.designs.forEach((design, index) => {
    if (designKeys.has(design.key)) {
      context.addIssue({
        code: 'custom',
        path: ['designs', index, 'key'],
        message: 'design keys must be unique',
      });
    }
    designKeys.add(design.key);
  });

  const denominationAmounts = new Set<number>();
  value.denominations.forEach((denomination, index) => {
    if (denominationAmounts.has(denomination.amountMinor)) {
      context.addIssue({
        code: 'custom',
        path: ['denominations', index, 'amountMinor'],
        message: 'denomination amounts must be unique',
      });
    }
    denominationAmounts.add(denomination.amountMinor);
  });
}

export const giftCertificateCatalogInputSchema = z
  .object({
    ...catalogFields,
    designs: z.array(giftCertificateDesignInputSchema).max(20),
    denominations: z.array(giftCertificateDenominationInputSchema).max(20),
  })
  .strict()
  .superRefine(validateCatalogCollections);
export type GiftCertificateCatalogInput = z.infer<typeof giftCertificateCatalogInputSchema>;

export const giftCertificateCatalogViewSchema = z
  .object({
    id: uuid,
    catalogNumber: z.number().int().positive(),
    status: giftCertificateCatalogStatusSchema,
    revision: z.number().int().positive(),
    ...catalogFields,
    designs: z.array(giftCertificateDesignViewSchema).max(20),
    denominations: z.array(giftCertificateDenominationViewSchema).max(20),
    createdAt: dateTime,
    updatedAt: dateTime,
    publishedAt: nullableDateTime,
    archivedAt: nullableDateTime,
  })
  .strict()
  .superRefine(validateCatalogCollections);
export type GiftCertificateCatalogView = z.infer<typeof giftCertificateCatalogViewSchema>;

export const giftCertificateAdminCatalogStateSchema = z
  .object({
    draft: giftCertificateCatalogViewSchema.nullable(),
    published: giftCertificateCatalogViewSchema.nullable(),
  })
  .strict();
export type GiftCertificateAdminCatalogState = z.infer<
  typeof giftCertificateAdminCatalogStateSchema
>;

export const publicGiftCertificateCatalogSchema = z
  .object({
    id: uuid,
    catalogNumber: z.number().int().positive(),
    title: catalogFields.title,
    availableFrom: nullableDateTime,
    availableTo: nullableDateTime,
    flowSteps: catalogFields.flowSteps,
    policy: giftCertificatePolicySchema,
    designs: z.array(giftCertificateDesignViewSchema).min(1).max(20),
    denominations: z.array(giftCertificateDenominationViewSchema).min(1).max(20),
    publishedAt: dateTime,
  })
  .strict();
export type PublicGiftCertificateCatalog = z.infer<typeof publicGiftCertificateCatalogSchema>;

export const saveGiftCertificateCatalogDraftRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive().nullable(),
    catalog: giftCertificateCatalogInputSchema,
  })
  .strict();
export type SaveGiftCertificateCatalogDraftRequest = z.infer<
  typeof saveGiftCertificateCatalogDraftRequestSchema
>;

export const publishGiftCertificateCatalogRequestSchema = z
  .object({
    catalogId: uuid,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type PublishGiftCertificateCatalogRequest = z.infer<
  typeof publishGiftCertificateCatalogRequestSchema
>;

export type GiftCertificatePublicationIssue = 'active_design' | 'active_denomination';

export function giftCertificatePublicationIssues(
  catalog: Pick<GiftCertificateCatalogView, 'designs' | 'denominations'>,
): readonly GiftCertificatePublicationIssue[] {
  const issues: GiftCertificatePublicationIssue[] = [];
  if (!catalog.designs.some((design) => design.active)) issues.push('active_design');
  if (!catalog.denominations.some((denomination) => denomination.active)) {
    issues.push('active_denomination');
  }
  return issues;
}

export function buildPublicGiftCertificateCatalog(
  catalog: GiftCertificateCatalogView,
): PublicGiftCertificateCatalog {
  if (catalog.status !== 'PUBLISHED' || !catalog.publicEnabled || !catalog.publishedAt) {
    throw new Error('GIFT_CERTIFICATE_CATALOG_NOT_PUBLIC');
  }
  return publicGiftCertificateCatalogSchema.parse({
    id: catalog.id,
    catalogNumber: catalog.catalogNumber,
    title: catalog.title,
    availableFrom: catalog.availableFrom,
    availableTo: catalog.availableTo,
    flowSteps: catalog.flowSteps,
    policy: catalog.policy,
    designs: catalog.designs
      .filter((design) => design.active)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)),
    denominations: catalog.denominations
      .filter((denomination) => denomination.active)
      .sort(
        (left, right) => left.sortOrder - right.sortOrder || left.amountMinor - right.amountMinor,
      ),
    publishedAt: catalog.publishedAt,
  });
}

export const GIFT_CERTIFICATE_CATALOG_DRAFT_SAVED_EVENT = 'gift.catalog.draft_saved.v1';
export const GIFT_CERTIFICATE_CATALOG_PUBLISHED_EVENT = 'gift.catalog.published.v1';

export const giftCertificateSalesChannelSchema = z.enum(['PUBLIC_WEB', 'LK']);
export type GiftCertificateSalesChannel = z.infer<typeof giftCertificateSalesChannelSchema>;

export const giftCertificateOrderStatusSchema = z.enum([
  'PAYMENT_PENDING',
  'PAID',
  'PAYMENT_FAILED',
  'CANCELLED',
]);
export type GiftCertificateOrderStatus = z.infer<typeof giftCertificateOrderStatusSchema>;

export const giftCertificateDeliveryModeSchema = z.enum(['IMMEDIATE', 'SCHEDULED']);
export type GiftCertificateDeliveryMode = z.infer<typeof giftCertificateDeliveryModeSchema>;

export const createGiftCertificateOrderRequestSchema = z
  .object({
    catalogId: uuid,
    designId: uuid,
    denominationId: uuid,
    buyerEmail: z.string().trim().toLowerCase().email().max(320),
    recipientName: z.string().trim().min(1).max(120),
    recipientEmail: z.string().trim().toLowerCase().email().max(320),
    message: nullableText(500),
    deliveryMode: giftCertificateDeliveryModeSchema,
    scheduledFor: nullableDateTime,
    termsAccepted: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.deliveryMode === 'IMMEDIATE' && value.scheduledFor !== null) {
      context.addIssue({
        code: 'custom',
        path: ['scheduledFor'],
        message: 'immediate delivery cannot be scheduled',
      });
    }
    if (value.deliveryMode === 'SCHEDULED' && value.scheduledFor === null) {
      context.addIssue({
        code: 'custom',
        path: ['scheduledFor'],
        message: 'scheduled delivery requires a date',
      });
    }
  });
export type CreateGiftCertificateOrderRequest = z.infer<
  typeof createGiftCertificateOrderRequestSchema
>;

export const giftCertificateOrderViewSchema = z
  .object({
    id: uuid,
    orderNumber: z.string().regex(/^GC-[A-Z0-9]{12}$/),
    salesChannel: giftCertificateSalesChannelSchema,
    status: giftCertificateOrderStatusSchema,
    revision: z.number().int().positive(),
    catalog: z.object({ id: uuid, catalogNumber: z.number().int().positive() }).strict(),
    design: z
      .object({
        id: uuid,
        key: giftCertificateDesignInputSchema.shape.key,
        title: giftCertificateDesignInputSchema.shape.title,
        imageUrl: giftCertificateDesignInputSchema.shape.imageUrl,
        alt: giftCertificateDesignInputSchema.shape.alt,
      })
      .strict(),
    amountMinor: giftCertificateDenominationInputSchema.shape.amountMinor,
    currency: z.literal('RUB'),
    policy: giftCertificatePolicySchema,
    buyerEmailMasked: z.string().min(3).max(320),
    recipientName: z.string().min(1).max(120),
    recipientEmailMasked: z.string().min(3).max(320),
    deliveryMode: giftCertificateDeliveryModeSchema,
    scheduledFor: nullableDateTime,
    createdAt: dateTime,
    paidAt: nullableDateTime,
  })
  .strict();
export type GiftCertificateOrderView = z.infer<typeof giftCertificateOrderViewSchema>;

export const giftCertificatePaymentStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'FAILED']);
export type GiftCertificatePaymentStatus = z.infer<typeof giftCertificatePaymentStatusSchema>;

export const giftCertificatePaymentViewSchema = z
  .object({
    id: uuid,
    orderId: uuid,
    provider: z.literal('PADLHUB_SANDBOX'),
    status: giftCertificatePaymentStatusSchema,
    amountMinor: giftCertificateDenominationInputSchema.shape.amountMinor,
    currency: z.literal('RUB'),
    createdAt: dateTime,
    confirmedAt: nullableDateTime,
  })
  .strict();
export type GiftCertificatePaymentView = z.infer<typeof giftCertificatePaymentViewSchema>;

export const giftCertificatePaymentIntentSchema = z
  .object({
    payment: giftCertificatePaymentViewSchema,
    nextAction: z
      .object({
        type: z.literal('REDIRECT'),
        url: z.string().startsWith('/'),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();
export type GiftCertificatePaymentIntent = z.infer<typeof giftCertificatePaymentIntentSchema>;

export const giftCertificatePaymentConfirmationSchema = z
  .object({
    order: giftCertificateOrderViewSchema,
    payment: giftCertificatePaymentViewSchema,
    replayed: z.boolean(),
  })
  .strict();
export type GiftCertificatePaymentConfirmation = z.infer<
  typeof giftCertificatePaymentConfirmationSchema
>;

export const giftCertificateIssuanceStatusSchema = z.enum(['PREPARING', 'ISSUED', 'VOIDED']);
export type GiftCertificateIssuanceStatus = z.infer<typeof giftCertificateIssuanceStatusSchema>;

export const giftCertificateDeliveryStatusSchema = z.enum([
  'PENDING',
  'SANDBOXED',
  'DELIVERED',
  'FAILED',
]);
export type GiftCertificateDeliveryStatus = z.infer<typeof giftCertificateDeliveryStatusSchema>;

export const giftCertificateFulfillmentViewSchema = z
  .object({
    certificate: z
      .object({
        id: uuid,
        certificateNumber: z.string().regex(/^PH-GC-[A-Z0-9]{16}$/),
        status: giftCertificateIssuanceStatusSchema,
        amountMinor: giftCertificateDenominationInputSchema.shape.amountMinor,
        currency: z.literal('RUB'),
        issuedAt: nullableDateTime,
        validFrom: nullableDateTime,
        validUntil: nullableDateTime,
        activationDeadlineAt: nullableDateTime,
        downloadReady: z.boolean(),
      })
      .strict(),
    delivery: z
      .object({
        status: giftCertificateDeliveryStatusSchema,
        scheduledFor: dateTime,
        deliveredAt: nullableDateTime,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type GiftCertificateFulfillmentView = z.infer<typeof giftCertificateFulfillmentViewSchema>;

export const giftCertificateOrderDetailSchema = giftCertificateOrderViewSchema.extend({
  fulfillment: giftCertificateFulfillmentViewSchema.nullable(),
});
export type GiftCertificateOrderDetail = z.infer<typeof giftCertificateOrderDetailSchema>;

export const giftCertificatePaymentConfirmedEventSchema = z
  .object({
    id: uuid,
    type: z.literal('commerce.payment.confirmed.v1'),
    aggregateId: uuid,
    tenantId: uuid,
    occurredAt: dateTime,
    correlationId: z.string().min(1).max(200),
    payload: z
      .object({
        orderId: uuid,
        paymentId: uuid,
      })
      .strict(),
  })
  .strict();
export type GiftCertificatePaymentConfirmedEvent = z.infer<
  typeof giftCertificatePaymentConfirmedEventSchema
>;

export const giftCertificateMediaAssetSchema = z
  .object({
    id: uuid,
    status: z.literal('READY'),
    mediaUrl: giftCertificateDesignInputSchema.shape.imageUrl,
    contentType: z.literal('image/webp'),
    bytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1_024 * 1_024),
    width: z.number().int().positive().max(2_048),
    height: z.number().int().positive().max(2_048),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: dateTime,
  })
  .strict();
export type GiftCertificateMediaAsset = z.infer<typeof giftCertificateMediaAssetSchema>;

export const GIFT_CERTIFICATE_ORDER_CREATED_EVENT = 'gift.order.created.v1';
export const GIFT_CERTIFICATE_PAYMENT_CONFIRMED_EVENT = 'commerce.payment.confirmed.v1';
export const GIFT_CERTIFICATE_MEDIA_READY_EVENT = 'gift.design_media.ready.v1';
export const GIFT_CERTIFICATE_ISSUED_EVENT = 'gift.certificate.issued.v1';
