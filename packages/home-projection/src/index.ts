import { communitySummarySchema } from '@phub/communities';
import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const route = z.string().startsWith('/');
const nullableUrl = z.string().url().nullable();
const positiveRevision = z.string().regex(/^[1-9]\d*$/);
const promotionHref = z
  .string()
  .min(1)
  .max(4_000)
  .refine((value) => {
    if (/^(?:\/|#|mailto:|tel:)/i.test(value)) return !/^\/\//.test(value);
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Promotion link must use a supported safe protocol');

export const homeSnapshotSchema = z
  .object({
    version: z.string().min(1).max(100),
    generatedAt: dateTime,
    staleAt: dateTime,
    source: z.enum(['LOCAL_PROJECTION', 'LOCAL_MOCK']),
  })
  .strict();

export const homeProfileSchema = z
  .object({
    userId: uuid,
    displayName: z.string().min(1).max(200),
    firstName: z.string().max(100).nullable().optional(),
    avatarUrl: nullableUrl.optional(),
    phoneLast4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    balanceMinor: z.number().int(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    level: z
      .object({
        label: z.string().min(1).max(20),
        value: z.number().min(0).max(10),
        assessmentRequired: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const homeCountersSchema = z
  .object({
    unreadChats: z.number().int().nonnegative(),
    upcomingEvents: z.number().int().nonnegative(),
    activeSubscriptions: z.number().int().nonnegative(),
  })
  .strict();

export const homeQuickActionSchema = z
  .object({
    id: z.enum(['play', 'group_training', 'tournament', 'individual_training']),
    title: z.string().min(1).max(80),
    subtitle: z.string().max(120).nullable().optional(),
    route,
    tone: z.enum(['violet', 'lime', 'mint', 'sand']),
  })
  .strict();

export const homeUpcomingSchema = z
  .object({
    id: uuid,
    kind: z.enum(['game', 'training', 'tournament']),
    title: z.string().min(1).max(160),
    startsAt: dateTime,
    venue: z.string().min(1).max(160),
    status: z.enum(['confirmed', 'waitlist', 'payment_required']),
    route,
  })
  .strict();

export const homeSubscriptionSchema = z
  .object({
    id: uuid,
    title: z.string().min(1).max(160),
    status: z.enum(['active', 'scheduled', 'paused', 'exhausted', 'expired']),
    remainingUnits: z.number().int().nonnegative(),
    validUntil: dateTime.nullable(),
    route,
  })
  .strict();

export const homeCommunitySchema = communitySummarySchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCommunitySummaries(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return (value as readonly unknown[]).slice(0, 5).map((community) => {
    if (!isRecord(community)) return community;
    if ('isVerified' in community && 'unreadChatCount' in community) return community;
    return {
      id: community.id,
      title: community.title,
      logoUrl: community.logoUrl ?? null,
      // The previous Home projection did not own verification truth. Fail closed until
      // the community read model refreshes this component.
      isVerified: false,
      unreadChatCount:
        typeof community.unreadCount === 'number' && Number.isInteger(community.unreadCount)
          ? Math.max(0, community.unreadCount)
          : 0,
      route: community.route,
    };
  });
}

/**
 * Expand/migrate compatibility for Home snapshots persisted before the community summary was
 * reduced. This can be removed after every stored snapshot has been rebuilt with the new shape.
 */
export const homePromotionSchema = z
  .object({
    id: uuid,
    eyebrow: z.string().min(1).max(40),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(220),
    actionLabel: z.string().min(1).max(60),
    route: promotionHref,
    tone: z.enum(['violet', 'lime', 'mint', 'sand']),
    imageUrl: nullableUrl.optional(),
    mobileImageUrl: nullableUrl.optional(),
  })
  .strict();

export const homePromotionDeckSchema = z
  .object({
    rotationEnabled: z.boolean(),
    intervalSeconds: z.number().int().min(3).max(30),
    items: z.array(homePromotionSchema).max(20),
  })
  .strict();

function normalizePromotionDeck(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.items)) return value;
  if (value === null || value === undefined) {
    return { rotationEnabled: false, intervalSeconds: 6, items: [] };
  }
  return { rotationEnabled: false, intervalSeconds: 6, items: [value] };
}

function firstPromotion(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = value.items as readonly unknown[];
  return items[0] ?? null;
}

/**
 * Expand/migrate compatibility for Home snapshots persisted before communities were reduced and
 * before the CUP advertising placement became a rotatable deck. Remove only after every stored
 * snapshot has been rebuilt with the expanded contract.
 */
export function normalizeHomeDashboardPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const promotions = normalizePromotionDeck(value.promotions ?? value.promotion);
  return {
    ...value,
    ...('communities' in value
      ? { communities: normalizeCommunitySummaries(value.communities) }
      : {}),
    promotions,
    promotion: value.promotion ?? firstPromotion(promotions),
  };
}

/** Compatibility for component rows that can outlive the API process during rollout. */
export function normalizeHomeProjectionComponentPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.component === 'communities') {
    return { ...value, value: normalizeCommunitySummaries(value.value) };
  }
  if (value.component === 'promotion') {
    return { ...value, value: normalizePromotionDeck(value.value) };
  }
  return value;
}

export const homeLocationSchema = z
  .object({
    id: uuid,
    title: z.string().min(1).max(120),
    courtCount: z.number().int().min(1),
    imageUrl: nullableUrl,
    route,
  })
  .strict();

export const homeAdditionalLinkSchema = z
  .object({
    id: z.enum(['promotions', 'gift_certificates', 'offers']),
    title: z.string().min(1).max(80),
    route,
  })
  .strict();

export const homeCapabilitiesSchema = z
  .object({
    canCreateGame: z.boolean(),
    canManageTournaments: z.boolean(),
    canViewCommunities: z.boolean(),
  })
  .strict();

export const homeDashboardSchema = z
  .object({
    snapshot: homeSnapshotSchema,
    profile: homeProfileSchema,
    counters: homeCountersSchema,
    quickActions: z.array(homeQuickActionSchema).max(4),
    upcoming: z.array(homeUpcomingSchema).max(6),
    subscriptions: z.array(homeSubscriptionSchema).max(6),
    communities: z.array(homeCommunitySchema).max(5),
    /** @deprecated Kept during the expand/migrate window for older clients. */
    promotion: homePromotionSchema.nullable(),
    promotions: homePromotionDeckSchema,
    locations: z.array(homeLocationSchema).max(8),
    additionalLinks: z.array(homeAdditionalLinkSchema).max(6),
    capabilities: homeCapabilitiesSchema,
  })
  .strict();

export type HomeDashboard = z.infer<typeof homeDashboardSchema>;

export const HOME_PROJECTION_COMPONENT_EVENT = 'home.projection.component.changed.v1';

export const HOME_PROJECTION_COMPONENTS = [
  'profile',
  'messaging',
  'upcoming',
  'subscriptions',
  'communities',
  'promotion',
  'locations',
  'navigation',
  'capabilities',
] as const;

export type HomeProjectionComponent = (typeof HOME_PROJECTION_COMPONENTS)[number];

const componentBaseSchema = z.object({
  userId: uuid,
  componentRevision: positiveRevision,
});

export const homeProjectionComponentPayloadSchema = z.discriminatedUnion('component', [
  componentBaseSchema
    .extend({ component: z.literal('profile'), value: homeProfileSchema })
    .strict(),
  componentBaseSchema
    .extend({
      component: z.literal('messaging'),
      value: z.object({ unreadChats: z.number().int().nonnegative() }).strict(),
    })
    .strict(),
  componentBaseSchema
    .extend({ component: z.literal('upcoming'), value: z.array(homeUpcomingSchema).max(6) })
    .strict(),
  componentBaseSchema
    .extend({
      component: z.literal('subscriptions'),
      value: z.array(homeSubscriptionSchema).max(6),
    })
    .strict(),
  componentBaseSchema
    .extend({
      component: z.literal('communities'),
      value: z.array(homeCommunitySchema).max(5),
    })
    .strict(),
  componentBaseSchema
    .extend({ component: z.literal('promotion'), value: homePromotionDeckSchema })
    .strict(),
  componentBaseSchema
    .extend({ component: z.literal('locations'), value: z.array(homeLocationSchema).max(8) })
    .strict(),
  componentBaseSchema
    .extend({
      component: z.literal('navigation'),
      value: z
        .object({
          quickActions: z.array(homeQuickActionSchema).max(4),
          additionalLinks: z.array(homeAdditionalLinkSchema).max(6),
        })
        .strict(),
    })
    .strict(),
  componentBaseSchema
    .extend({ component: z.literal('capabilities'), value: homeCapabilitiesSchema })
    .strict(),
]);

export type HomeProjectionComponentPayload = z.infer<typeof homeProjectionComponentPayloadSchema>;

export const homeProjectionEventSchema = z
  .object({
    id: uuid,
    type: z.literal(HOME_PROJECTION_COMPONENT_EVENT),
    aggregateId: uuid,
    tenantId: uuid,
    occurredAt: dateTime,
    correlationId: z.string().min(8).max(128),
    payload: homeProjectionComponentPayloadSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.aggregateId !== event.payload.userId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'aggregateId must match payload.userId',
      });
    }
    if (
      event.payload.component === 'profile' &&
      event.payload.value.userId !== event.payload.userId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'value', 'userId'],
        message: 'profile userId must match payload.userId',
      });
    }
  });

