import { createHash, createHmac } from 'node:crypto';

export interface CommunityDirectInviteView {
  readonly id: string;
  readonly communityId: string;
  readonly issuedByUserId: string;
  readonly tokenKeyId: string;
  readonly state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly revision: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommunityDirectInvitePreviewView {
  readonly inviteId: string;
  readonly inviteRevision: number;
  readonly communityId: string;
  readonly title: string;
  readonly logoUrl: string | null;
  readonly visibility: 'PUBLIC' | 'LISTED_PRIVATE' | 'HIDDEN';
  readonly isVerified: boolean;
  readonly expiresAt: string;
  readonly membershipRevision: number;
  readonly redeemAction: 'CONFIRM_MEMBERSHIP' | 'OPEN_COMMUNITY' | 'REQUEST_PENDING';
}

export interface CommunityDirectInviteMembership {
  readonly communityId: string;
  readonly status: 'ACTIVE';
  readonly role: 'MEMBER';
  readonly revision: number;
  readonly updatedAt: string;
  readonly joinAction: 'OPEN_COMMUNITY';
}

export interface CommunityDirectInviteQuotaGrantView {
  readonly id: string;
  readonly communityId: string;
  readonly authorizedByUserId: string;
  readonly state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  readonly revision: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly consumedAt: string | null;
}

interface CommandBase {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface CommunityDirectInviteRepositoryPort {
  issue(
    input: CommandBase & {
      readonly communityId: string;
      readonly tokenHash: string;
      readonly tokenKeyId: string;
      readonly expectedIssuerMembershipRevision: number;
    },
  ): Promise<
    | {
        readonly outcome: 'issued';
        readonly invite: CommunityDirectInviteView;
        readonly replayed: boolean;
      }
    | { readonly outcome: 'idempotency_conflict' }
    | { readonly outcome: 'actor_not_active' }
    | { readonly outcome: 'community_not_found' }
    | { readonly outcome: 'permission_denied' }
    | {
        readonly outcome: 'issuer_membership_revision_conflict';
        readonly currentRevision: number;
      }
    | { readonly outcome: 'active_limit_exceeded'; readonly retryAfterSeconds: number }
    | { readonly outcome: 'daily_limit_exceeded'; readonly retryAfterSeconds: number }
  >;
  createQuotaGrant(
    input: CommandBase & {
      readonly communityId: string;
      readonly capability: 'communities.invite.quota.override';
      readonly reasonCode: string;
      readonly ticketId: string;
    },
  ): Promise<
    | {
        readonly outcome: 'granted';
        readonly grant: CommunityDirectInviteQuotaGrantView;
        readonly replayed: boolean;
      }
    | { readonly outcome: 'idempotency_conflict' }
    | { readonly outcome: 'actor_not_active' }
    | { readonly outcome: 'community_not_found' }
    | {
        readonly outcome: 'active_grant_exists';
        readonly currentGrantId: string;
        readonly currentRevision: number;
        readonly expiresAt: string;
      }
  >;
  preview(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly tokenHash: string;
    readonly correlationId: string;
  }): Promise<
    | { readonly outcome: 'found'; readonly preview: CommunityDirectInvitePreviewView }
    | { readonly outcome: 'invalid' }
    | { readonly outcome: 'actor_not_active' }
    | { readonly outcome: 'membership_banned' }
  >;
  redeem(
    input: CommandBase & {
      readonly tokenHash: string;
      readonly confirmed: boolean;
      readonly expectedMembershipRevision: number;
      readonly expectedInviteRevision: number;
    },
  ): Promise<
    | {
        readonly outcome: 'redeemed';
        readonly invite: CommunityDirectInviteView;
        readonly membership: CommunityDirectInviteMembership;
        readonly replayed: boolean;
      }
    | { readonly outcome: 'confirmation_required' }
    | { readonly outcome: 'idempotency_conflict' }
    | { readonly outcome: 'actor_not_active' }
    | { readonly outcome: 'invalid_invite' }
    | { readonly outcome: 'membership_banned' }
    | { readonly outcome: 'request_pending' }
    | { readonly outcome: 'membership_already_active' }
    | { readonly outcome: 'invite_revision_conflict'; readonly currentRevision: number }
    | { readonly outcome: 'membership_revision_conflict'; readonly currentRevision: number }
  >;
  revoke(
    input: CommandBase & {
      readonly inviteId: string;
      readonly expectedInviteRevision: number;
    },
  ): Promise<
    | {
        readonly outcome: 'revoked';
        readonly invite: CommunityDirectInviteView;
        readonly replayed: boolean;
      }
    | { readonly outcome: 'idempotency_conflict' }
    | { readonly outcome: 'actor_not_active' }
    | { readonly outcome: 'invite_not_found' }
    | { readonly outcome: 'permission_denied' }
    | { readonly outcome: 'invite_not_active' }
    | { readonly outcome: 'invite_revision_conflict'; readonly currentRevision: number }
  >;
  listActive(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly communityId: string;
    readonly limit: number;
    readonly cursor?: string;
    readonly correlationId: string;
  }): Promise<
    | {
        readonly outcome: 'found';
        readonly items: readonly CommunityDirectInviteView[];
        readonly nextCursor?: string;
      }
    | { readonly outcome: 'actor_not_active' }
    | { readonly outcome: 'community_not_found' }
    | { readonly outcome: 'permission_denied' }
  >;
}

