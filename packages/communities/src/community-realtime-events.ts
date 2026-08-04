import { z } from 'zod';

const uuid = z.string().uuid();
const sequence = z.number().int().nonnegative().safe();

export const COMMUNITY_REALTIME_EVENT_TYPES = [
  'community.post.created.v1',
  'community.post.edited.v1',
  'community.post.archived.v1',
  'community.post.restored.v1',
  'community.comment.created.v1',
  'community.comment.edited.v1',
  'community.comment.archived.v1',
  'community.comment.restored.v1',
  'community.reaction.changed.v1',
  'community.post.moderation_approved.v1',
  'community.post.moderation_rejected.v1',
  'community.post.moderation_hidden.v1',
  'community.post.moderation_restored.v1',
  'community.comment.moderation_hidden.v1',
  'community.comment.moderation_restored.v1',
] as const;

export const communityRealtimeEventSchema = z
  .object({
    communityId: uuid,
    sequence: sequence.refine((value) => value > 0),
    eventType: z.string().regex(/^community\.[a-z0-9_.-]+\.v[1-9][0-9]*$/),
    targetType: z.enum(['POST', 'COMMENT', 'REACTION']),
    targetId: uuid,
    targetRevision: z.number().int().positive().safe(),
    targetStatus: z.string().min(1).max(64).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const communityRealtimeEventPageSchema = z
  .object({
    items: z.array(communityRealtimeEventSchema).max(100),
    afterSequence: sequence,
    latestSequence: sequence,
    retainedFromSequence: z.number().int().positive().safe(),
    nextAfterSequence: z.number().int().positive().safe().optional(),
    hasMore: z.boolean(),
  })
  .strict();

export type CommunityRealtimeEvent = z.infer<typeof communityRealtimeEventSchema>;
export type CommunityRealtimeEventPage = z.infer<typeof communityRealtimeEventPageSchema>;

export const communityEventGapExpiredResponseSchema = z
  .object({
    code: z.literal('COMMUNITY_EVENT_GAP_EXPIRED'),
    message: z.string().min(1),
    correlationId: z.string().min(1),
    recoveryAction: z.literal('FULL_CANONICAL_RELOAD'),
    latestSequence: sequence,
    retainedFromSequence: z.number().int().positive().safe(),
  })
  .strict();
export type CommunityEventGapExpiredResponse = z.infer<
  typeof communityEventGapExpiredResponseSchema
>;

export const communityRealtimeEventHintSchema = communityRealtimeEventSchema
  .extend({ tenantId: uuid })
  .strict();
export type CommunityRealtimeEventHint = z.infer<typeof communityRealtimeEventHintSchema>;

export type CommunityEventRecoveryResult =
  | { readonly outcome: 'found'; readonly page: CommunityRealtimeEventPage }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'cursor_ahead'; readonly latestSequence: number }
  | {
      readonly outcome: 'gap_expired';
      readonly latestSequence: number;
      readonly retainedFromSequence: number;
    };

export interface CommunityEventRecoveryRepository {
  listEvents(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly afterSequence: number;
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<CommunityEventRecoveryResult>;
}

export interface CommunityEventRecoveryService {
  listEvents(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly afterSequence: number;
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<CommunityEventRecoveryResult>;
}

const listInputSchema = z
  .object({
    tenantId: uuid,
    viewerUserId: uuid,
    communityId: uuid,
    afterSequence: sequence,
    limit: z.number().int().min(1).max(100),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export class CommunityEventRecoveryError extends Error {
  public constructor(
    public readonly code:
      'COMMUNITY_EVENT_RECOVERY_QUERY_INVALID' | 'COMMUNITY_EVENT_STATE_INVALID',
  ) {
    super(code);
    this.name = 'CommunityEventRecoveryError';
  }
}

export function createCommunityEventRecoveryService(
  repository: CommunityEventRecoveryRepository,
): CommunityEventRecoveryService {
  return {
    async listEvents(input) {
      const parsed = listInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new CommunityEventRecoveryError('COMMUNITY_EVENT_RECOVERY_QUERY_INVALID');
      }
      const result = await repository.listEvents(parsed.data);
      if (
        result.outcome === 'found' &&
        !communityRealtimeEventPageSchema.safeParse(result.page).success
      ) {
        throw new CommunityEventRecoveryError('COMMUNITY_EVENT_STATE_INVALID');
      }
      return result;
    },
  };
}
