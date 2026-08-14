import { z } from 'zod';

import { communityJoinActionSchema } from './community-read.js';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const membershipRevision = z.number().int().nonnegative();
const requestRevision = z.number().int().positive();

const roleSchema = z.enum(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER']);
const requestOriginSchema = z.enum(['ABSENT', 'LEFT', 'REMOVED']);

export const COMMUNITY_MEMBER_JOINED_EVENT = 'community.member.joined.v1' as const;
export const COMMUNITY_JOIN_REQUESTED_EVENT = 'community.join.requested.v1' as const;
export const COMMUNITY_JOIN_CANCELLED_EVENT = 'community.join.cancelled.v1' as const;
export const COMMUNITY_MEMBER_LEFT_EVENT = 'community.member.left.v1' as const;
export const COMMUNITY_JOIN_APPROVED_EVENT = 'community.join.approved.v1' as const;
export const COMMUNITY_JOIN_REJECTED_EVENT = 'community.join.rejected.v1' as const;

export const communityPendingJoinRequestSchema = z
  .object({
    id: uuid,
    communityId: uuid,
    userId: uuid,
    state: z.literal('PENDING'),
    originStatus: requestOriginSchema,
    revision: requestRevision,
    requestedAt: dateTime,
  })
  .strict();

export const communityDecidedJoinRequestSchema = z
  .object({
    id: uuid,
    communityId: uuid,
    userId: uuid,
    state: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']),
    originStatus: requestOriginSchema,
    revision: requestRevision,
    requestedAt: dateTime,
    decidedByUserId: uuid,
    decidedAt: dateTime,
    reasonCode: z.string().min(1).max(64).optional(),
  })
  .strict();

const absentMembershipSchema = z
  .object({
    communityId: uuid,
    status: z.literal('ABSENT'),
    role: z.null(),
    revision: z.literal(0),
    pendingRequest: z.null(),
    joinAction: communityJoinActionSchema,
    updatedAt: z.null(),
  })
  .strict();

const pendingMembershipSchema = z
  .object({
    communityId: uuid,
    status: z.literal('PENDING'),
    role: z.literal('MEMBER'),
    revision: membershipRevision,
    updatedAt: dateTime,
    pendingRequest: communityPendingJoinRequestSchema,
    joinAction: z.literal('MEMBERSHIP_PENDING'),
  })
  .strict();

const activeMembershipSchema = z
  .object({
    communityId: uuid,
    status: z.literal('ACTIVE'),
    role: roleSchema,
    revision: membershipRevision,
    updatedAt: dateTime,
    pendingRequest: z.null(),
    joinAction: z.literal('OPEN_COMMUNITY'),
  })
  .strict();

function inactiveMembershipSchema<const T extends 'LEFT' | 'REMOVED' | 'BANNED'>(status: T) {
  return z
    .object({
      communityId: uuid,
      status: z.literal(status),
      role: z.literal('MEMBER'),
      revision: membershipRevision,
      updatedAt: dateTime,
      pendingRequest: z.null(),
      joinAction:
        status === 'REMOVED'
          ? z.enum(['REQUEST_REJOIN', 'INVITE_REQUIRED'])
          : status === 'BANNED'
            ? z.literal('UNAVAILABLE')
            : communityJoinActionSchema,
    })
    .strict();
}

const leftMembershipSchema = inactiveMembershipSchema('LEFT');
const removedMembershipSchema = inactiveMembershipSchema('REMOVED');
const bannedMembershipSchema = inactiveMembershipSchema('BANNED');

export const communityOwnMembershipStateSchema = z.discriminatedUnion('status', [
  absentMembershipSchema,
  pendingMembershipSchema,
  activeMembershipSchema,
  leftMembershipSchema,
  removedMembershipSchema,
  bannedMembershipSchema,
]);

export type CommunityPendingJoinRequest = z.infer<typeof communityPendingJoinRequestSchema>;
export type CommunityDecidedJoinRequest = z.infer<typeof communityDecidedJoinRequestSchema>;
export type CommunityOwnMembershipState = z.infer<typeof communityOwnMembershipStateSchema>;
type ActiveMembership = z.infer<typeof activeMembershipSchema>;
type PendingMembership = z.infer<typeof pendingMembershipSchema>;
type AbsentMembership = z.infer<typeof absentMembershipSchema>;
type LeftMembership = z.infer<typeof leftMembershipSchema>;
type RemovedMembership = z.infer<typeof removedMembershipSchema>;
type RestoredMembership = AbsentMembership | LeftMembership | RemovedMembership;
type CancelledJoinRequest = CommunityDecidedJoinRequest & { readonly state: 'CANCELLED' };
type ApprovedJoinRequest = CommunityDecidedJoinRequest & { readonly state: 'APPROVED' };
type RejectedJoinRequest = CommunityDecidedJoinRequest & { readonly state: 'REJECTED' };

const idempotentCommandFields = {
  tenantId: uuid,
  actorUserId: uuid,
  communityId: uuid,
  idempotencyKey: z.string().min(16).max(128),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  correlationId: z.string().min(1).max(128),
} as const;

const adminDecisionCommandFields = {
  tenantId: uuid,
  actorUserId: uuid,
  idempotencyKey: z.string().min(16).max(128),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  correlationId: z.string().min(1).max(128),
} as const;

const getOwnStateInputSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    communityId: uuid,
    correlationId: z.string().min(1).max(128),
  })
  .strict();

