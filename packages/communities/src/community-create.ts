import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });

export const COMMUNITY_CREATED_EVENT = 'community.created.v1' as const;
export const COMMUNITY_CREATE_QUOTA_GRANT_CREATED_EVENT =
  'community.create.quota_grant.created.v1' as const;
export const COMMUNITY_CREATE_QUOTA_GRANT_CONSUMED_EVENT =
  'community.create.quota_grant.consumed.v1' as const;
export const COMMUNITY_CREATE_QUOTA_GRANT_EXPIRED_EVENT =
  'community.create.quota_grant.expired.v1' as const;

export const COMMUNITY_CREATE_QUOTA_SCOPES = ['DAILY_CREATE_LIMIT', 'ACTIVE_OWNER_LIMIT'] as const;
export type CommunityCreateQuotaScope = (typeof COMMUNITY_CREATE_QUOTA_SCOPES)[number];

export const COMMUNITY_VISIBILITIES = ['PUBLIC', 'LISTED_PRIVATE', 'HIDDEN'] as const;
export const COMMUNITY_JOIN_POLICIES = ['INSTANT', 'MODERATED', 'INVITE_ONLY'] as const;
export const COMMUNITY_PUBLISHING_PRESETS = [
  'OPEN_COMMUNITY',
  'STAFF_FEED',
  'MODERATED_FEED',
] as const;

export const communityCreateStateSchema = z
  .object({
    id: uuid,
    title: z.string().min(1).max(120),
    description: z.string().max(2_000).nullable(),
    visibility: z.enum(COMMUNITY_VISIBILITIES),
    joinPolicy: z.enum(COMMUNITY_JOIN_POLICIES),
    publishingPreset: z.enum(COMMUNITY_PUBLISHING_PRESETS),
    status: z.literal('ACTIVE'),
    revision: z.literal(1),
    ownerUserId: uuid,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

export type CommunityCreateState = z.infer<typeof communityCreateStateSchema>;

export type CommunityCreateCommandResult =
  | {
      readonly outcome: 'created';
      readonly community: CommunityCreateState;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'active_owner_quota_exceeded' }
  | { readonly outcome: 'daily_create_quota_exceeded'; readonly retryAfterSeconds: number };

export interface CommunityCreateCommandInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly title: string;
  readonly description?: string;
  readonly visibility: (typeof COMMUNITY_VISIBILITIES)[number];
  readonly joinPolicy: (typeof COMMUNITY_JOIN_POLICIES)[number];
  readonly publishingPreset: (typeof COMMUNITY_PUBLISHING_PRESETS)[number];
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface CommunityCreateRepository {
  create(input: CommunityCreateCommandInput): Promise<CommunityCreateCommandResult>;
  createQuotaGrant(input: CommunityCreateQuotaGrantInput): Promise<CommunityCreateQuotaGrantResult>;
}

export interface CommunityCreateService {
  create(input: CommunityCreateCommandInput): Promise<CommunityCreateCommandResult>;
  readonly createQuotaGrant?: (
    input: CommunityCreateQuotaGrantInput,
  ) => Promise<CommunityCreateQuotaGrantResult>;
}

export const communityCreateQuotaGrantSchema = z
  .object({
    id: uuid,
    subjectUserId: uuid,
    authorizedByUserId: uuid,
    scopes: z.array(z.enum(COMMUNITY_CREATE_QUOTA_SCOPES)).min(1).max(2),
    state: z.enum(['ACTIVE', 'CONSUMED', 'EXPIRED']),
    revision: z.number().int().positive(),
    expiresAt: dateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
    consumedAt: dateTime.nullable(),
  })
  .strict();

export type CommunityCreateQuotaGrant = z.infer<typeof communityCreateQuotaGrantSchema>;

export interface CommunityCreateQuotaGrantInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly subjectUserId: string;
  readonly capability: 'communities.create.quota.override';
  readonly scopes: readonly CommunityCreateQuotaScope[];
  readonly reasonCode: string;
  readonly ticketId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export type CommunityCreateQuotaGrantResult =
  | {
      readonly outcome: 'granted';
      readonly grant: CommunityCreateQuotaGrant;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'subject_not_active' }
  | {
      readonly outcome: 'active_grant_exists';
      readonly currentGrantId: string;
      readonly expiresAt: string;
    };

const commandSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).optional(),
    visibility: z.enum(COMMUNITY_VISIBILITIES),
    joinPolicy: z.enum(COMMUNITY_JOIN_POLICIES),
    publishingPreset: z.enum(COMMUNITY_PUBLISHING_PRESETS),
    idempotencyKey: z.string().min(16).max(128),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

const quotaGrantCommandSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    subjectUserId: uuid,
    capability: z.literal('communities.create.quota.override'),
    scopes: z
      .array(z.enum(COMMUNITY_CREATE_QUOTA_SCOPES))
      .min(1)
      .max(2)
      .refine((value) => new Set(value).size === value.length),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    ticketId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    idempotencyKey: z.string().min(16).max(128),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export class CommunityCreateError extends Error {
  public constructor(public readonly code: 'COMMUNITY_CREATE_COMMAND_INVALID') {
    super(code);
    this.name = 'CommunityCreateError';
  }
}

export function createCommunityCreateService(
  repository: CommunityCreateRepository,
): CommunityCreateService {
  return {
    async create(input) {
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success) throw new CommunityCreateError('COMMUNITY_CREATE_COMMAND_INVALID');

      const result = await repository.create({
        tenantId: parsed.data.tenantId,
        actorUserId: parsed.data.actorUserId,
        title: parsed.data.title,
        ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
        visibility: parsed.data.visibility,
        joinPolicy: parsed.data.joinPolicy,
        publishingPreset: parsed.data.publishingPreset,
        idempotencyKey: parsed.data.idempotencyKey,
        requestHash: parsed.data.requestHash,
        correlationId: parsed.data.correlationId,
      });
      if (result.outcome !== 'created') return result;
      const community = communityCreateStateSchema.safeParse(result.community);
      if (!community.success) throw new CommunityCreateError('COMMUNITY_CREATE_COMMAND_INVALID');
      return { ...result, community: community.data };
    },
    async createQuotaGrant(input) {
      const parsed = quotaGrantCommandSchema.safeParse(input);
      if (!parsed.success) throw new CommunityCreateError('COMMUNITY_CREATE_COMMAND_INVALID');
      const result = await repository.createQuotaGrant(parsed.data);
      if (result.outcome !== 'granted') return result;
      const grant = communityCreateQuotaGrantSchema.safeParse(result.grant);
      if (!grant.success) throw new CommunityCreateError('COMMUNITY_CREATE_COMMAND_INVALID');
      return { ...result, grant: grant.data };
    },
  };
}