export interface CommunityDirectInviteService {
  issue(
    input: CommandBase & {
      readonly communityId: string;
      readonly expectedIssuerMembershipRevision: number;
    },
  ): ReturnType<CommunityDirectInviteRepositoryPort['issue']> extends Promise<infer Result>
    ? Promise<
        Result extends {
          readonly outcome: 'issued';
          readonly invite: infer Invite;
          readonly replayed: infer Replayed;
        }
          ? {
              readonly outcome: 'issued';
              readonly invite: Invite;
              readonly replayed: Replayed;
              readonly token: string;
            }
          : Result
      >
    : never;
  createQuotaGrant(
    input: Parameters<CommunityDirectInviteRepositoryPort['createQuotaGrant']>[0],
  ): ReturnType<CommunityDirectInviteRepositoryPort['createQuotaGrant']>;
  preview(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly token: string;
    readonly correlationId: string;
  }): ReturnType<CommunityDirectInviteRepositoryPort['preview']>;
  redeem(
    input: CommandBase & {
      readonly token: string;
      readonly confirmed: boolean;
      readonly expectedMembershipRevision: number;
      readonly expectedInviteRevision: number;
    },
  ): ReturnType<CommunityDirectInviteRepositoryPort['redeem']>;
  revoke(
    input: CommandBase & {
      readonly inviteId: string;
      readonly expectedInviteRevision: number;
    },
  ): ReturnType<CommunityDirectInviteRepositoryPort['revoke']>;
  listActive(
    input: Parameters<CommunityDirectInviteRepositoryPort['listActive']>[0],
  ): ReturnType<CommunityDirectInviteRepositoryPort['listActive']>;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const OVERRIDE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const OVERRIDE_TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function derivationContext(input: {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly communityId: string;
  readonly idempotencyKey: string;
}): string {
  return [
    'padlhub.community.direct-invite.v1',
    input.tenantId,
    input.actorUserId,
    input.communityId,
    input.idempotencyKey,
  ].join('\n');
}

export function createCommunityDirectInviteService(
  repository: CommunityDirectInviteRepositoryPort,
  options: {
    readonly tokenKeys: Readonly<Record<string, Buffer>>;
    readonly activeKeyId: string;
  },
): CommunityDirectInviteService {
  const activeKey = options.tokenKeys[options.activeKeyId];
  if (!activeKey || activeKey.length !== 32) {
    throw new Error('COMMUNITY_DIRECT_INVITE_ACTIVE_KEY_INVALID');
  }

  function deriveToken(keyId: string, context: string): string {
    const key = options.tokenKeys[keyId];
    if (!key || key.length !== 32) {
      throw new Error('COMMUNITY_DIRECT_INVITE_REPLAY_KEY_UNAVAILABLE');
    }
    return createHmac('sha256', key).update(context, 'utf8').digest('base64url');
  }

  function submittedTokenHash(token: string): string | undefined {
    return TOKEN_PATTERN.test(token) ? tokenHash(token) : undefined;
  }

  return {
    async issue(input) {
      const context = derivationContext(input);
      const proposedToken = deriveToken(options.activeKeyId, context);
      const result = await repository.issue({
        ...input,
        tokenHash: tokenHash(proposedToken),
        tokenKeyId: options.activeKeyId,
      });
      if (result.outcome !== 'issued') return result;
      return {
        ...result,
        token: deriveToken(result.invite.tokenKeyId, context),
      };
    },

    createQuotaGrant(input) {
      if (
        input.capability !== 'communities.invite.quota.override' ||
        !OVERRIDE_REASON_PATTERN.test(input.reasonCode) ||
        !OVERRIDE_TICKET_PATTERN.test(input.ticketId)
      ) {
        throw new Error('COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_AUTHORIZATION_INVALID');
      }
      return repository.createQuotaGrant(input);
    },

    preview(input) {
      const hash = submittedTokenHash(input.token);
      if (!hash) return Promise.resolve({ outcome: 'invalid' as const });
      return repository.preview({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        tokenHash: hash,
        correlationId: input.correlationId,
      });
    },

    redeem(input) {
      if (!input.confirmed) return Promise.resolve({ outcome: 'confirmation_required' as const });
      const hash = submittedTokenHash(input.token);
      if (!hash) return Promise.resolve({ outcome: 'invalid_invite' as const });
      return repository.redeem({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        correlationId: input.correlationId,
        tokenHash: hash,
        confirmed: input.confirmed,
        expectedMembershipRevision: input.expectedMembershipRevision,
        expectedInviteRevision: input.expectedInviteRevision,
      });
    },

    revoke(input) {
      return repository.revoke(input);
    },

    listActive(input) {
      return repository.listActive(input);
    },
  };
}
