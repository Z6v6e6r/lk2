import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });

export const COMMUNITY_MEMBERSHIP_PIN_CHANGED_EVENT =
  'community.membership.pin_changed.v1' as const;

export const communityMembershipPinStateSchema = z
  .object({
    communityId: uuid,
    pinned: z.boolean(),
    revision: z.number().int().nonnegative(),
    updatedAt: dateTime,
  })
  .strict();

export type CommunityMembershipPinState = z.infer<typeof communityMembershipPinStateSchema>;

export type CommunityMembershipPinCommandResult =
  | {
      readonly outcome: 'applied';
      readonly membership: CommunityMembershipPinState;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'membership_not_found' };

export interface CommunityMembershipPinRepository {
  setPin(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly pinned: boolean;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<CommunityMembershipPinCommandResult>;
}

export interface CommunityMembershipPinService {
  setPin(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly pinned: boolean;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
  }): Promise<CommunityMembershipPinCommandResult>;
}

const commandSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    communityId: uuid,
    pinned: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(16).max(128),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export class CommunityMembershipPinError extends Error {
  public constructor(public readonly code: 'COMMUNITY_MEMBERSHIP_PIN_COMMAND_INVALID') {
    super(code);
    this.name = 'CommunityMembershipPinError';
  }
}

export function createCommunityMembershipPinService(
  repository: CommunityMembershipPinRepository,
): CommunityMembershipPinService {
  return {
    async setPin(input) {
      const parsed = commandSchema.safeParse(input);
      if (!parsed.success) {
        throw new CommunityMembershipPinError('COMMUNITY_MEMBERSHIP_PIN_COMMAND_INVALID');
      }
      const result = await repository.setPin(parsed.data);
      if (result.outcome !== 'applied') return result;
      const membership = communityMembershipPinStateSchema.safeParse(result.membership);
      if (!membership.success) {
        throw new CommunityMembershipPinError('COMMUNITY_MEMBERSHIP_PIN_COMMAND_INVALID');
      }
      return { ...result, membership: membership.data };
    },
  };
}
