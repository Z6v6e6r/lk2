import { z } from 'zod';

const uuid = z.string().uuid();
const revision = z.number().int().positive();

export const COMMUNITY_OWNER_TRANSFERRED_EVENT = 'community.owner.transferred.v1' as const;

export const communityOwnershipTransferStateSchema = z
  .object({
    communityId: uuid,
    previousOwner: z.object({ userId: uuid, role: z.literal('ADMIN'), revision }).strict(),
    owner: z
      .object({
        userId: uuid,
        previousRole: z.enum(['ADMIN', 'MODERATOR', 'MEMBER']),
        role: z.literal('OWNER'),
        revision,
      })
      .strict(),
    transferredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CommunityOwnershipTransferState = z.infer<typeof communityOwnershipTransferStateSchema>;

export interface CommunityOwnershipTransferInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly communityId: string;
  readonly targetUserId: string;
  readonly expectedOwnerRevision: number;
  readonly expectedTargetRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export type CommunityOwnershipTransferResult =
  | {
      readonly outcome: 'transferred';
      readonly transfer: CommunityOwnershipTransferState;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'actor_not_active' }
  | { readonly outcome: 'community_not_found' }
  | { readonly outcome: 'actor_not_owner' }
  | { readonly outcome: 'target_not_active' }
  | { readonly outcome: 'owner_revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'target_revision_conflict'; readonly currentRevision: number };

export interface CommunityOwnershipTransferRepository {
  transfer(input: CommunityOwnershipTransferInput): Promise<CommunityOwnershipTransferResult>;
}

export interface CommunityOwnershipTransferService {
  transfer(input: CommunityOwnershipTransferInput): Promise<CommunityOwnershipTransferResult>;
}

const inputSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    communityId: uuid,
    targetUserId: uuid,
    expectedOwnerRevision: revision,
    expectedTargetRevision: revision,
    idempotencyKey: z.string().min(16).max(128),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    correlationId: z.string().min(1).max(128),
  })
  .strict()
  .refine((value) => value.actorUserId !== value.targetUserId, { path: ['targetUserId'] });

export class CommunityOwnershipTransferError extends Error {
  public constructor(public readonly code: 'COMMUNITY_OWNERSHIP_TRANSFER_INVALID') {
    super(code);
    this.name = 'CommunityOwnershipTransferError';
  }
}

export function createCommunityOwnershipTransferService(
  repository: CommunityOwnershipTransferRepository,
): CommunityOwnershipTransferService {
  return {
    async transfer(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new CommunityOwnershipTransferError('COMMUNITY_OWNERSHIP_TRANSFER_INVALID');
      }
      const result = await repository.transfer(parsed.data);
      if (result.outcome !== 'transferred') return result;
      const transfer = communityOwnershipTransferStateSchema.safeParse(result.transfer);
      if (!transfer.success) {
        throw new CommunityOwnershipTransferError('COMMUNITY_OWNERSHIP_TRANSFER_INVALID');
      }
      return { ...result, transfer: transfer.data };
    },
  };
}