const selfJoinInputSchema = z
  .object({
    ...idempotentCommandFields,
    expectedMembershipRevision: membershipRevision,
  })
  .strict();

const cancelPendingInputSchema = z
  .object({
    ...idempotentCommandFields,
    requestId: uuid,
    expectedMembershipRevision: membershipRevision,
    expectedRequestRevision: requestRevision,
  })
  .strict();

const leaveInputSchema = z
  .object({
    ...idempotentCommandFields,
    expectedMembershipRevision: membershipRevision,
  })
  .strict();

const listPendingInputSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    communityId: uuid.optional(),
    limit: z.number().int().min(1).max(50),
    cursor: z.string().min(16).max(1_024).optional(),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

const approveInputSchema = z
  .object({
    ...adminDecisionCommandFields,
    requestId: uuid,
    expectedMembershipRevision: membershipRevision,
    expectedRequestRevision: requestRevision,
  })
  .strict();

const rejectInputSchema = z
  .object({
    ...adminDecisionCommandFields,
    requestId: uuid,
    expectedMembershipRevision: membershipRevision,
    expectedRequestRevision: requestRevision,
    reasonCode: z.string().trim().min(1).max(64),
  })
  .strict();

export type CommunityGetOwnStateInput = z.input<typeof getOwnStateInputSchema>;
export type CommunitySelfJoinInput = z.input<typeof selfJoinInputSchema>;
export type CommunityCancelPendingInput = z.input<typeof cancelPendingInputSchema>;
export type CommunityLeaveInput = z.input<typeof leaveInputSchema>;
export type CommunityListPendingInput = z.input<typeof listPendingInputSchema>;
export type CommunityApproveJoinInput = z.input<typeof approveInputSchema>;
export type CommunityRejectJoinInput = z.input<typeof rejectInputSchema>;

export type CommunityGetOwnStateResult =
  | { readonly outcome: 'found'; readonly membership: CommunityOwnMembershipState }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_active' };

export type CommunitySelfJoinResult =
  | {
      readonly outcome: 'joined';
      readonly membership: ActiveMembership;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: 'requested';
      readonly membership: PendingMembership;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'membership_already_active' }
  | { readonly outcome: 'request_already_pending' }
  | { readonly outcome: 'invite_required' }
  | { readonly outcome: 'membership_banned' };

export type CommunityCancelPendingResult =
  | {
      readonly outcome: 'cancelled';
      readonly membership: RestoredMembership;
      readonly request: CancelledJoinRequest;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'membership_revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'request_revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'request_not_found' }
  | { readonly outcome: 'request_not_pending' }
  | { readonly outcome: 'membership_banned' };