export type HomeProjectionEvent = z.infer<typeof homeProjectionEventSchema>;

export type HomeProjectionBuildResult =
  | { readonly ready: false; readonly missing: readonly HomeProjectionComponent[] }
  | { readonly ready: true; readonly dashboard: HomeDashboard };

export function buildHomeProjection(input: {
  readonly components: readonly HomeProjectionComponentPayload[];
  readonly sourceRevision: string;
  readonly generatedAt: Date;
  readonly ttlSeconds: number;
}): HomeProjectionBuildResult {
  const values = new Map<HomeProjectionComponent, unknown>();
  for (const component of input.components) values.set(component.component, component.value);
  const missing = HOME_PROJECTION_COMPONENTS.filter((component) => !values.has(component));
  if (missing.length > 0) return { ready: false, missing };

  const profile = homeProfileSchema.parse(values.get('profile'));
  const messaging = z
    .object({ unreadChats: z.number().int().nonnegative() })
    .strict()
    .parse(values.get('messaging'));
  const upcoming = z.array(homeUpcomingSchema).max(6).parse(values.get('upcoming'));
  const subscriptions = z.array(homeSubscriptionSchema).max(6).parse(values.get('subscriptions'));
  const promotions = homePromotionDeckSchema.parse(values.get('promotion'));
  const navigation = z
    .object({
      quickActions: z.array(homeQuickActionSchema).max(4),
      additionalLinks: z.array(homeAdditionalLinkSchema).max(6),
    })
    .strict()
    .parse(values.get('navigation'));
  const generatedAt = input.generatedAt.toISOString();

  return {
    ready: true,
    dashboard: homeDashboardSchema.parse({
      snapshot: {
        version: `home-v1-${input.sourceRevision}`,
        generatedAt,
        staleAt: new Date(input.generatedAt.getTime() + input.ttlSeconds * 1_000).toISOString(),
        source: 'LOCAL_PROJECTION',
      },
      profile,
      counters: {
        unreadChats: messaging.unreadChats,
        upcomingEvents: upcoming.length,
        activeSubscriptions: subscriptions.filter((item) => item.status === 'active').length,
      },
      quickActions: navigation.quickActions,
      upcoming,
      subscriptions,
      communities: values.get('communities'),
      promotion: promotions.items[0] ?? null,
      promotions,
      locations: values.get('locations'),
      additionalLinks: navigation.additionalLinks,
      capabilities: values.get('capabilities'),
    }),
  };
}