export type CommunityLeaveResult =
  | {
      readonly outcome: 'left';
      readonly membership: LeftMembership;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'membership_not_active' }
  | { readonly outcome: 'owner_cannot_leave' };

export const communityPendingAdminRequestSchema = z
  .object({
    request: communityPendingJoinRequestSchema,
    membershipRevision,
  })
  .strict();

export type CommunityPendingAdminRequest = z.infer<typeof communityPendingAdminRequestSchema>;

export type CommunityListPendingResult =
  | {
      readonly outcome: 'found';
      readonly items: CommunityPendingAdminRequest[];
      readonly nextCursor?: string | undefined;
    }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'permission_denied' };

type JoinDecisionFailure =
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'membership_revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'request_revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'permission_denied' }
  | { readonly outcome: 'request_not_found' }
  | { readonly outcome: 'request_not_pending' }
  | { readonly outcome: 'membership_banned' };

export type CommunityApproveJoinResult =
  | {
      readonly outcome: 'approved';
      readonly membership: ActiveMembership & { readonly role: 'MEMBER' };
      readonly request: ApprovedJoinRequest;
      readonly replayed: boolean;
    }
  | JoinDecisionFailure;

export type CommunityRejectJoinResult =
  | {
      readonly outcome: 'rejected';
      readonly membership: RestoredMembership;
      readonly request: RejectedJoinRequest;
      readonly replayed: boolean;
    }
  | JoinDecisionFailure;

export interface CommunityMembershipLifecycleRepository {
  getOwnState(input: CommunityGetOwnStateInput): Promise<CommunityGetOwnStateResult>;
  selfJoin(input: CommunitySelfJoinInput): Promise<CommunitySelfJoinResult>;
  cancelPending(input: CommunityCancelPendingInput): Promise<CommunityCancelPendingResult>;
  leave(input: CommunityLeaveInput): Promise<CommunityLeaveResult>;
  listPending(input: CommunityListPendingInput): Promise<CommunityListPendingResult>;
  approve(input: CommunityApproveJoinInput): Promise<CommunityApproveJoinResult>;
  reject(input: CommunityRejectJoinInput): Promise<CommunityRejectJoinResult>;
}

export type CommunityMembershipLifecycleService = CommunityMembershipLifecycleRepository;

const getOwnStateResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('found'), membership: communityOwnMembershipStateSchema }).strict(),
  z.object({ outcome: z.literal('community_not_found') }).strict(),
  z.object({ outcome: z.literal('actor_not_active') }).strict(),
]);

const revisionConflictSchema = <
  const T extends
    'revision_conflict' | 'membership_revision_conflict' | 'request_revision_conflict',
>(
  outcome: T,
) =>
  z
    .object({ outcome: z.literal(outcome), currentRevision: z.number().int().nonnegative() })
    .strict();

const simpleOutcome = <T extends string>(outcome: T) =>
  z.object({ outcome: z.literal(outcome) }).strict();

const selfJoinResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('joined'),
      membership: activeMembershipSchema,
      replayed: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('requested'),
      membership: pendingMembershipSchema,
      replayed: z.boolean(),
    })
    .strict(),
  simpleOutcome('idempotency_conflict'),
  revisionConflictSchema('revision_conflict'),
  simpleOutcome('community_not_found'),
  simpleOutcome('actor_not_active'),
  simpleOutcome('membership_already_active'),
  simpleOutcome('request_already_pending'),
  simpleOutcome('invite_required'),
  simpleOutcome('membership_banned'),
]);

const cancelPendingResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('cancelled'),
      membership: z.discriminatedUnion('status', [
        absentMembershipSchema,
        leftMembershipSchema,
        removedMembershipSchema,
      ]),
      request: communityDecidedJoinRequestSchema.extend({ state: z.literal('CANCELLED') }),
      replayed: z.boolean(),
    })
    .strict(),
  simpleOutcome('idempotency_conflict'),
  revisionConflictSchema('membership_revision_conflict'),
  revisionConflictSchema('request_revision_conflict'),
  simpleOutcome('community_not_found'),
  simpleOutcome('actor_not_active'),
  simpleOutcome('request_not_found'),
  simpleOutcome('request_not_pending'),
  simpleOutcome('membership_banned'),
]);

const leaveResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('left'),
      membership: leftMembershipSchema,
      replayed: z.boolean(),
    })
    .strict(),
  simpleOutcome('idempotency_conflict'),
  revisionConflictSchema('revision_conflict'),
  simpleOutcome('community_not_found'),
  simpleOutcome('actor_not_active'),
  simpleOutcome('membership_not_active'),
  simpleOutcome('owner_cannot_leave'),
]);

const listPendingResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('found'),
      items: z.array(communityPendingAdminRequestSchema).max(50),
      nextCursor: z.string().min(16).max(1_024).optional(),
    })
    .strict(),
  simpleOutcome('community_not_found'),
  simpleOutcome('actor_not_active'),
  simpleOutcome('permission_denied'),
]);

const decisionFailures = [
  simpleOutcome('idempotency_conflict'),
  revisionConflictSchema('membership_revision_conflict'),
  revisionConflictSchema('request_revision_conflict'),
  simpleOutcome('community_not_found'),
  simpleOutcome('actor_not_active'),
  simpleOutcome('permission_denied'),
  simpleOutcome('request_not_found'),
  simpleOutcome('request_not_pending'),
  simpleOutcome('membership_banned'),
] as const;

const approveResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('approved'),
      membership: activeMembershipSchema.extend({ role: z.literal('MEMBER') }),
      request: communityDecidedJoinRequestSchema.extend({ state: z.literal('APPROVED') }),
      replayed: z.boolean(),
    })
    .strict(),
  ...decisionFailures,
]);

const rejectResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('rejected'),
      membership: z.discriminatedUnion('status', [
        absentMembershipSchema,
        leftMembershipSchema,
        removedMembershipSchema,
      ]),
      request: communityDecidedJoinRequestSchema.extend({ state: z.literal('REJECTED') }),
      replayed: z.boolean(),
    })
    .strict(),
  ...decisionFailures,
]);

export class CommunityMembershipLifecycleError extends Error {
  public constructor(public readonly code: 'COMMUNITY_MEMBERSHIP_LIFECYCLE_INVALID') {
    super(code);
    this.name = 'CommunityMembershipLifecycleError';
  }
}

function parseInput<T>(schema: z.ZodType<T>, value: T): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CommunityMembershipLifecycleError('COMMUNITY_MEMBERSHIP_LIFECYCLE_INVALID');
  }
  return parsed.data;
}

function parseResult<T>(schema: z.ZodType<T>, value: T): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CommunityMembershipLifecycleError('COMMUNITY_MEMBERSHIP_LIFECYCLE_INVALID');
  }
  return parsed.data;
}

export function createCommunityMembershipLifecycleService(
  repository: CommunityMembershipLifecycleRepository,
): CommunityMembershipLifecycleService {
  return {
    async getOwnState(input) {
      const command = parseInput(getOwnStateInputSchema, input);
      return parseResult(getOwnStateResultSchema, await repository.getOwnState(command));
    },
    async selfJoin(input) {
      const command = parseInput(selfJoinInputSchema, input);
      return parseResult(selfJoinResultSchema, await repository.selfJoin(command));
    },
    async cancelPending(input) {
      const command = parseInput(cancelPendingInputSchema, input);
      return parseResult(cancelPendingResultSchema, await repository.cancelPending(command));
    },
    async leave(input) {
      const command = parseInput(leaveInputSchema, input);
      return parseResult(leaveResultSchema, await repository.leave(command));
    },
    async listPending(input) {
      const query = parseInput(listPendingInputSchema, input);
      return parseResult(listPendingResultSchema, await repository.listPending(query));
    },
    async approve(input) {
      const command = parseInput(approveInputSchema, input);
      return parseResult(approveResultSchema, await repository.approve(command));
    },
    async reject(input) {
      const command = parseInput(rejectInputSchema, input);
      return parseResult(rejectResultSchema, await repository.reject(command));
    },
  };
}
